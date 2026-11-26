import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** Kvar att betala på en utfärdad faktura (ej kreditfaktura). */
export async function invoiceBalance(client: PoolClient, invoiceId: string): Promise<{ balance: number; customerId: string; kind: string; status: string }> {
  const { rows } = await client.query(
    `select b.balance_ore::float as balance, i.customer_id as "customerId", i.kind, i.status
     from invoice i join invoice_balance b on b.invoice_id = i.id where i.id = $1`,
    [invoiceId],
  );
  if (!rows[0]) throw new BadRequestException('Fakturan finns inte i valt bolag');
  return rows[0];
}

export async function unallocated(client: PoolClient, paymentId: string): Promise<{ unallocated: number; customerId: string }> {
  const { rows } = await client.query(
    `select unallocated_ore::float as unallocated, customer_id as "customerId" from payment_balance where payment_id = $1`,
    [paymentId],
  );
  if (!rows[0]) throw new BadRequestException('Betalningen finns inte i valt bolag');
  return rows[0];
}

async function allocate(client: PoolClient, companyId: string, paymentId: string, invoiceId: string, amount: number) {
  if (amount <= 0) return;
  await client.query(`insert into payment_allocation (company_id, payment_id, invoice_id, amount_ore) values ($1, $2, $3, $4)`, [
    companyId,
    paymentId,
    invoiceId,
    amount,
  ]);
}

/** Öppna fakturor för kunden, äldst förfallodag först. */
async function openInvoices(client: PoolClient, customerId: string, except: string[] = []): Promise<{ id: string; balance: number }[]> {
  const { rows } = await client.query(
    `select i.id, b.balance_ore::float as balance
     from invoice i join invoice_balance b on b.invoice_id = i.id
     where i.customer_id = $1 and i.status = 'issued' and i.kind <> 'credit_note' and b.balance_ore > 0 and not (i.id = any($2::uuid[]))
     order by i.due_date, i.invoice_nr`,
    [customerId, except],
  );
  return rows;
}

/** Påminnelseavgifter som hör till fakturan och ännu inte är betalda. */
async function openFeeInvoices(client: PoolClient, invoiceId: string): Promise<{ id: string; balance: number }[]> {
  const { rows } = await client.query(
    `select f.id, b.balance_ore::float as balance
     from reminder r join invoice f on f.id = r.fee_invoice_id join invoice_balance b on b.invoice_id = f.id
     where r.invoice_id = $1 and b.balance_ore > 0 order by r.level`,
    [invoiceId],
  );
  return rows;
}

/**
 * Fördelar en betalning.
 *  * Med faktura: först fakturan, sedan dess påminnelseavgifter. Överskott ligger kvar ej fördelat.
 *  * Utan faktura: kundens öppna fakturor, äldst först.
 * Returnerar fördelningen per faktura.
 */
export async function allocatePayment(
  client: PoolClient,
  companyId: string,
  paymentId: string,
  opts: { invoiceId?: string | null; amount?: number | null } = {},
): Promise<{ invoiceId: string; amountOre: number }[]> {
  const p = await unallocated(client, paymentId);
  let left = Math.min(p.unallocated, opts.amount ?? Number.POSITIVE_INFINITY);
  if (left <= 0) throw new ConflictException('Betalningen är redan helt fördelad');
  const out: { invoiceId: string; amountOre: number }[] = [];
  const take = async (invoiceId: string, balance: number) => {
    const a = Math.min(left, balance);
    if (a <= 0) return;
    await allocate(client, companyId, paymentId, invoiceId, a);
    out.push({ invoiceId, amountOre: a });
    left -= a;
  };
  if (opts.invoiceId) {
    const inv = await invoiceBalance(client, opts.invoiceId);
    if (inv.customerId !== p.customerId) throw new BadRequestException('Fakturan tillhör en annan kund');
    if (inv.status !== 'issued' || inv.kind === 'credit_note') throw new BadRequestException('Betalningar fördelas på utfärdade fakturor');
    if (inv.balance <= 0 && opts.amount) throw new ConflictException('Fakturan är redan betald');
    await take(opts.invoiceId, inv.balance);
    if (opts.amount == null) for (const f of await openFeeInvoices(client, opts.invoiceId)) if (left > 0) await take(f.id, f.balance);
  } else {
    for (const inv of await openInvoices(client, p.customerId)) if (left > 0) await take(inv.id, inv.balance);
  }
  return out;
}

export interface MatchResult {
  status: 'matched' | 'unmatched';
  rule: 'ocr' | 'invoice_nr' | null;
  customerId: string | null;
  invoiceId: string | null;
  note: string | null;
}

/** Hittar fakturan för en inbetalning: först på OCR, sedan på fakturanummer i referensen. */
/** Ord i ett namn utan versaler och accenter, för att jämföra inbetalarens namn med kundens. */
function nameWords(name: string | null | undefined): Set<string> {
  return new Set(
    (name ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !['och', 'ab', 'hb', 'kb'].includes(w)),
  );
}

export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = nameWords(a);
  return [...nameWords(b)].some((w) => wa.has(w));
}

export async function matchPayment(client: PoolClient, companyId: string, reference: string | null, payerName?: string | null): Promise<MatchResult> {
  const none: MatchResult = { status: 'unmatched', rule: null, customerId: null, invoiceId: null, note: null };
  const ref = (reference ?? '').replace(/\s/g, '');
  if (!ref) return { ...none, note: 'Betalningen saknar referens' };
  const byOcr = await client.query(
    `select id, customer_id, kind from invoice where company_id = $1 and status = 'issued' and ocr = $2`,
    [companyId, ref.replace(/^0+/, '')],
  );
  if (byOcr.rows[0]) return { status: 'matched', rule: 'ocr', customerId: byOcr.rows[0].customer_id, invoiceId: byOcr.rows[0].id, note: null };
  const nr = ref.match(/\d{3,12}/)?.[0];
  if (nr) {
    const byNr = await client.query(
      `select i.id, i.customer_id, c.name from invoice i join customer c on c.id = i.customer_id
       where i.company_id = $1 and i.status = 'issued' and i.kind <> 'credit_note' and i.invoice_nr = $2`,
      [companyId, Number(nr)],
    );
    // Ett tal i en fritext kan vara t.ex. ett lägenhetsnummer. Matcha bara om inbetalaren heter som kunden.
    if (byNr.rows[0] && !namesMatch(payerName, byNr.rows[0].name)) {
      return {
        ...none,
        note: `Referensen innehåller ${nr}, som är fakturanummer för ${byNr.rows[0].name}, men inbetalaren heter något annat. Kontrollera och välj kund.`,
      };
    }
    if (byNr.rows[0]) {
      return {
        status: 'matched',
        rule: 'invoice_nr',
        customerId: byNr.rows[0].customer_id,
        invoiceId: byNr.rows[0].id,
        note: `Matchad på fakturanummer ${nr} och inbetalarens namn eftersom OCR saknas. Kontrollera.`,
      };
    }
  }
  return { ...none, note: `Ingen faktura med OCR eller fakturanummer ${ref}` };
}

/** Bokför en matchad banktransaktion som betalning och fördelar den. */
export async function bookTransaction(client: PoolClient, companyId: string, txId: string): Promise<string> {
  const { rows } = await client.query(
    `select id, kind, status, amount_ore::float as amount, payment_date::text as date, reference, customer_id, invoice_id, payer_name
     from bank_transaction where id = $1 for update`,
    [txId],
  );
  const tx = rows[0];
  if (!tx) throw new BadRequestException('Transaktionen finns inte i valt bolag');
  if (tx.status !== 'matched' || !tx.customer_id) throw new ConflictException('Transaktionen är inte matchad mot en kund');
  const p = await client.query(
    `insert into payment (company_id, customer_id, amount_ore, payment_date, method, reference, note, bank_transaction_id)
     values ($1, $2, $3, $4, 'bankgiro', $5, $6, $7) returning id`,
    [companyId, tx.customer_id, tx.amount, tx.date, tx.reference, tx.payer_name ? `Inbetalare: ${tx.payer_name}` : null, tx.id],
  );
  const paymentId = p.rows[0].id;
  if (tx.invoice_id) {
    const inv = await invoiceBalance(client, tx.invoice_id);
    if (inv.balance > 0 || (await openFeeInvoices(client, tx.invoice_id)).length) await allocatePayment(client, companyId, paymentId, { invoiceId: tx.invoice_id });
  } else if ((await openInvoices(client, tx.customer_id)).length) {
    await allocatePayment(client, companyId, paymentId);
  }
  await client.query(`update bank_transaction set status = 'booked' where id = $1`, [tx.id]);
  return paymentId;
}
