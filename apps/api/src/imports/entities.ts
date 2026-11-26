/**
 * Systemets fält som importerade kolumner kan mappas mot, per typ av post.
 * Fältnycklar skrivs som "<typ>.<fält>", t.ex. "object.objectNr", så att en
 * och samma rad i en fil kan ge flera poster (objekt, hyresgäst och avtal).
 */

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'bool' | 'id';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
}

export interface EntityDef {
  key: EntityKey;
  label: string;
  labelPlural: string;
  /** false = posten kan läsas och kontrolleras men inte sparas ännu. */
  available: boolean;
  unavailableReason?: string;
  fields: FieldDef[];
}

export type EntityKey =
  | 'property'
  | 'object'
  | 'rent'
  | 'customer'
  | 'cotenant'
  | 'contract'
  | 'supplier'
  | 'account'
  | 'voucher'
  | 'invoice'
  | 'payment'
  | 'document';

const ext: FieldDef = { key: 'externalId', label: 'Id i originalsystemet', type: 'id', help: 'Används för att känna igen posten vid nästa import' };

export const ENTITIES: EntityDef[] = [
  {
    key: 'property',
    label: 'Fastighet',
    labelPlural: 'Fastigheter',
    available: true,
    fields: [
      ext,
      { key: 'designation', label: 'Fastighetsbeteckning', type: 'text', required: true },
      { key: 'name', label: 'Namn', type: 'text' },
      { key: 'category', label: 'Kategori', type: 'text', help: 'Bostad, Kommersiell, Blandad, Parkering, Hotell …' },
      { key: 'addressLine', label: 'Adress', type: 'text' },
      { key: 'postalCode', label: 'Postnummer', type: 'text' },
      { key: 'city', label: 'Ort', type: 'text' },
      { key: 'municipality', label: 'Kommun', type: 'text' },
      { key: 'constructionYear', label: 'Byggår', type: 'number' },
      { key: 'areaBoaM2', label: 'BOA (m²)', type: 'number' },
      { key: 'areaLoaM2', label: 'LOA (m²)', type: 'number' },
      { key: 'areaBtaM2', label: 'BTA (m²)', type: 'number' },
      { key: 'siteAreaM2', label: 'Tomtarea (m²)', type: 'number' },
    ],
  },
  {
    key: 'object',
    label: 'Objekt',
    labelPlural: 'Objekt',
    available: true,
    fields: [
      ext,
      { key: 'objectNr', label: 'Objektsnummer', type: 'text', required: true },
      { key: 'propertyRef', label: 'Fastighet', type: 'text', help: 'Beteckning, namn eller id i originalsystemet' },
      { key: 'type', label: 'Typ', type: 'text', required: true, help: 'Lägenhet, Lokal, Parkering, Förråd …' },
      { key: 'areaM2', label: 'Area (m²)', type: 'number' },
      { key: 'rooms', label: 'Antal rum', type: 'number' },
      { key: 'floor', label: 'Våning', type: 'number' },
      { key: 'apartmentNr', label: 'Lägenhetsnummer', type: 'text' },
      { key: 'addressLine', label: 'Adress', type: 'text' },
      { key: 'description', label: 'Beskrivning', type: 'text' },
      { key: 'monthlyRent', label: 'Månadshyra (kr)', type: 'money' },
      { key: 'rentFrom', label: 'Hyra från', type: 'date' },
      { key: 'vatLiable', label: 'Momspliktig', type: 'bool' },
    ],
  },
  {
    key: 'rent',
    label: 'Hyresperiod',
    labelPlural: 'Hyreshistorik',
    available: true,
    fields: [
      { key: 'objectRef', label: 'Objektsnummer', type: 'text', required: true },
      { key: 'monthlyRent', label: 'Månadshyra (kr)', type: 'money', required: true },
      { key: 'validFrom', label: 'Från', type: 'date', required: true },
      { key: 'validTo', label: 'Till', type: 'date' },
      { key: 'reason', label: 'Orsak', type: 'text' },
    ],
  },
  {
    key: 'customer',
    label: 'Hyresgäst',
    labelPlural: 'Hyresgäster',
    available: true,
    fields: [
      ext,
      { key: 'name', label: 'Namn', type: 'text', required: true },
      { key: 'nationalId', label: 'Person- eller organisationsnummer', type: 'text' },
      { key: 'kind', label: 'Person eller företag', type: 'text' },
      { key: 'email', label: 'E-post', type: 'text' },
      { key: 'phone', label: 'Telefon', type: 'text' },
      { key: 'addressLine', label: 'Adress', type: 'text' },
      { key: 'careOf', label: 'c/o', type: 'text' },
      { key: 'postalCode', label: 'Postnummer', type: 'text' },
      { key: 'city', label: 'Ort', type: 'text' },
      { key: 'invoiceReference', label: 'Fakturareferens', type: 'text' },
      { key: 'notes', label: 'Anteckning', type: 'text' },
    ],
  },
  {
    key: 'cotenant',
    label: 'Medhyresgäst',
    labelPlural: 'Medhyresgäster',
    available: true,
    fields: [
      { key: 'name', label: 'Namn', type: 'text', required: true },
      { key: 'nationalId', label: 'Personnummer', type: 'text' },
      { key: 'email', label: 'E-post', type: 'text' },
      { key: 'phone', label: 'Telefon', type: 'text' },
    ],
  },
  {
    key: 'contract',
    label: 'Hyresavtal',
    labelPlural: 'Hyresavtal',
    available: true,
    fields: [
      ext,
      { key: 'customerRef', label: 'Hyresgäst', type: 'text', help: 'Tomt = hyresgästen på samma rad' },
      { key: 'objectRef', label: 'Objekt', type: 'text', help: 'Tomt = objektet på samma rad. Flera objekt avgränsas med komma.' },
      { key: 'startDate', label: 'Startdatum', type: 'date', required: true },
      { key: 'endDate', label: 'Slutdatum', type: 'date' },
      { key: 'type', label: 'Avtalstyp', type: 'text', help: 'Bostad, Lokal, Parkering, Förråd. Tomt = efter objektet.' },
      { key: 'monthlyRent', label: 'Månadshyra (kr)', type: 'money', help: 'Tomt = objektets hyra' },
      { key: 'noticeMonths', label: 'Uppsägningstid (mån)', type: 'number' },
      { key: 'terminationDate', label: 'Uppsagt datum', type: 'date' },
      { key: 'signedDate', label: 'Undertecknat', type: 'date' },
      { key: 'billingInterval', label: 'Avisering', type: 'text', help: 'Månad eller Kvartal' },
    ],
  },
  {
    key: 'supplier',
    label: 'Leverantör',
    labelPlural: 'Leverantörer',
    available: true,
    fields: [
      ext,
      { key: 'name', label: 'Namn', type: 'text', required: true },
      { key: 'orgNr', label: 'Organisationsnummer', type: 'text' },
      { key: 'vatNr', label: 'Momsnummer', type: 'text' },
      { key: 'bankgiro', label: 'Bankgiro', type: 'text' },
      { key: 'plusgiro', label: 'Plusgiro', type: 'text' },
      { key: 'email', label: 'E-post', type: 'text' },
      { key: 'phone', label: 'Telefon', type: 'text' },
      { key: 'addressLine', label: 'Adress', type: 'text' },
      { key: 'postalCode', label: 'Postnummer', type: 'text' },
      { key: 'city', label: 'Ort', type: 'text' },
      { key: 'paymentTermsDays', label: 'Betalningsvillkor (dagar)', type: 'number' },
      { key: 'defaultAccount', label: 'Standardkonto', type: 'text' },
    ],
  },
  {
    key: 'account',
    label: 'Konto',
    labelPlural: 'Kontoplan',
    available: true,
    fields: [
      { key: 'number', label: 'Kontonummer', type: 'text', required: true },
      { key: 'name', label: 'Kontonamn', type: 'text', required: true },
      { key: 'type', label: 'Kontotyp', type: 'text', help: 'T, S, K, I eller tomt = efter kontonumret' },
      { key: 'sruCode', label: 'SRU-kod', type: 'text' },
      { key: 'vatCode', label: 'Momskod', type: 'text' },
    ],
  },
  {
    key: 'voucher',
    label: 'Verifikation',
    labelPlural: 'Konteringar',
    available: true,
    fields: [
      { key: 'series', label: 'Serie', type: 'text' },
      { key: 'voucherNr', label: 'Verifikationsnummer', type: 'text', required: true },
      { key: 'date', label: 'Datum', type: 'date', required: true },
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'account', label: 'Konto', type: 'text', required: true },
      { key: 'amount', label: 'Belopp (kr, debet +)', type: 'money', required: true },
      { key: 'debit', label: 'Debet (kr)', type: 'money' },
      { key: 'credit', label: 'Kredit (kr)', type: 'money' },
      { key: 'costCenter', label: 'Kostnadsställe', type: 'text' },
      { key: 'objectCode', label: 'Objekt', type: 'text' },
      { key: 'lineText', label: 'Radtext', type: 'text' },
    ],
  },
  {
    key: 'invoice',
    label: 'Faktura',
    labelPlural: 'Hyresavier och kundfakturor',
    available: true,
    fields: [
      ext,
      { key: 'invoiceNr', label: 'Fakturanummer', type: 'text', required: true },
      { key: 'customerRef', label: 'Kund', type: 'text', required: true },
      { key: 'invoiceDate', label: 'Fakturadatum', type: 'date', required: true },
      { key: 'dueDate', label: 'Förfallodatum', type: 'date' },
      { key: 'ocr', label: 'OCR', type: 'text' },
      { key: 'total', label: 'Belopp inkl. moms (kr)', type: 'money', required: true },
      { key: 'vat', label: 'Moms (kr)', type: 'money' },
      { key: 'remaining', label: 'Kvar att betala (kr)', type: 'money' },
      { key: 'periodFrom', label: 'Period från', type: 'date' },
      { key: 'periodTo', label: 'Period till', type: 'date' },
      { key: 'objectRef', label: 'Objekt', type: 'text' },
      { key: 'kind', label: 'Typ', type: 'text', help: 'Avi, Faktura eller Kredit' },
    ],
  },
  {
    key: 'payment',
    label: 'Betalning',
    labelPlural: 'Betalningshistorik',
    available: true,
    fields: [
      ext,
      { key: 'paymentDate', label: 'Betaldatum', type: 'date', required: true },
      { key: 'amount', label: 'Belopp (kr)', type: 'money', required: true },
      { key: 'invoiceRef', label: 'Fakturanummer', type: 'text' },
      { key: 'ocr', label: 'OCR', type: 'text' },
      { key: 'customerRef', label: 'Kund', type: 'text' },
      { key: 'payerName', label: 'Betalare', type: 'text' },
    ],
  },
  {
    key: 'document',
    label: 'Dokument',
    labelPlural: 'Dokument och bilagor',
    available: true,
    fields: [
      { key: 'fileName', label: 'Filnamn', type: 'text', required: true },
      { key: 'linkTo', label: 'Kopplas till', type: 'text', help: 'Objektsnummer, avtals-id eller person/orgnr' },
      { key: 'kind', label: 'Typ', type: 'text' },
    ],
  },
];

export const ENTITY = Object.fromEntries(ENTITIES.map((e) => [e.key, e])) as Record<EntityKey, EntityDef>;

/** Ordning som posterna sparas i, så att det som hänvisas till redan finns. */
export const APPLY_ORDER: EntityKey[] = [
  'account',
  'supplier',
  'property',
  'object',
  'rent',
  'customer',
  'cotenant',
  'contract',
  'voucher',
  'invoice',
  'payment',
  'document',
];

export function fieldDef(fieldKey: string): FieldDef | undefined {
  const [entity, field] = fieldKey.split('.');
  return ENTITY[entity as EntityKey]?.fields.find((f) => f.key === field);
}
