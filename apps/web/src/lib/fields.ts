import type { FieldDef } from '@/components/form';
import { ARTICLE_LABEL, CATEGORY_LABEL, DELIVERY_LABEL, DEPOSIT_LABEL, OBJECT_TYPE_LABEL, VAT_LABEL } from './format';

export const propertyFields: FieldDef[] = [
  { key: 'name', label: 'Namn', required: true, half: true },
  { key: 'designation', label: 'Fastighetsbeteckning', required: true, half: true, placeholder: 'Lund Hästen 12' },
  { key: 'category', label: 'Kategori', type: 'select', options: CATEGORY_LABEL, required: true, half: true },
  { key: 'constructionYear', label: 'Byggår', type: 'number', half: true },
  { key: 'addressLine', label: 'Adress' },
  { key: 'postalCode', label: 'Postnummer', half: true },
  { key: 'city', label: 'Ort', half: true },
  { key: 'municipality', label: 'Kommun', half: true },
  { key: 'siteAreaM2', label: 'Tomtarea (m²)', type: 'number', half: true },
  { key: 'areaBoaM2', label: 'BOA, boarea (m²)', type: 'number', half: true },
  { key: 'areaLoaM2', label: 'LOA, lokalarea (m²)', type: 'number', half: true },
  { key: 'areaBtaM2', label: 'BTA, bruttoarea (m²)', type: 'number', half: true },
  { key: 'acquiredDate', label: 'Förvärvsdatum', type: 'date', half: true },
  { key: 'acquisitionPriceSek', label: 'Köpeskilling (kr)', type: 'number', half: true },
  { key: 'notes', label: 'Anteckningar', type: 'textarea' },
];

export const objectFields: FieldDef[] = [
  { key: 'objectNr', label: 'Objektsnummer', required: true, half: true },
  { key: 'type', label: 'Typ', type: 'select', options: OBJECT_TYPE_LABEL, required: true, half: true },
  { key: 'areaM2', label: 'Area (m²)', type: 'number', half: true },
  { key: 'rooms', label: 'Antal rum', type: 'number', half: true },
  { key: 'floor', label: 'Våning', type: 'number', half: true },
  { key: 'apartmentNr', label: 'Lägenhetsnummer', half: true, hint: 'Lantmäteriets fyrsiffriga nummer' },
  { key: 'addressLine', label: 'Adress' },
  { key: 'description', label: 'Beskrivning', type: 'textarea' },
];

export const newObjectExtraFields: FieldDef[] = [
  { key: 'monthlyRent', label: 'Månadshyra (kr, exkl. moms)', type: 'kronor', half: true },
  { key: 'rentValidFrom', label: 'Hyra gäller från', type: 'date', half: true },
  { key: 'vatLiable', label: 'Momspliktig', type: 'checkbox', hint: 'Endast lokaler med frivillig skattskyldighet' },
];

export const customerFields: FieldDef[] = [
  { key: 'kind', label: 'Typ', type: 'select', options: { person: 'Privatperson', organization: 'Företag eller förening' }, required: true, half: true },
  { key: 'nationalId', label: 'Person- eller organisationsnummer', half: true, placeholder: 'ÅÅMMDD-NNNN' },
  { key: 'name', label: 'Namn', required: true },
  { key: 'email', label: 'E-post', half: true },
  { key: 'phone', label: 'Telefon', half: true },
  { key: 'addressLine', label: 'Adress' },
  { key: 'careOf', label: 'c/o', half: true },
  { key: 'vatNr', label: 'Momsregistreringsnummer', half: true, placeholder: 'SE559000003901' },
  { key: 'postalCode', label: 'Postnummer', half: true },
  { key: 'city', label: 'Ort', half: true },
];

export const customerInvoiceFields: FieldDef[] = [
  { key: 'deliveryMethod', label: 'Fakturor skickas med', type: 'select', options: DELIVERY_LABEL, required: true, half: true },
  { key: 'paymentTermsDays', label: 'Betalningsvillkor (dagar)', type: 'number', half: true },
  { key: 'invoiceReference', label: 'Fakturareferens', half: true },
  { key: 'peppolId', label: 'Peppol-id', half: true, hint: 'Krävs för e-faktura' },
  { key: 'invoiceAddressLine', label: 'Fakturaadress', hint: 'Lämnas tom om den är samma som postadressen' },
  { key: 'invoiceCareOf', label: 'Faktura c/o', half: true },
  { key: 'invoicePostalCode', label: 'Postnummer', half: true },
  { key: 'invoiceCity', label: 'Ort', half: true },
  { key: 'notes', label: 'Anteckningar', type: 'textarea' },
  { key: 'active', label: 'Aktiv hyresgäst', type: 'checkbox' },
];

export const contactFields: FieldDef[] = [
  { key: 'name', label: 'Namn', required: true },
  { key: 'role', label: 'Roll', half: true, placeholder: 'Ekonomiansvarig' },
  { key: 'phone', label: 'Telefon', half: true },
  { key: 'email', label: 'E-post' },
];

export const contractTermsFields: FieldDef[] = [
  { key: 'noticeMonths', label: 'Uppsägningstid (månader)', type: 'number', half: true },
  { key: 'extensionMonths', label: 'Förlängning (månader)', type: 'number', half: true, hint: 'Tom = ingen automatisk förlängning' },
  { key: 'billingInterval', label: 'Aviseras', type: 'select', options: { month: 'Månadsvis', quarter: 'Kvartalsvis' }, required: true, half: true },
  { key: 'paymentTermsDays', label: 'Betalningsvillkor (dagar)', type: 'number', half: true, hint: 'Tom = hyresgästens villkor' },
  { key: 'billingInAdvance', label: 'Hyran betalas i förskott', type: 'checkbox' },
  { key: 'renegotiateBy', label: 'Påminn om omförhandling', type: 'date', half: true },
  { key: 'signedDate', label: 'Undertecknat', type: 'date', half: true },
  { key: 'specialTerms', label: 'Särskilda villkor', type: 'textarea' },
  { key: 'notes', label: 'Interna anteckningar', type: 'textarea' },
];

export const lineFields: FieldDef[] = [
  { key: 'article', label: 'Artikel', type: 'select', options: ARTICLE_LABEL, required: true, half: true },
  { key: 'description', label: 'Text på avin', required: true, half: true },
  { key: 'amount', label: 'Belopp per månad (kr, exkl. moms)', type: 'kronor', required: true, half: true, hint: 'Negativt för rabatt' },
  { key: 'vatRateBp', label: 'Moms', type: 'select', options: VAT_LABEL, required: true, half: true },
  { key: 'validFrom', label: 'Gäller från', type: 'date', half: true, hint: 'Tom = avtalets start' },
  { key: 'validTo', label: 'Gäller till', type: 'date', half: true, hint: 'Tom = avtalets slut' },
  { key: 'indexed', label: 'Omfattas av indexklausulen', type: 'checkbox' },
];

export const depositFields: FieldDef[] = [
  { key: 'kind', label: 'Typ', type: 'select', options: DEPOSIT_LABEL, required: true, half: true },
  { key: 'amount', label: 'Belopp (kr)', type: 'kronor', required: true, half: true },
  { key: 'dueDate', label: 'Ska lämnas senast', type: 'date', half: true },
  { key: 'receivedDate', label: 'Mottagen', type: 'date', half: true },
  { key: 'returnedDate', label: 'Återbetald', type: 'date', half: true },
  { key: 'note', label: 'Anteckning' },
];
