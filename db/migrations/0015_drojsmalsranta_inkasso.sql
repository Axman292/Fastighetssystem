-- =====================================================================
-- 0015 Dröjsmålsränta, avbetalningsplaner och inkasso.
--
--  * Dröjsmålsränta debiteras på riktigt: referensräntan + 8 procentenheter
--    enligt räntelagen (eller avtalad ränta). Räntan läggs på nästa avi som
--    en extra debitering eller skickas som en egen räntefaktura. Artikeln
--    Dröjsmålsränta bokförs på 8313 utan moms.
--  * Avbetalningsplaner för en eller flera obetalda fakturor.
--  * Inkassoärenden: fakturor lämnas till inkassobolag, exporteras som fil
--    och följs upp med status. Det som inte går att få betalt för skrivs av
--    som kundförlust (6350) med en kreditfaktura.
--
-- Skydd i databasen:
--  * Samma dag på en faktura kan aldrig räntedebiteras två gånger.
--  * En faktura kan bara ingå i en aktiv avbetalningsplan och ett aktivt
--    inkassoärende åt gången.
-- (Numret 0015 lämnar plats för migreringar som byggs samtidigt.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Referensränta enligt räntelagen (Riksbanken, fastställs 1 januari och 1 juli)
-- ---------------------------------------------------------------------

create table reference_rate (
  valid_from  date primary key check (extract(day from valid_from) = 1 and extract(month from valid_from) in (1, 7)),
  rate_bp     integer not null check (rate_bp between -1000 and 5000),
  created_at  timestamptz not null default now(),
  created_by  uuid
);

insert into reference_rate (valid_from, rate_bp) values
  ('2023-01-01', 250),
  ('2023-07-01', 350),
  ('2024-01-01', 400),
  ('2024-07-01', 400),
  ('2025-01-01', 250),
  ('2025-07-01', 200),
  ('2026-01-01', 200),
  ('2026-07-01', 200);

grant select, insert, update on reference_rate to fastighet_app;
create trigger reference_rate_stamp before insert or update on reference_rate
  for each row execute function app.stamp();
create trigger reference_rate_audit after insert or update or delete on reference_rate
  for each row execute function app.audit();

-- ---------------------------------------------------------------------
-- Inställningar per bolag och avtal
-- ---------------------------------------------------------------------

alter table company
  -- true = referensräntan + marginal (räntelagen 6 §), false = fast ränta i late_interest_bp
  add column late_interest_reference boolean not null default true,
  add column late_interest_margin_bp integer not null default 800 check (late_interest_margin_bp between 0 and 5000),
  -- Räntor under beloppet debiteras inte ännu, de växer till nästa gång
  add column late_interest_min_ore   bigint  not null default 5000 check (late_interest_min_ore between 0 and 100000),
  -- next_notice = på nästa hyresavi, invoice = egen räntefaktura
  add column late_interest_method    text    not null default 'next_notice' check (late_interest_method in ('next_notice', 'invoice')),
  -- Ränta räknas inte för dagar före detta datum (ingen retroaktiv debitering när funktionen slås på)
  add column late_interest_from      date    not null default current_date,
  -- Konto för konstaterade kundförluster
  add column bad_debt_account        text    not null default '6350' check (bad_debt_account ~ '^\d{4}$');

-- Avtalad dröjsmålsränta ersätter bolagets. För konsumenter får den inte vara sämre än räntelagen.
alter table contract add column late_interest_bp integer check (late_interest_bp between 0 and 5000);

-- ---------------------------------------------------------------------
-- Artikeln Dröjsmålsränta (8313, momsfri)
-- ---------------------------------------------------------------------

create or replace function app.seed_articles(p_company uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.seed_bas_accounts(p_company);
  insert into article (company_id, code, name, account_number, vat_rate_bp, system, position)
  select p_company, a.code, a.name, a.account, a.vat, a.system, a.pos
  from (values
    ('rent',            'Hyra',            '3010', null::integer, true,  10),
    ('parking',         'Parkering',       '3010', null,          true,  20),
    ('storage',         'Förråd',          '3010', null,          true,  30),
    ('heating',         'Värme',           '3130', null,          true,  40),
    ('electricity',     'El',              '3120', null,          true,  50),
    ('water',           'Vatten',          '3110', null,          true,  60),
    ('broadband',       'Bredband',        '3690', null,          false, 70),
    ('cable_tv',        'Kabel-TV',        '3070', null,          false, 80),
    ('property_tax',    'Fastighetsskatt', '3950', null,          false, 90),
    ('service',         'Tjänst',          '3690', null,          true,  100),
    ('index',           'Indextillägg',    '3010', null,          true,  110),
    ('discount',        'Rabatt',          '3090', null,          true,  120),
    ('fee',             'Avgift',          '3540', 0,             true,  130),
    ('interest',        'Dröjsmålsränta',  '8313', 0,             true,  135),
    ('other',           'Övrigt',          '3690', null,          true,  140)
  ) as a(code, name, account, vat, system, pos)
  on conflict do nothing;
end $$;

-- Befintliga bolag. Finns redan en egen artikel som heter Dröjsmålsränta får systemartikeln ett annat namn.
insert into article (company_id, code, name, account_number, vat_rate_bp, system, position)
select c.id, 'interest',
       case when exists (select 1 from article x where x.company_id = c.id and lower(x.name) = 'dröjsmålsränta')
            then 'Dröjsmålsränta (system)' else 'Dröjsmålsränta' end,
       '8313', 0, true, 135
from company c
where exists (select 1 from account a where a.company_id = c.id and a.number = '8313')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Debiterad dröjsmålsränta
-- ---------------------------------------------------------------------

create table late_interest_charge (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  invoice_id          uuid not null,                 -- fakturan som betalades för sent
  customer_id         uuid not null,
  from_date           date not null,
  to_date             date not null,
  amount_ore          bigint not null check (amount_ore > 0),
  rate_text           text not null,                 -- t.ex. "10 %" eller "10 % / 12 %" när räntan ändrats
  method              text not null check (method in ('next_notice', 'invoice')),
  interest_invoice_id uuid,                          -- räntefakturan
  contract_charge_id  uuid,                          -- extra debiteringen på nästa avi
  run_date            date not null,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  unique (id, company_id),
  check (to_date >= from_date),
  check ((method = 'invoice') = (interest_invoice_id is not null)),
  check ((method = 'next_notice') = (contract_charge_id is not null)),
  foreign key (invoice_id, company_id) references invoice(id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (interest_invoice_id, company_id) references invoice(id, company_id),
  -- Tas debiteringen bort innan den aviserats kan räntan debiteras igen
  foreign key (contract_charge_id, company_id) references contract_charge(id, company_id) on delete cascade,
  -- Aldrig ränta två gånger för samma dag
  exclude using gist (invoice_id with =, daterange(from_date, to_date, '[]') with &&)
);
create index on late_interest_charge (invoice_id);
create index on late_interest_charge (interest_invoice_id);
create index on late_interest_charge (contract_charge_id);
create index on late_interest_charge (customer_id);

-- ---------------------------------------------------------------------
-- Avbetalningsplaner
-- ---------------------------------------------------------------------

create table payment_plan (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company(id),
  plan_nr          integer not null,
  customer_id      uuid not null,
  status           text not null default 'active' check (status in ('active', 'completed', 'broken', 'cancelled')),
  agreed_date      date not null,
  total_ore        bigint not null check (total_ore > 0),
  -- Dröjsmålsränta fortsätter att debiteras under planen om inte annat avtalats
  charge_interest  boolean not null default true,
  note             text,
  closed_date      date,
  closed_reason    text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (company_id, plan_nr),
  unique (id, company_id),
  check ((status = 'active') = (closed_date is null)),
  foreign key (customer_id, company_id) references customer(id, company_id)
);

create table payment_plan_invoice (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  plan_id      uuid not null,
  invoice_id   uuid not null,
  balance_ore  bigint not null check (balance_ore > 0),   -- obetalt när planen gjordes
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  unique (plan_id, invoice_id),
  foreign key (plan_id, company_id) references payment_plan(id, company_id) on delete cascade,
  foreign key (invoice_id, company_id) references invoice(id, company_id)
);
create unique index payment_plan_invoice_one_active on payment_plan_invoice (invoice_id) where active;

create table payment_plan_installment (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  plan_id     uuid not null,
  nr          smallint not null check (nr > 0),
  due_date    date not null,
  amount_ore  bigint not null check (amount_ore > 0),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (plan_id, nr),
  foreign key (plan_id, company_id) references payment_plan(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Inkasso
-- ---------------------------------------------------------------------

create table collection_case (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company(id),
  case_nr           integer not null,
  customer_id       uuid not null,
  -- prepared = förberett, sent = hos inkassobolaget, enforcement = betalningsföreläggande/Kronofogden,
  -- paid = betalt, withdrawn = återkallat, written_off = avskrivet som kundförlust
  status            text not null default 'prepared'
                    check (status in ('prepared', 'sent', 'enforcement', 'paid', 'withdrawn', 'written_off')),
  agency            text,
  agency_reference  text,
  capital_ore       bigint not null check (capital_ore > 0),   -- obetalt kapital när ärendet skapades
  interest_ore      bigint not null default 0 check (interest_ore >= 0), -- upplupen, ej debiterad ränta
  sent_date         date,
  closed_date       date,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (company_id, case_nr),
  unique (id, company_id),
  check ((status in ('paid', 'withdrawn', 'written_off')) = (closed_date is not null)),
  foreign key (customer_id, company_id) references customer(id, company_id)
);

create table collection_case_invoice (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  case_id            uuid not null,
  invoice_id         uuid not null,
  capital_ore        bigint not null check (capital_ore > 0),
  interest_from      date not null,            -- ränta räknas från och med
  interest_ore       bigint not null default 0 check (interest_ore >= 0),
  write_off_invoice_id uuid,                   -- kreditfakturan som skrev av fordran
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  unique (case_id, invoice_id),
  foreign key (case_id, company_id) references collection_case(id, company_id) on delete cascade,
  foreign key (invoice_id, company_id) references invoice(id, company_id),
  foreign key (write_off_invoice_id, company_id) references invoice(id, company_id)
);
create unique index collection_case_invoice_one_active on collection_case_invoice (invoice_id) where active;

create table collection_case_event (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  case_id      uuid not null,
  event_date   date not null,
  kind         text not null,
  description  text not null,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  foreign key (case_id, company_id) references collection_case(id, company_id) on delete cascade
);

create index on payment_plan (customer_id);
create index on payment_plan_invoice (plan_id);
create index on payment_plan_installment (plan_id);
create index on collection_case (customer_id);
create index on collection_case_invoice (case_id);
create index on collection_case_event (case_id);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['late_interest_charge', 'payment_plan', 'payment_plan_invoice', 'payment_plan_installment',
                           'collection_case', 'collection_case_invoice', 'collection_case_event'] loop
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

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['collection.manage']
  when 'finance'     then array['collection.manage']
  else array[]::text[]
end) as p
on conflict do nothing;
