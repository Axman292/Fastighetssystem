# Fastighetssystem

Affärssystem för fastighetsförvaltning: fastigheter, hyresobjekt, hyresgäster, avtal, avisering, ekonomi och koppling till Hogia Redovisning. Byggt för en koncern med flera fastighetsägande bolag.

Arkitektur och fullständig databasmodell beskrivs i dokumentet *Fastighetssystem – arkitektur och databasmodell*. Systemet byggs i faser. Fas 1–6 (grund, fastigheter, hyresgäster och avtal, avisering och fakturering, inbetalningar och reskontra, leverantörer och fastighetsekonomi) är klara.

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

## Vad som finns i fas 4

- **Aviseringskörning.** Välj månad, fakturadatum och fastigheter. Systemet skapar en hyresavi per avtal ur avtalens hyresrader: månadsavtal för månaden, kvartalsavtal i kvartalets första månad, förskott eller efterskott. Hyra för del av månad räknas per dag. Förfallodag blir sista bankdagen före perioden (svenska helgdagar tas med), eller avtalets betalningsvillkor.
- **Förhandsgranskning och kontroller** innan något låses: redan aviserade perioder, saknade aviseringar, avtal som fortfarande är utkast fast hyresgästen flyttat in, objekt som debiteras utan att ingå i avtalet, moms som inte stämmer med objektet eller hyresgästen, belopp som avviker från förra avin, saknad adress eller e-post och bolag utan bankgiro. Fel stoppar godkännandet, varningar måste bekräftas. Har avtalen ändrats sedan granskningen måste körningen granskas igen.
- **Godkännande.** Avierna får fakturanummer i följd utan luckor och OCR-nummer med längd- och kontrollsiffra och låses.
- **Retroaktiva justeringar.** Ändras hyran bakåt i tiden, eller avslutas ett avtal efter att perioden aviserats, räknas skillnaden fram och läggs på nästa avi. Blir beloppet negativt skapas en kreditfaktura.
- **Extra debiteringar** på ett avtal (nycklar, skador, avgifter) följer med nästa avi.
- **Manuella fakturor** (engångsfakturor) med valfria rader, koppling till avtal, objekt och kostnadsställe.
- **Kreditfakturor** för hela eller delar av en faktura, med val om perioden ska aviseras på nytt.
- **Betalningar** registreras manuellt, med delbetalning och överskjutande belopp. Bankfiler läses in från fas 5.
- **PDF** för varje avi och faktura, en samlad PDF för brevavier, **e-post** med PDF och **e-faktura** i Peppol BIS Billing 3.0.
- **Spårbarhet.** Varje fakturarad bär bolag, fastighet, objekt, avtal, avtalsrad och kostnadsställe, så att en senare export till bokföringen kan göras utan dubbelposter.

Databasen hindrar själv att samma avtalsrad aviseras två gånger för samma dag, att en extra debitering faktureras två gånger och att en utfärdad faktura ändras eller tas bort.

## Artikelregister

- **Egna artiklar per bolag** under Administration → Artiklar. Lägg till artiklar (till exempel Bredband, Kabel-TV, Fastighetsskatt), döp om dem och välj intäktskonto ur kontoplanen och standardmoms.
- **Standardartiklarna** (Hyra, Parkering, Förråd, Värme, El, Vatten, Tjänst, Indextillägg, Rabatt, Avgift, Övrigt) används av systemet och kan döpas om men inte tas bort. Befintliga avtal och fakturor behåller sina artiklar.
- Artiklarna används på hyresrader, extra debiteringar och manuella fakturor. När en artikel väljs fylls moms och text i. Bostäder får aldrig moms.
- **Fakturaraden sparar intäktskontot** när den skapas, så att en senare ändring av artikelns konto inte ändrar utfärdade fakturor. Kontot styr också om intäkten räknas som hyra i fastighetens resultat (kontots rapportgrupp, som standard 3010–3016, 3080–3109, 3300–3499 och 3910–3919).
- **Importcentralen** kopplar tillägg till artikeln med samma namn, annars gissas artikeln av texten (bredband, kabel-TV, fastighetsskatt ...).
- En använd artikel kan göras inaktiv men inte tas bort.

## Vad som finns i fas 5

- **Inläsning av bankfiler.** Bankgirots inbetalningsfil (BgMax, tjänsten Bankgiro Inbetalningar) läses in under Inbetalningar. Filen kontrolleras mot bolagets bankgiro och mot filens egna summor. Betalningarna får den betalningsdag som står i filen.
- **Automatisk matchning.** Betalningar kopplas till fakturan via OCR-numret. Saknas OCR används ett fakturanummer i referensen, men bara om inbetalarens namn stämmer med kunden. Annars föreslås en hyresgäst vars namn stämmer med inbetalaren och som har en obetald faktura på exakt beloppet. Förslag bokförs först när någon godkänt dem.
- **Granska innan bokföring.** Filen ligger som utkast tills någon trycker på Bokför. Betalningar som inte hittade sin faktura hamnar under Att hantera, där man väljer kund och faktura eller markerar dem som hanterade utanför systemet.
- **Överbetalning och återbetalning.** Det som betalats för mycket ligger kvar som ej fördelat på kunden och kan fördelas på en annan faktura eller registreras som återbetalt.
- **Påminnelser.** Förfallna fakturor föreslås efter en frist. Påminnelse 1 och 2 skickas med e-post eller skrivs ut som brev. Påminnelseavgiften (högst 60 kr, en gång per faktura) blir en egen momsfri faktura, och en betalning på den ursprungliga OCR:en täcker både hyran och avgiften. Upplupen dröjsmålsränta visas på påminnelsen men debiteras inte. Efter två påminnelser visas fakturan som redo för inkasso.
- **Kundreskontra.** Saldo per kund med åldersanalys (ej förfallet, 1–30, 31–60, 61–90, över 90 dagar), och ett kontoutdrag per kund med löpande saldo, på skärmen och som PDF.
- **Inställningar per bolag:** påminnelseavgift, frist, ny betalningsfrist och dröjsmålsränta.

Databasen hindrar att samma fil läses in två gånger, att samma betalning (Bankgirots löpnummer) bokförs två gånger, att en betalning fördelas eller återbetalas med mer än sitt belopp och att samma påminnelsenivå skickas två gånger.

Filen hämtas i dag i internetbanken och läses in för hand. Inläsningen är skild från filkällan, så att automatisk filöverföring från banken kan kopplas på senare.

### Utskick

E-post skickas på riktigt via **Brevo** (HTTP-API, fungerar även där SMTP-portar är spärrade) när `BREVO_API_KEY` är satt, annars via SMTP när `SMTP_HOST` (och vid behov `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) är satt. Avsändaradressen är `MAIL_FROM` (eller `SMTP_FROM`) och bolagets fakturamejl blir svarsadress. Utan Brevo eller SMTP körs **testläge**: meddelandet sparas som `.eml`-fil i `OUTBOX_DIR` (standard `./outbox`) och inget når hyresgästen. Med `EMAIL_ALLOWLIST_ONLY=true` skickas e-post bara till adresserna i `EMAIL_ALLOWLIST` (kommaseparerad, `@domän.se` tillåter en hel domän); övriga hanteras som testläge. E-faktura sparas som XML tills en Peppol-accesspunkt är ansluten.

## Hyresjustering

- **Ändra hyran för många avtal på en gång** under Avtal → Hyresjustering, till exempel den årliga hyreshöjningen för bostäderna.
- **Urval** på objekttyp (snabbval Bostäder, Lokaler, Parkering och förråd), fastighet, avtalstyp och vilka hyresrader (artiklar) som ändras. Avtal med indexklausul hoppas normalt över, eftersom de räknas upp med KPI.
- **Ändring** i procent (avrundad till hel krona, tiotal kronor eller öre) eller i kronor per månad, från ett datum. Negativt värde sänker hyran.
- **Förhandsgranskning** med hyra före och efter per objekt och avtal, total ökning per månad och år, och möjlighet att välja bort enskilda rader. Rader som redan ändrats från datumet eller har en senare ändring hoppas över. Är perioden redan aviserad läggs skillnaden på nästa avi.
- **Objektens hyra** ändras med samma procent eller belopp, även för lediga objekt, så att nästa avtal får rätt hyra.
- **Historik.** Den gamla raden avslutas dagen före och finns kvar. Varje justering sparas med nummer, urval, vem som gjorde den och varje ändrad rad, och noteras på avtalen.
- **Ångra** går så länge den nya hyran inte har aviserats och raderna inte ändrats efteråt.

## Vad som finns i fas 6

- **Kontoplan.** Varje bolag får ett urval BAS-konton för fastighetsbolag (även nya bolag). Konton kan läggas till och kompletteras från Hogia via importcentralen. Varje konto hör till en rapportgrupp (hyresintäkter, drift, underhåll, fastighetsskatt, försäkring, administration, räntor, investeringar) som bestäms av kontonumret men kan ändras.
- **Leverantörsregister** med löpnummer, organisationsnummer, bankgiro och plusgiro (kontrollsiffran kontrolleras), betalningsvillkor och standardkonto.
- **Leverantörsfakturor.** Registrering med löpnummer, förfallodag från villkoren, OCR, kreditfakturor och öresavrundning. Konteringen görs per rad på konto, fastighet, objekt och kostnadsställe, med period när fakturan avser flera månader. För bostäder är momsen inte avdragsgill och räknas som kostnad. Nya fakturor får konteringsförslag från leverantörens senaste faktura.
- **Attest och betalning.** Attest kräver att konteringen summerar till fakturan och låser den. Betalningar (även delbetalningar) registreras på attesterade fakturor. Makulering med orsak. Fakturan bifogas som PDF eller bild och sparas i sju år. Varje steg loggas på fakturan.
- **Leverantörsreskontra** med åldersanalys per leverantör, och listor för att attestera, att betala och förfallet.
- **Bokföringsunderlag** visas per faktura (kostnadskonton, ingående moms 2640, leverantörsskuld 2440) så att en senare export till Hogia kan göras utan dubbelposter. Inget skickas till Hogia ännu.
- **Resultat per fastighet** för valfri period: hyresintäkter, övriga intäkter, drift, underhåll, fastighetsskatt, försäkring, administration, driftnetto, räntor och resultat efter räntor. Intäkterna kommer från utfärdade avier och fakturor, kostnaderna från leverantörsfakturor, fördelade per dag på den period de avser. Saknas bokad fastighetsskatt, försäkring eller ränta beräknas den ur fastighetsregistret och märks som beräknad.
- **Nyckeltal:** direktavkastning (driftnetto i helårstakt på senaste marknadsvärdet), ekonomisk vakansgrad (hyresvärde som inte täcks av avtal), hyresintäkt och kostnad per m², och per månad.
- **Budget** per fastighet, år och rapportgrupp, med föregående års utfall som stöd. Budget mot utfall visas i resultaträkningen.
- **Ekonomi:** jämförelse av fastigheter och bolag, och koncernen totalt, med sortering på driftnetto, avkastning, vakans, kostnad per m² och avvikelse mot budget.

Databasen hindrar att samma leverantörsfaktura registreras två gånger, att en attesterad faktura eller dess kontering ändras, att en faktura attesteras med kontering som inte stämmer och att mer betalas än fakturans belopp.

## Rapporter

Under **Rapporter** finns sju rapporter. Alla visar valt bolag eller hela koncernen, kan begränsas till en fastighet och kan hämtas som **Excel** eller **PDF**.

- **Hyreslista.** Alla objekt per ett datum med hyresgäst, avtal, hyra, tillägg, moms, årshyra och kr/m², och en sammanställning per fastighet med vakant hyra och uthyrningsgrad.
- **Aviseringsjournal.** Utfärdade avier, fakturor och kreditfakturor under perioden, med summor per artikel, konto och momssats.
- **Månadsanalys.** Fakturerad hyra och tillägg, krediterat, moms, inbetalt och hyresbortfall för vakanser månad för månad, och netto per fastighet och månad.
- **Avstämning kundfordran.** Ingående saldo, fakturerat, krediterat, inbetalt, återbetalt och utgående saldo per kund. När perioden slutar i dag eller senare kontrolleras saldot mot kundreskontrans öppna poster, och differensen ska vara noll.
- **Momsavstämning.** Utgående moms per momssats och konto, ingående moms från leverantörsfakturor och ett förslag till momsdeklarationens rutor 05, 10–12, 42, 48 och 49.
- **Frivillig skattskyldighet.** Momspliktiga lokaler, momspliktig andel av area och hyra per fastighet (underlag för avdrag av ingående moms) och avvikelser, till exempel ett momspliktigt objekt där avtalet saknar moms eller en privatperson som hyresgäst.
- **In- och avflyttningslista.** Alla in- och avflyttningar under perioden med objekt, hyresgäst, hyra och uppsägning.

Rapporterna läser bara data. De ändrar ingenting och kräver ingen ny databastabell.

## Dröjsmålsränta, avbetalningsplaner och inkasso

Under **Ränta och inkasso**.

- **Dröjsmålsränta debiteras på riktigt.** Räntan räknas per dag från dagen efter förfallodagen på det som var obetalt, även för fakturor som redan betalats för sent. Satsen är referensräntan för kalenderhalvåret plus 8 procentenheter (räntelagen), en fast ränta per bolag eller en avtalad ränta på avtalet. Referensräntorna ligger i tabellen `reference_rate` och fylls på varje 1 januari och 1 juli (`PUT /reference-rates`, koncernadministratör).
- **Debiteras på nästa hyresavi** (en extra debitering på avtalet) eller **som egen räntefaktura** som skickas som vanligt. Fakturor utan avtal får alltid räntefaktura. Räntan är momsfri och bokförs på 8313 (artikeln Dröjsmålsränta). Samma dag räntedebiteras aldrig två gånger (databasen stoppar det), och det blir ingen ränta på ränta eller på påminnelseavgifter. Belopp under bolagets lägsta belopp växer till nästa gång. Ingen ränta räknas före bolagets startdatum, som är dagen då funktionen installerades.
- **Avbetalningsplaner** för en eller flera obetalda fakturor, i ett antal lika delbetalningar eller med ett belopp per månad. Hyresgästen betalar med OCR-numret på planens första faktura och betalningen fördelas på planens fakturor, äldst först. Fakturorna påminns inte och lämnas inte till inkasso så länge planen gäller. Brev till hyresgästen som PDF. En plan kan markeras som klar, bruten eller makulerad.
- **Inkasso.** Fakturor som fått båda påminnelserna utan att betalas visas som redo för inkasso. Ett ärende per hyresgäst samlar fakturorna med deras påminnelseavgifter, räntefakturor och upplupen ränta. Ärendefil till inkassobolaget som **Excel** eller **CSV**, och en **kravsammanställning** som PDF. Status: förberett, skickat till inkasso, betalningsföreläggande, betalt, återkallat eller avskrivet. Hos inkassobolaget debiterar systemet ingen egen ränta. Inbetalningar registreras som vanligt.
- **Avskrivning som kundförlust.** Det obetalda krediteras med en kreditfaktura som bokförs på kundförlustkontot (standard 6350) och följer med SIE-exporten. Momsen på momspliktiga fakturor återförs.
- **Inställningar per bolag** under Bolag: referensränta eller fast ränta, marginal, lägsta belopp, hur räntan debiteras, startdatum och konto för kundförluster.

## Bokföring med SIE-fil

Under **Bokföring** skapas en SIE-fil (SIE typ 4, PC8) med verifikationer för valt bolag, som läses in i Hogia eller ett annat ekonomiprogram. Ingen koppling mot Hogias API behövs.

- **Period** väljs som månad (standard), vecka, dag eller valfri period. Knappen *Allt sedan förra exporten* fyller i perioden från förra exporten till i dag.
- **Innehåll:** avier, fakturor och kreditfakturor (kundfordran mot intäktskonto per artikel, utgående moms per sats, öresavrundning), påminnelseavgifter (egna fakturor), inbetalningar (bank mot kundfordran, ej fördelat belopp på förskott från kunder 2420), senare fördelning av förskott, återbetalningar, attesterade leverantörsfakturor (kostnad, ingående moms, leverantörsskuld) och betalningar till leverantörer.
- **Förhandsgranskning** med verifikationer, kontering, summa per konto och varningar: ej godkända aviseringskörningar, ej bokförda bankfiler, ej attesterade leverantörsfakturor och konton som saknas i kontoplanen.
- **Ingen dubbelbokföring.** Varje händelse exporteras en gång. Exporteras samma period igen kommer bara det nya med. Ändras eller tas något bort efter exporten (till exempel en betalning) kommer en rättelseverifikation med nästa export. Händelser som registrerats i efterhand med datum i en redan exporterad period följer med i nästa export med sitt eget datum.
- **Ångra** går för den senaste exporten, om filen inte gick att läsa in.
- **Inställningar per bolag:** verifikationsserie (standard A), startdatum (det som hänt före finns redan i bokföringen), konton för bank, kundfordran, förskott, leverantörsskuld, moms och öresavrundning, och om kostnadsställe (dimension 1) och fastighet som projekt (dimension 6) ska följa med.
- Verifikationsnumret lämnas tomt så att ekonomiprogrammet numrerar. Varje fil sparas och kan hämtas igen.

## Bokföring som i Hogia DinHyresvärd

- **Samma konton som i dag.** Kontoplanen har FastBAS-kontona som DinHyresvärd använder: kundfordran 1510, skulder till hyresgäster 2420, förutbetalda hyror 2971, utgående moms för uthyrning 2613, hyresintäkter 3010–3016, hyresbortfall 3080–3085, påminnelseavgift 3540, fastighetsskatt 3950 med flera.
- **Standardartiklarna** bokförs som i DinHyresvärd: hyra, parkering, förråd och indextillägg på 3010, rabatt 3090, vatten, el och värme på 3110–3130, kabel-TV 3070, fastighetsskatt 3950, avgifter 3540 och övrigt 3690.
- **Intäktskonto per fastighet** under Administration → Artiklar. En artikel kan bokföras på ett eget konto i en viss fastighet, och skilt för rader med och utan moms (till exempel hyra i Ugglan på 3100 utan moms och 3101 med moms). Gäller nya fakturarader.
- **Exporten** använder verifikationsserie E och moms 25 % på 2613 som standard.
- Egna konton per fastighet (3100, 3300, 3401 ...) och kostnadskontona läses in från Hogia med en SIE 4-fil i importcentralen.

## Dataskydd (GDPR)

Under Administration → Dataskydd, per bolag.

- **Anonymisering av tidigare hyresgäster.** När hyresgästen har flyttat, allt är betalt och lagringstiden gått (standard 24 månader, minst 6) tas namn, personnummer, kontaktuppgifter, adresser, anteckningar, kontaktpersoner, e-postadresser i utskicksloggen och dokument bort. Kunden ligger kvar som "Anonymiserad kund 1042" så att avtal, fakturor och bokföring hänger ihop. Företagskunder behåller namn och organisationsnummer om inget annat väljs.
- **Hinder.** Ett gällande avtal, obetalda fakturor, en inbetalning som inte är fördelad, en deposition som inte är återbetald, en inbetalning som väntar på bokföring eller ett fakturautkast stoppar gallringen tills det är löst.
- **Bokföringslagen.** Fakturor och betalningar är räkenskapsinformation och behåller mottagarens namn och adress i 7 år efter utgången av det kalenderår då räkenskapsåret avslutades (brutet räkenskapsår tas med). Därefter rensas även fakturornas mottagare, bankfilernas betalaruppgifter och noteringar. Belopp och bokföring ändras aldrig.
- **Importfiler** i importcentralen rensas efter en egen lagringstid (standard 12 månader). En rensad import kan inte ångras.
- **Revisionsloggen** maskeras för de rader som gallras (värdet blir `[gallrad]`), så att uppgifterna inte finns kvar i historiken.
- **Förhandsgranskning** av vad som gallras nu, vad som stoppas och vilka som står på tur, och knappen **Gallra nu**.
- **Automatisk gallring** en gång per dygn när den är påslagen (avstängd från början). Stängs av helt med `GDPR_AUTO=off`.
- **Logg** över varje gallring, utan namn eller personnummer.
- **Registerutdrag** (artikel 15) för en hyresgäst som PDF eller JSON från kundsidan, med ändamål, rättslig grund, lagringstider, mottagare och rättigheter. Varje utdrag loggas.
- **Anonymisera på begäran** från kundsidan, utan att vänta på lagringstiden. Hindren och bokföringslagen gäller fortfarande.

## Utskick till hyresgäster

- **E-post och SMS** till alla hyresgäster eller ett urval under *Utskick*: nuvarande, uppsagda, kommande eller tidigare hyresgäster, fastigheter, objekttyper och avtalstyper. Kontaktpersoner kan tas med.
- **Mallar.** Färdiga mallar (vattenavstängning, planerat underhåll, tillträde till lägenhet, allmän information) och bolagets egna mallar.
- **Kopplingsfält** som `{namn}`, `{förnamn}`, `{fastighet}`, `{adress}`, `{objekt}`, `{lägenhet}`, `{avtal}`, `{kundnummer}`, `{bolag}` och `{datum}` fylls i för varje hyresgäst. Okända fält stoppar utskicket.
- **Förhandsgranskning** av texten för varje hyresgäst, vem som saknar e-post eller mobilnummer, antal SMS-delar, bortval av enskilda hyresgäster och provutskick till sig själv.
- **Logg.** Varje mottagare och kanal sparas med den text som skickades och hur det gick. Loggen syns på utskicket och på hyresgästen. Misslyckade kan skickas igen. Stora utskick skickas i bakgrunden.
- **SMS** via Brevo (`SMS_PROVIDER=brevo`, samma `BREVO_API_KEY` som e-posten, SMS-krediter köps i Brevo) eller 46elks (`SMS_PROVIDER=46elks`, `ELKS_API_USERNAME`, `ELKS_API_PASSWORD`). Avsändarnamn `SMS_FROM` (högst 11 tecken), annars bolagets namn. Utan leverantör körs testläge. I testmiljön (`EMAIL_ALLOWLIST_ONLY=true` eller `SMS_ALLOWLIST_ONLY=true`) får bara numren i `SMS_ALLOWLIST` SMS.
- Rättigheten `message.send` har koncernadministratör, ekonomiansvarig och förvaltare. Loggen tas bort när hyresgästen anonymiseras.

## Startsida med nyckeltal

- **Översikt** visar valt bolag eller hela koncernen: uthyrningsgrad (på hyresvärde och antal objekt), avtalad hyra per månad, obetalt och förfallet, inbetalt denna månad mot det som förfaller i månaden, lediga objekt, omatchade inbetalningar och avtal att hantera.
- **Diagram** över fakturerat och inbetalt per månad det senaste året och obetalt efter ålder.
- **Avtal** som slutar inom 90 dagar, uppsägningar som kommit in de senaste 30 dagarna och bevakningslistan för avtal.
- **Uthyrning per fastighet** och, i koncernvyn, en tabell per bolag.
- Varje tal länkar till listan det är räknat ur. Talen kommer från `GET /dashboard` (`apps/api/src/dashboard`).
- **Andra moduler kan lägga till egna kort**, till exempel öppna felanmälningar, med `registerDashboardExtra` i `apps/api/src/dashboard/extras.ts`.

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

## Testmiljö på nätet

En gratis testmiljö med påhittade data kan sättas upp på Render och Neon (båda i Frankfurt). Se [deploy/TESTMILJO.md](deploy/TESTMILJO.md). Lokalt fylls samma demodata i med `SEED_ADMIN_PASSWORD=... node apps/api/dist/scripts/seed-demo.js` efter `pnpm db:seed`.

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
- Inloggning: e-post och lösenord, och tvåstegsverifiering med autentiseringsapp (TOTP, RFC 6238) med reservkoder. Användare bjuds in med e-postlänk och väljer själva lösenord; glömt lösenord skickar en länk som gäller 1 timme. Kontot spärras 15 minuter efter 5 fel, för många fel från samma IP stoppas, och sessionen loggas ut efter inaktivitet (koncernens inställning, standard 30 minuter) och senast efter 12 timmar. Allt loggas i `login_event` och visas under Användare → Inloggningslogg. Koncernadministratören kan kräva tvåstegsverifiering för alla.
- `AUTH_SECRET` krypterar hemligheterna för tvåstegsverifiering (AES-256-GCM). Sätt den i produktion och byt den aldrig. `APP_URL` är adressen i länkar i e-post.
- BankID kan läggas till som ytterligare inloggningsmetod som skapar samma typ av session (`AuthService.createSession`).

## Nästa fas

Bestäms tillsammans med axel. Bokföringen förs över till Hogia med SIE-fil; en direktkoppling mot Hogias API väntar.

## Felanmälan och ärenden

- **Felanmälningsformulär per fastighet** under Felanmälan → Formulär och länkar. Varje fastighet får en egen länk och QR-kod (för anslag i trapphuset). Hyresgästen behöver inte logga in, väljer lägenhet, typ av fel, beskriver felet, bifogar upp till fem bilder och anger om huvudnyckel får användas.
- **Spamskydd:** dolt fält för robotar, minsta ifyllnadstid med signerad biljett, högst fem anmälningar per IP-adress och timme (`FAULT_REPORTS_PER_IP`), längdgränser, bara bildfiler och spärr mot texter med många länkar. En länk kan bytas ut så att den gamla slutar fungera.
- **Ärenden** med löpnummer per bolag, kategori, prioritet (akut, hög, normal, låg) med förslag på klart-datum, status (ny, hos hantverkare, pågår, väntar, åtgärdad, avslutad, makulerad), ansvarig handläggare och hantverkare ur leverantörsregistret. Ärenden kan också registreras för hand, till exempel efter ett samtal.
- **Hyresgästen kopplas automatiskt** när e-post eller telefon stämmer med hyresgästen på objektet.
- **Arbetsorder till hantverkaren** med e-post, bilderna bifogade och en egen länk där hantverkaren ser allt och kvitterar påbörjat eller utfört, med kommentar och bilder.
- **Anmälaren följer ärendet** på en egen statussida och kan skriva till förvaltningen. Kommentarer kan vara interna, till anmälaren eller till hantverkaren.
- **E-post:** besked om nya anmälningar till bolagets adresser och den ansvarige, kvittens till anmälaren, besked när ärendet påbörjas eller åtgärdas och arbetsordern till hantverkaren. Allt loggas i ärendet.
- **Kostnader:** leverantörsfakturor kopplas till ärendet och jämförs med kostnadsramen. Fakturan visar vilket ärende den hör till.
- **Dataskydd:** anmälarens namn, e-post, telefon och IP-adress gallras med hyresgästen, och för anmälningar utan hyresgäst när ärendet varit avslutat under lagringstiden. Felanmälningar finns med i registerutdraget.

## Lediga objekt och intresselista

- **Lediga objekt** visar objekt som står lediga i dag och objekt som blir lediga när ett avtal sägs upp eller löper ut utan att ett nytt tar vid. Allt räknas fram ur avtalen. Per objekt visas ledigt sedan, antal dagar, hyra och förlorad hyra (månadshyra × 12 / 365 per dag), och överst uthyrningsgrad, hyresbortfall per månad och hittills i år.
- **Intresselista** med anmälningar från personer och företag: önskad objekttyp, fastigheter, minsta antal rum och yta, högsta hyra och inflyttningsdatum. Status ny, kontaktad, erbjuden, blev hyresgäst, tackade nej eller återkallad, och interna anteckningar.
- **Publikt formulär** (`/intresseanmalan/<nyckel>`) som slås på per bolag under Intresselista → Formulär och inställningar. Den som anmäler sig måste godkänna samtyckestexten, som sparas på anmälan. Formuläret har spärr mot många anmälningar från samma adress och en fälla för robotar.
- **Matchning.** Varje ledigt objekt visar hur många i intresselistan som passar, först anmäld först. Ett objekt kan erbjudas och svaret noteras. **Gör till hyresgäst** lägger upp intressenten som hyresgäst och skapar ett avtalsutkast för objektet med objektets hyra, i en transaktion.
- **GDPR.** Anmälningar tas bort helt när ingen kontakt skett under lagringstiden (standard 12 månader) i den vanliga gallringen under Dataskydd. En anmälan kan också tas bort direkt på begäran; personuppgifterna maskas då i revisionsloggen.
