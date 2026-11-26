# Gratis testmiljö

En testmiljö där man kan klicka runt i systemet med **påhittade data**. Den körs gratis:

- **Render** (Frankfurt) kör webben och API:et i en och samma tjänst (`render.yaml`, `deploy/start.sh`).
- **Neon** (Frankfurt) är databasen, PostgreSQL.

Lägg aldrig in riktiga hyresgäster, personnummer eller fakturor här. Gratisnivåerna har ingen
säkerhetskopiering och är inte avsedda för personuppgifter. Riktiga data hör hemma i den riktiga driftmiljön.

## Begränsningar på gratisnivån

- Sidan somnar efter 15 minuter utan besök. Första besöket efter det tar ungefär en minut.
- Databasen somnar efter 5 minuter och vaknar av sig själv på någon sekund.
- Render ger 750 timmar per månad, vilket räcker för en tjänst som är igång hela tiden.
- E-post skickas inte. Fakturor och påminnelser som "skickas" sparas bara som filer i tjänsten (testläge).

## Så sätts den upp

1. **Neon.** Skapa ett konto på neon.com (logga in med GitHub). Skapa ett projekt med regionen
   *AWS Europe Central 1 (Frankfurt)*. Tryck på **Connect** och kopiera anslutningsadressen
   (börjar med `postgresql://`).
2. **Render.** Skapa ett konto på render.com (logga in med GitHub). Välj **New → Blueprint**,
   ge Render tillgång till repot `Fastighetssystem` och välj det.
3. Render läser `render.yaml` och frågar efter två värden:
   - `DATABASE_URL`: klistra in adressen från Neon.
   - `SEED_ADMIN_PASSWORD`: hitta på ett lösenord för testmiljöns inloggning.
4. Tryck **Deploy Blueprint**. Första bygget tar 5–10 minuter. Adressen står överst på tjänstens sida,
   till exempel `https://fastighetssystem-test.onrender.com`.
5. Logga in med `admin@example.se` och lösenordet från steg 3.

Varje gång något slås ihop till `main` byggs testmiljön om automatiskt.

## Vad som händer vid start

`deploy/start.sh` kör databasmigreringarna, lägger upp koncernen och användaren `admin@example.se`
om de saknas och, eftersom `DEMO_DATA=true`, demodata om det inte finns några fastigheter.
Demodatan (`apps/api/src/scripts/seed-demo.ts`) läggs in genom API:et: fyra fastigheter i tre bolag,
hyresgäster, avtal (två vakanta objekt), avier för fyra månader och betalningar där några hyresgäster
ligger efter, så att påminnelser och kundreskontra har något att visa.

## Börja om från början

Töm databasen i Neon (till exempel genom att skapa en ny gren eller ett nytt projekt och byta
`DATABASE_URL` i Render under *Environment*) och starta om tjänsten. Demodatan läggs då upp igen.
