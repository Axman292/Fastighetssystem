-- =====================================================================
-- 0001 Grund: koncern, bolag, användare, roller, sessioner,
-- bankkonton, kostnadsställen, revisionslogg och radnivåsäkerhet.
--
-- Applikationen kör varje anrop i en transaktion som:
--   set local role fastighet_app;
--   set_config('app.user_id', ..., true)
--   set_config('app.group_id', ..., true)
--   set_config('app.company_ids', '{...}', true)
-- Rollen fastighet_app äger inga tabeller och omfattas därför av RLS.
-- =====================================================================

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fastighet_app') then
    create role fastighet_app nologin;
  end if;
end $$;

-- Den som kör migreringarna (och appens inloggning) ska kunna byta till rollen.
do $$ begin execute format('grant fastighet_app to %I', current_user); end $$;

create schema if not exists app;

-- Svensk sortering (å, ä, ö sist, versaler och gemener tillsammans)
create collation if not exists sv (provider = icu, locale = 'sv-SE');
grant usage on schema app to fastighet_app;

create or replace function app.current_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.current_group_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.group_id', true), '')::uuid $$;

create or replace function app.allowed_companies() returns uuid[]
language sql stable as $$
  select coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[], '{}'::uuid[])
$$;

-- ---------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------

create table company_group (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table company (
  id                   uuid primary key default gen_random_uuid(),
  group_id             uuid not null references company_group(id),
  name                 text collate sv not null,
  org_nr               text not null unique check (org_nr ~ '^\d{6}-\d{4}$'),
  vat_nr               text,
  address_line         text,
  postal_code          text,
  city                 text,
  bankgiro             text,
  plusgiro             text,
  fiscal_year_start    smallint not null default 1 check (fiscal_year_start between 1 and 12),
  hogia_client_id      text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);

create table app_user (
  id                   uuid primary key default gen_random_uuid(),
  group_id             uuid not null references company_group(id),
  email                text not null unique,
  name                 text collate sv not null,
  password_hash        text,                      -- null när endast BankID används
  personal_id_hash     text unique,               -- hash av personnummer från BankID
  is_group_admin       boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create table role (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  description text
);

create table role_permission (
  role_id     uuid not null references role(id) on delete cascade,
  permission  text not null,
  primary key (role_id, permission)
);

create table membership (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company(id),
  user_id     uuid not null references app_user(id),
  role_id     uuid not null references role(id),
  valid_until date,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  unique (user_id, company_id)
);

create table user_session (
  token_hash   text primary key,                  -- sha256 av cookie-värdet
  user_id      uuid not null references app_user(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           inet,
  user_agent   text
);
create index on user_session (user_id);

-- ---------------------------------------------------------------------
-- Bolagsdata som används redan i fas 1
-- ---------------------------------------------------------------------

create table bank_account (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company(id),
  purpose      text not null check (purpose in ('rent','operations','loan','deposit','other')),
  bank_name    text,
  clearing_nr  text,
  account_nr   text,
  iban         text,
  bic          text,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

create table cost_center (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company(id),
  code        text not null,
  name        text collate sv not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (company_id, code)
);

-- ---------------------------------------------------------------------
-- Revisionslogg
-- ---------------------------------------------------------------------

create table audit_log (
  id           bigint generated always as identity,
  occurred_at  timestamptz not null default now(),
  user_id      uuid,
  company_id   uuid,
  table_name   text not null,
  row_id       text not null,
  action       text not null,
  before       jsonb,
  after        jsonb,
  request_id   text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table audit_log_default partition of audit_log default;
create index on audit_log (company_id, occurred_at desc);
create index on audit_log (table_name, row_id);

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
  -- lösenord och liknande loggas aldrig
  v_old := v_old - 'password_hash';
  v_new := v_new - 'password_hash';
  insert into audit_log (user_id, company_id, table_name, row_id, action, before, after, request_id)
  values (app.current_user_id(), v_company, tg_table_name, v_rec ->> 'id', lower(tg_op),
          v_old, v_new, nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

-- Sätt updated_at/updated_by och created_by automatiskt
create or replace function app.stamp() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if (to_jsonb(new) ? 'created_by') and new.created_by is null then
      new.created_by := app.current_user_id();
    end if;
  end if;
  if (to_jsonb(new) ? 'updated_at') then
    new.updated_at := now();
    new.updated_by := app.current_user_id();
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Rättigheter och RLS
-- ---------------------------------------------------------------------

grant select on company_group, role, role_permission to fastighet_app;
grant select, insert, update on company, app_user, membership, bank_account, cost_center to fastighet_app;
grant delete on membership, bank_account, cost_center to fastighet_app;
grant select on audit_log to fastighet_app;

-- Bolagsdata: filtreras på company_id
do $$
declare t text;
begin
  foreach t in array array['bank_account', 'cost_center', 'membership'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
  end loop;
  foreach t in array array['company', 'app_user', 'membership', 'bank_account', 'cost_center'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
  foreach t in array array['company', 'bank_account', 'cost_center', 'membership'] loop
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;

-- Bolag: läsa och ändra de tillåtna, skapa nya inom den egna koncernen
alter table company enable row level security;
create policy company_read on company for select using (id = any (app.allowed_companies()));
create policy company_update on company for update
  using (id = any (app.allowed_companies())) with check (id = any (app.allowed_companies()));
create policy company_insert on company for insert with check (group_id = app.current_group_id());

-- Användare: synliga inom den egna koncernen
alter table app_user enable row level security;
create policy user_same_group on app_user using (group_id = app.current_group_id())
  with check (group_id = app.current_group_id());

-- Revisionslogg: endast tillåtna bolag
alter table audit_log enable row level security;
create policy audit_read on audit_log for select using (company_id = any (app.allowed_companies()));

-- ---------------------------------------------------------------------
-- Standardroller
-- ---------------------------------------------------------------------

insert into role (key, name, description) values
  ('group_admin', 'Koncernadministratör', 'Allt i bolaget, hantera användare och bolag'),
  ('finance',     'Ekonomiansvarig',      'Avisering, fakturor, betalningar, Hogia-export'),
  ('manager',     'Förvaltare',           'Fastigheter, objekt, kunder och avtal'),
  ('approver',    'Attestant',            'Attestera leverantörsfakturor'),
  ('reader',      'Läsbehörig',           'Läsa allt, inga ändringar'),
  ('auditor',     'Revisor',              'Läsa allt inklusive revisionslogg');

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['company.read','company.write','user.manage','bank_account.write','cost_center.write','audit.read']
  when 'finance'     then array['company.read','bank_account.write','cost_center.write','audit.read']
  when 'manager'     then array['company.read','cost_center.write']
  when 'approver'    then array['company.read']
  when 'reader'      then array['company.read']
  when 'auditor'     then array['company.read','audit.read']
end) as p;
