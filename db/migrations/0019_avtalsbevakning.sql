-- =====================================================================
-- 0019 Avtalsbevakning: påminnelser om avtal.
--
-- Påminnelserna räknas fram ur avtalens datum vid varje anrop
-- (uppsägningstid, avtalsslut, omförhandling, KPI-uppräkning,
-- hyresändringar och säkerheter). Här sparas bara
--  - framförhållning och e-postsammanfattning per bolag,
--  - vilka användare som får sammanfattningen,
--  - påminnelser som markerats som klara eller skjutits upp.
-- Dessutom får säkerheter ett datum för hur länge de gäller
-- (bankgaranti och borgen löper ofta ut).
-- =====================================================================

alter table contract_deposit add column valid_until date;

create table contract_alert_setting (
  company_id          uuid primary key references company(id),
  id                  uuid not null unique default gen_random_uuid(),
  notice_days         smallint not null default 120 check (notice_days between 1 and 730),
  ending_days         smallint not null default 90  check (ending_days between 1 and 730),
  renegotiate_days    smallint not null default 120 check (renegotiate_days between 1 and 730),
  index_days          smallint not null default 60  check (index_days between 1 and 730),
  rent_change_days    smallint not null default 30  check (rent_change_days between 1 and 730),
  security_days       smallint not null default 60  check (security_days between 1 and 730),
  digest_enabled      boolean not null default false,
  digest_frequency    text not null default 'weekly' check (digest_frequency in ('daily','weekly')),
  digest_weekday      smallint not null default 1 check (digest_weekday between 1 and 7), -- 1 = måndag
  last_digest_at      timestamptz,
  last_digest_note    text,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);

create table contract_alert_recipient (
  id          uuid not null unique default gen_random_uuid(),
  company_id  uuid not null references company(id),
  user_id     uuid not null references app_user(id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  primary key (company_id, user_id)
);

-- En påminnelse identifieras av en nyckel: typ, avtal, datum och ev. rad.
-- Ändras datumet (till exempel efter en förlängning) blir det en ny påminnelse.
create table contract_alert_ack (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  contract_id   uuid not null,
  alert_key     text not null,
  kind          text not null,
  due_date      date not null,
  action        text not null check (action in ('done','snooze')),
  snooze_until  date,
  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  unique (company_id, alert_key),
  check (action <> 'snooze' or snooze_until is not null),
  foreign key (contract_id, company_id) references contract(id, company_id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['contract_alert_setting', 'contract_alert_recipient', 'contract_alert_ack'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
  end loop;
  foreach t in array array['contract_alert_setting', 'contract_alert_ack'] loop
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;
