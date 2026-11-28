-- =====================================================================
-- 0012 Automatisk hämtning av inbetalningsfiler från banken.
--
-- Bankgirot slutade skicka BgMax efter 27 november 2026. Bankerna skickar i stället
-- ISO 20022-filer (camt.054, eller camt.053) till kundens system, oftast via SFTP.
--
--  * bank_file kan nu vara camt.054 eller camt.053, och vet om den laddats upp för hand
--    eller hämtats automatiskt.
--  * bank_connection är koncernens anslutning till banken (SFTP, eller en mapp på servern).
--    Filerna hämtas med jämna mellanrum och läses in i det bolag vars bankgiro eller
--    bankkonto de gäller. Matchade betalningar kan bokföras direkt.
--  * SSH-nyckeln skapas av systemet och sparas krypterad. Den privata delen visas aldrig.
--  * bank_fetch_run är loggen över varje hämtning, bank_fetch_file varje fil som hittats.
-- =====================================================================

alter table bank_file drop constraint if exists bank_file_format_check;
alter table bank_file add constraint bank_file_format_check check (format in ('bgmax','camt054','camt053'));
alter table bank_file
  add column source             text not null default 'upload' check (source in ('upload','auto')),
  add column bank_connection_id uuid;


create table bank_connection (
  id                   uuid primary key default gen_random_uuid(),
  group_id             uuid not null references company_group(id),
  name                 text not null default 'Danske Bank',
  kind                 text not null default 'sftp' check (kind in ('sftp','folder')),
  host                 text,
  port                 integer not null default 22 check (port between 1 and 65535),
  username             text,
  remote_dir           text not null default '/',
  -- Bara filer vars namn matchar mönstret (t.ex. *.xml). Tomt = alla filer.
  file_pattern         text,
  -- Värdnyckelns SHA256-fingeravtryck. Sparas vid första lyckade anslutning och kontrolleras sedan.
  host_fingerprint     text,
  public_key           text,
  enabled              boolean not null default false,
  auto_book            boolean not null default true,
  delete_after_fetch   boolean not null default false,
  interval_minutes     integer not null default 60 check (interval_minutes between 5 and 1440),
  notify_email         text,
  last_run_at          timestamptz,
  last_status          text check (last_status in ('ok','error')),
  last_error           text,
  created_at           timestamptz not null default now(),
  created_by           uuid,
  updated_at           timestamptz not null default now(),
  updated_by           uuid,
  check (kind <> 'sftp' or not enabled or (host is not null and username is not null))
);

alter table bank_file
  add constraint bank_file_connection_fk foreign key (bank_connection_id) references bank_connection(id) on delete set null;

-- Den privata nyckeln ligger i en egen tabell utan revisionslogg, så att den aldrig hamnar i loggen.
-- Den är krypterad med APP_SECRET_KEY och lämnar aldrig servern.
create table bank_connection_key (
  connection_id    uuid primary key references bank_connection(id) on delete cascade,
  group_id         uuid not null references company_group(id),
  private_key_enc  text not null,
  created_at       timestamptz not null default now()
);

create table bank_fetch_run (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references company_group(id),
  connection_id    uuid not null references bank_connection(id) on delete cascade,
  trigger          text not null check (trigger in ('schedule','manual','test')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running' check (status in ('running','ok','error')),
  files_found      integer not null default 0,
  files_imported   integer not null default 0,
  payments         integer not null default 0,
  booked           integer not null default 0,
  unmatched        integer not null default 0,
  message          text
);

create table bank_fetch_file (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references company_group(id),
  connection_id    uuid not null references bank_connection(id) on delete cascade,
  run_id           uuid not null references bank_fetch_run(id) on delete cascade,
  remote_name      text not null,
  size             bigint,
  modified_at      timestamptz,
  sha256           text,
  result           text not null check (result in ('imported','duplicate','error','ignored')),
  message          text,
  bank_file_ids    uuid[] not null default '{}',
  created_at       timestamptz not null default now()
);

-- En fil som redan hanterats hämtas inte igen (om den inte tas bort hos banken)
create unique index bank_fetch_file_once on bank_fetch_file (connection_id, remote_name, coalesce(size, -1), coalesce(modified_at, 'epoch'))
  where result in ('imported','duplicate','ignored');

create index on bank_fetch_run (connection_id, started_at desc);
create index on bank_fetch_file (run_id);
create index on bank_file (bank_connection_id);

do $$
declare t text;
begin
  foreach t in array array['bank_connection','bank_connection_key','bank_fetch_run','bank_fetch_file'] loop
    execute format('grant select, insert, update, delete on %I to fastighet_app', t);
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy group_isolation on %I
                    using (group_id = app.current_group_id())
                    with check (group_id = app.current_group_id())$p$, t);
  end loop;
end $$;

create trigger bank_connection_stamp before insert or update on bank_connection
  for each row execute function app.stamp();
create trigger bank_connection_audit after insert or update or delete on bank_connection
  for each row execute function app.audit();
