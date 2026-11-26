-- =====================================================================
-- 0005 Importcentral för datamigrering från andra fastighetssystem.
--
-- En import (import_batch) består av uppladdade filer (import_file) som
-- tolkas till tabeller (import_table). Varje tabell mappas mot systemets
-- fält och blir poster (import_row) som kontrolleras innan något sparas.
--
-- external_ref kopplar originalsystemets id till vår egen stabila id, så
-- att samma import kan köras igen utan dubbletter. import_change sparar
-- varje rad som en import skapat eller ändrat, så att importen kan ångras.
--
-- Här finns också register som importen behöver och som inte fanns förut:
-- kontoplan (account), leverantörer (supplier), dokument (document) och
-- historiska verifikationer från det gamla systemet (legacy_voucher).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kontoplan, leverantörer, dokument och historiska verifikationer
-- ---------------------------------------------------------------------

create table account (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company(id),
  number      text not null check (number ~ '^\d{4}$'),   -- BAS-konto
  name        text collate sv not null,
  type        text not null check (type in ('asset','liability','equity','revenue','expense')),
  vat_code    text,
  sru_code    text,
  active      boolean not null default true,
  source      text not null default 'local' check (source in ('hogia','local','import')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (company_id, number),
  unique (id, company_id)
);

create table supplier (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company(id),
  supplier_nr         integer not null,
  name                text collate sv not null,
  org_nr              text,
  vat_nr              text,
  bankgiro            text,
  plusgiro            text,
  iban                text,
  email               text,
  phone               text,
  address_line        text,
  postal_code         text,
  city                text,
  payment_terms_days  smallint not null default 30 check (payment_terms_days between 0 and 365),
  default_account     text check (default_account ~ '^\d{4}$'),
  notes               text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  unique (company_id, supplier_nr),
  unique (company_id, org_nr),
  unique (id, company_id)
);

-- Dokument och avtalsbilagor. Innehållet ligger i en egen tabell så att
-- revisionsloggen inte fylls med filinnehåll.
create table document (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  kind          text not null default 'attachment',   -- contract, attachment, invoice_pdf ...
  file_name     text not null,
  mime_type     text not null,
  sha256        text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  entity_type   text check (entity_type in ('property','rental_object','customer','contract','supplier')),
  entity_id     uuid,
  description   text,
  retain_until  date,                                 -- bokföringslagen: minst 7 år
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  unique (id, company_id),
  check ((entity_type is null) = (entity_id is null))
);

create table document_content (
  id            uuid primary key default gen_random_uuid(),   -- samma som document.id
  company_id    uuid not null,
  content       bytea not null,
  foreign key (id, company_id) references document(id, company_id) on delete cascade
);

-- Verifikationer från tidigare bokföring. Endast arkiv, de skickas aldrig till Hogia.
create table legacy_voucher (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company(id),
  source_system  text not null,
  series         text not null,
  voucher_nr     text not null,
  voucher_date   date not null,
  description    text,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  unique (company_id, source_system, series, voucher_nr, voucher_date),
  unique (id, company_id)
);

create table legacy_voucher_line (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  voucher_id     uuid not null,
  line_nr        integer not null,
  account_number text not null check (account_number ~ '^\d{4}$'),
  amount_ore     bigint not null,                    -- debet positivt, kredit negativt
  cost_center    text,
  object_code    text,
  description    text,
  transaction_date date,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  foreign key (voucher_id, company_id) references legacy_voucher(id, company_id) on delete cascade
);

create index on document (entity_type, entity_id);
create index on legacy_voucher (company_id, voucher_date);
create index on legacy_voucher_line (voucher_id);
create index on legacy_voucher_line (company_id, account_number);

-- ---------------------------------------------------------------------
-- Importcentral
-- ---------------------------------------------------------------------

create table import_batch (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company(id),
  batch_nr            integer not null,
  name                text not null,
  source_system       text not null,                    -- dinhyresvard, generic ...
  status              text not null default 'draft'
                        check (status in ('draft','validated','tested','committed','rolled_back')),
  default_property_id uuid,
  -- Kontrollsummor från originalsystemet som användaren fyller i, för jämförelse
  control_totals      jsonb not null default '{}',
  validation          jsonb,                            -- sammanfattning av senaste kontroll
  test_result         jsonb,
  reconciliation      jsonb,                            -- avstämning efter skarp import
  validated_at        timestamptz,
  tested_at           timestamptz,
  committed_at        timestamptz,
  committed_by        uuid,
  rolled_back_at      timestamptz,
  rolled_back_by      uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  unique (company_id, batch_nr),
  unique (id, company_id),
  foreign key (default_property_id, company_id) references property(id, company_id)
);

create table import_file (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  batch_id      uuid not null,
  file_name     text not null,
  format        text not null check (format in ('xlsx','csv','xml','sie','pdf','document')),
  mime_type     text,
  size_bytes    bigint not null,
  sha256        text not null,
  content       bytea not null,
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (id, company_id),
  unique (batch_id, sha256),                            -- samma fil två gånger i samma import
  foreign key (batch_id, company_id) references import_batch(id, company_id) on delete cascade
);

create table import_table (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  batch_id      uuid not null,
  file_id       uuid not null,
  name          text not null,                          -- flik eller tabell i filen
  profile       text not null,                          -- vad tabellen innehåller, t.ex. dhv_residential
  headers       jsonb not null,
  data          jsonb not null,                         -- rader som listor av värden
  mapping       jsonb not null default '{}',            -- systemfält -> kolumnrubrik
  source_totals jsonb not null default '{}',            -- summor räknade ur filen
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, company_id),
  foreign key (file_id, company_id) references import_file(id, company_id) on delete cascade
);

create table import_row (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  batch_id      uuid not null,
  table_id      uuid,
  file_id       uuid,
  source_row    integer,                                -- radnummer i filen
  entity        text not null,
  record_key    text not null,                          -- originalsystemets id eller härledd nyckel
  label         text not null,
  data          jsonb not null,
  status        text not null check (status in ('new','update','unchanged','link','error','skipped')),
  issues        jsonb not null default '[]',
  changes       jsonb not null default '[]',            -- fält som skiljer mot befintlig post
  target_id     uuid,                                   -- befintlig eller skapad post
  created_at    timestamptz not null default now(),
  unique (batch_id, entity, record_key),
  foreign key (batch_id, company_id) references import_batch(id, company_id) on delete cascade
);

-- Användarens beslut per post: godkänn överskrivning, hoppa över, koppla till fastighet.
-- Beslut ligger kvar när importen kontrolleras på nytt.
create table import_decision (
  batch_id      uuid not null,
  company_id    uuid not null,
  entity        text not null,
  record_key    text not null,
  approve_update boolean not null default false,
  skip          boolean not null default false,
  overrides     jsonb not null default '{}',
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  primary key (batch_id, entity, record_key),
  foreign key (batch_id, company_id) references import_batch(id, company_id) on delete cascade
);

-- Originalsystemets id per post. Gör att en import kan köras om utan dubbletter.
create table external_ref (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company(id),
  source_system  text not null,
  entity         text not null,
  external_id    text not null,
  internal_id    uuid not null,
  batch_id       uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  unique (company_id, source_system, entity, external_id)
);
create index on external_ref (entity, internal_id);

-- Varje rad en import har skapat eller ändrat, i ordning. Används för att ångra.
create table import_change (
  id            bigint generated always as identity primary key,
  company_id    uuid not null,
  batch_id      uuid not null,
  table_name    text not null,
  row_id        uuid not null,
  action        text not null check (action in ('insert','update')),
  before        jsonb,
  created_at    timestamptz not null default now(),
  foreign key (batch_id, company_id) references import_batch(id, company_id)
);
create index on import_change (batch_id, id);

create table import_event (
  id            bigint generated always as identity primary key,
  company_id    uuid not null,
  batch_id      uuid not null,
  kind          text not null,                          -- created, file_added, mapped, validated, tested, committed, rolled_back ...
  message       text not null,
  details       jsonb,
  user_id       uuid,
  created_at    timestamptz not null default now(),
  foreign key (batch_id, company_id) references import_batch(id, company_id) on delete cascade
);
create index on import_event (batch_id, id);
create index on import_row (batch_id, entity, status);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['account','supplier','document','document_content','legacy_voucher','legacy_voucher_line',
                           'import_batch','import_file','import_table','import_row','import_decision',
                           'external_ref','import_change','import_event'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
  end loop;
  -- Revisionslogg för register och importens livscykel. Filinnehåll, tolkade rader
  -- och ändringslistan loggas inte (de är stora och finns redan i importen).
  foreach t in array array['account','supplier','document','legacy_voucher','legacy_voucher_line',
                           'import_batch','external_ref'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
  foreach t in array array['account','supplier','document','legacy_voucher','legacy_voucher_line','import_batch','external_ref'] loop
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Historiska fakturor som importerats är utfärdade och därmed låsta.
-- Enda undantaget: när just den import som skapade dem ångras.
-- ---------------------------------------------------------------------

create or replace function app.import_rollback_allows(p_table text, p_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('app.import_rollback', true), '') <> ''
     and exists (select 1 from import_change c
                 where c.batch_id = nullif(current_setting('app.import_rollback', true), '')::uuid
                   and c.table_name = p_table and c.row_id = p_id and c.action = 'insert')
$$;

create or replace function app.invoice_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and not app.import_rollback_allows('invoice', old.id) then
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

create or replace function app.invoice_line_immutable() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  if tg_op = 'DELETE' and app.import_rollback_allows('invoice_line', old.id) then
    return old;
  end if;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Raderna på en utfärdad faktura kan inte ändras' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;

-- Ändringslistan får aldrig ändras i efterhand
revoke update, delete on import_change from fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['import.manage','account.write','supplier.write','document.write']
  when 'finance'     then array['import.manage','account.write','supplier.write','document.write']
  when 'manager'     then array['supplier.write','document.write']
  else array[]::text[]
end) as p;
