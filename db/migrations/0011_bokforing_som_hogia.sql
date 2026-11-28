-- =====================================================================
-- 0011 Bokföring som i Hogia DinHyresvärd.
--
-- Bolagen bokför i dag via DinHyresvärd med kontoplanen FastBAS.
-- För att bokföringen ska se likadan ut efter bytet används samma konton:
--  * Kontoplanen får FastBAS-kontona för hyresbokföring (kundfordran 1510,
--    förskott 2971, utgående moms för uthyrning 2613, hyresintäkter
--    3010–3016, hyresbortfall 3080–3085 med flera).
--  * Standardartiklarna bokförs på samma konton som i DinHyresvärd
--    (hyra 3010, påminnelseavgift 3540, fastighetsskatt 3950 ...).
--  * Exporten använder verifikationsserie E och moms 25 % på 2613.
--  * Ett intäktskonto kan anges per fastighet och artikel, och skilt för
--    momspliktiga och momsfria rader. Så delar DinHyresvärd upp intäkterna
--    per fastighet (till exempel 3100 Ugglan, 3300 Hjärpen 9).
--  * Hyreskonton räknas fram ur kontots rapportgrupp i stället för att
--    bara vara 3910–3919.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kontoplan
-- ---------------------------------------------------------------------

create or replace function app.seed_bas_accounts(p_company uuid) returns void
language sql security definer set search_path = public, app as $$
  insert into account (company_id, number, name, type, source)
  select p_company, a.number, a.name, a.type, 'local'
  from (values
    ('1110','Byggnader','asset'),
    ('1130','Mark','asset'),
    ('1150','Markanläggningar','asset'),
    ('1220','Inventarier och verktyg','asset'),
    ('1510','Hyres- och avgiftsfordringar','asset'),
    ('1520','Andra kundfordringar','asset'),
    ('1920','Bankgiro','asset'),
    ('1930','Företagskonto/checkkonto/affärskonto','asset'),
    ('1999','Parkerad inbetalning','asset'),
    ('2350','Skulder till kreditinstitut','liability'),
    ('2420','Skulder till och förskott från hyresgäster och andra kunder','liability'),
    ('2440','Leverantörsskulder','liability'),
    ('2610','Utgående moms 25 %','liability'),
    ('2613','Utgående moms för uthyrning, 25 %','liability'),
    ('2618','Vilande utgående moms, oreducerad','liability'),
    ('2620','Utgående moms 12 %','liability'),
    ('2630','Utgående moms 6 %','liability'),
    ('2640','Ingående moms','liability'),
    ('2897','Mottagna depositioner','liability'),
    ('2971','Förutbetalda hyresintäkter','liability'),
    ('3010','Hyresintäkter','revenue'),
    ('3011','Hyresintäkter bostäder','revenue'),
    ('3012','Hyresintäkter lokaler, momsregistrerade','revenue'),
    ('3013','Hyresintäkter lokaler, ej momsregistrerade','revenue'),
    ('3014','Hyresintäkter garage och p-platser, momsregistrerade','revenue'),
    ('3015','Hyresintäkter garage och p-platser, ej momsregistrerade','revenue'),
    ('3016','Hyresintäkter övriga objekt','revenue'),
    ('3017','Separat debiterad f.skatt, momsreg. lokaler','revenue'),
    ('3018','Separat debiterad f.skatt, ej momsreg. lokaler','revenue'),
    ('3070','Kabeltv','revenue'),
    ('3080','Hyresbortfall','revenue'),
    ('3081','Hyres- och avgiftsbortfall vakanta bostäder','revenue'),
    ('3082','Hyres- och avgiftsbortfall vakanta lokaler, momsreg.','revenue'),
    ('3083','Hyres- och avgiftsbortfall lokaler, ej momsreg.','revenue'),
    ('3084','Hyres- och avgiftsbortfall garage och p-platser, momsreg.','revenue'),
    ('3085','Hyres- och avgiftsbortfall garage och p-platser, ej momsreg.','revenue'),
    ('3090','Rabatter','revenue'),
    ('3110','Debiterade förbrukningskostnader - Vatten','revenue'),
    ('3120','Debiterade förbrukningskostnader - El','revenue'),
    ('3130','Debiterade förbrukningskostnader - Uppvärmning','revenue'),
    ('3140','Debiterade förbrukningskostnader - Kyla','revenue'),
    ('3150','Debiterade förbrukningskostnader - Renhållning','revenue'),
    ('3500','Fakturerade kostnader','revenue'),
    ('3510','Fakturerade kundkostnader','revenue'),
    ('3511','Inkasso','revenue'),
    ('3540','Faktureringsavgifter','revenue'),
    ('3590','Övriga fakturerade kostnader','revenue'),
    ('3690','Övriga sidointäkter','revenue'),
    ('3740','Öres- och kronutjämning','revenue'),
    ('3950','Fastighetsskatt','revenue'),
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
    ('6350','Förluster på hyres-, avgifts- och kundfordringar','expense'),
    ('6420','Ersättningar till revisor','expense'),
    ('6530','Redovisningstjänster','expense'),
    ('6570','Bankkostnader','expense'),
    ('6990','Övriga externa kostnader','expense'),
    ('7832','Avskrivningar på byggnader','expense'),
    ('8313','Ränteintäkter från hyres-, avgifts- och kundfordringar','revenue'),
    ('8410','Räntekostnader för långfristiga skulder','expense')
  ) as a(number, name, type)
  on conflict (company_id, number) do nothing
$$;

select app.seed_bas_accounts(id) from company;

-- ---------------------------------------------------------------------
-- Standardartiklar på samma konton som i DinHyresvärd
-- ---------------------------------------------------------------------

create or replace function app.seed_articles(p_company uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.seed_bas_accounts(p_company);
  insert into article (company_id, code, name, account_number, vat_rate_bp, system, position)
  select p_company, a.code, a.name, a.account, a.vat, a.system, a.pos
  from (values
    ('rent',            'Hyra',            '3010', null::integer, true,  10),
    ('parking',         'Parkering',       '3010', null,          true,  20),
    ('storage',         'Förråd',          '3010', null,          true,  30),
    ('heating',         'Värme',           '3130', null,          true,  40),
    ('electricity',     'El',              '3120', null,          true,  50),
    ('water',           'Vatten',          '3110', null,          true,  60),
    ('broadband',       'Bredband',        '3690', null,          false, 70),
    ('cable_tv',        'Kabel-TV',        '3070', null,          false, 80),
    ('property_tax',    'Fastighetsskatt', '3950', null,          false, 90),
    ('service',         'Tjänst',          '3690', null,          true,  100),
    ('index',           'Indextillägg',    '3010', null,          true,  110),
    ('discount',        'Rabatt',          '3090', null,          true,  120),
    ('fee',             'Avgift',          '3540', 0,             true,  130),
    ('other',           'Övrigt',          '3690', null,          true,  140)
  ) as a(code, name, account, vat, system, pos)
  on conflict do nothing;
end $$;

-- Befintliga bolag: artiklar som fortfarande har det gamla standardkontot
-- flyttas. Utfärdade fakturor behåller sitt konto (det sparas på raden).
update article a set account_number = n.account
from (values
  ('rent', '3911', '3010'), ('parking', '3911', '3010'), ('storage', '3911', '3010'),
  ('heating', '3990', '3130'), ('electricity', '3990', '3120'), ('water', '3990', '3110'),
  ('broadband', '3990', '3690'), ('cable_tv', '3990', '3070'), ('property_tax', '3990', '3950'),
  ('service', '3990', '3690'), ('index', '3911', '3010'), ('discount', '3911', '3090'),
  ('fee', '3990', '3540'), ('other', '3990', '3690')
) as n(code, old, account)
where a.code = n.code and a.account_number = n.old;

-- ---------------------------------------------------------------------
-- Hyreskonton räknas fram ur rapportgruppen
-- ---------------------------------------------------------------------

-- Samma regel som defaultReportGroup i economy/report-groups.ts
create or replace function app.default_rent_account(p_number text) returns boolean
language sql immutable as $$
  select case when p_number ~ '^\d{4}$' then
    p_number::int between 3010 and 3016
    or p_number::int between 3080 and 3099
    or p_number::int between 3100 and 3109
    or p_number::int between 3300 and 3499
    or p_number::int between 3910 and 3919
  else false end
$$;

-- Hyreskonto: kontots egen rapportgrupp om den är angiven, annars kontonumret
create or replace function app.is_rent_account(p_company uuid, p_number text) returns boolean
language sql stable as $$
  select coalesce(
    (select a.report_group = 'rent_income' from account a
      where a.company_id = p_company and a.number = p_number and a.report_group is not null),
    app.default_rent_account(p_number))
$$;

-- ---------------------------------------------------------------------
-- Intäktskonto per fastighet
-- ---------------------------------------------------------------------

create table article_account (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  article         text not null,
  property_id     uuid not null,
  -- Gäller rader med moms (taxable), utan moms (exempt) eller alla (any)
  vat             text not null default 'any' check (vat in ('any', 'taxable', 'exempt')),
  account_number  text not null,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  unique (company_id, article, property_id, vat),
  foreign key (company_id, article) references article(company_id, code),
  foreign key (property_id, company_id) references property(id, company_id),
  foreign key (company_id, account_number) references account(company_id, number)
);
create index on article_account (company_id, property_id);

grant select, insert, update, delete on article_account to fastighet_app;
alter table article_account enable row level security;
create policy company_isolation on article_account
  using (company_id = any (app.allowed_companies()))
  with check (company_id = any (app.allowed_companies()));
create trigger article_account_stamp before insert or update on article_account
  for each row execute function app.stamp();
create trigger article_account_audit after insert or update or delete on article_account
  for each row execute function app.audit();

-- Fakturaraden får kontot för fastigheten om det finns, annars artikelns.
-- Ett konto för just momspliktiga eller momsfria rader går före "alla".
create or replace function app.invoice_line_account() returns trigger
language plpgsql as $$
begin
  if new.account_number is null and new.property_id is not null then
    select x.account_number into new.account_number
    from article_account x
    where x.company_id = new.company_id and x.article = new.article and x.property_id = new.property_id
      and (x.vat = 'any' or x.vat = case when new.vat_rate_bp > 0 then 'taxable' else 'exempt' end)
    order by (x.vat = 'any')
    limit 1;
  end if;
  if new.account_number is null then
    select a.account_number into new.account_number
    from article a where a.company_id = new.company_id and a.code = new.article;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Exporten: serie E och moms 25 % på 2613 som i DinHyresvärd
-- ---------------------------------------------------------------------

alter table accounting_setting alter column series set default 'E';
alter table accounting_setting alter column output_vat_25_account set default '2613';

-- Sparade inställningar som fortfarande har de gamla standardvärdena och
-- som ännu inte använts för en export följer med.
update accounting_setting s set series = 'E'
where s.series = 'A' and not exists (select 1 from sie_export e where e.company_id = s.company_id);
update accounting_setting s set output_vat_25_account = '2613'
where s.output_vat_25_account = '2610' and not exists (select 1 from sie_export e where e.company_id = s.company_id);
