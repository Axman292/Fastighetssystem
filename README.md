# Fastighetssystem

Affärssystem för fastighetsförvaltning: fastigheter, hyresobjekt, hyresgäster, avtal, avisering, ekonomi och koppling till Hogia Redovisning. Byggt för en koncern med flera fastighetsägande bolag.

Arkitektur och fullständig databasmodell beskrivs i dokumentet *Fastighetssystem – arkitektur och databasmodell*. Systemet byggs i sex faser. Fas 1 (grunden) och fas 2 (fastigheter och hyresobjekt) är klara.

## Vad som finns i fas 1

- **Bolag och koncern.** Flera juridiska bolag med organisationsnummer (kontrollsiffran valideras), momsnummer, adress, bankgiro, räkenskapsår och Hogia-klient-id.
- **Bolagsväljare.** Byt bolag utan att logga ut, eller visa hela koncernen i läsläge. Ändringar görs alltid i ett valt bolag.
- **Användare, roller och behörigheter.** Koncernadministratör, ekonomiansvarig, förvaltare, attestant, läsbehörig och revisor. En roll per bolag.
- **Bolagsisolering i databasen.** PostgreSQL Row Level Security gör att ett bolags data aldrig syns i ett annat, även om koden skulle ha en bugg.
- **Revisionslogg.** Varje ändring loggas av databasen själv med vem, när, före och efter. Lösenord loggas aldrig.
- **Bankkonton och kostnadsställen** per bolag.
- **Designsystem** och grundlayout (sidomeny, startsida, tabeller, formulär, dialoger).

## Vad som finns i fas 2

- **Fastighetsregister** med beteckning, kategori, adress, byggår, BOA, LOA, BTA, tomtarea och förvärv.
- **Underregister per fastighet:** byggnader, taxering och fastighetsskatt, marknadsvärdering, lån, försäkring, tekniska uppgifter och underhållsplan.
- **Fastighetsöversikt** med antal objekt, uthyrningsbar area, hyresvärde och kr/m², marknadsvärde och belåningsgrad.
- **Hyresobjekt** (lägenhet, lokal, kontor, restaurang, parkering, förråd, hotellrum med flera). Hyra och momsstatus lagras med giltighetsperiod. En ny hyra avslutar den föregående, och historiken skrivs aldrig över. Bostäder kan aldrig bli momspliktiga, vilket både API:et och databasen kontrollerar.
- **Import från Excel** med nedladdningsbar mall. Filen kontrolleras rad för rad och förhandsgranskas, och sedan sparas allt i en transaktion. Rader som redan finns hoppas över.

## Vad som finns i fas 3

- **Hyresgäster** (privatpersoner och företag) med löpande kundnummer per bolag, kontrollerat person-, samordnings- eller organisationsnummer, postadress, separat fakturaadress, fakturareferens, leveranssätt (e-post, brev eller e-faktura via Peppol) och kontaktpersoner. Kundvyn samlar uppgifter, kontakter och avtal.
- **Hyresavtal** för bostad, lokal, parkering, förråd och övrigt. Ett avtal kan omfatta flera objekt. Hyresrader fylls i från objektens hyra och moms och kan kompletteras med värme, el, vatten, tjänster och rabatter. Databasen hindrar att ett objekt hyrs ut i två avtal samtidigt och att bostadsavtal får moms.
- **Avtalsflöde:** utkast, aktivering, uppsägning, återkallad uppsägning, förlängning och makulering. Uppsägning räknar fram slutdatum: tills vidare-avtal från närmaste månadsskifte, tidsbestämda avtal vid avtalstidens slut eller efter förlängning om uppsägningen kom för sent.
- **Hyresändring från ett datum.** Den gamla raden avslutas dagen före och historiken finns kvar. Alla händelser loggas på avtalet.
- **Indexklausul och KPI.** Uppräkning för alla avtal på en gång med förhandsvisning, eller för ett enskilt avtal. Tillägget läggs som en egen rad, med andel och golv mot bashyran. En uppräkning kan inte göras två gånger för samma år.
- **Säkerheter** (deposition, bankgaranti, borgen) med förfallodatum och mottagen/återbetald.
- **Avtalsmallar och PDF** per avtalstyp, med parter, objekt, hyrestid, hyra och moms, indexklausul, säkerhet, villkor och underskrifter. Mallarna finns i `apps/api/src/contracts/contract-pdf.ts` och bör granskas mot bolagets egna villkor.
- **Att hantera:** sista dag för uppsägning, avtal som förlängs eller upphör, omförhandlingar, utkast, aktiva avtal utan hyra och säkerheter som inte kommit in.
- **Objektstatus** (uthyrd, uppsagd, kommande, vakant) räknas fram ur avtalen. Uthyrningsgrad och vakanser visas per fastighet och på översikten.

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

Fas 4: avisering och fakturering (hyresavier per månad eller kvartal ur avtalens rader, OCR, kontroll före utskick, e-post, brev och e-faktura).
