-- =====================================================================
-- 0009 Hyresjustering för många objekt på en gång.
--
-- En justering (till exempel årets hyreshöjning för bostäder) ändrar
-- avtalens hyresrader och objektens hyra från ett datum. Varje ändrad rad
-- sparas som en post, så att justeringen går att följa i efterhand och
-- ångras så länge den nya hyran inte har aviserats.
-- =====================================================================

create table rent_adjustment (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company(id),
  adjustment_nr      integer not null,
  name               text not null,
  effective_date     date not null,
  method             text not null check (method in ('percent','amount')),
  percent            numeric(7,3),                 -- vid procent, t.ex. 3.250
  amount_ore         bigint,                       -- vid belopp, per månad
  rounding           text not null default 'krona' check (rounding in ('none','krona','ten')),
  criteria           jsonb not null default '{}',  -- urvalet: fastigheter, objekttyper, avtalstyper, artiklar
  reason             text,
  status             text not null default 'applied' check (status in ('applied','reverted')),
  line_count         integer not null default 0,
  object_count       integer not null default 0,
  total_before_ore   bigint not null default 0,    -- avtalens hyra per månad före
  total_after_ore    bigint not null default 0,    -- och efter
  reverted_at        timestamptz,
  reverted_by        uuid,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  unique (company_id, adjustment_nr),
  unique (id, company_id),
  check ((method = 'percent') = (percent is not null)),
  check ((method = 'amount') = (amount_ore is not null))
);

create table rent_adjustment_item (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  adjustment_id      uuid not null,
  kind               text not null check (kind in ('line','object')),
  contract_id        uuid references contract(id) on delete set null,
  object_id          uuid references rental_object(id) on delete set null,
  old_line_id        uuid references contract_line(id) on delete set null,
  new_line_id        uuid references contract_line(id) on delete set null,
  old_price_id       uuid references rental_object_price(id) on delete set null,
  new_price_id       uuid references rental_object_price(id) on delete set null,
  old_valid_to       date,                         -- den gamla radens slutdatum före justeringen
  description        text not null,
  old_amount_ore     bigint not null,
  new_amount_ore     bigint not null,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  foreign key (adjustment_id, company_id) references rent_adjustment(id, company_id) on delete cascade
);

create index on rent_adjustment (company_id, effective_date desc);
create index on rent_adjustment_item (adjustment_id);
create index on rent_adjustment_item (contract_id);
create index on rent_adjustment_item (object_id);

do $$
declare t text;
begin
  foreach t in array array['rent_adjustment','rent_adjustment_item'] loop
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

-- Objektens hyra ändras i samma justering som avtalen
grant delete on rental_object_price to fastighet_app;
