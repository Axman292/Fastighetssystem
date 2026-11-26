/**
 * Läser Bankgirots inbetalningsfil BgMax (Bankgiro Inbetalningar, layout BGMAX version 01).
 *
 * Filen består av poster på 80 tecken. Varje post börjar med en transaktionskod (TK):
 *   01 start, 05 öppning (mottagarens bankgiro), 20 betalning, 21 avdrag,
 *   22/23 extra referens, 25 information, 26 namn, 27 adress, 28 ort, 29 org.nr,
 *   15 insättning (stänger avsnittet och ger betalningsdagen), 70 slut.
 * Betalningarna i ett avsnitt får betalningsdagen från insättningsposten som följer dem.
 * Antal poster och insättningsbelopp stäms av mot filens egna summor.
 */

export interface BgMaxPayment {
  kind: 'payment' | 'deduction';
  senderBankgiro: string | null;
  reference: string | null;
  referenceCode: string;
  amountOre: number;
  channel: string;
  bgcSerial: string | null;
  deductionCode: string | null;
  extraReferences: { reference: string; amountOre: number; negative: boolean }[];
  information: string[];
  payerName: string | null;
  payerAddress: string | null;
  payerOrgNr: string | null;
  paymentDate: string;
  depositSerial: string;
}

export interface BgMaxFile {
  timestamp: string;
  test: boolean;
  bankgiro: string;
  currency: string;
  payments: BgMaxPayment[];
  deposits: { date: string; serial: string; amountOre: number; count: number }[];
}

export class BgMaxError extends Error {}

const field = (line: string, from: number, to: number) => line.slice(from - 1, to);
const trimmed = (line: string, from: number, to: number) => field(line, from, to).trim();
const digits = (s: string) => s.replace(/^0+/, '') || '0';

function amount(line: string, from: number, to: number, row: number): number {
  const s = field(line, from, to);
  if (!/^\d+$/.test(s)) throw new BgMaxError(`Rad ${row}: ogiltigt belopp "${s.trim()}"`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new BgMaxError(`Rad ${row}: för stort belopp`);
  return n;
}

/** Bankgironummer utan inledande nollor och med bindestreck, t.ex. 5050-1055. */
export function formatBankgiro(raw: string): string {
  const d = digits(raw.replace(/\D/g, ''));
  if (d.length < 7) return d;
  return `${d.slice(0, d.length - 4)}-${d.slice(-4)}`;
}

/** Jämför bankgironummer oavsett bindestreck och inledande nollor. */
export function sameBankgiro(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return digits(a.replace(/\D/g, '')) === digits(b.replace(/\D/g, ''));
}

function date(s: string, row: number): string {
  if (!/^\d{8}$/.test(s)) throw new BgMaxError(`Rad ${row}: ogiltigt datum "${s}"`);
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) throw new BgMaxError(`Rad ${row}: ogiltigt datum "${s}"`);
  return iso;
}

export function parseBgMax(text: string): BgMaxFile {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) throw new BgMaxError('Filen är tom');
  const head = lines[0];
  if (field(head, 1, 2) !== '01' || trimmed(head, 3, 22) !== 'BGMAX') {
    throw new BgMaxError('Filen är inte en BgMax-fil från Bankgirot (startposten saknas)');
  }
  const out: BgMaxFile = {
    timestamp: trimmed(head, 25, 44),
    test: field(head, 45, 45) === 'T',
    bankgiro: '',
    currency: 'SEK',
    payments: [],
    deposits: [],
  };
  let section: Omit<BgMaxPayment, 'paymentDate' | 'depositSerial'>[] | null = null;
  let current: Omit<BgMaxPayment, 'paymentDate' | 'depositSerial'> | null = null;
  let ended = false;
  const counts = { payments: 0, deductions: 0, extra: 0, deposits: 0 };

  lines.forEach((line, i) => {
    const row = i + 1;
    if (ended) throw new BgMaxError(`Rad ${row}: poster efter slutposten`);
    const tk = field(line, 1, 2);
    if (i === 0) return;
    switch (tk) {
      case '05': {
        if (section) throw new BgMaxError(`Rad ${row}: öppningspost innan föregående insättning avslutats`);
        const bg = formatBankgiro(field(line, 3, 12));
        if (out.bankgiro && out.bankgiro !== bg) throw new BgMaxError('Filen innehåller flera mottagande bankgironummer');
        out.bankgiro = bg;
        out.currency = trimmed(line, 23, 25) || 'SEK';
        if (out.currency !== 'SEK') throw new BgMaxError(`Rad ${row}: valutan ${out.currency} stöds inte`);
        section = [];
        current = null;
        return;
      }
      case '20':
      case '21': {
        if (!section) throw new BgMaxError(`Rad ${row}: betalning utanför ett avsnitt`);
        const ref = trimmed(line, 13, 37);
        const sender = field(line, 3, 12);
        current = {
          kind: tk === '20' ? 'payment' : 'deduction',
          senderBankgiro: /^0*$/.test(sender) ? null : formatBankgiro(sender),
          reference: ref || null,
          referenceCode: field(line, 56, 56),
          amountOre: amount(line, 38, 55, row),
          channel: field(line, 57, 57),
          bgcSerial: trimmed(line, 58, 69) || null,
          deductionCode: tk === '21' ? field(line, 71, 71) || null : null,
          extraReferences: [],
          information: [],
          payerName: null,
          payerAddress: null,
          payerOrgNr: null,
        };
        section.push(current);
        if (tk === '20') counts.payments += 1;
        else counts.deductions += 1;
        return;
      }
      case '22':
      case '23': {
        if (!current) throw new BgMaxError(`Rad ${row}: extra referens utan betalning`);
        current.extraReferences.push({ reference: trimmed(line, 13, 37), amountOre: amount(line, 38, 55, row), negative: tk === '23' });
        counts.extra += 1;
        return;
      }
      case '25':
        if (!current) throw new BgMaxError(`Rad ${row}: informationspost utan betalning`);
        current.information.push(trimmed(line, 3, 52));
        return;
      case '26':
        if (!current) throw new BgMaxError(`Rad ${row}: namnpost utan betalning`);
        current.payerName = [trimmed(line, 3, 37), trimmed(line, 38, 72)].filter(Boolean).join(' ') || null;
        return;
      case '27':
        if (!current) throw new BgMaxError(`Rad ${row}: adresspost utan betalning`);
        current.payerAddress = [trimmed(line, 3, 37), trimmed(line, 38, 46)].filter(Boolean).join(', ') || null;
        return;
      case '28':
        if (!current) throw new BgMaxError(`Rad ${row}: adresspost utan betalning`);
        current.payerAddress = [current.payerAddress, trimmed(line, 3, 37), trimmed(line, 38, 72)].filter(Boolean).join(', ') || null;
        return;
      case '29':
        if (!current) throw new BgMaxError(`Rad ${row}: organisationsnummer utan betalning`);
        current.payerOrgNr = trimmed(line, 3, 14).replace(/^0+(?=\d{10}$)/, '') || null;
        return;
      case '15': {
        if (!section) throw new BgMaxError(`Rad ${row}: insättning utan öppningspost`);
        const paymentDate = date(field(line, 38, 45), row);
        const serial = trimmed(line, 46, 50);
        const deposit = amount(line, 51, 68, row);
        const count = Number(field(line, 72, 79));
        const sum = section.reduce((s, p) => s + (p.kind === 'payment' ? p.amountOre : -p.amountOre), 0);
        if (sum !== deposit) {
          throw new BgMaxError(`Rad ${row}: insättningen är ${deposit / 100} kr men betalningarna summerar till ${sum / 100} kr`);
        }
        const nPayments = section.filter((p) => p.kind === 'payment').length;
        if (Number.isFinite(count) && count !== nPayments) {
          throw new BgMaxError(`Rad ${row}: insättningen anger ${count} betalningar men avsnittet har ${nPayments}`);
        }
        for (const p of section) out.payments.push({ ...p, paymentDate, depositSerial: serial });
        out.deposits.push({ date: paymentDate, serial, amountOre: deposit, count: nPayments });
        counts.deposits += 1;
        section = null;
        current = null;
        return;
      }
      case '70': {
        if (section) throw new BgMaxError(`Rad ${row}: slutpost innan sista insättningen avslutats`);
        const want = {
          payments: Number(field(line, 3, 10)),
          deductions: Number(field(line, 11, 18)),
          extra: Number(field(line, 19, 26)),
          deposits: Number(field(line, 27, 34)),
        };
        if (want.payments !== counts.payments || want.deductions !== counts.deductions || want.deposits !== counts.deposits) {
          throw new BgMaxError(
            `Slutposten stämmer inte: filen anger ${want.payments} betalningar och ${want.deposits} insättningar, ` +
              `men innehåller ${counts.payments} betalningar och ${counts.deposits} insättningar. Filen kan vara ofullständig.`,
          );
        }
        ended = true;
        return;
      }
      default:
        // Okända poster (t.ex. framtida tillägg) ignoreras som Bankgirot rekommenderar
        return;
    }
  });
  if (!ended) throw new BgMaxError('Slutposten saknas. Filen kan vara avklippt, hämta den igen från banken.');
  if (!out.bankgiro) throw new BgMaxError('Filen saknar mottagande bankgironummer');
  return out;
}

/** Skapar en BgMax-fil. Används i tester och för demodata. */
export function buildBgMax(opts: {
  bankgiro: string;
  date: string;
  test?: boolean;
  payments: { reference?: string; amountOre: number; name?: string; serial?: string; senderBankgiro?: string; deduction?: boolean }[];
}): string {
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ');
  const num = (v: number | string, n: number) => String(v).padStart(n, '0');
  const bg = opts.bankgiro.replace(/\D/g, '');
  const d = opts.date.replace(/-/g, '');
  const lines = [`01${pad('BGMAX', 20)}01${pad(`${d}120000000000`, 20)}${opts.test ? 'T' : 'P'}`];
  lines.push(`05${num(bg, 10)}${' '.repeat(10)}SEK`);
  let sum = 0;
  let n = 0;
  let dn = 0;
  opts.payments.forEach((p, i) => {
    const serial = p.serial ?? `${d.slice(2)}${num(i + 1, 6)}`;
    const code = p.deduction ? '' : p.reference ? '2' : '1';
    const tk = p.deduction ? '21' : '20';
    lines.push(`${tk}${num((p.senderBankgiro ?? '').replace(/\D/g, ''), 10)}${pad(p.reference ?? '', 25)}${num(p.amountOre, 18)}${pad(code, 1)}3${pad(serial, 12)}0${p.deduction ? '1' : ''}`);
    if (p.name) lines.push(`26${pad(p.name, 35)}`);
    if (p.deduction) {
      sum -= p.amountOre;
      dn += 1;
    } else {
      sum += p.amountOre;
      n += 1;
    }
  });
  lines.push(`15${pad('99601234567', 35)}${d}${num(1, 5)}${num(sum, 18)}SEK${num(n, 8)}`);
  lines.push(`70${num(n, 8)}${num(dn, 8)}${num(0, 8)}${num(1, 8)}`);
  return lines.join('\r\n') + '\r\n';
}
