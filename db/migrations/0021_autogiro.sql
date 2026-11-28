-- =====================================================================
-- 0021 Autogiro (Bankgirot) för hyresbetalning.
--
-- Autogiro påverkas inte av Bankgirots omställning 2026: tjänsten och dess
-- filer (nya formatet, 80 tecken per post) fortsätter som vanligt tills vidare.
--
--  * autogiro_mandate är medgivanderegistret: vilken hyresgäst som betalar via
--    autogiro, betalarnummer, konto och status hos Bankgirot.
--  * autogiro_payment är en dragning per avi: planeras när aviseringskörningen
--    godkänns, skickas i en betalningsfil och blir betald eller misslyckad när
--    Bankgirots betalningsspecifikation läses in.
--  * autogiro_file sparar varje fil till och från Bankgirot.
--
-- Skydd i databasen:
--  * En hyresgäst har högst ett gällande medgivande, och ett betalarnummer
--    används bara av ett gällande medgivande.
--  * En avi kan bara ha en dragning som inte misslyckats eller makulerats.
--  * En dragning bokförs aldrig två gånger, och samma fil läses aldrig in två gånger.
-- =====================================================================

alter table company
  -- Bankgirots kundnummer för Autogiro (6 siffror) och bankgirot dragningarna sätts in på
  add column autogiro_customer_nr text check (autogiro_customer_nr ~ '^\d{1,6}$'),
  add column autogiro_bankgiro    text check (autogiro_bankgiro ~ '^\d{3,4}-?\d{4}$'),
  add column autogiro_enabled     boolean not null default false;

create table autogiro_mandate (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company(id),
  customer_id      uuid not null,
  -- Betalarnummer hos Bankgirot, normalt hyresgästens kundnummer
  payer_nr         text not null check (payer_nr ~ '^\d{1,16}$'),
  clearing_nr      text check (clearing_nr ~ '^\d{4}$'),
  account_nr       text check (account_nr ~ '^\d{1,12}$'),
  -- Kontohavarens personnummer (12 siffror) eller organisationsnummer (00 + 10 siffror)
  holder_id        text check (holder_id ~ '^\d{12}$'),
  holder_name      text,
  -- form = påskriven blankett, internet_bank = hyresgästen anmälde i sin internetbank
  source           text not null default 'form' check (source in ('form','internet_bank')),
  -- review: internetbanksmedgivande som väntar på godkännande
  -- new: ska skickas till Bankgirot, sent: skickat och väntar på svar
  -- active: godkänt av Bankgirot, rejected: avvisat
  -- cancel_new: makulering ska skickas, cancel_sent: makulering skickad, cancelled: makulerat
  status           text not null default 'new'
                   check (status in ('review','new','sent','active','rejected','cancel_new','cancel_sent','cancelled')),
  -- Svar på ett internetbanksmedgivande: approve skickas med blankt, reject med "AV"
  response         text check (response in ('approve','reject')),
  signed_date      date,
  sent_file_id     uuid,
  info_code        text,
  comment_code     text,
  bgc_message      text,
  activated_date   date,
  cancelled_date   date,
  note             text,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id),
  check (source = 'internet_bank' or (clearing_nr is not null and account_nr is not null and holder_id is not null))
);
create unique index autogiro_mandate_one_per_customer on autogiro_mandate (customer_id)
  where status not in ('rejected','cancelled');
create unique index autogiro_mandate_payer_nr on autogiro_mandate (company_id, payer_nr)
  where status not in ('rejected','cancelled');

create table autogiro_file (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company(id),
  direction      text not null check (direction in ('out','in')),
  -- out: mandates (medgivanden), payments (dragningar)
  -- in: mandate_advice (AG-MEDAVI), internet_mandates (AG-EMEDGIV),
  --     payment_spec (BET. SPEC & STOPP TK), rejected_payments (AVVISADE BET UPPDR)
  kind           text not null check (kind in ('mandates','payments','mandate_advice','internet_mandates','payment_spec','rejected_payments')),
  filename       text not null,
  content        text not null,
  sha256         text not null,
  record_count   integer not null default 0,
  total_ore      bigint not null default 0,
  file_date      date,
  -- Utgående: created = skapad, uploaded = markerad som skickad till Bankgirot
  status         text not null default 'created' check (status in ('created','uploaded','processed')),
  uploaded_at    timestamptz,
  result         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  created_by     uuid,
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  unique (id, company_id),
  unique (company_id, direction, sha256)
);

alter table autogiro_mandate
  add constraint autogiro_mandate_file_fk foreign key (sent_file_id, company_id) references autogiro_file(id, company_id);

create table autogiro_payment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  invoice_id      uuid not null,
  mandate_id      uuid not null,
  customer_id     uuid not null,
  payer_nr        text not null,
  amount_ore      bigint not null check (amount_ore > 0),
  payment_date    date not null,
  reference       text not null,                 -- avins OCR-nummer
  -- planned: väntar på betalningsfil, sent: i fil till Bankgirot,
  -- paid: dragen och bokförd, failed: gick inte igenom, cancelled: dras inte
  status          text not null default 'planned' check (status in ('planned','sent','paid','failed','cancelled')),
  file_id         uuid,
  result_file_id  uuid,
  status_code     text,
  message         text,
  payment_id      uuid unique,
  -- Vanlig avi skickad till hyresgästen efter misslyckad dragning
  fallback_delivery_id uuid,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  unique (id, company_id),
  foreign key (invoice_id, company_id) references invoice(id, company_id),
  foreign key (mandate_id, company_id) references autogiro_mandate(id, company_id),
  foreign key (customer_id, company_id) references customer(id, company_id),
  foreign key (file_id, company_id) references autogiro_file(id, company_id),
  foreign key (result_file_id, company_id) references autogiro_file(id, company_id),
  -- Tas betalningen bort (t.ex. bokförd fel) ligger dragningen kvar som betald utan betalning
  foreign key (payment_id) references payment(id) on delete set null
);
create unique index autogiro_payment_one_per_invoice on autogiro_payment (invoice_id)
  where status not in ('failed','cancelled');
create index on autogiro_payment (status);
create index on autogiro_payment (mandate_id);
create index on autogiro_payment (customer_id);
create index on autogiro_mandate (customer_id);

do $$
declare t text;
begin
  foreach t in array array['autogiro_mandate','autogiro_file','autogiro_payment'] loop
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
