-- =====================================================================
-- 0006 Inbetalningar, påminnelser och kundreskontra.
--
-- Bankgirots inbetalningsfiler (BgMax) läses in, granskas och bokförs.
-- Betalningar matchas mot fakturor på OCR-nummer. Det som inte går att
-- matcha ligger kvar som omatchade inbetalningar tills någon pekar ut kunden.
--
-- Skydd i databasen:
--  * Samma fil kan inte läsas in två gånger (kontrollsumma per bolag).
--  * Samma betalning kan inte bokföras två gånger (Bankgirots löpnummer).
--  * En betalning kan aldrig fördelas eller återbetalas med mer än sitt belopp.
--  * En faktura får bara en påminnelse per nivå.
-- (0005 är reserverad för importcentret.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Inställningar för påminnelser per bolag
-- ---------------------------------------------------------------------

alter table company
  -- Påminnelseavgift i öre. Högst 60 kr enligt förordningen om ersättning för inkassokostnader.
  add column reminder_fee_ore    bigint  not null default 6000 check (reminder_fee_ore between 0 and 6000),
  -- Dagar efter förfallodagen innan en påminnelse föreslås
  add column reminder_grace_days integer not null default 5 check (reminder_grace_days between 0 and 90),
  -- Ny betalningsfrist på påminnelsen, i dagar
  add column reminder_due_days   integer not null default 10 check (reminder_due_days between 1 and 60),
  -- Dröjsmålsränta i baspunkter per år (referensränta + 8 procentenheter enligt räntelagen)
  add column late_interest_bp    integer not null default 1000 check (late_interest_bp between 0 and 5000);

-- ---------------------------------------------------------------------
-- Bankfiler och transaktioner
-- ---------------------------------------------------------------------

create table bank_file (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company(id),
  format            text not null check (format in ('bgmax')),
  filename          text not null,
  sha256            text not null,
  bankgiro          text,                 -- mottagarens bankgiro enligt filen
  file_timestamp    text,                 -- Bankgirots skrivtidpunkt
  test_file         boolean not null default false,
  status            text not null default 'draft' check (status in ('draft','booked')),
  payment_count     integer not null default 0,
  total_ore         bigint not null default 0,
  booked_at         timestamptz,
  booked_by         uuid,
  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (company_id, sha256),
  unique (id, company_id)
);

create table bank_transaction (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  bank_file_id      uuid not null,
  position          integer not null,
  kind              text not null check (kind in ('payment','deduction')),
  amount_ore        bigint not null check (amount_ore > 0),
  payment_date      date not null,
  reference         text,
  reference_code    text,                 -- Bankgirots referenskod (2 = korrekt OCR, 5 = felaktig referens …)
  sender_bankgiro   text,
  payer_name        text,
  payer_address     text,
  payer_org_nr      text,
  information       text,
  extra_references  jsonb not null default '[]',
  bgc_serial        text,                 -- Bankgirots löpnummer, unikt per betalning
  deposit_serial    text,
  status            text not null check (status in ('matched','unmatched','ignored','booked','duplicate')),
  match_rule        text check (match_rule in ('ocr','invoice_nr','name_amount','manual')),  -- name_amount = förslag som ska bekräftas
  customer_id       uuid,
  invoice_id        uuid,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (id, company_id),
  check (status not in ('matched','booked') or customer_id is not null),
  check (kind = 'payment' or status in ('unmatched','ignored','duplicate')),
  foreign key (bank_file_id, company_id) references bank_file(id, company_id) on delete cascade,
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (invoice_id, company_id) references invoice(id, company_id)
);

-- Samma betalning från Bankgirot bokförs bara en gång, även om den finns i flera filer
create unique index bank_transaction_once on bank_transaction (company_id, bgc_serial)
  where bgc_serial is not null and status <> 'duplicate';

-- ---------------------------------------------------------------------
-- Betalningar: koppling till bankfil och återbetalningar
-- ---------------------------------------------------------------------

alter table payment
  add column bank_transaction_id uuid unique;
alter table payment
  add constraint payment_bank_transaction_fk foreign key (bank_transaction_id, company_id) references bank_transaction(id, company_id);

create table payment_refund (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  payment_id    uuid not null,
  amount_ore    bigint not null check (amount_ore > 0),
  refund_date   date not null,
  method        text not null default 'bank' check (method in ('bank','swish','cash','other')),
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  -- En återbetalning är utbetalda pengar: betalningen kan inte tas bort så länge den finns
  foreign key (payment_id, company_id) references payment(id, company_id)
);

-- En betalning kan aldrig användas för mer än sitt belopp
create or replace function app.check_payment_usage() returns trigger
language plpgsql as $$
declare
  v_payment uuid := coalesce(new.payment_id, old.payment_id);
  v_amount bigint;
  v_used bigint;
begin
  select amount_ore into v_amount from payment where id = v_payment for update;
  if v_amount is null then return null; end if;
  select coalesce((select sum(amount_ore) from payment_allocation where payment_id = v_payment), 0)
       + coalesce((select sum(amount_ore) from payment_refund where payment_id = v_payment), 0)
    into v_used;
  if v_used > v_amount then
    raise exception 'Betalningen räcker inte: % öre fördelat av % öre', v_used, v_amount using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger payment_allocation_usage after insert or update on payment_allocation
  deferrable initially immediate for each row execute function app.check_payment_usage();
create constraint trigger payment_refund_usage after insert or update on payment_refund
  deferrable initially immediate for each row execute function app.check_payment_usage();

-- Ej fördelat belopp per betalning
create view payment_balance with (security_invoker = true) as
select p.id as payment_id, p.company_id, p.customer_id, p.amount_ore,
  coalesce((select sum(a.amount_ore) from payment_allocation a where a.payment_id = p.id), 0)::bigint as allocated_ore,
  coalesce((select sum(r.amount_ore) from payment_refund r where r.payment_id = p.id), 0)::bigint as refunded_ore,
  (p.amount_ore
    - coalesce((select sum(a.amount_ore) from payment_allocation a where a.payment_id = p.id), 0)
    - coalesce((select sum(r.amount_ore) from payment_refund r where r.payment_id = p.id), 0))::bigint as unallocated_ore
from payment p;

-- ---------------------------------------------------------------------
-- Påminnelser
-- ---------------------------------------------------------------------

create table reminder (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  invoice_id       uuid not null,
  customer_id      uuid not null,
  level            smallint not null check (level between 1 and 2),
  reminder_date    date not null,
  due_date         date not null,
  balance_ore      bigint not null check (balance_ore > 0),   -- obetalt på fakturan när påminnelsen skapades
  fee_ore          bigint not null default 0 check (fee_ore >= 0),
  interest_ore     bigint not null default 0 check (interest_ore >= 0), -- upplupen dröjsmålsränta, upplysning
  fee_invoice_id   uuid,
  bill_to          jsonb not null default '{}',
  channel          text not null check (channel in ('email','post')),
  recipient        text,
  status           text not null default 'queued' check (status in ('queued','sent','test','failed','printed')),
  sent_at          timestamptz,
  error            text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (invoice_id, level),
  unique (id, company_id),
  check (due_date >= reminder_date),
  foreign key (invoice_id, company_id) references invoice(id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (fee_invoice_id, company_id) references invoice(id, company_id)
);

create index on bank_transaction (bank_file_id);
create index on bank_transaction (company_id, status);
create index on bank_transaction (customer_id);
create index on payment_refund (payment_id);
create index on reminder (invoice_id);
create index on reminder (customer_id);
create index on reminder (fee_invoice_id);
create index on invoice (company_id, ocr);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['bank_file','bank_transaction','payment_refund','reminder'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
end $$;

grant select on payment_balance to fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['reminder.send']
  when 'finance'     then array['reminder.send']
  else array[]::text[]
end) as p;
