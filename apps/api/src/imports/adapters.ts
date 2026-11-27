import type { Cell, ParsedTable } from './formats';
import { ENTITIES } from './entities';

/**
 * Källadaptrar: kunskap om hur ett visst fastighetssystem exporterar data.
 * En adapter känner igen en tabell, föreslår mappning mot systemets fält och
 * kan härleda värden som inte finns som egna kolumner (t.ex. typ ur
 * "2 rum och kök"). Ett nytt källsystem läggs till som en ny adapter här.
 */

export type Fields = Record<string, Cell>;

export interface Detection {
  profile: string;
  label: string;
  score: number;
  mapping: Record<string, string>;
}

export interface SourceAdapter {
  key: string;
  label: string;
  description: string;
  detect(table: ParsedTable, fileName: string): Detection | null;
  /** Kompletterar mappade fält för en rad. raw är hela raden med rubrik som nyckel. */
  derive?(profile: string, fields: Fields, raw: Record<string, Cell>, headers: string[]): void;
}

// ---------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findHeader(headers: string[], ...patterns: (string | RegExp)[]): string | undefined {
  for (const p of patterns) {
    const hit = headers.find((h) => (typeof p === 'string' ? norm(h) === norm(p) : p.test(h)));
    if (hit) return hit;
  }
  return undefined;
}

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

/** "Månadshyra november 2026" → 2026-11-01 */
export function monthFromHeader(h: string): string | null {
  const m = h.toLowerCase().match(/(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)\s+(\d{4})/);
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-01`;
  const d = h.match(/(\d{4})-(\d{2})(?!-\d)/);
  return d ? `${d[1]}-${d[2]}-01` : null;
}

/** "Testgatan 1 A LGH 11, 223 52 Lund" → gata, postnummer, ort */
export function splitAddress(s: string | null): { street: string | null; postalCode: string | null; city: string | null } {
  if (!s) return { street: null, postalCode: null, city: null };
  const m = String(s).match(/^(.*?),\s*(\d{3})\s?(\d{2})\s+(.+)$/);
  if (!m) return { street: String(s).trim(), postalCode: null, city: null };
  return { street: m[1].replace(/\s+/g, ' ').trim(), postalCode: `${m[2]} ${m[3]}`, city: m[4].trim() };
}

function text(v: Cell): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ---------------------------------------------------------------------
// Generell adapter: känner igen kolumner efter vanliga namn
// ---------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  'property.designation': ['fastighetsbeteckning', 'beteckning', 'fastighet beteckning'],
  'property.name': ['fastighetsnamn', 'fastighet namn'],
  'property.category': ['kategori', 'fastighetskategori', 'fastighetstyp'],
  'property.municipality': ['kommun'],
  'property.constructionYear': ['byggar', 'byggnadsar'],
  'property.areaBoaM2': ['boa'],
  'property.areaLoaM2': ['loa'],
  'property.areaBtaM2': ['bta'],
  'property.siteAreaM2': ['tomtarea', 'tomtyta'],
  'object.objectNr': ['objektsnummer', 'objektnummer', 'objekt nr', 'objektnr', 'objekt id'],
  'object.propertyRef': ['fastighet', 'fastighetsbeteckning', 'fastighetsnamn'],
  'object.type': ['typ', 'objekttyp', 'objektstyp'],
  'object.areaM2': ['area', 'yta', 'storlek', 'kvm', 'm2'],
  'object.rooms': ['rum', 'antal rum'],
  'object.floor': ['vaning', 'vaningsplan'],
  'object.apartmentNr': ['lagenhetsnummer', 'lgh nr', 'skatteverkets lagenhetsnummer'],
  'object.addressLine': ['adress', 'gatuadress'],
  'object.monthlyRent': ['manadshyra', 'hyra per manad', 'hyra'],
  'object.rentFrom': ['hyra fran', 'giltig fran'],
  'object.vatLiable': ['momspliktig', 'moms'],
  'rent.objectRef': ['objektsnummer', 'objektnummer', 'objekt'],
  'rent.monthlyRent': ['manadshyra', 'hyra'],
  'rent.validFrom': ['fran', 'fran och med', 'from', 'giltig fran', 'fr o m'],
  'rent.validTo': ['till', 'till och med', 'tom', 'giltig till', 't o m'],
  'customer.externalId': ['kundnummer', 'kundnr', 'hyresgastnummer', 'hyresgast id', 'kund id'],
  'customer.name': ['hyresgast', 'kundnamn', 'namn', 'kund'],
  'customer.nationalId': ['personnummer', 'organisationsnummer', 'person orgnr', 'orgnr', 'pnr', 'person organisationsnummer'],
  'customer.email': ['e post', 'epost', 'email', 'mejl'],
  'customer.phone': ['telefon', 'mobil', 'tel'],
  'customer.addressLine': ['adress', 'postadress', 'utdelningsadress'],
  'customer.careOf': ['c o', 'co adress'],
  'customer.postalCode': ['postnummer', 'postnr'],
  'customer.city': ['ort', 'postort'],
  'contract.externalId': ['avtalsnummer', 'kontraktsnummer', 'avtal nr', 'kontrakt nr', 'avtalsnr', 'kontraktsnr'],
  'contract.startDate': ['startdatum', 'avtal fran', 'kontrakt startdatum', 'tilltradesdatum', 'inflyttningsdatum'],
  'contract.endDate': ['slutdatum', 'avtal till', 'kontrakt slutdatum', 'avflyttningsdatum'],
  'contract.noticeMonths': ['uppsagningstid'],
  'contract.terminationDate': ['uppsagt datum', 'uppsagningsdatum'],
  'supplier.externalId': ['leverantorsnummer', 'leverantorsnr', 'lev nr'],
  'supplier.name': ['leverantor', 'leverantorsnamn', 'namn'],
  'supplier.orgNr': ['organisationsnummer', 'orgnr'],
  'supplier.bankgiro': ['bankgiro', 'bg'],
  'supplier.plusgiro': ['plusgiro', 'pg'],
  'supplier.email': ['e post', 'epost', 'email'],
  'supplier.phone': ['telefon'],
  'supplier.addressLine': ['adress'],
  'supplier.postalCode': ['postnummer', 'postnr'],
  'supplier.city': ['ort'],
  'supplier.paymentTermsDays': ['betalningsvillkor', 'kredittid'],
  'account.number': ['konto', 'kontonummer', 'kontonr'],
  'account.name': ['kontonamn', 'benamning', 'namn'],
  'account.type': ['kontotyp'],
  'account.sruCode': ['sru'],
  'account.vatCode': ['momskod'],
  'voucher.series': ['serie', 'verifikationsserie'],
  'voucher.voucherNr': ['verifikationsnummer', 'vernr', 'verifikation'],
  'voucher.date': ['datum', 'verifikationsdatum', 'bokforingsdatum'],
  'voucher.text': ['text', 'verifikationstext'],
  'voucher.account': ['konto', 'kontonummer'],
  'voucher.amount': ['belopp'],
  'voucher.debit': ['debet'],
  'voucher.credit': ['kredit'],
  'voucher.costCenter': ['kostnadsstalle', 'resultatenhet', 'ks'],
  'voucher.objectCode': ['objekt', 'projekt'],
  'voucher.lineText': ['radtext', 'transaktionstext'],
  'invoice.invoiceNr': ['fakturanummer', 'fakturanr', 'avinummer', 'avinr', 'faktura'],
  'invoice.customerRef': ['kundnummer', 'kundnr', 'kund', 'kundnamn', 'hyresgast'],
  'invoice.invoiceDate': ['fakturadatum', 'avidatum'],
  'invoice.dueDate': ['forfallodatum', 'forfaller'],
  'invoice.ocr': ['ocr', 'ocr nummer'],
  'invoice.total': ['belopp', 'fakturabelopp', 'totalt', 'belopp inkl moms'],
  'invoice.vat': ['moms', 'momsbelopp'],
  'invoice.remaining': ['restbelopp', 'saldo', 'kvar att betala', 'obetalt'],
  'invoice.periodFrom': ['period fran'],
  'invoice.periodTo': ['period till'],
  'invoice.objectRef': ['objekt', 'objektnummer'],
  'payment.paymentDate': ['betaldatum', 'betalningsdatum', 'inbetalningsdatum'],
  'payment.amount': ['belopp', 'inbetalt', 'betalt belopp'],
  'payment.invoiceRef': ['fakturanummer', 'fakturanr', 'avinr'],
  'payment.ocr': ['ocr'],
  'payment.customerRef': ['kundnummer', 'kund'],
  'payment.payerName': ['betalare', 'avsandare'],
};

/** Föreslår mappning för de typer av poster vars obligatoriska fält hittas. */
export function suggestMapping(headers: string[], only?: string[]): { mapping: Record<string, string>; entities: string[] } {
  const normed = headers.map((h) => ({ h, n: norm(h) }));
  const candidate: Record<string, string> = {};
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (only && !only.includes(key.split('.')[0])) continue;
    const hit = syns.map((s) => normed.find((x) => x.n === s)).find(Boolean) ?? syns.map((s) => normed.find((x) => x.n.startsWith(s + ' '))).find(Boolean);
    if (hit) candidate[key] = hit.h;
  }
  const entities = ENTITIES.filter((e) => {
    if (only && !only.includes(e.key as string)) return false;
    const req = e.fields.filter((f) => f.required);
    return req.length > 0 && req.every((f) => candidate[`${e.key}.${f.key}`]);
  }).map((e) => e.key);
  // Fler typer kan matcha samma kolumner. Föredra den mest specifika.
  let chosen: string[] = entities;
  if (chosen.includes('voucher')) chosen = ['voucher'];
  else if (chosen.includes('invoice')) {
    // Kunduppgifter tas bara med om de står i egna kolumner, inte bara som kundreferens på fakturan
    chosen = chosen.filter((e) => e === 'invoice' || (e === 'customer' && candidate['customer.name'] !== candidate['invoice.customerRef']));
  }
  else if (chosen.includes('payment')) chosen = ['payment'];
  else if (chosen.includes('rent') && !chosen.includes('property')) chosen = chosen.filter((e) => e !== 'object' || !candidate['rent.validFrom']);
  if (chosen.includes('object')) chosen = chosen.filter((e) => e !== 'rent' || !!candidate['rent.validFrom']);
  if (chosen.includes('account') && chosen.length > 1 && !chosen.includes('voucher')) chosen = chosen.filter((e) => e !== 'supplier' && e !== 'customer');
  if (chosen.includes('supplier')) {
    // Leverantör bara om filen tydligt handlar om leverantörer
    const isSupplier = !!candidate['supplier.externalId'] || norm(candidate['supplier.name'] ?? '').startsWith('leverantor');
    chosen = isSupplier ? chosen.filter((e) => e !== 'customer') : chosen.filter((e) => e !== 'supplier');
  }
  const mapping = Object.fromEntries(Object.entries(candidate).filter(([k]) => chosen.includes(k.split('.')[0])));
  return { mapping, entities: chosen };
}

export const genericAdapter: SourceAdapter = {
  key: 'generic',
  label: 'Annat system (CSV, Excel, XML)',
  description: 'Kolumner känns igen efter vanliga namn. Mappningen kan alltid ändras för hand.',
  detect(table) {
    if (table.hint === 'sie_accounts') {
      return {
        profile: 'sie_accounts',
        label: 'Kontoplan (SIE)',
        score: 1,
        mapping: { 'account.number': 'Konto', 'account.name': 'Kontonamn', 'account.type': 'Kontotyp', 'account.sruCode': 'SRU', 'account.vatCode': 'Momskod' },
      };
    }
    if (table.hint === 'sie_vouchers') {
      return {
        profile: 'sie_vouchers',
        label: 'Verifikationer (SIE)',
        score: 1,
        mapping: {
          'voucher.series': 'Serie',
          'voucher.voucherNr': 'Verifikationsnummer',
          'voucher.date': 'Datum',
          'voucher.text': 'Text',
          'voucher.account': 'Konto',
          'voucher.amount': 'Belopp',
          'voucher.costCenter': 'Kostnadsställe',
          'voucher.objectCode': 'Objekt',
          'voucher.lineText': 'Radtext',
        },
      };
    }
    if (table.hint === 'sie_balances') return { profile: 'ignored', label: 'Balanser (läses inte in)', score: 1, mapping: {} };
    const { mapping, entities } = suggestMapping(table.headers);
    const labels = entities.map((e) => ENTITIES.find((x) => x.key === e)!.labelPlural.toLowerCase());
    return {
      profile: 'generic',
      label: labels.length ? capitalize(labels.join(', ')) : 'Okänt innehåll, mappa kolumnerna',
      score: Object.keys(mapping).length / Math.max(table.headers.length, 1),
      mapping,
    };
  },
};

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------
// Hogia DinHyresvärd: rapporterna Bostäder, Lokaler och Bilplatser
// ---------------------------------------------------------------------

const DHV_COMMERCIAL_TYPE: Record<string, string> = {
  restaurang: 'restaurant',
  kontor: 'office',
  hotell: 'commercial',
  butik: 'commercial',
  lokal: 'commercial',
  lager: 'storage',
  forrad: 'storage',
  verkstad: 'commercial',
  garage: 'parking',
};

export const dinHyresvardAdapter: SourceAdapter = {
  key: 'dinhyresvard',
  label: 'Hogia DinHyresvärd',
  description: 'Exporter av bostäder, lokaler och bilplatser (Excel), med hyresgäster och kontrakt. Kontoplan och verifikationer som SIE 4.',
  detect(table, fileName) {
    const h = table.headers;
    const has = (...names: string[]) => names.every((n) => findHeader(h, n));
    const rentCol = findHeader(h, /^Månadshyra [a-zåäö]+ \d{4}$/i, /^Månadshyra \d{4}-\d{2}$/i, 'Månadshyra');
    const base: Record<string, string> = {};
    const set = (k: string, col?: string) => col && (base[k] = col);
    set('object.externalId', findHeader(h, 'Objektnummer'));
    set('object.objectNr', findHeader(h, 'Objektnummer'));
    set('object.addressLine', findHeader(h, 'Adress'));
    set('object.type', findHeader(h, 'Objekttyp'));
    set('object.monthlyRent', rentCol);

    if (has('Objektnummer', 'Fastighet') && findHeader(h, 'Hyresgäst 1')) {
      set('meta.company', findHeader(h, 'Företag'));
      set('object.propertyRef', findHeader(h, 'Fastighet'));
      set('object.floor', findHeader(h, 'Våningsplan'));
      set('object.apartmentNr', findHeader(h, 'Lägenhetsnummer'));
      set('object.areaM2', findHeader(h, 'Storlek'));
      set('object.rooms', findHeader(h, 'Antal rum'));
      set('object.description', findHeader(h, 'Notering'));
      set('property.externalId', findHeader(h, 'Fastighet'));
      set('property.designation', findHeader(h, 'Fastighet'));
      set('property.name', findHeader(h, 'Fastighet'));
      set('customer.name', findHeader(h, 'Hyresgäst 1'));
      set('customer.nationalId', findHeader(h, 'Hyresgäst 1, person/orgnr'));
      set('customer.email', findHeader(h, 'Hyresgäst 1, e-post'));
      set('customer.phone', findHeader(h, 'Hyresgäst 1, telefon'));
      set('cotenant.name', findHeader(h, 'Hyresgäst 2'));
      set('cotenant.nationalId', findHeader(h, 'Hyresgäst 2, person/orgnr'));
      set('cotenant.email', findHeader(h, 'Hyresgäst 2, e-post'));
      set('cotenant.phone', findHeader(h, 'Hyresgäst 2, telefon'));
      set('contract.startDate', findHeader(h, 'Kontrakt, startdatum'));
      set('contract.endDate', findHeader(h, 'Kontrakt, slutdatum'));
      set('contract.monthlyRent', findHeader(h, /^Hyra kontrakt [a-zåäö]+ \d{4}$/i, /^Hyra kontrakt/i));
      return { profile: 'dhv_residential', label: 'Bostäder med hyresgäster och kontrakt (DinHyresvärd)', score: 1, mapping: base };
    }
    if (has('Objektnummer', 'Bilplatsnummer')) {
      set('object.apartmentNr', findHeader(h, 'Bilplatsnummer'));
      set('object.description', findHeader(h, 'Objekttyp'));
      set('object.propertyRef', findHeader(h, 'Fastighet'));
      return { profile: 'dhv_parking', label: 'Bilplatser (DinHyresvärd)', score: 1, mapping: base };
    }
    if (has('Objektnummer', 'Objekttyp') && (findHeader(h, 'Årshyra') || /lokal/i.test(table.name + fileName))) {
      set('object.areaM2', findHeader(h, 'Storlek'));
      set('object.floor', findHeader(h, 'Våningsplan'));
      set('object.propertyRef', findHeader(h, 'Fastighet'));
      return { profile: 'dhv_commercial', label: 'Lokaler (DinHyresvärd)', score: 1, mapping: base };
    }
    // Kundreskontra, verifikationer och annat: generell igenkänning
    return genericAdapter.detect(table, fileName);
  },

  derive(profile, f, raw, headers) {
    if (!profile.startsWith('dhv_')) return;
    // Adressen innehåller postnummer och ort: "Testgatan 1 A LGH 11, 223 52 Lund"
    if (typeof f['object.addressLine'] === 'string') {
      const a = splitAddress(f['object.addressLine']);
      f['object.addressLine'] = a.street;
      if (profile === 'dhv_residential') {
        f['property.addressLine'] ??= a.street?.replace(/\s+(LGH|lgh)\s*\S+$/, '').replace(/\s+[A-Z]$/, '') ?? null;
        f['property.postalCode'] ??= a.postalCode;
        f['property.city'] ??= a.city;
        f['property.municipality'] ??= a.city;
      }
      f['meta.postalCode'] = a.postalCode;
      f['meta.city'] = a.city;
    }
    // Hyran gäller från den månad som står i kolumnrubriken
    const rentCol = headers.find((h) => /^Månadshyra [a-zåäö]+ \d{4}$/i.test(h));
    if (rentCol && f['object.rentFrom'] == null) f['object.rentFrom'] = monthFromHeader(rentCol);

    const typeText = text(f['object.type']);
    if (profile === 'dhv_residential') {
      // "2 rum och kök", "1 rok", "Lägenhet" … är alltid bostad
      f['object.type'] = typeText && /förråd/i.test(typeText) ? 'Förråd' : 'Lägenhet';
      f['object.vatLiable'] = false;
      f['property.category'] ??= 'Bostad';
      if (f['object.rooms'] == null && typeText) {
        const m = typeText.match(/^(\d+(?:[.,]5)?)\s*(rum|rok)/i);
        if (m) f['object.rooms'] = Number(m[1].replace(',', '.'));
      }
      // Hyresgäst utan namn = vakant objekt, inget avtal
      if (!text(f['customer.name'])) {
        for (const k of Object.keys(f)) if (k.startsWith('customer.') || k.startsWith('contract.') || k.startsWith('cotenant.')) f[k] = null;
      } else if (!text(f['cotenant.name'])) {
        for (const k of Object.keys(f)) if (k.startsWith('cotenant.')) f[k] = null;
      }
      // Ett kontrakt i DinHyresvärd omfattar alla objekt med samma hyresgäst och startdatum i fastigheten
      if (text(f['customer.name']) && f['contract.startDate']) {
        f['contract.groupKey'] = [f['customer.nationalId'] ?? f['customer.name'], f['contract.startDate'], f['object.propertyRef']]
          .map((x) => norm(String(x ?? '')))
          .join('|');
      }
      // Våning 0 i exporten betyder oftast att uppgiften saknas
      if (f['object.floor'] === 0) f['object.floor'] = null;
    } else if (profile === 'dhv_parking') {
      f['object.type'] = 'Parkering';
    } else if (profile === 'dhv_commercial') {
      const key = norm(typeText ?? '');
      f['object.type'] = DHV_COMMERCIAL_TYPE[key] ? typeText : 'Lokal';
      if (DHV_COMMERCIAL_TYPE[key] === 'restaurant') f['object.type'] = 'Restaurang';
      else if (DHV_COMMERCIAL_TYPE[key] === 'office') f['object.type'] = 'Kontor';
      else if (DHV_COMMERCIAL_TYPE[key] === 'storage') f['object.type'] = 'Förråd';
      else if (DHV_COMMERCIAL_TYPE[key] === 'parking') f['object.type'] = 'Parkering';
      else f['object.type'] = 'Lokal';
      if (key === 'hotell') f['object.floor'] = null; // våning i exporten är antal våningar för hotell
      if (typeText && key === 'hotell') f['object.description'] ??= 'Hotell';
      // Momsplikt syns som skillnad mellan årshyra med och utan moms
      const year = num(raw[findHeader(headers, 'Årshyra') ?? '']);
      const yearVat = num(raw[findHeader(headers, 'Årshyra inkl. moms', /^Årshyra inkl/i) ?? '']);
      if (year !== null && yearVat !== null) f['object.vatLiable'] = yearVat > year + 0.5;
    }
  },
};

function num(v: Cell | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export const ADAPTERS: SourceAdapter[] = [dinHyresvardAdapter, genericAdapter];

export function adapterFor(key: string): SourceAdapter {
  return ADAPTERS.find((a) => a.key === key) ?? genericAdapter;
}
