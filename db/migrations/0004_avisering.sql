-- =====================================================================
-- 0004 Avisering och fakturering.
--
-- Hyresavier skapas i aviseringskörningar ur avtalens debiteringsrader.
-- En körning är ett utkast tills den godkänns; då får varje avi ett
-- löpnummer utan luckor och ett OCR-nummer, och blir låst.
--
-- Skydd i databasen:
--  * En avtalsrad kan bara aviseras en gång per period (exclusion-villkor).
--  * En extra debitering kan bara faktureras en gång.
--  * Utfärdade fakturor och deras rader kan aldrig ändras eller tas bort.
--    Rättelser görs med kreditfaktura.
--  * Fakturanummer delas ut i följd per bolag utan luckor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fakturainställningar per bolag
-- ---------------------------------------------------------------------

alter table company
  add column invoice_email   text,                          -- avsändare/svarsadress för fakturor
  add column f_tax           boolean not null default true, -- Godkänd för F-skatt
  add column invoice_footer  text,                          -- fritext längst ned på fakturan
  add column round_to_krona  boolean not null default true; -- öresavrundning till hela kronor

create table invoice_series (
  company_id   uuid primary key references company(id),
  next_nr      bigint not null default 1001 check (next_nr > 0),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

-- ---------------------------------------------------------------------
-- Extra debiteringar (engångsbelopp som följer med nästa avi)
-- ---------------------------------------------------------------------

create table contract_charge (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  contract_id    uuid not null,
  object_id      uuid,
  article        text not null check (article in ('rent','heating','electricity','water','parking','storage','service','index','discount','fee','other')),
  description    text not null,
  amount_ore     bigint not null check (amount_ore <> 0),   -- exkl. moms, negativt för avdrag
  vat_rate_bp    integer not null default 0 check (vat_rate_bp in (0, 600, 1200, 2500)),
  bill_from      date not null,                             -- tas med i första avisering för denna månad eller senare
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  unique (id, company_id),
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade,
  foreign key (object_id, company_id) references rental_object(id, company_id)
);

create or replace function app.check_charge_vat() returns trigger
language plpgsql as $$
begin
  if new.vat_rate_bp > 0 and exists (select 1 from contract c where c.id = new.contract_id and c.type = 'residential') then
    raise exception 'Bostadsavtal kan inte ha moms' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger contract_charge_vat_check before insert or update on contract_charge
  for each row execute function app.check_charge_vat();

-- ---------------------------------------------------------------------
-- Aviseringskörningar
-- ---------------------------------------------------------------------

create table billing_run (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company(id),
  run_nr         integer not null,
  period_month   date not null check (extract(day from period_month) = 1),  -- månaden som aviseras
  invoice_date   date not null,
  due_date       date,                                      -- null = räknas fram per avtal
  property_ids   uuid[],                                    -- null = alla fastigheter
  object_ids     uuid[],                                    -- null = alla objekt
  excluded_contract_ids uuid[] not null default '{}',       -- avtal som tagits bort ur körningen
  fingerprint    text,                                      -- summering av underlaget vid senaste uppdatering
  status         text not null default 'draft' check (status in ('draft','issued','cancelled')),
  generated_at   timestamptz,
  issued_at      timestamptz,
  issued_by      uuid,
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  unique (company_id, run_nr),
  unique (id, company_id)
);
-- Högst en körning under arbete per bolag, så att två utkast aldrig aviserar samma sak.
create unique index billing_run_one_draft on billing_run (company_id) where status = 'draft';

create table billing_run_issue (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  billing_run_id  uuid not null,
  kind            text not null,   -- already_billed, partially_billed, missing_previous, draft_contract, no_lines,
                                   -- vacant_billed, vat_mismatch, deviating_amount, negative_total, missing_address,
                                   -- missing_email, missing_peppol, no_bankgiro, zero_total
  severity        text not null check (severity in ('blocking','warning','info')),
  contract_id     uuid,
  object_id       uuid,
  customer_id     uuid,
  invoice_id      uuid,
  message         text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  foreign key (billing_run_id, company_id) references billing_run(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Fakturor och avier
-- ---------------------------------------------------------------------

create table invoice (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company(id),
  kind                text not null check (kind in ('rent_notice','invoice','credit_note')),
  status              text not null default 'draft' check (status in ('draft','issued')),
  invoice_nr          bigint,                                -- sätts när fakturan utfärdas, i följd utan luckor
  ocr                 text,
  customer_id         uuid not null,
  contract_id         uuid,
  billing_run_id      uuid,
  invoice_date        date not null,
  due_date            date not null,
  period_from         date,
  period_to           date,
  bill_to             jsonb not null default '{}',           -- kunduppgifter som de såg ut när fakturan skapades
  delivery_method     text not null check (delivery_method in ('email','post','e_invoice')),
  our_reference       text,
  your_reference      text,
  message             text,                                  -- fritext på fakturan
  net_ore             bigint not null default 0,
  vat_ore             bigint not null default 0,
  rounding_ore        bigint not null default 0,
  total_ore           bigint not null default 0,
  credits_invoice_id  uuid,
  credit_reason       text,
  issued_at           timestamptz,
  issued_by           uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  unique (company_id, invoice_nr),
  unique (company_id, ocr),
  unique (id, company_id),
  check (status = 'draft' or (invoice_nr is not null and issued_at is not null)),
  check (kind <> 'credit_note' or credits_invoice_id is not null),
  check (due_date >= invoice_date),
  check (period_to is null or period_to >= period_from),
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (contract_id, company_id) references contract(id, company_id),
  foreign key (billing_run_id, company_id) references billing_run(id, company_id),
  foreign key (credits_invoice_id, company_id) references invoice(id, company_id)
);

create table invoice_line (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  invoice_id          uuid not null,
  position            smallint not null default 0,
  line_kind           text not null check (line_kind in ('regular','retroactive','charge','manual','credit')),
  contract_id         uuid,
  -- Avtalsraden som debiteras. Ingen främmande nyckel: fakturan ska finnas kvar
  -- oförändrad även om avtalsraden senare tas bort.
  contract_line_id    uuid,
  contract_charge_id  uuid,
  object_id           uuid,
  property_id         uuid,
  cost_center_id      uuid references cost_center(id),
  article             text not null check (article in ('rent','heating','electricity','water','parking','storage','service','index','discount','fee','other')),
  description         text not null,
  period_from         date,
  period_to           date,
  quantity            numeric(12,3) not null default 1,
  unit_price_ore      bigint not null,
  net_ore             bigint not null,
  vat_rate_bp         integer not null check (vat_rate_bp in (0, 600, 1200, 2500)),
  vat_ore             bigint not null,
  credits_line_id     uuid references invoice_line(id),
  rebill              boolean not null default false,        -- kreditrad: perioden ska aviseras på nytt
  created_at          timestamptz not null default now(),
  created_by          uuid,
  check (period_to is null or period_to >= period_from),
  check (line_kind not in ('regular','retroactive') or (contract_line_id is not null and period_from is not null and period_to is not null)),
  check (line_kind <> 'charge' or contract_charge_id is not null),
  foreign key (invoice_id, company_id) references invoice(id, company_id) on delete cascade,
  foreign key (contract_id, company_id) references contract(id, company_id),
  foreign key (contract_charge_id, company_id) references contract_charge(id, company_id),
  foreign key (object_id, company_id) references rental_object(id, company_id),
  foreign key (property_id, company_id) references property(id, company_id),
  -- Aldrig dubbeldebitering: en avtalsrad kan bara aviseras en gång för en given dag.
  exclude using gist (contract_line_id with =, daterange(period_from, period_to, '[]') with &&)
    where (line_kind = 'regular')
);
-- En extra debitering kan bara faktureras en gång.
create unique index invoice_line_charge_once on invoice_line (contract_charge_id) where line_kind = 'charge';

-- Utfärdade fakturor är låsta. Bara övergången från utkast till utfärdad är tillåten.
create or replace function app.invoice_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'En utfärdad faktura kan inte tas bort. Gör en kreditfaktura i stället.' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and
     (to_jsonb(new) - 'updated_at' - 'updated_by') is distinct from (to_jsonb(old) - 'updated_at' - 'updated_by') then
    raise exception 'En utfärdad faktura kan inte ändras. Gör en kreditfaktura i stället.' using errcode = '23514';
  end if;
  if new.status = 'draft' and old.status <> 'draft' then
    raise exception 'En utfärdad faktura kan inte göras till utkast' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger invoice_immutable before update or delete on invoice
  for each row execute function app.invoice_immutable();

create or replace function app.invoice_line_immutable() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  -- När fakturan själv tas bort (utkast) finns den inte längre att slå upp
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Raderna på en utfärdad faktura kan inte ändras' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger invoice_line_immutable before insert or update or delete on invoice_line
  for each row execute function app.invoice_line_immutable();

-- Bostadsavtal ska aldrig få moms, inte heller på fakturor
create or replace function app.check_invoice_line_vat() returns trigger
language plpgsql as $$
begin
  if new.vat_rate_bp > 0 and new.contract_id is not null
     and exists (select 1 from contract c where c.id = new.contract_id and c.type = 'residential') then
    raise exception 'Bostadsavtal kan inte ha moms' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger invoice_line_vat_check before insert or update on invoice_line
  for each row execute function app.check_invoice_line_vat();

create table invoice_delivery (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  invoice_id    uuid not null,
  channel       text not null check (channel in ('email','post','e_invoice')),
  status        text not null default 'queued' check (status in ('queued','sent','test','failed')),
  recipient     text,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  foreign key (invoice_id, company_id) references invoice(id, company_id)
);

-- ---------------------------------------------------------------------
-- Inbetalningar (registreras manuellt i fas 4, bankfiler kommer i fas 5)
-- ---------------------------------------------------------------------

create table payment (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  customer_id   uuid not null,
  amount_ore    bigint not null check (amount_ore > 0),
  payment_date  date not null,
  method        text not null default 'bankgiro' check (method in ('bankgiro','autogiro','swish','cash','other')),
  reference     text,
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id)
);

create table payment_allocation (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  payment_id   uuid not null,
  invoice_id   uuid not null,
  amount_ore   bigint not null check (amount_ore > 0),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  foreign key (payment_id, company_id) references payment(id, company_id) on delete cascade,
  foreign key (invoice_id, company_id) references invoice(id, company_id)
);

-- Saldo per faktura: totalt, betalt, krediterat och kvar att betala
create view invoice_balance with (security_invoker = true) as
select i.id as invoice_id, i.company_id, i.total_ore,
  coalesce((select sum(a.amount_ore) from payment_allocation a where a.invoice_id = i.id), 0)::bigint as paid_ore,
  coalesce((select -sum(c.total_ore) from invoice c where c.credits_invoice_id = i.id and c.status = 'issued'), 0)::bigint as credited_ore,
  case when i.kind = 'credit_note' or i.status <> 'issued' then 0
       else i.total_ore
            - coalesce((select sum(a.amount_ore) from payment_allocation a where a.invoice_id = i.id), 0)
            - coalesce((select -sum(c.total_ore) from invoice c where c.credits_invoice_id = i.id and c.status = 'issued'), 0)
  end::bigint as balance_ore
from invoice i;

create index on invoice (company_id, status, invoice_date desc);
create index on invoice (customer_id);
create index on invoice (contract_id);
create index on invoice (billing_run_id);
create index on invoice (credits_invoice_id);
create index on invoice_line (invoice_id);
create index on invoice_line (contract_id, period_from);
create index on invoice_line (contract_line_id);
create index on billing_run_issue (billing_run_id);
create index on invoice_delivery (invoice_id);
create index on payment_allocation (invoice_id);
create index on payment_allocation (payment_id);
create index on payment (customer_id);
create index on contract_charge (contract_id);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['invoice_series','contract_charge','billing_run','billing_run_issue','invoice','invoice_line',
                           'invoice_delivery','payment','payment_allocation'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
  -- Körningens kontrollista skrivs om vid varje uppdatering och loggas inte rad för rad
  foreach t in array array['invoice_series','contract_charge','billing_run','invoice','invoice_line',
                           'invoice_delivery','payment','payment_allocation'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
end $$;

-- invoice_series saknar id; revisionsloggen använder company_id
create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_rec jsonb := coalesce(v_new, v_old);
  v_company uuid;
begin
  v_company := coalesce((v_rec ->> 'company_id')::uuid,
                        case when tg_table_name = 'company' then (v_rec ->> 'id')::uuid end);
  v_old := v_old - 'password_hash';
  v_new := v_new - 'password_hash';
  insert into audit_log (user_id, company_id, table_name, row_id, action, before, after, request_id)
  values (app.current_user_id(), v_company, tg_table_name,
          coalesce(v_rec ->> 'id', v_rec ->> 'contract_id', v_rec ->> 'property_id', v_rec ->> 'company_id'), lower(tg_op),
          v_old, v_new, nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

grant select on invoice_balance to fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['invoice.write','billing.run','invoice.issue','payment.write']
  when 'finance'     then array['invoice.write','billing.run','invoice.issue','payment.write']
  when 'manager'     then array['invoice.write','billing.run']
  else array[]::text[]
end) as p;
