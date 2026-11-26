import type { FieldDef } from '@/components/form';
import { CATEGORY_LABEL, OBJECT_TYPE_LABEL } from './format';

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
