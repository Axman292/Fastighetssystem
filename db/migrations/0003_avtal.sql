-- =====================================================================
-- 0003 Kunder (hyresgäster) och hyresavtal.
--
-- Ett avtal kan omfatta flera objekt (contract_object) och har debiteringsrader
-- med giltighetsperiod (contract_line). Ett objekt kan aldrig ingå i två
-- avtal med överlappande perioder. Objektens status (uthyrd, uppsagd,
-- ledig, kommande) räknas fram ur avtalen och lagras inte.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kunder
-- ---------------------------------------------------------------------

create table customer (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company(id),
  customer_nr          integer not null,
  kind                 text not null check (kind in ('person','organization')),
  name                 text collate sv not null,
  national_id          text,                       -- personnummer ÅÅÅÅMMDD-NNNN eller orgnr NNNNNN-NNNN
  vat_nr               text,
  email                text,
  phone                text,
  address_line         text,
  care_of              text,
  postal_code          text,
  city                 text,
  country              text not null default 'SE',
  invoice_address_line text,                       -- tomt = samma som postadress
  invoice_care_of      text,
  invoice_postal_code  text,
  invoice_city         text,
  invoice_reference    text,
  delivery_method      text not null default 'email' check (delivery_method in ('email','post','e_invoice')),
  peppol_id            text,
  payment_terms_days   smallint not null default 30 check (payment_terms_days between 0 and 120),
  notes                text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (company_id, customer_nr),
  unique (company_id, national_id),
  unique (id, company_id)
);

create table customer_contact (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  customer_id          uuid not null,
  name                 text not null,
  role                 text,
  email                text,
  phone                text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  foreign key (customer_id, company_id) references customer(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Konsumentprisindex (gemensamt för alla bolag)
-- ---------------------------------------------------------------------

create table kpi_value (
  year       smallint not null,
  month      smallint not null check (month between 1 and 12),
  value      numeric(8,2) not null check (value > 0),
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (year, month)
);

-- ---------------------------------------------------------------------
-- Avtal
-- ---------------------------------------------------------------------

create table contract (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  contract_nr          integer not null,
  type                 text not null check (type in ('residential','commercial','parking','storage','other')),
  customer_id          uuid not null,
  start_date           date not null,
  end_date             date,                        -- null = tills vidare
  notice_months        smallint not null default 3 check (notice_months between 0 and 60),
  extension_months     smallint check (extension_months between 0 and 120),
  billing_interval     text not null default 'month' check (billing_interval in ('month','quarter')),
  billing_in_advance   boolean not null default true,
  payment_terms_days   smallint check (payment_terms_days between 0 and 120),
  status               text not null default 'draft' check (status in ('draft','active','terminated','cancelled')),
  signed_date          date,
  termination_received date,
  terminated_by        text check (terminated_by in ('tenant','landlord','mutual')),
  termination_reason   text,
  renegotiate_by       date,                        -- påminnelse om omförhandling
  special_terms        text,                        -- särskilda villkor i avtalet
  notes                text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (company_id, contract_nr),
  unique (id, company_id),
  check (end_date is null or end_date >= start_date),
  foreign key (customer_id, company_id) references customer(id, company_id)
);

create table contract_object (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  contract_id   uuid not null,
  object_id     uuid not null,
  valid_from    date not null,
  valid_to      date,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  check (valid_to is null or valid_to >= valid_from),
  unique (contract_id, object_id),
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade,
  foreign key (object_id, company_id) references rental_object(id, company_id),
  -- Ett objekt kan inte hyras ut i två avtal samtidigt
  exclude using gist (object_id with =, daterange(valid_from, valid_to, '[]') with &&)
);

create table contract_line (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  contract_id      uuid not null,
  object_id        uuid,
  article          text not null check (article in ('rent','heating','electricity','water','parking','storage','service','index','discount','other')),
  description      text not null,
  amount_ore       bigint not null,                 -- per månad, exkl. moms; negativt för rabatt
  vat_rate_bp      integer not null default 0 check (vat_rate_bp in (0, 600, 1200, 2500)),
  indexed          boolean not null default false,
  base_amount_ore  bigint,                          -- bashyra för indexuppräkning
  valid_from       date not null,
  valid_to         date,
  reason           text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  check (valid_to is null or valid_to >= valid_from),
  check (not indexed or base_amount_ore is not null),
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade,
  foreign key (object_id, company_id) references rental_object(id, company_id)
);

create table contract_index_clause (
  contract_id      uuid primary key,
  company_id       uuid not null,
  base_year        smallint not null,               -- KPI-basmånad, normalt oktober året före avtalsstart
  base_month       smallint not null default 10 check (base_month between 1 and 12),
  base_value       numeric(8,2) not null check (base_value > 0),
  share_pct        numeric(5,2) not null default 100 check (share_pct between 0 and 100),
  floor_at_base    boolean not null default true,   -- hyran sänks aldrig under bashyran
  adjust_month     smallint not null default 1 check (adjust_month between 1 and 12),
  last_adjusted    date,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade
);

create table contract_deposit (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  contract_id      uuid not null,
  kind             text not null check (kind in ('deposit','bank_guarantee','surety','other')),
  amount_ore       bigint not null check (amount_ore >= 0),
  due_date         date,
  received_date    date,
  returned_date    date,
  note             text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade
);

create table contract_event (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  contract_id      uuid not null,
  kind             text not null,                   -- created, activated, terminated, extended, cancelled, index_adjusted, rent_changed, note
  event_date       date not null default current_date,
  description      text not null,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade
);

-- Bostäder ska alltid vara momsfria
create or replace function app.check_contract_line_vat() returns trigger
language plpgsql as $$
begin
  if new.vat_rate_bp > 0 and exists (select 1 from contract c where c.id = new.contract_id and c.type = 'residential') then
    raise exception 'Bostadsavtal kan inte ha moms' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger contract_line_vat_check before insert or update on contract_line
  for each row execute function app.check_contract_line_vat();

-- ---------------------------------------------------------------------
-- Objektstatus, framräknad ur avtalen
-- ---------------------------------------------------------------------

create view rental_object_status with (security_invoker = true) as
select o.id as object_id, o.company_id,
  cur.contract_id as current_contract_id,
  cur.valid_to as current_until,
  nxt.contract_id as next_contract_id,
  nxt.valid_from as next_from,
  case
    when not o.active then 'inactive'
    when cur.contract_id is not null and cur.status = 'terminated' then 'notice'
    when cur.contract_id is not null then 'occupied'
    when nxt.contract_id is not null then 'upcoming'
    else 'vacant'
  end as status
from rental_object o
left join lateral (
  select co.contract_id, co.valid_to, c.status from contract_object co join contract c on c.id = co.contract_id
  where co.object_id = o.id and c.status in ('active','terminated')
    and co.valid_from <= current_date and (co.valid_to is null or co.valid_to >= current_date)
  limit 1
) cur on true
left join lateral (
  select co.contract_id, co.valid_from from contract_object co join contract c on c.id = co.contract_id
  where co.object_id = o.id and c.status in ('active','terminated','draft') and co.valid_from > current_date
  order by co.valid_from limit 1
) nxt on true;

create index on customer (company_id, name);
create index on contract (customer_id);
create index on contract (company_id, status);
create index on contract_object (object_id);
create index on contract_line (contract_id, valid_from);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['customer','customer_contact','contract','contract_object','contract_line',
                           'contract_index_clause','contract_deposit','contract_event'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;

-- contract_index_clause saknar id; revisionsloggen använder contract_id
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
          coalesce(v_rec ->> 'id', v_rec ->> 'contract_id', v_rec ->> 'property_id'), lower(tg_op),
          v_old, v_new, nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

grant select on kpi_value to fastighet_app;
grant insert, update on kpi_value to fastighet_app;
grant select on rental_object_status to fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['customer.write','contract.write','contract.activate','index.write']
  when 'finance'     then array['customer.write','contract.write','contract.activate','index.write']
  when 'manager'     then array['customer.write','contract.write']
  else array[]::text[]
end) as p;
