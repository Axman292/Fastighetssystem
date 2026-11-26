# Fastighetssystem

Affärssystem för fastighetsförvaltning: fastigheter, hyresobjekt, hyresgäster, avtal, avisering, ekonomi och koppling till Hogia Redovisning. Byggt för en koncern med flera fastighetsägande bolag.

Arkitektur och fullständig databasmodell beskrivs i dokumentet *Fastighetssystem – arkitektur och databasmodell*. Systemet byggs i sex faser; det här är **fas 1, grunden**.

## Vad som finns i fas 1

- **Bolag och koncern.** Flera juridiska bolag med organisationsnummer (kontrollsiffran valideras), momsnummer, adress, bankgiro, räkenskapsår och Hogia-klient-id.
- **Bolagsväljare.** Byt bolag utan att logga ut, eller visa hela koncernen i läsläge. Ändringar görs alltid i ett valt bolag.
- **Användare, roller och behörigheter.** Koncernadministratör, ekonomiansvarig, förvaltare, attestant, läsbehörig och revisor. En roll per bolag.
- **Bolagsisolering i databasen.** PostgreSQL Row Level Security gör att ett bolags data aldrig syns i ett annat, även om koden skulle ha en bugg.
- **Revisionslogg.** Varje ändring loggas av databasen själv med vem, när, före och efter. Lösenord loggas aldrig.
- **Bankkonton och kostnadsställen** per bolag.
- **Designsystem** och grundlayout (sidomeny, startsida, tabeller, formulär, dialoger).

## Struktur

```
db/migrations/   SQL-migreringar (körs i namnordning)
apps/api/        API och affärslogik (NestJS, Drizzle, PostgreSQL)
apps/web/        Webbgränssnitt (Next.js, Tailwind CSS)
```

## Kom igång lokalt

Kräver Node 22, pnpm 10 och PostgreSQL 16 eller senare (till exempel via `docker compose up -d`).

```bash
cp .env.example .env          # justera DATABASE_URL vid behov
pnpm install
pnpm db:migrate
SEED_ADMIN_PASSWORD='välj-ett-lösenord' pnpm db:seed
pnpm build
pnpm dev                      # API på :4000, webb på http://localhost:3000
```

Seed-skriptet lägger upp koncernen med P Dahlqvist Förvaltning AB, HPK AB och Hardebergabanan AB samt användaren `admin@example.se`. **Organisationsnumren i seed-data är påhittade** och ska ersättas med de riktiga under Bolag.

## Tester

Testerna kör mot en riktig PostgreSQL-databas (`fastighet_test` skapas och tas bort automatiskt):

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

De visar bland annat att en förvaltare i ett bolag inte kan läsa eller skriva i ett annat bolag, inte ens genom att manipulera bolagsvalet, och att databasen själv stoppar skrivningar utanför valt bolag.

## Säkerhet

- Varje API-anrop körs som databasrollen `fastighet_app`, som omfattas av RLS. Valda bolag sätts per transaktion (`app.company_ids`).
- Sessioner lagras som SHA-256 av en slumpad token i en http-only-cookie. Lösenord hashas med scrypt.
- I produktion ska `COOKIE_SECURE=true` och trafiken gå över https.
- Inloggning med BankID och tvåfaktor läggs till som en ytterligare inloggningsmetod som skapar samma typ av session (`AuthService.createSession`).

## Nästa fas

Fas 2: fastighetsregister och hyresobjekt (fastigheter, byggnader, objekt, hyror och momsstatus över tid, import från Excel).
