-- =====================================================================
-- 0015 GDPR: gallring av tidigare hyresgästers personuppgifter.
--
-- Två steg per kund:
--  1. Anonymisering. När hyresgästen har flyttat, allt är betalt och
--     lagringstiden (standard 24 månader) har gått tas namn, person-
--     nummer, kontaktuppgifter, adresser, anteckningar, kontaktpersoner
--     och dokument bort. Kunden ligger kvar som "Anonymiserad kund 1042"
--     så att avtal, fakturor och bokföring hänger ihop.
--  2. Bokföringsunderlag. Fakturor, inbetalningar och påminnelser är
--     räkenskapsinformation och sparas i sju år efter utgången av det
--     kalenderår då räkenskapsåret avslutades (bokföringslagen 7 kap.).
--     Därefter rensas namn och adress även där.
--
-- Importfiler (som innehåller hela kundregister) rensas efter en egen
-- lagringstid. Revisionsloggen maskeras för de rader som gallras, så
-- att personuppgifterna inte finns kvar i historiken.
-- Loggen över gallringar innehåller aldrig personuppgifter.
-- =====================================================================

create table gdpr_setting (
  company_id               uuid primary key references company(id),
  auto_enabled             boolean not null default false,
  retention_months         smallint not null default 24 check (retention_months between 6 and 120),
  bookkeeping_years        smallint not null default 7 check (bookkeeping_years between 7 and 20),
  import_retention_months  smallint not null default 12 check (import_retention_months between 1 and 120),
  include_organizations    boolean not null default false,
  last_auto_run_at         timestamptz,
  created_at               timestamptz not null default now(),
  created_by               uuid,
  updated_at               timestamptz not null default now(),
  updated_by               uuid
);

alter table customer add column anonymized_at timestamptz;
alter table customer add column accounting_purged_at timestamptz;
alter table import_batch add column purged_at timestamptz;

create table gdpr_run (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company(id),
  run_nr             integer not null,
  trigger            text not null check (trigger in ('manual','auto','request')),
  anonymized_count   integer not null default 0,
  accounting_count   integer not null default 0,
  import_count       integer not null default 0,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  unique (company_id, run_nr),
  unique (id, company_id)
);

-- En rad per kund eller import som gallrats, och per registerutdrag.
-- Bara kundnummer och antal, aldrig namn eller personnummer.
create table gdpr_log (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company(id),
  run_id             uuid,
  kind               text not null check (kind in ('anonymize','accounting','import','extract')),
  customer_id        uuid,
  customer_nr        integer,
  import_batch_id    uuid,
  details            jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  created_by         uuid,
  foreign key (run_id, company_id) references gdpr_run(id, company_id) on delete cascade
);
create index on gdpr_log (company_id, created_at desc);
create index on gdpr_log (customer_id);

-- ---------------------------------------------------------------------
-- Maskering i revisionsloggen (appen får annars bara läsa den)
-- ---------------------------------------------------------------------

create or replace function app.gdpr_mask(j jsonb, keys text[]) returns jsonb
language sql immutable as $$
  select case when j is null then null else
    j || coalesce((select jsonb_object_agg(k, to_jsonb('[gallrad]'::text))
                   from unnest(keys) k where j ? k and j -> k <> 'null'::jsonb), '{}'::jsonb)
  end
$$;

create or replace function app.gdpr_scrub_audit(p_company uuid, p_table text, p_ids text[], p_keys text[]) returns integer
language plpgsql security definer set search_path = public, app as $$
declare n integer;
begin
  if not (p_company = any (app.allowed_companies())) then
    raise exception 'Bolaget är inte valt' using errcode = '42501';
  end if;
  update audit_log
     set before = app.gdpr_mask(before, p_keys),
         after  = app.gdpr_mask(after, p_keys)
   where company_id = p_company and table_name = p_table and row_id = any (p_ids)
     and (coalesce(before ?| p_keys, false) or coalesce(after ?| p_keys, false));
  get diagnostics n = row_count;
  -- Importens ångra-logg sparar också hur posterna såg ut före importen
  update import_change
     set before = app.gdpr_mask(before, p_keys)
   where company_id = p_company and table_name = p_table and row_id::text = any (p_ids)
     and coalesce(before ?| p_keys, false);
  return n;
end $$;

-- En gallrad import kan inte ångras; ångra-loggen behövs inte längre
create or replace function app.gdpr_clear_import_changes(p_company uuid, p_batch uuid) returns integer
language plpgsql security definer set search_path = public, app as $$
declare n integer;
begin
  if not (p_company = any (app.allowed_companies())) then
    raise exception 'Bolaget är inte valt' using errcode = '42501';
  end if;
  if not exists (select 1 from import_batch where id = p_batch and company_id = p_company and purged_at is not null) then
    raise exception 'Importen är inte gallrad' using errcode = '23514';
  end if;
  update import_change set before = null where company_id = p_company and batch_id = p_batch and before is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Utfärdade fakturor är låsta. Efter bokföringstiden får mottagaren på
-- fakturan (bill_to) och er referens ersättas, inget annat.
create or replace function app.gdpr_clear_invoice_recipient(p_company uuid, p_customer uuid, p_label text) returns integer
language plpgsql security definer set search_path = public, app as $$
declare n integer;
begin
  if not (p_company = any (app.allowed_companies())) then
    raise exception 'Bolaget är inte valt' using errcode = '42501';
  end if;
  if not exists (select 1 from customer where id = p_customer and company_id = p_company and anonymized_at is not null) then
    raise exception 'Kunden måste vara anonymiserad först' using errcode = '23514';
  end if;
  alter table invoice disable trigger invoice_immutable;
  update invoice
     set bill_to = jsonb_build_object('name', p_label), your_reference = null
   where company_id = p_company and customer_id = p_customer
     and (bill_to <> jsonb_build_object('name', p_label) or your_reference is not null);
  get diagnostics n = row_count;
  alter table invoice enable trigger invoice_immutable;
  return n;
end $$;

revoke all on function app.gdpr_scrub_audit(uuid, text, text[], text[]) from public;
revoke all on function app.gdpr_clear_invoice_recipient(uuid, uuid, text) from public;
revoke all on function app.gdpr_clear_import_changes(uuid, uuid) from public;
grant execute on function app.gdpr_clear_import_changes(uuid, uuid) to fastighet_app;
grant execute on function app.gdpr_scrub_audit(uuid, text, text[], text[]) to fastighet_app;
grant execute on function app.gdpr_clear_invoice_recipient(uuid, uuid, text) to fastighet_app;

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['gdpr_setting','gdpr_run','gdpr_log'] loop
    execute format('grant select, insert, update on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;
create trigger gdpr_setting_audit after insert or update or delete on gdpr_setting
  for each row execute function app.audit();

-- Gallringsloggen ändras aldrig i efterhand
revoke update on gdpr_run, gdpr_log from fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['gdpr.manage','gdpr.extract']
  when 'finance'     then array['gdpr.manage','gdpr.extract']
  when 'manager'     then array['gdpr.extract']
  else array[]::text[]
end) as p
on conflict do nothing;
