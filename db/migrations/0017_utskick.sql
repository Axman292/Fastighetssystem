-- =====================================================================
-- 0017 Utskick till hyresgäster.
--
-- Massutskick med e-post och SMS till alla hyresgäster eller ett urval
-- (fastigheter, objekttyper, avtalstyper, avtalsstatus), till exempel
-- om vattenavstängning eller planerat underhåll.
--
--  * message_template: bolagets egna mallar med kopplingsfält som {namn}.
--  * message_campaign: ett utskick med innehåll och urval.
--  * message_recipient: varje mottagare och kanal, med det text som
--    faktiskt skickades och hur det gick. Det är utskicksloggen som
--    visas på hyresgästen.
--
-- Loggraderna har ingen revisionslogg, eftersom de själva är en logg och
-- innehåller hela meddelandet. De tas bort när hyresgästen anonymiseras.
-- =====================================================================

create table message_template (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id),
  name          text not null,
  subject       text not null default '',
  body          text not null default '',          -- e-post
  sms_body      text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  unique (company_id, name)
);

create table message_campaign (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company(id),
  campaign_nr     integer not null,
  name            text not null,
  send_email      boolean not null default false,
  send_sms        boolean not null default false,
  subject         text,
  body            text,
  sms_body        text,
  criteria        jsonb not null default '{}',
  template_id     uuid references message_template(id) on delete set null,
  status          text not null default 'sending' check (status in ('sending','done')),
  recipient_count integer not null default 0,     -- hyresgäster i utskicket
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  unique (company_id, campaign_nr),
  unique (id, company_id),
  check (send_email or send_sms),
  check (not send_email or (coalesce(subject, '') <> '' and coalesce(body, '') <> '')),
  check (not send_sms or coalesce(sms_body, '') <> '')
);

create table message_recipient (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  campaign_id    uuid not null,
  customer_id    uuid references customer(id) on delete cascade,
  customer_name  text not null,
  channel        text not null check (channel in ('email','sms')),
  recipient      text,                             -- e-postadress eller mobilnummer
  subject        text,
  body           text not null,
  status         text not null default 'queued' check (status in ('queued','sent','test','failed','skipped')),
  note           text,                             -- varför den hoppades över, misslyckades eller bara testades
  sent_at        timestamptz,
  created_at     timestamptz not null default now(),
  foreign key (campaign_id, company_id) references message_campaign(id, company_id) on delete cascade
);

create index on message_campaign (company_id, created_at desc);
create index on message_recipient (campaign_id);
create index on message_recipient (customer_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['message_template','message_campaign','message_recipient'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy company_isolation on %I
                    using (company_id = any (app.allowed_companies()))
                    with check (company_id = any (app.allowed_companies()))$p$, t);
  end loop;
  foreach t in array array['message_template','message_campaign'] loop
    execute format('create trigger %I_audit after insert or update or delete on %I
                    for each row execute function app.audit()', t, t);
    execute format('create trigger %I_stamp before insert or update on %I
                    for each row execute function app.stamp()', t, t);
  end loop;
end $$;

insert into role_permission (role_id, permission)
select r.id, p from role r
cross join lateral unnest(case r.key
  when 'group_admin' then array['message.send']
  when 'finance'     then array['message.send']
  when 'manager'     then array['message.send']
  else array[]::text[]
end) as p
on conflict do nothing;
