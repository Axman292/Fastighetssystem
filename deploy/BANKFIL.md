# Automatisk hämtning av inbetalningar

Systemet kan hämta bankens inbetalningsfiler själv, läsa in dem i rätt bolag och bokföra
de betalningar som matchar en avi. Det som inte matchar hamnar under
**Inbetalningar → Att hantera** och i rapporten **Omatchade inbetalningar**.

## Viktigt: BgMax finns inte längre

Bankgirot slutade skicka BgMax-filer efter **27 november 2026**. I stället skickar banken
**camt.054** (ISO 20022, XML). Systemet läser båda formaten, så gamla BgMax-filer går
fortfarande att ladda upp. camt.053 (kontoutdrag) går också att läsa.

## Så fungerar det

1. Banken lägger en camt.054-fil i en mapp på sin SFTP-server, normalt en gång per bankdag.
2. Systemet loggar in med en SSH-nyckel som det själv har skapat och hämtar nya filer
   (varje timme som standard).
3. Varje avsnitt i filen läses in i det bolag vars **bankgiro** eller **bankkonto (IBAN)**
   det gäller. Bankgiro anges under *Bolag*, bankkonton under bolagets bankkonton.
4. Betalningar med rätt OCR-nummer bokförs direkt mot avin. Resten väntar på hantering.
5. Om något behöver hanteras, eller hämtningen misslyckas, skickas ett mejl till adressen i
   anslutningen.

Samma fil läses aldrig in två gånger, och samma betalning bokförs aldrig två gånger, även om
den finns i flera filer.

## Vad du beställer hos Danske Bank

Ring Danske Banks **Integration Services** eller din företagsrådgivare och säg ungefär:

> Vi tar emot hyror på bankgiro till Danske Bank och vill ha **camt.054 för inkommande
> betalningar** (Bankgiro Inbetalningar), **dagligen**, levererad till vårt eget
> ekonomisystem via **SFTP (filöverföring)**. Det gäller bankgiro … för bolagen … .

Fråga och skriv ned:

- **Server** (adress) och **port** för SFTP.
- **Användarnamn**.
- **Mappen** där filerna läggs till er (Danske kallar mapparna *Inbox* och *Outbox*).
- **Fingeravtryck** för deras server (SHA256), om de kan ge det.
- Om filerna till er är **PGP-krypterade**. Systemet läser i dag okrypterade filer. Är de
  krypterade, säg till så lägger vi in det.
- **Avgiften** för camt.054 och filöverföringen.
- Om ett avtal för **District / Business eBanking** behövs (det krävs för SFTP).

Banken behöver er **publika SSH-nyckel**. Den skapar du i systemet (se nedan) och skickar till
banken. Den hemliga delen lämnar aldrig servern.

Kan du inte få SFTP direkt kan du beställa camt.054 i District, ladda ned filen och läsa in
den för hand under **Inbetalningar → Läs in bankfil** tills vidare.

## Så ställer du in det i systemet

Du behöver vara koncernadministratör.

1. Gå till **Inbetalningar → Automatisk hämtning → Ny anslutning**.
2. Fyll i server, port, användarnamn och mapp från banken. Spara.
3. Klicka **Skapa nyckel**. Kopiera den publika nyckeln och skicka den till banken.
4. När banken säger att nyckeln är inlagd: klicka **Testa**. Då visas vilka filer som finns.
   Bankens fingeravtryck sparas, och systemet vägrar ansluta om det senare ändras.
5. Klicka **Hämta nu** för att läsa in direkt, och **Slå på** för att hämta automatiskt.

## Inställningar på servern

| Variabel | Vad |
| --- | --- |
| `APP_SECRET_KEY` | Hemlig sträng (minst 16 tecken) som krypterar SSH-nyckeln i databasen. I testmiljön skapar Render den själv (`render.yaml`). Finns den inte efter nästa deploy: lägg in den under *Environment* i Render med ett långt slumpat värde. Byts den måste en ny nyckel skapas och skickas till banken. |
| `PUBLIC_URL` | Systemets adress, för länken i mejlen. |
| `BANK_FETCH=off` | Stänger av den schemalagda hämtningen (Hämta nu fungerar ändå). |
| `BANK_FOLDER_ROOT` | Frivilligt. Gör att en anslutning kan läsa filer från en mapp på servern, till exempel om banken eller en annan tjänst lägger filerna där. |

## Testmiljön på Render

Renders gratisnivå somnar efter en stunds inaktivitet. Då körs ingen schemalagd hämtning
förrän någon öppnar sidan igen, och då hämtas det som missats. I produktion (UpCloud) körs
hämtningen dygnet runt.

Danske Bank kan också kräva att anslutningen kommer från en fast IP-adress. Det har inte
Render gratis, men en egen server hos UpCloud har det.
