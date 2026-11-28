# Autogiro för hyresbetalning

Med autogiro dras hyran automatiskt från hyresgästens bankkonto på förfallodagen.
Systemet håller reda på medgivandena, skapar filerna till Bankgirot, läser Bankgirots svar,
bokför de dragna hyrorna och skickar en vanlig avi när en dragning inte går igenom.

## Gäller Autogiro fortfarande 2026?

Ja. Bankgirot stänger Leverantörsbetalningar, Löner och Bankgiro Inbetalningar (BgMax) under
2026, men **Autogiro påverkas inte**. Bankgirot skriver att tjänsten och filerna för den
fortsätter som vanligt tills vidare (Bankgirots frågor och svar om omställningen, november
2026). Ett moderniseringsarbete pågår, men inget datum är satt. Systemet använder Bankgirots
**nya Autogiroformat** (80 tecken per post), som är det som gäller i dag.

## Så fungerar det

1. **Medgivande.** Hyresgästen fyller i och skriver under medgivandeblanketten (Autogiro →
   Medgivanden → Blankett), eller anmäler autogiro i sin egen internetbank med sitt
   kundnummer som betalarnummer.
2. **Registrera.** Blanketter läggs in under *Nytt medgivande*. Medgivanden från internetbanken
   kommer in med Bankgirots fil och godkänns eller avvisas med en knapp.
3. **Skicka medgivandefil.** *Skapa medgivandefil* ger en fil som skickas till Bankgirot.
   Makuleringar följer med i samma fil.
4. **Bankgirots svar.** Bankgirot svarar med en *medgivandeavisering*. Läs in den med
   *Läs in fil från Bankgirot*. Godkända medgivanden blir gröna.
5. **Avisering.** När en aviseringskörning godkänns planeras en dragning på förfallodagen för
   varje avi till en hyresgäst med medgivande. Avin säger att beloppet dras via autogiro.
6. **Skicka dragningsfil.** *Skapa dragningsfil* under Dragningar. Skicka filen till Bankgirot
   senast bankdagen före första förfallodagen.
7. **Resultat.** Bankgirot skickar en *betalningsspecifikation* efter dragningen. När den läses
   in bokförs de dragna hyrorna på avierna. Saknades täckning eller finns inget medgivande
   markeras dragningen som misslyckad och hyresgästen får avin igen som vanlig avi med OCR
   (e-post direkt, brev ligger kvar för utskrift i aviseringskörningen).

Samma fil läses aldrig in två gånger, och en dragning bokförs aldrig två gånger.

### Observera

- Autogiropengarna kommer in på bankgirot som en samlad insättning. Om den insättningen också
  syns i en camt-fil från banken under Inbetalningar ska den markeras som hanterad där, så att
  hyran inte bokförs två gånger. Hyrorna bokförs från Bankgirots betalningsspecifikation.
- Filer till Bankgirot ska enligt Bankgirot ha ett skydd mot ändring (sigill eller
  motsvarande). När filen skickas via bankens filtjänst eller Bankgirots webbtjänst sköter
  tjänsten det. Behöver Bankgirot ett eget sigill (HMAC) i filen, säg till så läggs det in.
- Medgivandeblankettens villkorstext följer Bankgirots villkor i sak. Jämför den med Bankgirots
  senaste medgivandetext innan den används skarpt.

## Vad du beställer

Autogiro beställs via banken (Danske Bank). Bankgirot ger sedan ett kundnummer.

Ring Danske Banks företagsrådgivare eller Integration Services och säg ungefär:

> Vi vill ta emot hyror med **Bankgirots Autogiro** på bankgiro … för bolaget … . Vi använder
> **nya Autogiroformatet** och vill skicka medgivande- och betalningsfiler själva och få
> tillbaka **medgivandeavisering**, **betalningsspecifikation med stoppade betalningar** och
> **avvisade betalningsuppdrag** som filer. Vi vill också kunna ta emot **medgivanden via
> internetbanken**.

Fråga och skriv ned:

- **Kundnumret hos Bankgirot** (sex siffror). Det fylls i under Autogiro → Inställningar.
- **Hur filerna skickas och hämtas**: via Danske Banks filtjänst (samma SFTP som camt.054),
  via Bankgirots webbtjänst för filöverföring, eller på annat sätt.
- Om filerna behöver ett **sigill** och i så fall hur nyckeln fås.
- Att **stoppade betalningar** (täckning saknas) ska komma med i betalningsspecifikationen.
  Annars kan systemet inte skicka vanlig avi när dragningen misslyckas.
- Om ni vill ha **förnyad täckningskontroll** (Bankgirot försöker igen några dagar om pengarna
  saknas).
- **Avgifter**: fast avgift och pris per dragning och medgivande.

Gör detta för varje bolag som ska ha autogiro (P Dahlqvist Förvaltning AB, Hardebergabanan AB,
Fastighets Hemporten K AB). Varje bolag får eget kundnummer.

## Så kommer du igång i systemet

1. Välj bolaget och gå till **Autogiro → Inställningar**. Fyll i kundnumret och bocka i
   *Använd autogiro för bolaget*. Bankgirot hämtas från bolaget om fältet lämnas tomt.
2. Skicka medgivandeblanketten till de hyresgäster som vill betala med autogiro.
3. Lägg in påskrivna blanketter och skapa en medgivandefil.
4. När medgivandena är godkända planeras dragningar vid nästa aviseringskörning. Avier som
   redan är utskickade kan tas med med *Planera obetalda avier*.
