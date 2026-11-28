import { XMLParser } from 'fast-xml-parser';
import { BgMaxPayment, formatBankgiro } from './bgmax';

/**
 * Läser bankens inbetalningsfiler i ISO 20022-format, som ersätter BgMax från och med
 * 28 november 2026:
 *  * camt.054 (BkToCstmrDbtCdtNtfctn), avisering av insättningar utan saldon. Det är
 *    filen Danske Bank och de andra bankerna skickar för Bankgiro Inbetalningar.
 *  * camt.053 (BkToCstmrStmt), kontoutdrag. Har samma poster och läses på samma sätt.
 *
 * Alla versioner (001.02 till 001.10) har samma grundform. Namnrymden tas bort, så att
 * både Dbtr/Nm (äldre) och Dbtr/Pty/Nm (nyare) hittas.
 *
 * Varje kontoavsnitt (Ntfctn/Stmt) blir ett eget avsnitt med sitt konto. Bankgiro anges som
 * Othr/Id med schemat BGNR, bankkonto som IBAN eller Othr/Id (BBAN).
 * Varje transaktion (TxDtls) blir en betalning. OCR finns i RmtInf/Strd/CdtrRefInf/Ref,
 * fritext i RmtInf/Ustrd. Belopp med CdtDbtInd DBIT och återföringar läses som avdrag,
 * som inte bokförs automatiskt.
 */

export type CamtPayment = BgMaxPayment;

export interface CamtAccount {
  /** Bankgiro när kontot anges med schemat BGNR. */
  bankgiro: string | null;
  iban: string | null;
  /** Annat kontonummer (BBAN). */
  other: string | null;
  currency: string;
  payments: CamtPayment[];
}

export interface CamtFile {
  format: 'camt054' | 'camt053';
  messageId: string | null;
  timestamp: string | null;
  accounts: CamtAccount[];
}

export class CamtError extends Error {}

const ARRAYS = new Set(['Ntfctn', 'Stmt', 'Ntry', 'NtryDtls', 'TxDtls', 'Ustrd', 'Strd', 'AdrLine', 'AddtlNtryInf', 'Othr', 'RfrdDocInf']);

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // OCR-nummer och kontonummer ska behålla inledande nollor
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return text((v as X)['#text']);
  const s = String(v).trim();
  return s || null;
};

/** Belopp som "1234.50" till öre, utan flyttal. */
export function amountToOre(v: unknown): number {
  const s = text(v);
  if (!s || !/^\d+(\.\d{1,5})?$/.test(s)) throw new CamtError(`Ogiltigt belopp "${s ?? ''}"`);
  const [kr, dec = ''] = s.split('.');
  const ore = Number(kr) * 100 + Number((dec + '00').slice(0, 2));
  if (!Number.isSafeInteger(ore)) throw new CamtError('För stort belopp');
  return ore;
}

function day(d: X | undefined): string | null {
  const s = text(d?.Dt) ?? text(d?.DtTm);
  if (!s) return null;
  const iso = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/** Konto i Acct/Id eller DbtrAcct/Id. */
function account(id: X | undefined): { bankgiro: string | null; iban: string | null; other: string | null } {
  const iban = text(id?.IBAN)?.replace(/\s/g, '').toUpperCase() ?? null;
  let bankgiro: string | null = null;
  let other: string | null = null;
  for (const o of arr<X>(id?.Othr)) {
    const v = text(o.Id);
    if (!v) continue;
    const scheme = (text(o.SchmeNm?.Prtry) ?? text(o.SchmeNm?.Cd) ?? '').toUpperCase();
    if (scheme === 'BGNR') bankgiro = formatBankgiro(v);
    else other ??= v.replace(/\s/g, '');
  }
  return { bankgiro, iban, other };
}

function party(p: X | undefined): X | undefined {
  // Nyare versioner: Dbtr/Pty/Nm, äldre: Dbtr/Nm
  return p?.Pty ?? p;
}

function address(a: X | undefined): string | null {
  if (!a) return null;
  const parts = [
    [text(a.StrtNm), text(a.BldgNb)].filter(Boolean).join(' '),
    ...arr(a.AdrLine).map(text),
    [text(a.PstCd), text(a.TwnNm)].filter(Boolean).join(' '),
  ].filter((s): s is string => !!s);
  return parts.length ? parts.join(', ').slice(0, 300) : null;
}

function orgNr(p: X | undefined): string | null {
  for (const o of arr<X>(p?.Id?.OrgId?.Othr)) {
    const v = text(o.Id)?.replace(/\D/g, '');
    if (v && v.length >= 10) {
      const d = v.slice(-10);
      return `${d.slice(0, 6)}-${d.slice(6)}`;
    }
  }
  return null;
}

/** Referenser i RmtInf: strukturerade (OCR) först, annars fritext. */
function remittance(rmt: X | undefined): { reference: string | null; code: string; extra: { reference: string; amountOre: number; negative: boolean }[]; info: string[] } {
  const refs: { reference: string; amountOre: number | null; negative: boolean }[] = [];
  for (const s of arr<X>(rmt?.Strd)) {
    const ref = text(s.CdtrRefInf?.Ref) ?? arr<X>(s.RfrdDocInf).map((d) => text(d.Nb)).find(Boolean) ?? null;
    if (!ref) continue;
    const amt = s.RfrdDocAmt;
    const credit = amt?.CdtNoteAmt != null;
    const v = amt?.RmtdAmt ?? amt?.DuePyblAmt ?? amt?.CdtNoteAmt;
    refs.push({ reference: ref.replace(/\s/g, ''), amountOre: v != null ? amountToOre(v) : null, negative: credit });
  }
  const ustrd = arr(rmt?.Ustrd).map(text).filter((s): s is string => !!s);
  if (refs.length) {
    const [first, ...more] = refs;
    return {
      reference: first.reference,
      code: 'SCOR',
      extra: more.map((r) => ({ reference: r.reference, amountOre: r.amountOre ?? 0, negative: r.negative })),
      info: ustrd,
    };
  }
  if (ustrd.length) return { reference: ustrd.join(' ').slice(0, 140), code: 'USTRD', extra: [], info: [] };
  return { reference: null, code: 'NONE', extra: [], info: [] };
}

export function isCamt(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<(\w+:)?Document[\s>]/.test(head) && /camt\.05[34]|BkToCstmrDbtCdtNtfctn|BkToCstmrStmt/.test(text.slice(0, 20000));
}

export function parseCamt(xml: string): CamtFile {
  let doc: X;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new CamtError(`Filen är inte giltig XML: ${(err as Error).message}`);
  }
  const root: X | undefined = doc?.Document;
  const ntf = root?.BkToCstmrDbtCdtNtfctn;
  const stm = root?.BkToCstmrStmt;
  if (!ntf && !stm) throw new CamtError('Filen är inte en camt.054- eller camt.053-fil från banken');
  const body: X = ntf ?? stm;
  const out: CamtFile = {
    format: ntf ? 'camt054' : 'camt053',
    messageId: text(body.GrpHdr?.MsgId),
    timestamp: text(body.GrpHdr?.CreDtTm),
    accounts: [],
  };
  const sections = arr<X>(ntf ? body.Ntfctn : body.Stmt);
  sections.forEach((sec, si) => {
    const acct = account(sec.Acct?.Id);
    const currency = text(sec.Acct?.Ccy) ?? 'SEK';
    const payments: CamtPayment[] = [];
    arr<X>(sec.Ntry).forEach((ntry, ni) => {
      const status = text(ntry.Sts?.Cd) ?? text(ntry.Sts);
      // Bara bokförda poster. Väntande (PDNG) eller upplysningar (INFO) kommer igen när de bokförs.
      if (status && status !== 'BOOK') return;
      const entryDate = day(ntry.BookgDt) ?? day(ntry.ValDt);
      if (!entryDate) throw new CamtError(`Post ${ni + 1} i avsnitt ${si + 1} saknar bokföringsdag`);
      const entryCredit = text(ntry.CdtDbtInd) !== 'DBIT';
      const reversal = text(ntry.RvslInd) === 'true';
      const entryRef = text(ntry.AcctSvcrRef) ?? text(ntry.NtryRef);
      const entryCcy = text(ntry.Amt?.['@Ccy']) ?? currency;
      if (entryCcy !== 'SEK') throw new CamtError(`Valutan ${entryCcy} stöds inte`);
      const txs = arr<X>(ntry.NtryDtls).flatMap((d) => arr<X>(d.TxDtls));
      const info = arr(ntry.AddtlNtryInf).map(text).filter((s): s is string => !!s);
      const list = txs.length ? txs : [{} as X];
      list.forEach((tx, ti) => {
        const amtNode = tx.Amt ?? tx.AmtDtls?.TxAmt?.Amt ?? (list.length === 1 ? ntry.Amt : undefined);
        if (amtNode == null) throw new CamtError(`Transaktion ${ti + 1} i post ${ni + 1} saknar belopp`);
        const credit = (text(tx.CdtDbtInd) ?? (entryCredit ? 'CRDT' : 'DBIT')) !== 'DBIT';
        const dbtr = party(tx.RltdPties?.Dbtr);
        const rmt = remittance(tx.RmtInf);
        const sender = account(tx.RltdAccts?.DbtrAcct?.Id);
        const serial = text(tx.Refs?.AcctSvcrRef) ?? text(tx.Refs?.TxId) ?? (entryRef ? (list.length > 1 ? `${entryRef}-${ti + 1}` : entryRef) : null);
        const txInfo = [text(tx.AddtlTxInf), ...rmt.info, ...(ti === 0 ? info : [])].filter((s): s is string => !!s);
        payments.push({
          kind: credit && !reversal ? 'payment' : 'deduction',
          senderBankgiro: sender.bankgiro,
          reference: rmt.reference,
          referenceCode: rmt.code,
          amountOre: amountToOre(amtNode),
          channel: 'camt',
          bgcSerial: serial ? serial.slice(0, 60) : null,
          deductionCode: credit && !reversal ? null : reversal ? 'RVSL' : 'DBIT',
          extraReferences: rmt.extra,
          information: txInfo.map((s) => s.slice(0, 200)),
          payerName: text(dbtr?.Nm)?.slice(0, 140) ?? null,
          payerAddress: address(dbtr?.PstlAdr),
          payerOrgNr: orgNr(dbtr),
          paymentDate: day(tx.RltdDts?.IntrBkSttlmDt ? { Dt: tx.RltdDts.IntrBkSttlmDt } : undefined) ?? entryDate,
          depositSerial: entryRef ?? '',
        });
      });
    });
    out.accounts.push({ ...acct, currency, payments });
  });
  if (!out.accounts.length) throw new CamtError('Filen innehåller inget konto');
  return out;
}

/** Skapar en camt.054-fil. Används i tester och för demodata. */
export function buildCamt054(opts: {
  bankgiro?: string;
  iban?: string;
  date: string;
  messageId?: string;
  payments: { reference?: string; text?: string; amountOre: number; name?: string; serial?: string; debit?: boolean }[];
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const kr = (ore: number) => `${Math.floor(ore / 100)}.${String(ore % 100).padStart(2, '0')}`;
  const acct = opts.iban
    ? `<IBAN>${opts.iban}</IBAN>`
    : `<Othr><Id>${(opts.bankgiro ?? '').replace(/\D/g, '')}</Id><SchmeNm><Prtry>BGNR</Prtry></SchmeNm></Othr>`;
  const entries = opts.payments
    .map((p, i) => {
      const serial = p.serial ?? `${opts.date.replace(/-/g, '')}${String(i + 1).padStart(6, '0')}`;
      const rmt = p.reference
        ? `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${esc(p.reference)}</Ref></CdtrRefInf></Strd></RmtInf>`
        : p.text
          ? `<RmtInf><Ustrd>${esc(p.text)}</Ustrd></RmtInf>`
          : '';
      const ind = p.debit ? 'DBIT' : 'CRDT';
      return `<Ntry><Amt Ccy="SEK">${kr(p.amountOre)}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>${opts.date}</Dt></BookgDt><ValDt><Dt>${opts.date}</Dt></ValDt><AcctSvcrRef>E${serial}</AcctSvcrRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>DMCT</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>${serial}</AcctSvcrRef></Refs><Amt Ccy="SEK">${kr(p.amountOre)}</Amt><CdtDbtInd>${ind}</CdtDbtInd>
${p.name ? `<RltdPties><Dbtr><Pty><Nm>${esc(p.name)}</Nm></Pty></Dbtr></RltdPties>` : ''}${rmt}</TxDtls></NtryDtls></Ntry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08">
<BkToCstmrDbtCdtNtfctn>
<GrpHdr><MsgId>${opts.messageId ?? `MSG${opts.date.replace(/-/g, '')}`}</MsgId><CreDtTm>${opts.date}T06:00:00</CreDtTm></GrpHdr>
<Ntfctn><Id>N1</Id><CreDtTm>${opts.date}T06:00:00</CreDtTm><Acct><Id>${acct}</Id><Ccy>SEK</Ccy></Acct>
${entries}
</Ntfctn>
</BkToCstmrDbtCdtNtfctn>
</Document>
`;
}
