-- =====================================================================
-- 0020 Felanmälan och ärenden.
--
--  * Ett felanmälningsformulär per fastighet som hyresgästen når via en
--    länk eller QR-kod utan att logga in. Länken är en slumpad nyckel.
--  * Ärenden (arbetsordrar) med status, prioritet, ansvarig, hantverkare
--    (leverantör), händelser och kommentarer, bilder och kostnader.
--  * Anmälaren kan följa sitt ärende och hantverkaren kan kvittera
--    arbetsordern via egna slumpade länkar, utan inloggning.
--  * Leverantörsfakturor kan kopplas till ärendet som kostnad.
--
-- Personuppgifter (anmälarens namn, e-post, telefon) gallras av GDPR-
-- gallringen tillsammans med hyresgästen, eller efter lagringstiden när
-- ärendet är avslutat.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Inställningar per bolag
-- ---------------------------------------------------------------------

create table work_order_setting (
  company_id        uuid primary key references company(id),
  -- Kommaseparerade adresser som får besked om nya felanmälningar
  notify_emails     text,
  -- Skicka kvittens med ärendenummer och statuslänk till anmälaren
  confirm_reporter  boolean not null default true,
  -- Text överst i formuläret, t.ex. "Vid akuta fel efter kl. 16, ring jouren 040-..."
  form_intro        text check (length(form_intro) <= 2000),
  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

-- ---------------------------------------------------------------------
-- Felanmälningsformulär per fastighet
-- ---------------------------------------------------------------------

create table fault_form (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null,
  property_id              uuid not null,
  token                    text not null unique check (token ~ '^[A-Za-z0-9_-]{20,64}$'),
  enabled                  boolean not null default true,
  default_assignee_user_id uuid references app_user(id),
  created_at               timestamptz not null default now(),
  created_by               uuid,
  updated_at               timestamptz not null default now(),
  updated_by               uuid,
  unique (company_id, property_id),
  unique (id, company_id),
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Ärenden
-- ---------------------------------------------------------------------

create table work_order (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company(id),
  order_nr             integer not null,
  -- form = felanmälningsformuläret, manual = registrerat av personalen
  source               text not null default 'manual' check (source in ('form', 'manual', 'phone', 'email', 'inspection')),
  property_id          uuid not null,
  object_id            uuid,
  customer_id          uuid,
  title                text not null check (length(title) between 1 and 200),
  description          text check (length(description) <= 5000),
  category             text not null default 'other'
                       check (category in ('plumbing', 'electric', 'appliance', 'heating', 'ventilation', 'lock', 'windows',
                                           'surfaces', 'pests', 'laundry', 'outdoor', 'cleaning', 'parking', 'other')),
  location             text check (length(location) <= 200),
  priority             text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  -- new = ny, assigned = skickad till hantverkare, in_progress = pågår, waiting = väntar (material, hyresgäst),
  -- done = åtgärdad, closed = avslutad, cancelled = makulerad
  status               text not null default 'new'
                       check (status in ('new', 'assigned', 'in_progress', 'waiting', 'done', 'closed', 'cancelled')),
  reporter_name        text check (length(reporter_name) <= 200),
  reporter_email       text check (length(reporter_email) <= 200),
  reporter_phone       text check (length(reporter_phone) <= 50),
  -- Hyresgästen godkänner att man går in med huvudnyckel
  master_key_ok        boolean not null default false,
  access_note          text check (length(access_note) <= 1000),
  notify_reporter      boolean not null default true,
  assignee_user_id     uuid references app_user(id),
  supplier_id          uuid,
  due_date             date,
  scheduled_date       date,
  cost_estimate_ore    bigint check (cost_estimate_ore >= 0),
  -- Kostnaden ska vidaredebiteras hyresgästen (t.ex. skada)
  chargeable           boolean not null default false,
  resolution           text check (length(resolution) <= 5000),
  sent_to_supplier_at  timestamptz,
  done_at              timestamptz,
  closed_at            timestamptz,
  -- Slumpade nycklar för anmälarens statussida och hantverkarens arbetsorder
  public_token         text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  supplier_token       text unique,
  reporter_ip          text,
  anonymized_at        timestamptz,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  unique (company_id, order_nr),
  unique (id, company_id),
  check (status <> 'closed' or closed_at is not null),
  foreign key (property_id, company_id) references property(id, company_id),
  foreign key (object_id, company_id) references rental_object(id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (supplier_id, company_id) references supplier(id, company_id)
);
create index on work_order (company_id, status);
create index on work_order (property_id);
create index on work_order (object_id);
create index on work_order (customer_id);
create index on work_order (supplier_id);

-- Händelser och kommentarer. visibility: internal = bara personalen, reporter = syns för anmälaren,
-- supplier = syns för hantverkaren.
create table work_order_event (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  work_order_id  uuid not null,
  kind           text not null check (kind in ('created', 'comment', 'status', 'priority', 'assigned', 'supplier',
                                               'email', 'photo', 'cost', 'updated', 'supplier_report', 'reporter_comment')),
  body           text check (length(body) <= 5000),
  visibility     text not null default 'internal' check (visibility in ('internal', 'reporter', 'supplier')),
  -- Namn för händelser utan inloggad användare (anmälaren eller hantverkaren)
  author_label   text,
  created_at     timestamptz not null default clock_timestamp(),
  created_by     uuid,
  foreign key (work_order_id, company_id) references work_order(id, company_id) on delete cascade
);
create index on work_order_event (work_order_id, created_at);

-- Kostnader: leverantörsfakturor som hör till ärendet
create table work_order_cost (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  work_order_id       uuid not null,
  supplier_invoice_id uuid not null,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  unique (work_order_id, supplier_invoice_id),
  foreign key (work_order_id, company_id) references work_order(id, company_id) on delete cascade,
  foreign key (supplier_invoice_id, company_id) references supplier_invoice(id, company_id) on delete cascade
);
create index on work_order_cost (supplier_invoice_id);

-- Bilder sparas som dokument på ärendet
alter table document drop constraint document_entity_type_check;
alter table document add constraint document_entity_type_check
  check (entity_type in ('property', 'rental_object', 'customer', 'contract', 'supplier', 'supplier_invoice', 'work_order'));

-- ---------------------------------------------------------------------
-- Uppslag utan inloggning. Nyckeln är det enda som krävs; funktionerna
-- returnerar bara det bolag och den rad nyckeln gäller.
-- ---------------------------------------------------------------------

create or replace function app.fault_form_lookup(p_token text)
returns table (form_id uuid, company_id uuid, group_id uuid, property_id uuid, enabled boolean)
language sql stable security definer set search_path = public, app as $$
  select f.id, f.company_id, c.group_id, f.property_id, f.enabled and c.active
  from fault_form f join company c on c.id = f.company_id where f.token = p_token
$$;

create or replace function app.work_order_lookup(p_token text, p_kind text)
returns table (id uuid, company_id uuid, group_id uuid)
language sql stable security definer set search_path = public, app as $$
  select w.id, w.company_id, c.group_id from work_order w join company c on c.id = w.company_id
  where (p_kind = 'reporter' and w.public_token = p_token)
     or (p_kind = 'supplier' and w.supplier_token = p_token)
$$;

revoke all on function app.fault_form_lookup(text) from public;
revoke all on function app.work_order_lookup(text, text) from public;
grant execute on function app.fault_form_lookup(text) to fastighet_app;
grant execute on function app.work_order_lookup(text, text) to fastighet_app;

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['work_order_setting', 'fault_form', 'work_order', 'work_order_event', 'work_order_cost'] loop
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
  when 'group_admin' then array['work_order.manage']
  when 'finance'     then array['work_order.manage']
  when 'manager'     then array['work_order.manage']
  else array[]::text[]
end) as p
on conflict do nothing;
