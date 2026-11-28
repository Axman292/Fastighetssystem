-- =====================================================================
-- 0012 Säker inloggning: tvåstegsverifiering (TOTP), inbjudningar,
-- återställning av lösenord, kontospärr, sessionstimeout och inloggningslogg.
--
-- Säkerhetsuppgifterna ligger i en egen tabell (user_security) som inte
-- revisionsloggas, så att hemligheter och räknare aldrig hamnar i audit_log.
-- Tabellerna läses och skrivs bara av API:ets systemanslutning, inte av
-- rollen fastighet_app.
-- Befintliga användare påverkas inte: de loggar in som förut tills de själva
-- slår på tvåstegsverifiering eller koncernen kräver det.
-- =====================================================================

create table user_security (
  user_id              uuid primary key references app_user(id) on delete cascade,
  totp_secret          text,                    -- krypterad med AUTH_SECRET när den är satt
  totp_pending_secret  text,                    -- under uppsättning, innan första koden bekräftats
  totp_enabled_at      timestamptz,
  totp_last_step       bigint,                  -- senast använda tidssteg, stoppar återanvändning av en kod
  failed_logins        integer not null default 0,
  locked_until         timestamptz,
  password_changed_at  timestamptz,
  last_login_at        timestamptz
);

insert into user_security (user_id, password_changed_at)
select id, case when password_hash is not null then created_at end from app_user;

-- Engångskoder om telefonen med autentiseringsappen tappas bort
create table mfa_recovery_code (
  user_id    uuid not null references app_user(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  primary key (user_id, code_hash)
);

-- Länkar och steg i inloggningen. Bara hashen av token sparas.
create table auth_token (
  token_hash  text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  purpose     text not null check (purpose in ('invite', 'password_reset', 'login_mfa')),
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer not null default 0
);
create index on auth_token (user_id, purpose);

-- Inloggningslogg: lyckade och misslyckade inloggningar och säkerhetsändringar
create table login_event (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  group_id     uuid references company_group(id),
  user_id      uuid references app_user(id) on delete set null,
  email        text,
  event        text not null,
  ip           text,
  user_agent   text,
  detail       text
);
create index on login_event (group_id, occurred_at desc);
create index on login_event (user_id, occurred_at desc);

-- Sessioner: senaste aktivitet för timeout vid inaktivitet
alter table user_session add column last_seen_at timestamptz not null default now();

-- Koncernens säkerhetsinställningar
alter table company_group
  add column require_mfa boolean not null default false,
  add column session_idle_minutes integer not null default 30
    check (session_idle_minutes between 5 and 720);
