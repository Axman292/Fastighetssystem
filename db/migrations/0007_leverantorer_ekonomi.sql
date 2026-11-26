-- =====================================================================
-- 0007 Leverantörer, leverantörsfakturor och ekonomisk uppföljning.
--
-- Leverantörsfakturor registreras med kontering per rad: BAS-konto,
-- fastighet, objekt och kostnadsställe. En faktura går från registrerad
-- till attesterad och betald. Efter attest är den låst.
--
-- Kontoplanen fylls med ett urval BAS-konton för fastighetsbolag för
-- varje bolag. Kontona kan kompletteras eller ersättas från Hogia.
-- Varje konto hör till en rapportgrupp (hyresintäkter, drift, underhåll,
-- fastighetsskatt ...) som styr fastighetens resultaträkning.
--
-- Skydd i databasen:
--  * Samma leverantörsfaktura (leverantör + fakturanummer) kan inte
--    registreras två gånger.
--  * En attesterad faktura och dess rader kan inte ändras eller tas bort.
--  * Attest kräver att raderna summerar till fakturans netto och moms.
--  * Betalningar kan aldrig överstiga fakturans belopp.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kontoplan: rapportgrupp och BAS-standardkonton
-- ---------------------------------------------------------------------

-- Rapportgrupp per konto. Tomt = bestäms av kontonumret (se economy/report-groups.ts).
alter table account
  add column report_group text check (report_group in
    ('rent_income','other_income','operating','maintenance','property_tax','insurance','admin','interest','investment','none'));

create or replace function app.seed_bas_accounts(p_company uuid) returns void
language sql security definer set search_path = public, app as $$
  insert into account (company_id, number, name, type, source)
  select p_company, a.number, a.name, a.type, 'local'
  from (values
    ('1110','Byggnader','asset'),
    ('1130','Mark','asset'),
    ('1150','Markanläggningar','asset'),
    ('1220','Inventarier och verktyg','asset'),
    ('1510','Kundfordringar','asset'),
    ('1930','Företagskonto','asset'),
    ('2350','Skulder till kreditinstitut','liability'),
    ('2440','Leverantörsskulder','liability'),
    ('2610','Utgående moms 25 %','liability'),
    ('2640','Ingående moms','liability'),
    ('3740','Öres- och kronutjämning','revenue'),
    ('3911','Hyresintäkter','revenue'),
    ('3913','Frivilligt momspliktiga hyresintäkter','revenue'),
    ('3990','Övriga ersättningar och intäkter','revenue'),
    ('5110','Tomträttsavgäld och arrende','expense'),
    ('5120','El för belysning','expense'),
    ('5130','Värme','expense'),
    ('5140','Vatten och avlopp','expense'),
    ('5160','Städning och renhållning','expense'),
    ('5170','Reparation och underhåll av fastighet','expense'),
    ('5190','Övriga fastighetskostnader','expense'),
    ('5191','Fastighetsskatt och fastighetsavgift','expense'),
    ('5192','Fastighetsförsäkringspremier','expense'),
    ('5193','Fastighetsskötsel och förvaltning','expense'),
    ('6310','Företagsförsäkringar','expense'),
    ('6420','Ersättningar till revisor','expense'),
    ('6530','Redovisningstjänster','expense'),
    ('6570','Bankkostnader','expense'),
    ('6990','Övriga externa kostnader','expense'),
    ('7832','Avskrivningar på byggnader','expense'),
    ('8410','Räntekostnader för långfristiga skulder','expense')
  ) as a(number, name, type)
  on conflict (company_id, number) do nothing
$$;

select app.seed_bas_accounts(id) from company;

create or replace function app.company_seed_accounts() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.seed_bas_accounts(new.id);
  return null;
end $$;
create trigger company_seed_accounts after insert on company
  for each row execute function app.company_seed_accounts();

-- Dokument kan höra till en leverantörsfaktura
alter table document drop constraint document_entity_type_check;
alter table document add constraint document_entity_type_check
  check (entity_type in ('property','rental_object','customer','contract','supplier','supplier_invoice'));

-- ---------------------------------------------------------------------
-- Leverantörsfakturor
-- ---------------------------------------------------------------------

create table supplier_invoice (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  -- Löpnummer i vårt system (ankomstregistrering), i följd per bolag
  entry_nr        integer not null,
  kind            text not null default 'invoice' check (kind in ('invoice','credit_note')),
  supplier_id     uuid not null,
  invoice_nr      text not null,                         -- leverantörens fakturanummer
  invoice_date    date not null,
  due_date        date not null,
  ocr             text,
  description     text,
  net_ore         bigint not null,
  vat_ore         bigint not null default 0,
  rounding_ore    bigint not null default 0 check (rounding_ore between -100 and 100),
  total_ore       bigint not null,
  status          text not null default 'registered' check (status in ('registered','approved','paid','cancelled')),
  document_id     uuid,
  approved_at     timestamptz,
  approved_by     uuid,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  unique (company_id, entry_nr),
  unique (id, company_id),
  -- Skydd mot dubbelregistrering
  unique (company_id, supplier_id, invoice_nr),
  check (due_date >= invoice_date),
  check (total_ore = net_ore + vat_ore + rounding_ore),
  check (kind = 'invoice' and total_ore >= 0 or kind = 'credit_note' and total_ore <= 0),
  check (status not in ('approved','paid') or approved_at is not null),
  check (status <> 'cancelled' or cancel_reason is not null),
  foreign key (supplier_id, company_id) references supplier(id, company_id),
  foreign key (document_id, company_id) references document(id, company_id)
);

create table supplier_invoice_line (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  supplier_invoice_id uuid not null,
  position            smallint not null default 0,
  account_number      text not null,
  description         text,
  property_id         uuid,
  object_id           uuid,
  cost_center_id      uuid,
  net_ore             bigint not null,
  vat_ore             bigint not null default 0,
  -- Ingående moms dras av bara när kostnaden hör till momspliktig verksamhet.
  -- För bostäder blir momsen en del av kostnaden.
  vat_deductible      boolean not null default true,
  -- Period som kostnaden avser, t.ex. en årspremie. Tomt = fakturadatum.
  period_from         date,
  period_to           date,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  check ((period_from is null) = (period_to is null)),
  check (period_to is null or period_to >= period_from),
  foreign key (supplier_invoice_id, company_id) references supplier_invoice(id, company_id) on delete cascade,
  foreign key (company_id, account_number) references account(company_id, number),
  foreign key (property_id, company_id) references property(id, company_id),
  foreign key (object_id, company_id) references rental_object(id, company_id),
  foreign key (cost_center_id) references cost_center(id)
);

create table supplier_invoice_payment (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  supplier_invoice_id uuid not null,
  paid_date           date not null,
  amount_ore          bigint not null check (amount_ore <> 0),
  method              text not null default 'bankgiro' check (method in ('bankgiro','plusgiro','bank_transfer','autogiro','card','offset','other')),
  reference           text,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  foreign key (supplier_invoice_id, company_id) references supplier_invoice(id, company_id)
);

create table supplier_invoice_event (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  supplier_invoice_id uuid not null,
  event               text not null,     -- registered, updated, approved, unapproved, paid, payment_removed, cancelled, document
  note                text,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  foreign key (supplier_invoice_id, company_id) references supplier_invoice(id, company_id) on delete cascade
);

create index on supplier_invoice (company_id, status, due_date);
create index on supplier_invoice (supplier_id);
create index on supplier_invoice_line (supplier_invoice_id);
create index on supplier_invoice_line (property_id);
create index on supplier_invoice_payment (supplier_invoice_id);
create index on supplier_invoice_event (supplier_invoice_id);

-- Betalt och kvar att betala per faktura
create view supplier_invoice_balance with (security_invoker = true) as
select i.id as supplier_invoice_id, i.company_id,
  coalesce((select sum(p.amount_ore) from supplier_invoice_payment p where p.supplier_invoice_id = i.id), 0)::bigint as paid_ore,
  case when i.status = 'cancelled' then 0
       else i.total_ore - coalesce((select sum(p.amount_ore) from supplier_invoice_payment p where p.supplier_invoice_id = i.id), 0)
  end::bigint as balance_ore
from supplier_invoice i;

-- Attesterade och betalda fakturor är låsta. Bara status, makulering och bifogat dokument får ändras.
create or replace function app.supplier_invoice_guard() returns trigger
language plpgsql as $$
declare
  v_locked text[] := array['supplier_id','invoice_nr','invoice_date','due_date','ocr','net_ore','vat_ore','rounding_ore',
                           'total_ore','kind','entry_nr','company_id','description'];
  k text;
  v_net bigint; v_vat bigint; v_n int;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'registered' then
      raise exception 'En attesterad faktura kan inte tas bort. Makulera den i stället.' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status <> 'registered' then
    foreach k in array v_locked loop
      if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
        raise exception 'Fakturan är attesterad och kan inte ändras. Ta bort attesten först.' using errcode = '23514';
      end if;
    end loop;
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'En makulerad faktura kan inte återställas' using errcode = '23514';
  end if;
  if new.status in ('approved','paid') and old.status = 'registered' then
    select coalesce(sum(net_ore), 0), coalesce(sum(vat_ore), 0), count(*) into v_net, v_vat, v_n
      from supplier_invoice_line where supplier_invoice_id = new.id;
    if v_n = 0 then
      raise exception 'Fakturan saknar kontering' using errcode = '23514';
    end if;
    if v_net <> new.net_ore or v_vat <> new.vat_ore then
      raise exception 'Konteringen summerar inte till fakturans netto och moms' using errcode = '23514';
    end if;
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled'
     and exists (select 1 from supplier_invoice_payment where supplier_invoice_id = new.id) then
    raise exception 'Fakturan har betalningar och kan inte makuleras' using errcode = '23514';
  end if;
  if new.status = 'registered' and old.status <> 'registered'
     and exists (select 1 from supplier_invoice_payment where supplier_invoice_id = new.id) then
    raise exception 'Fakturan har betalningar. Ta bort betalningarna innan attesten tas bort.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger supplier_invoice_guard before update or delete on supplier_invoice
  for each row execute function app.supplier_invoice_guard();

create or replace function app.supplier_invoice_line_guard() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from supplier_invoice where id = coalesce(new.supplier_invoice_id, old.supplier_invoice_id);
  if v_status is not null and v_status <> 'registered' then
    raise exception 'Konteringen på en attesterad faktura kan inte ändras' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger supplier_invoice_line_guard before insert or update or delete on supplier_invoice_line
  for each row execute function app.supplier_invoice_line_guard();

-- Betalningar: bara på attesterade fakturor, med samma tecken som fakturan och aldrig mer än beloppet.
create or replace function app.supplier_payment_guard() returns trigger
language plpgsql as $$
declare v_inv supplier_invoice; v_paid bigint;
begin
  if tg_op = 'UPDATE' then
    raise exception 'En betalning kan inte ändras. Ta bort den och registrera på nytt.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select * into v_inv from supplier_invoice where id = new.supplier_invoice_id for update;
  if v_inv.status not in ('approved','paid') then
    raise exception 'Fakturan måste vara attesterad innan den betalas' using errcode = '23514';
  end if;
  if sign(new.amount_ore) <> sign(v_inv.total_ore) then
    raise exception 'Beloppet har fel tecken' using errcode = '23514';
  end if;
  select coalesce(sum(amount_ore), 0) into v_paid from supplier_invoice_payment where supplier_invoice_id = new.supplier_invoice_id;
  if abs(v_paid + new.amount_ore) > abs(v_inv.total_ore) then
    raise exception 'Betalningen är större än det som är kvar att betala' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger supplier_payment_guard before insert or update or delete on supplier_invoice_payment
  for each row execute function app.supplier_payment_guard();

-- ---------------------------------------------------------------------
-- Budget per fastighet, år och rapportgrupp
-- ---------------------------------------------------------------------

create table property_budget (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  property_id   uuid not null,
  year          smallint not null check (year between 2000 and 2100),
  report_group  text not null check (report_group in
    ('rent_income','other_income','operating','maintenance','property_tax','insurance','admin','interest','investment')),
  amount_ore    bigint not null check (amount_ore >= 0),   -- intäkt eller kostnad för helåret, alltid positivt
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  unique (property_id, year, report_group),
  foreign key (property_id, company_id) references property(id, company_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['supplier_invoice','supplier_invoice_line','supplier_invoice_payment','supplier_invoice_event','property_budget'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
  foreach t in array array['supplier_invoice','supplier_invoice_line','supplier_invoice_payment','property_budget'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
end $$;

grant select on supplier_invoice_balance to fastighet_app;
-- Händelseloggen skrivs bara till
revoke update, delete on supplier_invoice_event from fastighet_app;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['supplier_invoice.write','supplier_invoice.approve','supplier_invoice.pay','budget.write']
  when 'finance'     then array['supplier_invoice.write','supplier_invoice.approve','supplier_invoice.pay','budget.write']
  when 'manager'     then array['supplier_invoice.write','budget.write']
  when 'approver'    then array['supplier_invoice.approve']
  else array[]::text[]
end) as p;
