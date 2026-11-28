-- =====================================================================
-- 0010 Export till bokföringen med SIE-fil (SIE typ 4, verifikationer).
--
-- Systemet räknar fram bokföringshändelser ur det som redan finns:
-- avier, fakturor och kreditfakturor, inbetalningar och hur de fördelas,
-- återbetalningar, leverantörsfakturor och betalningar av dem. En export
-- gäller ett bolag och en valfri period (dag, vecka, månad ...) och
-- blir en SIE-fil som läses in i Hogia eller ett annat ekonomiprogram.
--
-- Varje händelse har en nyckel (till exempel invoice:<id>). Exporten
-- sparar vilka konteringar som skickades för varje nyckel. Det gör att
--  * samma händelse aldrig exporteras två gånger, och
--  * en händelse som ändrats eller tagits bort efter exporten (till
--    exempel en betalning som tagits bort) ger en rättelseverifikation
--    nästa gång i stället för att bokföringen blir fel.
-- Den senaste exporten kan ångras om filen inte gick att läsa in.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Inställningar per bolag
-- ---------------------------------------------------------------------

create table accounting_setting (
  company_id              uuid primary key references company(id),
  -- Verifikationsserie i ekonomiprogrammet
  series                  text not null default 'A' check (series ~ '^[A-Za-z0-9]{1,10}$'),
  -- Händelser före detta datum finns redan i bokföringen och exporteras aldrig
  start_date              date,
  -- Konton
  bank_account            text not null default '1930' check (bank_account ~ '^\d{4}$'),
  receivable_account      text not null default '1510' check (receivable_account ~ '^\d{4}$'),
  prepayment_account      text not null default '2420' check (prepayment_account ~ '^\d{4}$'),
  payable_account         text not null default '2440' check (payable_account ~ '^\d{4}$'),
  input_vat_account       text not null default '2640' check (input_vat_account ~ '^\d{4}$'),
  output_vat_25_account   text not null default '2610' check (output_vat_25_account ~ '^\d{4}$'),
  output_vat_12_account   text not null default '2620' check (output_vat_12_account ~ '^\d{4}$'),
  output_vat_6_account    text not null default '2630' check (output_vat_6_account ~ '^\d{4}$'),
  rounding_account        text not null default '3740' check (rounding_account ~ '^\d{4}$'),
  -- Kostnadsställe (dimension 1) och fastighet som projekt (dimension 6) på raderna
  include_dimensions      boolean not null default false,
  created_at              timestamptz not null default now(),
  created_by              uuid,
  updated_at              timestamptz not null default now(),
  updated_by              uuid
);

-- ---------------------------------------------------------------------
-- Gjorda exporter
-- ---------------------------------------------------------------------

create table sie_export (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company(id),
  export_nr         integer not null,
  period_from       date not null,
  period_to         date not null,
  series            text not null,
  voucher_count     integer not null default 0,
  correction_count  integer not null default 0,
  debit_ore         bigint not null default 0,
  filename          text not null,
  file              bytea not null,                 -- filen exakt som den laddades ned
  created_at        timestamptz not null default now(),
  created_by        uuid,
  unique (company_id, export_nr),
  unique (id, company_id),
  check (period_to >= period_from)
);

create table sie_export_item (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  sie_export_id   uuid not null,
  source_key      text not null,                    -- t.ex. invoice:<id>, payment:<id>, allocation:<id>
  kind            text not null check (kind in ('customer_invoice','payment','allocation','refund','supplier_invoice','supplier_payment')),
  event_date      date not null,                    -- händelsens bokföringsdag
  voucher_date    date not null,                    -- verifikationens datum i filen
  correction      boolean not null default false,
  text            text not null,
  -- Konteringen så som den ser ut efter exporten: [{account, amountOre, costCenter, property}].
  -- Tom lista = händelsen finns inte längre (allt har vänts).
  rows            jsonb not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  unique (sie_export_id, source_key),
  foreign key (sie_export_id, company_id) references sie_export(id, company_id) on delete cascade
);

create index on sie_export_item (company_id, source_key, created_at desc);
create index on sie_export (company_id, period_from);

-- ---------------------------------------------------------------------
-- Konton som exporten använder
-- ---------------------------------------------------------------------

insert into account (company_id, number, name, type, source)
select c.id, a.number, a.name, a.type, 'local'
from company c
cross join (values
  ('2420', 'Förskott från kunder', 'liability'),
  ('2620', 'Utgående moms 12 %', 'liability'),
  ('2630', 'Utgående moms 6 %', 'liability')
) as a(number, name, type)
on conflict (company_id, number) do nothing;

create or replace function app.seed_export_accounts() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into account (company_id, number, name, type, source)
  values (new.id, '2420', 'Förskott från kunder', 'liability', 'local'),
         (new.id, '2620', 'Utgående moms 12 %', 'liability', 'local'),
         (new.id, '2630', 'Utgående moms 6 %', 'liability', 'local')
  on conflict (company_id, number) do nothing;
  return null;
end $$;
create trigger company_seed_export_accounts after insert on company
  for each row execute function app.seed_export_accounts();

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['accounting_setting','sie_export','sie_export_item'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
  -- Exporterna loggas inte rad för rad (filen ligger i tabellen); de har skapad av och när
  foreach t in array array['accounting_setting'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
end $$;

-- En gjord export ändras aldrig, den kan bara ångras (tas bort)
revoke update on sie_export, sie_export_item from fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['accounting.export']
  when 'finance'     then array['accounting.export']
  else array[]::text[]
end) as p;
