import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BgMaxError, BgMaxPayment, parseBgMax, sameBankgiro } from './bgmax';
import { CamtError, isCamt, parseCamt } from './camt';
import { bookTransaction, matchPayment } from './payment-store';

/**
 * Gemensam inläsning av bankens inbetalningsfiler, oavsett om de laddas upp för hand
 * eller hämtas automatiskt från banken.
 *
 * En fil kan innehålla flera konton (camt) och då flera bolag. Varje avsnitt läses in
 * i det bolag vars bankgiro eller bankkonto det gäller.
 */

export type BankFileFormat = 'bgmax' | 'camt054' | 'camt053';

export interface BankFileSection {
  bankgiro: string | null;
  iban: string | null;
  other: string | null;
  payments: BgMaxPayment[];
}

export interface ParsedBankFile {
  format: BankFileFormat;
  timestamp: string | null;
  test: boolean;
  sections: BankFileSection[];
}

export class BankFileError extends Error {}

/** Känner igen formatet och läser filen. Kastar BankFileError med en förklaring på svenska. */
export function parseBankFile(buffer: Buffer): ParsedBankFile {
  const head = buffer.subarray(0, 64).toString('latin1');
  if (head.startsWith('-----BEGIN PGP') || [0x84, 0x85, 0x8c, 0xc1, 0xc3].includes(buffer[0])) {
    throw new BankFileError('Filen är krypterad (PGP). Be banken leverera inbetalningsfilen okrypterad, eller kontakta oss för att lägga in nyckeln.');
  }
  const utf8 = buffer.toString('utf8').replace(/^﻿/, '');
  if (isCamt(utf8)) {
    try {
      const f = parseCamt(utf8);
      return {
        format: f.format,
        timestamp: f.timestamp,
        test: false,
        sections: f.accounts.map((a) => ({ bankgiro: a.bankgiro, iban: a.iban, other: a.other, payments: a.payments })),
      };
    } catch (err) {
      if (err instanceof CamtError) throw new BankFileError(err.message);
      throw err;
    }
  }
  try {
    // Bankgirots BgMax-filer är i ISO 8859-1
    const f = parseBgMax(buffer.toString('latin1'));
    return { format: 'bgmax', timestamp: f.timestamp, test: f.test, sections: [{ bankgiro: f.bankgiro, iban: null, other: null, payments: f.payments }] };
  } catch (err) {
    if (err instanceof BgMaxError) {
      if (/inte en BgMax-fil/.test(err.message)) {
        throw new BankFileError('Filen är varken en BgMax-fil eller en camt.054/camt.053-fil från banken');
      }
      throw new BankFileError(err.message);
    }
    throw err;
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** Läsbar beskrivning av kontot i ett avsnitt. */
export function sectionAccount(s: BankFileSection): string {
  if (s.bankgiro) return `bankgiro ${s.bankgiro}`;
  if (s.iban) return `konto ${s.iban}`;
  if (s.other) return `konto ${s.other}`;
  return 'okänt konto';
}

export interface CompanyAccounts {
  id: string;
  name: string;
  bankgiro: string | null;
  accounts: { clearing: string | null; account: string | null; iban: string | null }[];
}

/** Bolagens bankgiron och bankkonton, för att avgöra vilket bolag ett avsnitt gäller. */
export async function loadCompanyAccounts(client: PoolClient, companyIds: string[]): Promise<CompanyAccounts[]> {
  const { rows } = await client.query(
    `select c.id, c.name, c.bankgiro,
            coalesce((select json_agg(json_build_object('clearing', a.clearing_nr, 'account', a.account_nr, 'iban', a.iban))
                      from bank_account a where a.company_id = c.id), '[]') as accounts
     from company c where c.id = any($1::uuid[])`,
    [companyIds],
  );
  return rows;
}

export function sectionBelongsTo(s: BankFileSection, c: CompanyAccounts): boolean {
  if (s.bankgiro) return sameBankgiro(s.bankgiro, c.bankgiro);
  const iban = (s.iban ?? '').toUpperCase();
  const other = digits(s.other);
  return c.accounts.some((a) => {
    const ai = (a.iban ?? '').replace(/\s/g, '').toUpperCase();
    if (iban && ai && ai === iban) return true;
    // Svenskt IBAN slutar med clearing och kontonummer. Danske Bank: clearing 12xx/13xx.
    const local = digits(a.clearing) + digits(a.account);
    const acct = digits(a.account);
    const target = iban ? digits(iban.slice(4)) : other;
    if (!target) return false;
    return (acct.length >= 7 && target.endsWith(acct)) || (local.length >= 9 && target.endsWith(local));
  });
}

export interface ImportResult {
  id: string;
  companyId: string;
  payments: number;
  totalOre: number;
  matched: number;
  unmatched: number;
  duplicates: number;
  booked: number;
}

/**
 * Läser in avsnitten som ett utkast i ett bolag och matchar betalningarna mot fakturor.
 * Med autoBook bokförs de matchade direkt. Omatchade ligger kvar att hantera.
 * Kastar ingenting om filen redan finns, utan returnerar null.
 */
export async function importSections(
  client: PoolClient,
  opts: {
    companyId: string;
    filename: string;
    sha256: string;
    parsed: ParsedBankFile;
    sections: BankFileSection[];
    source: 'upload' | 'auto';
    connectionId?: string | null;
    autoBook?: boolean;
  },
): Promise<ImportResult | null> {
  const { companyId, parsed, sections } = opts;
  const dup = await client.query('select id from bank_file where company_id = $1 and sha256 = $2', [companyId, opts.sha256]);
  if (dup.rows[0]) return null;
  const payments = sections.flatMap((s) => s.payments);
  const credits = payments.filter((p) => p.kind === 'payment');
  const total = credits.reduce((s, p) => s + p.amountOre, 0);
  const first = sections[0];
  const f = await client.query(
    `insert into bank_file (company_id, format, filename, sha256, bankgiro, file_timestamp, test_file, payment_count, total_ore, source, bank_connection_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [companyId, parsed.format, opts.filename.slice(0, 200), opts.sha256, first ? first.bankgiro ?? first.iban ?? first.other : null,
     parsed.timestamp, parsed.test, credits.length, total, opts.source, opts.connectionId ?? null],
  );
  const fileId: string = f.rows[0].id;
  const counts = { matched: 0, unmatched: 0, duplicates: 0 };
  let pos = 0;
  for (const p of payments) {
    pos += 1;
    const seen = p.bgcSerial
      ? (await client.query(`select 1 from bank_transaction where company_id = $1 and bgc_serial = $2 and status <> 'duplicate'`, [companyId, p.bgcSerial])).rows[0]
      : null;
    let m: { status: string; rule: string | null; customerId: string | null; invoiceId: string | null; note: string | null };
    if (seen) m = { status: 'duplicate', rule: null, customerId: null, invoiceId: null, note: 'Betalningen finns redan i en tidigare inläst fil' };
    else if (p.kind === 'deduction') {
      const note = parsed.format === 'bgmax' ? 'Avdrag från Bankgirot, hanteras manuellt' : 'Uttag eller återföring på kontot, hanteras manuellt';
      m = { status: 'unmatched', rule: null, customerId: null, invoiceId: null, note };
    } else if (p.extraReferences.length) {
      const res = await matchPayment(client, companyId, p.reference, p.payerName, p.amountOre);
      m = { ...res, status: 'unmatched', note: 'Betalningen avser flera fakturor. Välj hur den ska fördelas.' };
    } else m = await matchPayment(client, companyId, p.reference, p.payerName, p.amountOre);
    if (m.status === 'matched') counts.matched += 1;
    else if (m.status === 'duplicate') counts.duplicates += 1;
    else counts.unmatched += 1;
    await client.query(
      `insert into bank_transaction (company_id, bank_file_id, position, kind, amount_ore, payment_date, reference, reference_code,
         sender_bankgiro, payer_name, payer_address, payer_org_nr, information, extra_references, bgc_serial, deposit_serial,
         status, match_rule, customer_id, invoice_id, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [companyId, fileId, pos, p.kind, p.amountOre, p.paymentDate, p.reference, p.referenceCode, p.senderBankgiro, p.payerName,
       p.payerAddress, p.payerOrgNr, p.information.join(' ') || null, JSON.stringify(p.extraReferences), p.bgcSerial, p.depositSerial || null,
       m.status, m.rule, m.customerId, m.invoiceId, m.note],
    );
  }
  let booked = 0;
  if (opts.autoBook) booked = (await bookFile(client, companyId, fileId)).booked;
  return { id: fileId, companyId, payments: credits.length, totalOre: total, ...counts, booked };
}

/** Bokför alla matchade betalningar i en fil som är utkast. */
export async function bookFile(client: PoolClient, companyId: string, fileId: string): Promise<{ booked: number; unmatched: number }> {
  const txs = (await client.query(`select id from bank_transaction where bank_file_id = $1 and status = 'matched' order by position`, [fileId])).rows;
  for (const t of txs) await bookTransaction(client, companyId, t.id);
  await client.query(`update bank_file set status = 'booked', booked_at = now(), booked_by = app.current_user_id() where id = $1`, [fileId]);
  const left = (await client.query(`select count(*)::int as n from bank_transaction where bank_file_id = $1 and status = 'unmatched'`, [fileId])).rows[0].n;
  return { booked: txs.length, unmatched: left };
}
