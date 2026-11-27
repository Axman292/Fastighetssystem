-- =====================================================================
-- 0008 Artikelregister per bolag.
--
-- Tidigare var artiklarna på avtalsrader, extra debiteringar och
-- fakturarader en fast lista (rent, heating, ... other). Nu har varje
-- bolag ett eget register där artiklar kan läggas till och döpas om.
-- Varje artikel har ett intäktskonto i kontoplanen och kan ha en
-- standardmoms.
--
-- Kolumnen article på raderna innehåller fortfarande artikelns kod.
-- De gamla värdena blir standardartiklar med samma kod, så befintliga
-- avtal och fakturor behåller sina artiklar. Koden ändras aldrig, bara
-- namnet, kontot och momsen.
--
-- Fakturaraden sparar intäktskontot när den skapas, så att en senare
-- ändring av artikelns konto inte ändrar redan utfärdade fakturor.
-- =====================================================================

create table article (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  code            text not null check (code ~ '^[a-z0-9_]{1,40}$'),
  name            text collate sv not null check (length(trim(name)) > 0),
  account_number  text not null,
  -- Standardmoms när artikeln väljs. Tomt = följer avtalet och objektet.
  vat_rate_bp     integer check (vat_rate_bp in (0, 600, 1200, 2500)),
  -- Standardartiklar som systemet självt använder kan inte tas bort
  system          boolean not null default false,
  active          boolean not null default true,
  position        smallint not null default 100,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  unique (company_id, code),
  unique (id, company_id),
  foreign key (company_id, account_number) references account(company_id, number)
);

create unique index article_name_unique on article (company_id, lower(name));

-- Standardartiklar för ett bolag. Kontona skapas först om de saknas.
create or replace function app.seed_articles(p_company uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.seed_bas_accounts(p_company);
  insert into article (company_id, code, name, account_number, vat_rate_bp, system, position)
  select p_company, a.code, a.name, a.account, a.vat, a.system, a.pos
  from (values
    ('rent',            'Hyra',            '3911', null::integer, true,  10),
    ('parking',         'Parkering',       '3911', null,          true,  20),
    ('storage',         'Förråd',          '3911', null,          true,  30),
    ('heating',         'Värme',           '3990', null,          true,  40),
    ('electricity',     'El',              '3990', null,          true,  50),
    ('water',           'Vatten',          '3990', null,          true,  60),
    ('broadband',       'Bredband',        '3990', null,          false, 70),
    ('cable_tv',        'Kabel-TV',        '3990', null,          false, 80),
    ('property_tax',    'Fastighetsskatt', '3990', null,          false, 90),
    ('service',         'Tjänst',          '3990', null,          true,  100),
    ('index',           'Indextillägg',    '3911', null,          true,  110),
    ('discount',        'Rabatt',          '3911', null,          true,  120),
    ('fee',             'Avgift',          '3990', 0,             true,  130),
    ('other',           'Övrigt',          '3990', null,          true,  140)
  ) as a(code, name, account, vat, system, pos)
  on conflict do nothing;
end $$;

select app.seed_articles(id) from company;

create or replace function app.company_seed_articles() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.seed_articles(new.id);
  return null;
end $$;
create trigger company_seed_articles after insert on company
  for each row execute function app.company_seed_articles();

-- ---------------------------------------------------------------------
-- Raderna pekar på artikelregistret i stället för en fast lista
-- ---------------------------------------------------------------------

alter table contract_line drop constraint contract_line_article_check;
alter table contract_line add constraint contract_line_article_fk
  foreign key (company_id, article) references article(company_id, code);

alter table contract_charge drop constraint contract_charge_article_check;
alter table contract_charge add constraint contract_charge_article_fk
  foreign key (company_id, article) references article(company_id, code);

alter table invoice_line drop constraint invoice_line_article_check;
alter table invoice_line add constraint invoice_line_article_fk
  foreign key (company_id, article) references article(company_id, code);

create index contract_line_article_idx on contract_line (company_id, article);
create index contract_charge_article_idx on contract_charge (company_id, article);
create index invoice_line_article_idx on invoice_line (company_id, article);

-- Intäktskontot sparas på fakturaraden
alter table invoice_line add column account_number text;

create or replace function app.invoice_line_account() returns trigger
language plpgsql as $$
begin
  if new.account_number is null then
    select a.account_number into new.account_number
    from article a where a.company_id = new.company_id and a.code = new.article;
  end if;
  return new;
end $$;
create trigger invoice_line_account before insert on invoice_line
  for each row execute function app.invoice_line_account();

-- Befintliga fakturarader får kontot från standardartikeln. Raderna på
-- utfärdade fakturor är låsta, så låset stängs av under uppdateringen.
alter table invoice_line disable trigger invoice_line_immutable;
alter table invoice_line disable trigger invoice_line_audit;
alter table invoice_line disable trigger invoice_line_stamp;
update invoice_line l set account_number = a.account_number
from article a where a.company_id = l.company_id and a.code = l.article and l.account_number is null;
alter table invoice_line enable trigger invoice_line_immutable;
alter table invoice_line enable trigger invoice_line_audit;
alter table invoice_line enable trigger invoice_line_stamp;

-- ---------------------------------------------------------------------
-- Rättigheter, RLS, revisionslogg och stämplar
-- ---------------------------------------------------------------------

grant select, insert, update, delete on article to fastighet_app;
alter table article enable row level security;
create policy company_isolation on article
  using (company_id = any (app.allowed_companies()))
  with check (company_id = any (app.allowed_companies()));
create trigger article_stamp before insert or update on article
  for each row execute function app.stamp();
create trigger article_audit after insert or update or delete on article
  for each row execute function app.audit();

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['article.write']
  when 'finance'     then array['article.write']
  else array[]::text[]
end) as p;
