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
om de saknas. Mer läggs inte in: testmiljön börjar tom (`DEMO_DATA=false`).

Med `TEST_COMPANY_DATA=true` (påslaget i `render.yaml`) fylls bolagen vid varje start med påhittade
betaluppgifter där de saknas: bankgiro (Bankgirots exempelnummer 5050-1055/-1063/-1071), momsnummer,
adress och fakturamejl. Ifyllda värden skrivs aldrig över. Det behövs för att avier ska kunna godkännas.
Använd aldrig detta i produktion.

Med `DEMO_DATA=true` fylls en databas utan fastigheter med demodata vid start. Demodatan (`apps/api/src/scripts/seed-demo.ts`) läggs in genom API:et: fyra fastigheter i tre bolag,
hyresgäster, avtal (två vakanta objekt), avier för fyra månader och betalningar där några hyresgäster
ligger efter, så att påminnelser och kundreskontra har något att visa.

## Börja om från början

Radera projektet i Neon (*Settings → Delete project*) och skapa ett nytt i Frankfurt. Då försvinner
även Neons historik och grenar, så att inget av det gamla innehållet finns kvar. Byt sedan
`DATABASE_URL` i Render under *Environment* till den nya adressen och spara. Vid nästa start läggs
bara koncernen, de tre bolagen och `admin@example.se` upp igen (med lösenordet i `SEED_ADMIN_PASSWORD`).

## Riktig e-post i testmiljön

Renders gratisnivå spärrar SMTP-portarna, så e-post skickas via Brevos HTTP-API (EU, gratis upp till
300 mejl per dag). Lägg in tre värden under *Environment* i Render:

| Nyckel | Värde |
| --- | --- |
| `BREVO_API_KEY` | API-nyckeln från Brevo (*SMTP & API → API keys*). Klistra aldrig in den i chatten. |
| `MAIL_FROM` | Avsändaradressen. Måste vara verifierad som avsändare i Brevo (*Senders, domains & dedicated IPs*). |
| `EMAIL_ALLOWLIST` | De adresser som får ta emot e-post, kommaseparerade. `@domän.se` tillåter en hel domän. |

`EMAIL_ALLOWLIST_ONLY=true` står i `render.yaml`: mejl till andra adresser skickas inte utan sparas i
testläge, och fakturan visar varför under *Utskick*. Utan `BREVO_API_KEY` körs allt i testläge.

## Inloggning och användare

- Under **Användare** bjuder du in nya användare med e-post. De får en länk och väljer själva sitt
  lösenord. I testmiljön skickas inbjudan bara till adresser i `EMAIL_ALLOWLIST`; annars visas länken
  på skärmen så att du kan skicka den själv.
- Under **Mitt konto** (klicka på ditt namn längst ned till vänster) slår du på tvåstegsverifiering
  med en app i telefonen, byter lösenord och ser inloggade enheter.
- `AUTH_SECRET` skapas automatiskt av Render och krypterar tvåstegsnycklarna. Ändra den aldrig.
- Kommer du inte in: välj *Glömt lösenordet?* på inloggningssidan. Har du tappat telefonen, använd en
  reservkod. Som sista utväg kan en annan koncernadministratör nollställa tvåstegsverifieringen.
