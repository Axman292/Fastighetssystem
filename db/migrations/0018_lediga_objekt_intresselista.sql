-- =====================================================================
-- 0018 Lediga objekt och intresselista.
--
-- Intresseanmälningar från personer och företag som vill hyra. En
-- anmälan kommer från det publika formuläret (med samtycke) eller läggs
-- in för hand. Anmälan kan matchas mot lediga objekt (erbjudanden) och
-- till sist bli en hyresgäst med ett avtalsutkast.
--
-- Vakansöversikten räknas fram ur avtalen och behöver inga egna tabeller.
-- =====================================================================

-- Inställningar för det publika formuläret, en rad per bolag
create table interest_setting (
  company_id         uuid primary key references company(id),
  form_enabled       boolean not null default false,
  public_key         text not null unique default encode(gen_random_bytes(9), 'hex'),
  intro_text         text,
  consent_text       text not null default
    'Jag samtycker till att mina uppgifter sparas i bolagets intresselista för att jag ska kunna erbjudas en bostad eller lokal. Uppgifterna sparas så länge anmälan är aktuell och tas bort senast 12 månader efter senaste kontakt. Jag kan när som helst återkalla mitt samtycke och be att uppgifterna tas bort.',
  retention_months   integer not null default 12 check (retention_months between 1 and 120),
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

create table interest_registration (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company(id),
  registration_nr    integer not null,
  kind               text not null default 'person' check (kind in ('person','organization')),
  name               text not null,
  contact_person     text,                          -- för företag
  email              text,
  phone              text,
  address_line       text,
  postal_code        text,
  city               text,
  -- Önskemål. Tomma listor betyder "vad som helst".
  object_types       text[] not null default '{}',
  property_ids       uuid[] not null default '{}',
  min_rooms          numeric(4,1),
  min_area_m2        numeric(10,2),
  max_rent_ore       bigint,
  desired_from       date,
  household_size     integer,
  message            text,                          -- det den som anmält skrev
  notes              text,                          -- interna anteckningar
  source             text not null default 'manual' check (source in ('form','manual')),
  status             text not null default 'new'
                       check (status in ('new','contacted','offered','converted','declined','withdrawn')),
  consent_at         timestamptz,
  consent_text       text,
  customer_id        uuid references customer(id) on delete set null,
  contract_id        uuid references contract(id) on delete set null,
  last_activity_at   timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (company_id, registration_nr),
  unique (id, company_id),
  check (email is not null or phone is not null),
  check (source <> 'form' or consent_at is not null)
);

-- Ett objekt som föreslagits eller erbjudits en intressent
create table interest_offer (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  registration_id    uuid not null,
  object_id          uuid not null references rental_object(id) on delete cascade,
  status             text not null default 'offered' check (status in ('offered','accepted','declined')),
  note               text,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (registration_id, object_id),
  foreign key (registration_id, company_id) references interest_registration(id, company_id) on delete cascade
);

create index on interest_registration (company_id, status, created_at);
create index on interest_registration (customer_id);
create index on interest_offer (object_id);

do $$
declare t text;
begin
  foreach t in array array['interest_setting','interest_registration','interest_offer'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
  foreach t in array array['interest_registration','interest_offer'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
end $$;

-- Gallring av intresselistan loggas som en egen sorts post
alter table gdpr_log drop constraint gdpr_log_kind_check;
alter table gdpr_log add constraint gdpr_log_kind_check
  check (kind in ('anonymize','accounting','import','extract','interest'));
alter table gdpr_run add column interest_count integer not null default 0;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['interest.manage']
  when 'finance'     then array['interest.manage']
  when 'manager'     then array['interest.manage']
  else array[]::text[]
end) as p
on conflict do nothing;
