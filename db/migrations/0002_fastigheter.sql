-- =====================================================================
-- 0002 Fastighetsregister och hyresobjekt.
--
-- Barntabeller har både company_id och en sammansatt främmande nyckel
-- (förälder_id, company_id), så att en rad aldrig kan hamna i ett annat
-- bolag än fastigheten den hör till.
-- Hyra och momsstatus lagras med giltighetsperiod och får inte överlappa.
-- Belopp lagras i öre (bigint), värden från taxering och värdering i kronor.
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Fastigheter
-- ---------------------------------------------------------------------

create table property (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company(id),
  name                 text collate sv not null,
  designation          text not null,
  municipality         text,
  address_line         text,
  postal_code          text,
  city                 text,
  category             text not null check (category in ('residential','commercial','mixed','parking','hotel','industrial','land','other')),
  construction_year    smallint check (construction_year between 1000 and 2200),
  area_boa_m2          numeric(10,1) check (area_boa_m2 >= 0),
  area_loa_m2          numeric(10,1) check (area_loa_m2 >= 0),
  area_bta_m2          numeric(10,1) check (area_bta_m2 >= 0),
  site_area_m2         numeric(12,1) check (site_area_m2 >= 0),
  cost_center_id       uuid,
  acquired_date        date,
  acquisition_price_sek bigint,
  sold_date            date,
  notes                text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (company_id, designation),
  unique (id, company_id),
  foreign key (cost_center_id) references cost_center(id)
);

create table building (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  name                 text collate sv not null,
  address_line         text,
  construction_year    smallint,
  energy_class         text check (energy_class in ('A','B','C','D','E','F','G')),
  floors               smallint,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (id, company_id),
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table property_tax_assessment (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  assessment_year      smallint not null,
  type_code            text,
  land_value_sek       bigint,
  building_value_sek   bigint,
  property_tax_ore     bigint,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (property_id, assessment_year),
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table property_insurance (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  insurer              text not null,
  policy_nr            text,
  sum_insured_sek      bigint,
  premium_ore          bigint,
  valid_from           date not null,
  valid_to             date,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  check (valid_to is null or valid_to >= valid_from),
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table property_valuation (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  valuation_date       date not null,
  value_sek            bigint not null check (value_sek >= 0),
  valuer               text,
  method               text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table property_loan (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  lender               text not null,
  loan_nr              text,
  principal_ore        bigint not null check (principal_ore >= 0),
  interest_bp          integer check (interest_bp between 0 and 10000),
  fixed_until          date,
  amortization_ore_per_year bigint,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table property_technical (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null unique,
  heating              text,
  ventilation          text,
  elevators            smallint,
  ovk_date             date,
  energy_declaration_date date,
  energy_use_kwh_m2    numeric(8,1),
  notes                text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

create table maintenance_plan_item (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  component            text not null,
  planned_year         smallint not null,
  estimated_cost_ore   bigint,
  status               text not null default 'planned' check (status in ('planned','ordered','done','postponed')),
  notes                text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Hyresobjekt
-- ---------------------------------------------------------------------

create table rental_object (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  property_id          uuid not null,
  building_id          uuid,
  object_nr            text not null,
  type                 text not null check (type in ('apartment','commercial','office','restaurant','parking','storage','hotel_room','hotel_apartment','other')),
  area_m2              numeric(10,1) check (area_m2 >= 0),
  rooms                numeric(3,1) check (rooms >= 0),
  floor                smallint,
  apartment_nr         text,
  address_line         text,
  description          text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (company_id, object_nr),
  unique (id, company_id),
  foreign key (property_id, company_id) references property(id, company_id),
  foreign key (building_id, company_id) references building(id, company_id)
);

create table rental_object_price (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  object_id            uuid not null,
  monthly_rent_ore     bigint not null check (monthly_rent_ore >= 0),
  valid_from           date not null,
  valid_to             date,
  reason               text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  check (valid_to is null or valid_to >= valid_from),
  foreign key (object_id, company_id) references rental_object(id, company_id) on delete cascade,
  exclude using gist (object_id with =, daterange(valid_from, valid_to, '[]') with &&)
);

create table rental_object_vat (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  object_id            uuid not null,
  vat_liable           boolean not null,
  valid_from           date not null,
  valid_to             date,
  note                 text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  check (valid_to is null or valid_to >= valid_from),
  foreign key (object_id, company_id) references rental_object(id, company_id) on delete cascade,
  exclude using gist (object_id with =, daterange(valid_from, valid_to, '[]') with &&)
);

-- Bostäder får aldrig vara momspliktiga (uthyrning av bostad är momsfri).
create or replace function app.check_object_vat() returns trigger
language plpgsql as $$
begin
  if new.vat_liable and exists (
    select 1 from rental_object o where o.id = new.object_id and o.type in ('apartment','hotel_apartment')
  ) then
    raise exception 'Bostäder kan inte vara momspliktiga' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger rental_object_vat_check before insert or update on rental_object_vat
  for each row execute function app.check_object_vat();

-- Aktuell hyra och momsstatus per objekt
create view rental_object_current with (security_invoker = true) as
select o.id as object_id, o.company_id,
  (select p.monthly_rent_ore from rental_object_price p
    where p.object_id = o.id and p.valid_from <= current_date and (p.valid_to is null or p.valid_to >= current_date)
    order by p.valid_from desc limit 1) as monthly_rent_ore,
  (select v.vat_liable from rental_object_vat v
    where v.object_id = o.id and v.valid_from <= current_date and (v.valid_to is null or v.valid_to >= current_date)
    order by v.valid_from desc limit 1) as vat_liable
from rental_object o;

create index on property (company_id);
create index on building (property_id);
create index on rental_object (property_id);
create index on rental_object_price (object_id, valid_from desc);
create index on rental_object_vat (object_id, valid_from desc);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['property','building','property_tax_assessment','property_insurance','property_valuation',
                           'property_loan','property_technical','maintenance_plan_item','rental_object',
                           'rental_object_price','rental_object_vat'] loop
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

grant select on rental_object_current to fastighet_app;

-- Nya rättigheter
insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['property.write','property.import']
  when 'manager'     then array['property.write','property.import']
  when 'finance'     then array['property.write']
  else array[]::text[]
end) as p;
