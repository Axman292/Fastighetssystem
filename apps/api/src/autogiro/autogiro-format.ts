/**
 * Bankgirots Autogiro-filer i det nya formatet (Bg Autogiro Teknisk manual).
 *
 * Varje post är 80 tecken. Filerna skrivs i ISO 8859-1 med CRLF.
 *
 * Till Bankgirot:
 *  - Medgivanden: TK01 öppningspost, TK04 nytt medgivande (eller svar på ett
 *    internetbanksmedgivande), TK03 makulering.
 *  - Dragningar: TK01 och TK82, en betalning per post.
 *
 * Från Bankgirot:
 *  - Medgivandeavisering (AG-MEDAVI): TK73 per medgivande med informations- och kommentarskod.
 *  - Medgivanden via internetbanken (AG-EMEDGIV): TK51–TK59.
 *  - Betalningsspecifikation (BET. SPEC & STOPP TK): TK15 insättning, TK82 med betalningsstatus.
 *  - Avvisade betalningsuppdrag (AVVISADE BET UPPDR): TK82 med kommentarskod.
 */

export class AutogiroFileError extends Error {}

const CRLF = '\r\n';

function num(value: string | number, len: number): string {
  const s = String(value).replace(/\D/g, '');
  if (s.length > len) throw new AutogiroFileError(`Värdet ${value} är för långt (högst ${len} siffror)`);
  return s.padStart(len, '0');
}

function alpha(value: string | null | undefined, len: number): string {
  // Bankgirot tillåter versaler, siffror och ett fåtal tecken. Å, Ä och Ö tas bort ur referenser.
  const s = (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 \-./]/g, ' ');
  return s.slice(0, len).padEnd(len, ' ');
}

function record(parts: string[]): string {
  const r = parts.join('');
  if (r.length !== 80) throw new Error(`Autogiroposten blev ${r.length} tecken`);
  return r;
}

const ymd = (iso: string) => iso.replace(/-/g, '').slice(0, 8);
const iso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

export function bankgiroDigits(bg: string): string {
  return bg.replace(/\D/g, '');
}

/** "5050-1055" av tio siffror med inledande nollor. */
export function formatBankgiro(digits: string): string {
  const d = digits.replace(/^0+/, '');
  return d.length > 4 ? `${d.slice(0, -4)}-${d.slice(-4)}` : d;
}

function opening(date: string, customerNr: string, bankgiro: string): string {
  return record(['01', ymd(date), 'AUTOGIRO', ' '.repeat(44), num(customerNr, 6), num(bankgiroDigits(bankgiro), 10), '  ']);
}

export interface MandateOrder {
  action: 'add' | 'cancel' | 'approve' | 'reject';
  payerNr: string;
  clearingNr?: string | null;
  accountNr?: string | null;
  /** 12 siffror: personnummer ÅÅÅÅMMDDNNNN eller 00 + organisationsnummer */
  holderId?: string | null;
}

/** Medgivandefil: nya medgivanden, svar på internetbanksmedgivanden och makuleringar. */
export function buildMandateFile(o: { date: string; customerNr: string; bankgiro: string; orders: MandateOrder[] }): string {
  const bg = num(bankgiroDigits(o.bankgiro), 10);
  const lines = [opening(o.date, o.customerNr, o.bankgiro)];
  // Nya medgivanden ska komma före makuleringar
  const sorted = [...o.orders].sort((a, b) => Number(a.action === 'cancel') - Number(b.action === 'cancel'));
  for (const m of sorted) {
    if (m.action === 'cancel') {
      lines.push(record(['03', bg, num(m.payerNr, 16), ' '.repeat(52)]));
      continue;
    }
    const withAccount = m.action === 'add' || m.accountNr;
    if (m.action === 'add' && (!m.clearingNr || !m.accountNr || !m.holderId)) {
      throw new AutogiroFileError(`Medgivandet för betalarnummer ${m.payerNr} saknar clearingnummer, kontonummer eller personnummer`);
    }
    lines.push(
      record([
        '04',
        bg,
        num(m.payerNr, 16),
        withAccount && m.clearingNr && m.accountNr ? num(m.clearingNr, 4) + num(m.accountNr, 12) : ' '.repeat(16),
        withAccount && m.holderId ? num(m.holderId, 12) : ' '.repeat(12),
        ' '.repeat(20),
        m.action === 'reject' ? 'AV' : '  ',
        '  ',
      ]),
    );
  }
  return lines.join(CRLF) + CRLF;
}

export interface PaymentOrder {
  payerNr: string;
  amountOre: number;
  paymentDate: string;
  reference: string;
}

/** Betalningsfil med engångsdragningar (periodkod 0). */
export function buildPaymentFile(o: { date: string; customerNr: string; bankgiro: string; payments: PaymentOrder[] }): string {
  const bg = num(bankgiroDigits(o.bankgiro), 10);
  const lines = [opening(o.date, o.customerNr, o.bankgiro)];
  for (const p of o.payments) {
    if (!Number.isInteger(p.amountOre) || p.amountOre <= 0) throw new AutogiroFileError(`Ogiltigt belopp för betalarnummer ${p.payerNr}`);
    lines.push(record(['82', ymd(p.paymentDate), '0', '   ', ' ', num(p.payerNr, 16), num(p.amountOre, 12), bg, alpha(p.reference, 16), ' '.repeat(11)]));
  }
  return lines.join(CRLF) + CRLF;
}

// ---------------------------------------------------------------------
// Filer från Bankgirot
// ---------------------------------------------------------------------

export type IncomingKind = 'mandate_advice' | 'internet_mandates' | 'payment_spec' | 'rejected_payments';

export interface MandateAdvice {
  payerNr: string;
  clearingNr: string | null;
  accountNr: string | null;
  holderId: string | null;
  infoCode: string;
  commentCode: string;
  date: string | null;
}

export interface InternetMandate {
  payerNr: string;
  clearingNr: string | null;
  accountNr: string | null;
  holderId: string | null;
  messageType: string;
  info: string | null;
  nameLines: string[];
  postalCode: string | null;
  city: string | null;
}

export interface PaymentResult {
  payerNr: string;
  amountOre: number;
  paymentDate: string | null;
  reference: string;
  /** 0 = dragen, 1 = täckning saknas, 2 = ingen koppling / banken godkände inte, 9 = förnyad täckningskontroll. Vid avvisade: kommentarskod. */
  code: string;
  ok: boolean;
}

export interface ParsedAutogiro {
  kind: IncomingKind;
  fileDate: string | null;
  customerNr: string | null;
  bankgiro: string | null;
  mandates: MandateAdvice[];
  internetMandates: InternetMandate[];
  payments: PaymentResult[];
}

const CONTENTS: Record<string, IncomingKind> = {
  'AG-MEDAVI': 'mandate_advice',
  'BET. SPEC & STOPP TK': 'payment_spec',
  'AVVISADE BET UPPDR': 'rejected_payments',
};

function clean(digits: string): string | null {
  const d = digits.trim();
  return d && !/^0+$/.test(d) ? d : null;
}

const payerNr = (s: string) => s.trim().replace(/^0+(?=\d)/, '');

export function parseAutogiroFile(input: Buffer | string): ParsedAutogiro {
  const text = typeof input === 'string' ? input : input.toString('latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new AutogiroFileError('Filen är tom');
  const first = lines[0].padEnd(80, ' ');
  const tk = first.slice(0, 2);

  if (tk === '51') {
    if (!first.slice(24, 44).trim().startsWith('AG-EMEDGIV')) throw new AutogiroFileError('Okänd fil från Bankgirot');
    const out: ParsedAutogiro = {
      kind: 'internet_mandates',
      fileDate: iso(first.slice(2, 10)),
      customerNr: null,
      bankgiro: formatBankgiro(first.slice(14, 24)),
      mandates: [],
      internetMandates: [],
      payments: [],
    };
    let cur: InternetMandate | null = null;
    let ended = false;
    for (const raw of lines.slice(1)) {
      const l = raw.padEnd(80, ' ');
      const code = l.slice(0, 2);
      if (code === '52') {
        const account = l.slice(28, 44);
        cur = {
          payerNr: payerNr(l.slice(12, 28)),
          clearingNr: clean(account.slice(0, 4)),
          accountNr: clean(account.slice(4).replace(/^0+(?=\d)/, '')),
          holderId: clean(l.slice(44, 56)),
          messageType: l.slice(61, 62).trim() || '0',
          info: null,
          nameLines: [],
          postalCode: null,
          city: null,
        };
        out.internetMandates.push(cur);
      } else if (cur && code === '53') cur.info = l.slice(2, 38).trim() || null;
      else if (cur && (code === '54' || code === '55')) cur.nameLines.push(...[l.slice(2, 38).trim(), l.slice(38, 74).trim()].filter(Boolean));
      else if (cur && code === '56') {
        cur.postalCode = clean(l.slice(2, 7));
        cur.city = l.slice(7, 38).trim() || null;
      } else if (code === '59') {
        ended = true;
        const count = Number(l.slice(14, 21));
        if (count && count !== lines.length) throw new AutogiroFileError(`Filen säger ${count} poster men innehåller ${lines.length}. Filen kan vara ofullständig.`);
      }
    }
    if (!ended) throw new AutogiroFileError('Slutposten (TK59) saknas. Filen kan vara ofullständig.');
    return out;
  }

  if (tk !== '01' || first.slice(2, 22).trim() !== 'AUTOGIRO') {
    throw new AutogiroFileError('Filen är inte en Autogirofil från Bankgirot i det nya formatet');
  }
  const contents = first.slice(44, 64).trim();
  const kind = CONTENTS[contents];
  if (!kind) throw new AutogiroFileError(`Filtypen "${contents || 'okänd'}" kan inte läsas in här`);
  const out: ParsedAutogiro = {
    kind,
    fileDate: iso(first.slice(24, 32)),
    customerNr: first.slice(64, 70).replace(/^0+(?=\d)/, ''),
    bankgiro: formatBankgiro(first.slice(70, 80)),
    mandates: [],
    internetMandates: [],
    payments: [],
  };
  let ended = false;
  for (const raw of lines.slice(1)) {
    const l = raw.padEnd(80, ' ');
    const code = l.slice(0, 2);
    if (code === '09') {
      ended = true;
      if (kind === 'mandate_advice') {
        const count = Number(l.slice(14, 21));
        if (count !== out.mandates.length) throw new AutogiroFileError(`Slutposten säger ${count} medgivanden men filen innehåller ${out.mandates.length}`);
      }
      continue;
    }
    if (kind === 'mandate_advice' && code === '73') {
      const account = l.slice(28, 44);
      out.mandates.push({
        payerNr: payerNr(l.slice(12, 28)),
        clearingNr: clean(account.slice(0, 4)),
        accountNr: clean(account.slice(4).replace(/^0+(?=\d)/, '')),
        holderId: clean(l.slice(44, 56)),
        infoCode: l.slice(61, 63),
        commentCode: l.slice(63, 65),
        date: iso(l.slice(65, 73)),
      });
    } else if (kind === 'payment_spec' && code === '82') {
      const status = l.slice(79, 80).trim() || '0';
      out.payments.push({
        paymentDate: iso(l.slice(2, 10)),
        payerNr: payerNr(l.slice(15, 31)),
        amountOre: Number(l.slice(31, 43)),
        reference: l.slice(53, 69).trim(),
        code: status,
        ok: status === '0',
      });
    } else if (kind === 'rejected_payments' && code === '82') {
      out.payments.push({
        paymentDate: iso(l.slice(2, 10)),
        payerNr: payerNr(l.slice(14, 30)),
        amountOre: Number(l.slice(30, 42)),
        reference: l.slice(42, 58).trim(),
        code: l.slice(58, 60),
        ok: false,
      });
    }
  }
  if (!ended) throw new AutogiroFileError('Slutposten (TK09) saknas. Filen kan vara ofullständig.');
  return out;
}

// ---------------------------------------------------------------------
// Koder
// ---------------------------------------------------------------------

export const MANDATE_COMMENT: Record<string, string> = {
  '02': 'Makulerat av betalaren eller betalarens bank',
  '03': 'Kontoslaget är inte godkänt för autogiro',
  '04': 'Medgivandet finns inte hos Bankgirot',
  '05': 'Fel kontonummer eller personuppgifter',
  '07': 'Makulerat eftersom banken inte fick svar på kontoförfrågan',
  '09': 'Betalarens bankgironummer finns inte hos Bankgirot',
  '10': 'Medgivandet finns redan hos Bankgirot, eller förfrågan pågår',
  '20': 'Fel personnummer eller organisationsnummer',
  '21': 'Fel betalarnummer',
  '23': 'Fel bankkontonummer',
  '29': 'Fel bankgironummer för betalningsmottagaren',
  '30': 'Betalningsmottagarens bankgironummer är avregistrerat',
  '32': 'Nytt medgivande godkänt',
  '33': 'Makulerat',
  '98': 'Makulerat eftersom betalarens bankgironummer avslutats',
};

/** Vad en TK73-post betyder för medgivandet. */
export function mandateOutcome(infoCode: string, commentCode: string): 'active' | 'cancelled' | 'rejected' | 'pending' {
  if (commentCode === '32') return 'active';
  if (['03', '10', '43', '44', '46'].includes(infoCode) || ['02', '07', '33', '98'].includes(commentCode)) {
    // En makulering som Bankgirot inte hittar (04) är också borta
    return infoCode === '04' ? 'rejected' : 'cancelled';
  }
  if (commentCode === '10') return 'pending';
  return 'rejected';
}

export const PAYMENT_STATUS: Record<string, string> = {
  '0': 'Dragen',
  '1': 'Täckning saknades på kontot',
  '2': 'Medgivandet saknas, kontot är avslutat eller banken godkände inte dragningen',
  '9': 'Förnyad täckningskontroll, dras igen om möjligt',
};

export const REJECTED_COMMENT: Record<string, string> = {
  '01': 'Medgivande saknas',
  '02': 'Kontot är inte godkänt eller avslutat',
  '04': 'Fel betalarnummer',
  '06': 'Fel periodkod',
  '07': 'Fel antal självförnyande uppdrag',
  '08': 'Beloppet är inte numeriskt',
  '09': 'Förbud mot utbetalningar',
  '10': 'Bankgironumret finns inte hos Bankgirot',
  '12': 'Fel betalningsdag',
  '13': 'Betalningsdagen har passerat',
  '15': 'Bankgironumret i öppningsposten och betalningsposten skiljer sig',
  '24': 'Beloppet är högre än maxbeloppet',
};

export const KIND_LABEL: Record<string, string> = {
  mandates: 'Medgivanden till Bankgirot',
  payments: 'Dragningar till Bankgirot',
  mandate_advice: 'Medgivandeavisering',
  internet_mandates: 'Medgivanden via internetbanken',
  payment_spec: 'Betalningsspecifikation',
  rejected_payments: 'Avvisade betalningsuppdrag',
};
