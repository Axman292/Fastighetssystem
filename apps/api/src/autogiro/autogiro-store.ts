import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { today } from '../common/money';
import { resolveChannel, type BillTo } from '../billing/invoice-store';
import { sendQueued } from '../billing/delivery';
import { allocatePayment } from '../payments/payment-store';
import {
  AutogiroFileError,
  buildMandateFile,
  buildPaymentFile,
  MANDATE_COMMENT,
  mandateOutcome,
  MandateOrder,
  PAYMENT_STATUS,
  ParsedAutogiro,
  REJECTED_COMMENT,
} from './autogiro-format';

export interface AutogiroSettings {
  enabled: boolean;
  customerNr: string | null;
  bankgiro: string | null;
}

export async function loadSettings(client: PoolClient, companyId: string): Promise<AutogiroSettings & { companyBankgiro: string | null }> {
  const r = (
    await client.query(
      `select autogiro_enabled as enabled, autogiro_customer_nr as "customerNr", autogiro_bankgiro as bankgiro, bankgiro as "companyBankgiro"
       from company where id = $1`,
      [companyId],
    )
  ).rows[0];
  if (!r) throw new BadRequestException('Bolaget finns inte');
  return r;
}

async function requireReady(client: PoolClient, companyId: string): Promise<{ customerNr: string; bankgiro: string }> {
  const s = await loadSettings(client, companyId);
  const bankgiro = s.bankgiro ?? s.companyBankgiro;
  if (!s.customerNr) throw new BadRequestException('Ange bolagets kundnummer hos Bankgirot under Autogiro → Inställningar');
  if (!bankgiro) throw new BadRequestException('Ange bankgiro för autogiro under Autogiro → Inställningar, eller bolagets bankgiro under Bolag');
  return { customerNr: s.customerNr, bankgiro };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'latin1').digest('hex');

async function nextBankDayAfterToday(): Promise<string> {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Dragningar
// ---------------------------------------------------------------------

/**
 * Planerar autogirodragningar för utfärdade avier vars hyresgäst har ett gällande medgivande.
 * Dragningen görs på avins förfallodag. Fakturor som redan har en dragning hoppas över.
 */
export async function planPayments(client: PoolClient, companyId: string, invoiceIds?: string[]): Promise<number> {
  const s = await loadSettings(client, companyId);
  if (!s.enabled) return 0;
  const { rowCount } = await client.query(
    `insert into autogiro_payment (company_id, invoice_id, mandate_id, customer_id, payer_nr, amount_ore, payment_date, reference)
     select i.company_id, i.id, m.id, i.customer_id, m.payer_nr, b.balance_ore, i.due_date, i.ocr
     from invoice i
     join invoice_balance b on b.invoice_id = i.id
     join autogiro_mandate m on m.customer_id = i.customer_id and m.status in ('active','sent','new')
     where i.company_id = $1 and i.status = 'issued' and i.kind <> 'credit_note' and i.ocr is not null
       and b.balance_ore > 0 and i.due_date > current_date
       and ($2::uuid[] is null or i.id = any($2))
       and not exists (select 1 from autogiro_payment p where p.invoice_id = i.id and p.status not in ('failed','cancelled'))`,
    [companyId, invoiceIds ?? null],
  );
  return rowCount ?? 0;
}

/**
 * Hyresgästen får avin som vanlig avi att betala med OCR, när dragningen inte gick igenom
 * eller inte kunde göras. E-post skickas direkt, brev läggs i kön för utskrift.
 */
async function fallback(client: PoolClient, companyId: string, paymentIds: string[]): Promise<number> {
  if (!paymentIds.length) return 0;
  const { rows } = await client.query(
    `select p.id, p.invoice_id, i.delivery_method, i.bill_to
     from autogiro_payment p join invoice i on i.id = p.invoice_id join invoice_balance b on b.invoice_id = i.id
     where p.id = any($1) and p.fallback_delivery_id is null and b.balance_ore > 0`,
    [paymentIds],
  );
  const ids: string[] = [];
  for (const r of rows) {
    const { channel, recipient } = resolveChannel(r.delivery_method, r.bill_to as BillTo);
    const d = await client.query(
      `insert into invoice_delivery (company_id, invoice_id, channel, status, recipient) values ($1, $2, $3, 'queued', $4) returning id`,
      [companyId, r.invoice_id, channel, recipient],
    );
    await client.query('update autogiro_payment set fallback_delivery_id = $2 where id = $1', [r.id, d.rows[0].id]);
    ids.push(d.rows[0].id);
  }
  await sendQueued(client, ids);
  return ids.length;
}

/** Makulerar planerade dragningar för ett medgivande som upphört och skickar vanlig avi i stället. */
async function cancelMandatePayments(client: PoolClient, companyId: string, mandateId: string, message: string): Promise<number> {
  const { rows } = await client.query(
    `update autogiro_payment set status = 'cancelled', message = $2
     where mandate_id = $1 and status in ('planned','sent') returning id`,
    [mandateId, message],
  );
  return fallback(
    client,
    companyId,
    rows.map((r) => r.id),
  );
}

export interface FileResult {
  id: string;
  filename: string;
  count: number;
  totalOre: number;
  skipped: { customerName: string; invoiceNr: number | null; reason: string }[];
}

async function saveOutgoing(client: PoolClient, companyId: string, kind: 'mandates' | 'payments', content: string, count: number, totalOre: number) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const filename = `autogiro-${kind === 'mandates' ? 'medgivanden' : 'dragningar'}-${stamp}.txt`;
  const r = await client.query(
    `insert into autogiro_file (company_id, direction, kind, filename, content, sha256, record_count, total_ore, file_date)
     values ($1, 'out', $2, $3, $4, $5, $6, $7, current_date) returning id`,
    [companyId, kind, filename, content, sha256(`${content}${stamp}`), count, totalOre],
  );
  return { id: r.rows[0].id as string, filename };
}

/** Skapar en betalningsfil med alla planerade dragningar vars medgivande är godkänt. */
export async function createPaymentFile(client: PoolClient, companyId: string): Promise<FileResult> {
  const cfg = await requireReady(client, companyId);
  const firstDay = await nextBankDayAfterToday();
  const { rows } = await client.query(
    `select p.id, p.payer_nr as "payerNr", p.amount_ore::float as "amountOre", p.payment_date::text as "paymentDate", p.reference,
            m.status as "mandateStatus", b.balance_ore::float as balance, i.invoice_nr::float as "invoiceNr", c.name as "customerName"
     from autogiro_payment p
     join autogiro_mandate m on m.id = p.mandate_id
     join invoice i on i.id = p.invoice_id
     join invoice_balance b on b.invoice_id = i.id
     join customer c on c.id = p.customer_id
     where p.status = 'planned'
     order by p.payment_date, c.customer_nr
     for update of p`,
  );
  const include: typeof rows = [];
  const skipped: FileResult['skipped'] = [];
  const late: string[] = [];
  for (const r of rows) {
    if (r.balance <= 0) {
      await client.query(`update autogiro_payment set status = 'cancelled', message = 'Avin var redan betald' where id = $1`, [r.id]);
      skipped.push({ customerName: r.customerName, invoiceNr: r.invoiceNr, reason: 'Avin är redan betald och dras inte' });
    } else if (r.paymentDate < firstDay) {
      await client.query(`update autogiro_payment set status = 'cancelled', message = 'Förfallodagen passerade innan dragningen skickades' where id = $1`, [r.id]);
      late.push(r.id);
      skipped.push({ customerName: r.customerName, invoiceNr: r.invoiceNr, reason: 'Förfallodagen har passerat. Hyresgästen får avin att betala som vanligt.' });
    } else if (r.mandateStatus !== 'active') {
      skipped.push({ customerName: r.customerName, invoiceNr: r.invoiceNr, reason: 'Medgivandet är inte godkänt av Bankgirot ännu. Dragningen tas med i nästa fil.' });
    } else {
      include.push({ ...r, amountOre: Math.min(r.amountOre, r.balance) });
    }
  }
  await fallback(client, companyId, late);
  if (!include.length) throw new ConflictException(skipped.length ? `Inga dragningar kan skickas nu. ${skipped[0].reason}` : 'Det finns inga planerade dragningar');
  const content = buildPaymentFile({ date: today(), ...cfg, payments: include });
  const total = include.reduce((s, r) => s + r.amountOre, 0);
  const f = await saveOutgoing(client, companyId, 'payments', content, include.length, total);
  for (const r of include) {
    await client.query(`update autogiro_payment set status = 'sent', file_id = $2, amount_ore = $3 where id = $1`, [r.id, f.id, r.amountOre]);
  }
  return { ...f, count: include.length, totalOre: total, skipped };
}

/** Skapar en medgivandefil med nya medgivanden, svar på internetbanksmedgivanden och makuleringar. */
export async function createMandateFile(client: PoolClient, companyId: string): Promise<FileResult> {
  const cfg = await requireReady(client, companyId);
  const { rows } = await client.query(
    `select id, status, response, payer_nr as "payerNr", clearing_nr as "clearingNr", account_nr as "accountNr", holder_id as "holderId"
     from autogiro_mandate where status in ('new','cancel_new') order by created_at for update`,
  );
  if (!rows.length) throw new ConflictException('Det finns inga medgivanden att skicka');
  const orders: MandateOrder[] = rows.map((r) => ({
    action: r.status === 'cancel_new' ? 'cancel' : r.response === 'reject' ? 'reject' : r.response === 'approve' ? 'approve' : 'add',
    payerNr: r.payerNr,
    clearingNr: r.clearingNr,
    accountNr: r.accountNr,
    holderId: r.holderId,
  }));
  let content: string;
  try {
    content = buildMandateFile({ date: today(), ...cfg, orders });
  } catch (err) {
    if (err instanceof AutogiroFileError) throw new BadRequestException(err.message);
    throw err;
  }
  const f = await saveOutgoing(client, companyId, 'mandates', content, rows.length, 0);
  for (const r of rows) {
    const next = r.status === 'cancel_new' ? 'cancel_sent' : r.response === 'reject' ? 'rejected' : 'sent';
    await client.query(`update autogiro_mandate set status = $2, sent_file_id = $3 where id = $1`, [r.id, next, f.id]);
  }
  return { ...f, count: rows.length, totalOre: 0, skipped: [] };
}

// ---------------------------------------------------------------------
// Filer från Bankgirot
// ---------------------------------------------------------------------

export interface IncomingResult {
  id: string;
  kind: string;
  lines: { payerNr: string; customerName: string | null; outcome: string; message: string }[];
  paid: number;
  failed: number;
  fallbacks: number;
  unmatched: number;
}

export async function importIncoming(client: PoolClient, companyId: string, filename: string, raw: string, parsed: ParsedAutogiro): Promise<IncomingResult> {
  const cfg = await loadSettings(client, companyId);
  const bg = (cfg.bankgiro ?? cfg.companyBankgiro ?? '').replace(/\D/g, '');
  if (parsed.bankgiro && bg && parsed.bankgiro.replace(/\D/g, '') !== bg) {
    throw new BadRequestException(`Filen gäller bankgiro ${parsed.bankgiro}, men bolagets autogiro använder ${cfg.bankgiro ?? cfg.companyBankgiro}. Välj rätt bolag.`);
  }
  if (parsed.customerNr && cfg.customerNr && Number(parsed.customerNr) !== Number(cfg.customerNr)) {
    throw new BadRequestException(`Filen gäller kundnummer ${parsed.customerNr} hos Bankgirot, men bolagets är ${cfg.customerNr}. Välj rätt bolag.`);
  }
  const hash = sha256(raw);
  const ins = await client.query(
    `insert into autogiro_file (company_id, direction, kind, filename, content, sha256, record_count, total_ore, file_date, status)
     values ($1, 'in', $2, $3, $4, $5, $6, $7, $8, 'processed') on conflict (company_id, direction, sha256) do nothing returning id`,
    [
      companyId,
      parsed.kind,
      filename,
      raw,
      hash,
      parsed.mandates.length + parsed.internetMandates.length + parsed.payments.length,
      parsed.payments.reduce((s, p) => s + p.amountOre, 0),
      parsed.fileDate,
    ],
  );
  if (!ins.rows[0]) throw new ConflictException('Filen är redan inläst');
  const fileId: string = ins.rows[0].id;
  const res: IncomingResult = { id: fileId, kind: parsed.kind, lines: [], paid: 0, failed: 0, fallbacks: 0, unmatched: 0 };

  if (parsed.kind === 'mandate_advice') await applyMandateAdvice(client, companyId, parsed, res);
  else if (parsed.kind === 'internet_mandates') await applyInternetMandates(client, companyId, parsed, res);
  else await applyPayments(client, companyId, fileId, parsed, res);

  await client.query(`update autogiro_file set result = $2 where id = $1`, [fileId, JSON.stringify(res)]);
  return res;
}

async function customerByPayerNr(client: PoolClient, payerNr: string): Promise<{ id: string; name: string } | null> {
  if (!/^\d{1,9}$/.test(payerNr)) return null;
  return (await client.query('select id, name from customer where customer_nr = $1', [Number(payerNr)])).rows[0] ?? null;
}

async function applyMandateAdvice(client: PoolClient, companyId: string, parsed: ParsedAutogiro, res: IncomingResult) {
  for (const a of parsed.mandates) {
    const outcome = mandateOutcome(a.infoCode, a.commentCode);
    const message = MANDATE_COMMENT[a.commentCode] ?? `Kod ${a.infoCode}/${a.commentCode}`;
    const m = (
      await client.query(
        `select m.id, m.status, c.name from autogiro_mandate m join customer c on c.id = m.customer_id
         where m.payer_nr = $1 order by (m.status in ('rejected','cancelled')), m.created_at desc limit 1 for update of m`,
        [a.payerNr],
      )
    ).rows[0];
    const codes = [a.infoCode, a.commentCode, message];
    if (!m) {
      const c = outcome === 'active' ? await customerByPayerNr(client, a.payerNr) : null;
      if (c) {
        await client.query(
          `insert into autogiro_mandate (company_id, customer_id, payer_nr, clearing_nr, account_nr, holder_id, source, status, info_code, comment_code, bgc_message, activated_date)
           values ($1, $2, $3, $4, $5, $6, 'internet_bank', 'active', $7, $8, $9, coalesce($10::date, current_date))`,
          [companyId, c.id, a.payerNr, a.clearingNr, a.accountNr, a.holderId, ...codes, a.date],
        );
        res.lines.push({ payerNr: a.payerNr, customerName: c.name, outcome: 'Godkänt', message: `${message}. Medgivandet lades upp på hyresgästen med samma kundnummer.` });
      } else {
        res.unmatched += 1;
        res.lines.push({ payerNr: a.payerNr, customerName: null, outcome: 'Okänt', message: `${message}. Inget medgivande med betalarnumret finns i systemet.` });
      }
      continue;
    }
    if (outcome === 'active') {
      await client.query(
        `update autogiro_mandate set status = 'active', activated_date = coalesce($2::date, current_date), info_code = $3, comment_code = $4, bgc_message = $5,
                clearing_nr = coalesce($6, clearing_nr), account_nr = coalesce($7, account_nr), holder_id = coalesce($8, holder_id)
         where id = $1`,
        [m.id, a.date, ...codes, a.clearingNr, a.accountNr, a.holderId],
      );
      res.lines.push({ payerNr: a.payerNr, customerName: m.name, outcome: 'Godkänt', message });
    } else if (outcome === 'pending') {
      await client.query(`update autogiro_mandate set info_code = $2, comment_code = $3, bgc_message = $4 where id = $1`, [m.id, ...codes]);
      res.lines.push({ payerNr: a.payerNr, customerName: m.name, outcome: 'Väntar', message });
    } else {
      // En makulering som Bankgirot inte hittar betyder också att medgivandet är borta
      const status = outcome === 'cancelled' || m.status === 'cancel_sent' ? 'cancelled' : 'rejected';
      await client.query(
        `update autogiro_mandate set status = $2, cancelled_date = coalesce($3::date, current_date), info_code = $4, comment_code = $5, bgc_message = $6 where id = $1`,
        [m.id, status, a.date, ...codes],
      );
      const n = await cancelMandatePayments(client, companyId, m.id, `Medgivandet ${status === 'cancelled' ? 'makulerades' : 'avvisades'}: ${message}`);
      res.fallbacks += n;
      res.lines.push({
        payerNr: a.payerNr,
        customerName: m.name,
        outcome: status === 'cancelled' ? 'Makulerat' : 'Avvisat',
        message: n ? `${message}. ${n} avi(er) skickades som vanlig avi i stället.` : message,
      });
    }
  }
}

async function applyInternetMandates(client: PoolClient, companyId: string, parsed: ParsedAutogiro, res: IncomingResult) {
  for (const a of parsed.internetMandates) {
    const c = await customerByPayerNr(client, a.payerNr);
    if (!c) {
      res.unmatched += 1;
      res.lines.push({
        payerNr: a.payerNr,
        customerName: a.nameLines[0] ?? null,
        outcome: 'Okänt',
        message: 'Betalarnumret är inget kundnummer här. Be hyresgästen ange sitt kundnummer, eller lägg upp medgivandet för hand.',
      });
      continue;
    }
    const existing = (await client.query(`select id, status from autogiro_mandate where customer_id = $1 and status not in ('rejected','cancelled')`, [c.id])).rows[0];
    if (existing) {
      res.lines.push({ payerNr: a.payerNr, customerName: c.name, outcome: 'Finns redan', message: 'Hyresgästen har redan ett medgivande. Kontrollera och avvisa vid behov.' });
      continue;
    }
    await client.query(
      `insert into autogiro_mandate (company_id, customer_id, payer_nr, clearing_nr, account_nr, holder_id, holder_name, source, status, signed_date, note)
       values ($1, $2, $3, $4, $5, $6, $7, 'internet_bank', 'review', coalesce($8::date, current_date), $9)`,
      [companyId, c.id, a.payerNr, a.clearingNr, a.accountNr, a.holderId, a.nameLines[0] ?? null, parsed.fileDate, a.info],
    );
    res.lines.push({ payerNr: a.payerNr, customerName: c.name, outcome: 'Att granska', message: 'Nytt medgivande från internetbanken. Godkänn eller avvisa det under Medgivanden.' });
  }
}

async function applyPayments(client: PoolClient, companyId: string, fileId: string, parsed: ParsedAutogiro, res: IncomingResult) {
  const failedIds: string[] = [];
  for (const p of parsed.payments) {
    const ref = p.reference.replace(/\s/g, '');
    const ap = (
      await client.query(
        `select ap.id, ap.invoice_id, ap.customer_id, ap.status, c.name
         from autogiro_payment ap join customer c on c.id = ap.customer_id
         where ap.payer_nr = $1 and ap.reference = $2
         order by (ap.status = 'sent') desc, ap.created_at desc limit 1 for update of ap`,
        [p.payerNr, ref],
      )
    ).rows[0];
    const why = parsed.kind === 'rejected_payments' ? (REJECTED_COMMENT[p.code] ?? `Kod ${p.code}`) : (PAYMENT_STATUS[p.code] ?? `Status ${p.code}`);
    if (!ap) {
      if (p.ok) {
        // Pengarna har kommit in. Bokför på avin med samma OCR om den finns.
        const inv = (await client.query(`select id, customer_id from invoice where status = 'issued' and ocr = $1`, [ref.replace(/^0+/, '')])).rows[0];
        if (inv) {
          await bookPayment(client, companyId, inv.customer_id, inv.id, p.amountOre, p.paymentDate ?? today(), ref);
          res.paid += 1;
          res.lines.push({ payerNr: p.payerNr, customerName: null, outcome: 'Bokförd', message: `Dragningen fanns inte i systemet men bokfördes på avin med OCR ${ref}.` });
          continue;
        }
      }
      res.unmatched += 1;
      res.lines.push({ payerNr: p.payerNr, customerName: null, outcome: p.ok ? 'Okänd betalning' : 'Okänd', message: `${why}. Ingen dragning med referens ${ref || '(tom)'} finns. Registrera betalningen för hand.` });
      continue;
    }
    if (ap.status === 'paid') {
      res.lines.push({ payerNr: p.payerNr, customerName: ap.name, outcome: 'Redan bokförd', message: 'Dragningen är redan bokförd och bokförs inte igen.' });
      continue;
    }
    if (p.ok) {
      const paymentId = await bookPayment(client, companyId, ap.customer_id, ap.invoice_id, p.amountOre, p.paymentDate ?? today(), ref);
      await client.query(`update autogiro_payment set status = 'paid', payment_id = $2, result_file_id = $3, status_code = $4, message = null where id = $1`, [
        ap.id,
        paymentId,
        fileId,
        p.code,
      ]);
      res.paid += 1;
      res.lines.push({ payerNr: p.payerNr, customerName: ap.name, outcome: 'Dragen', message: 'Betalningen är bokförd på avin.' });
    } else if (p.code === '9' && parsed.kind === 'payment_spec') {
      await client.query(`update autogiro_payment set result_file_id = $2, status_code = $3, message = $4 where id = $1`, [ap.id, fileId, p.code, why]);
      res.lines.push({ payerNr: p.payerNr, customerName: ap.name, outcome: 'Försöker igen', message: why });
    } else {
      await client.query(`update autogiro_payment set status = 'failed', result_file_id = $2, status_code = $3, message = $4 where id = $1`, [ap.id, fileId, p.code, why]);
      failedIds.push(ap.id);
      res.failed += 1;
      res.lines.push({ payerNr: p.payerNr, customerName: ap.name, outcome: 'Misslyckad', message: `${why}. Hyresgästen får avin att betala med OCR.` });
    }
  }
  res.fallbacks += await fallback(client, companyId, failedIds);
}

async function bookPayment(client: PoolClient, companyId: string, customerId: string, invoiceId: string, amountOre: number, date: string, ref: string): Promise<string> {
  const p = await client.query(
    `insert into payment (company_id, customer_id, amount_ore, payment_date, method, reference, note)
     values ($1, $2, $3, $4, 'autogiro', $5, 'Autogiro') returning id`,
    [companyId, customerId, amountOre, date, ref],
  );
  const paymentId = p.rows[0].id;
  await allocatePayment(client, companyId, paymentId, { invoiceId });
  return paymentId;
}

/** Mandatets följder när det makuleras i systemet: planerade dragningar stoppas och vanlig avi skickas. */
export async function cancelMandate(client: PoolClient, companyId: string, mandateId: string): Promise<{ status: string; fallbacks: number }> {
  const m = (await client.query(`select status from autogiro_mandate where id = $1 for update`, [mandateId])).rows[0];
  if (!m) throw new BadRequestException('Medgivandet finns inte i valt bolag');
  if (['rejected', 'cancelled', 'cancel_new', 'cancel_sent'].includes(m.status)) throw new ConflictException('Medgivandet är redan avslutat');
  // Har det aldrig skickats till Bankgirot behövs ingen makulering där
  const next = m.status === 'new' || m.status === 'review' ? 'cancelled' : 'cancel_new';
  await client.query(`update autogiro_mandate set status = $2, cancelled_date = case when $2 = 'cancelled' then current_date end where id = $1`, [mandateId, next]);
  // Dragningar som redan skickats ligger kvar hos Bankgirot tills makuleringen gått fram. Planerade stoppas direkt.
  const { rows } = await client.query(
    `update autogiro_payment set status = 'cancelled', message = 'Medgivandet makulerades' where mandate_id = $1 and status = 'planned' returning id`,
    [mandateId],
  );
  const fallbacks = await fallback(
    client,
    companyId,
    rows.map((r) => r.id),
  );
  return { status: next, fallbacks };
}
