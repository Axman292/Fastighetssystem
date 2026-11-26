import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from '../common/validation';
import { withContext } from '../db/db';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { BgMaxError, parseBgMax, sameBankgiro } from './bgmax';
import { bookTransaction, matchPayment } from './payment-store';

const TX_SQL = `
  select t.id, t.bank_file_id as "bankFileId", t.position, t.kind, t.amount_ore::float as "amountOre", t.payment_date::text as "paymentDate",
         t.reference, t.reference_code as "referenceCode", t.sender_bankgiro as "senderBankgiro", t.payer_name as "payerName",
         t.payer_address as "payerAddress", t.payer_org_nr as "payerOrgNr", t.information, t.extra_references as "extraReferences",
         t.bgc_serial as "bgcSerial", t.status, t.match_rule as "matchRule", t.note,
         t.customer_id as "customerId", c.name as "customerName", c.customer_nr as "customerNr",
         t.invoice_id as "invoiceId", i.invoice_nr::float as "invoiceNr", i.kind as "invoiceKind",
         b.balance_ore::float as "invoiceBalanceOre", i.total_ore::float as "invoiceTotalOre",
         (select p.id from payment p where p.bank_transaction_id = t.id) as "paymentId",
         (select pb.unallocated_ore::float from payment p join payment_balance pb on pb.payment_id = p.id where p.bank_transaction_id = t.id) as "unallocatedOre",
         f.filename, f.status as "fileStatus"
  from bank_transaction t
  join bank_file f on f.id = t.bank_file_id
  left join customer c on c.id = t.customer_id
  left join invoice i on i.id = t.invoice_id
  left join invoice_balance b on b.invoice_id = t.invoice_id`;

const assignSchema = z.union([
  z.object({ ignore: z.literal(true), note: z.string().trim().min(2, 'Ange varför').max(300) }),
  z.object({
    ignore: z.literal(false).optional(),
    customerId: z.string().uuid().nullable(),
    invoiceId: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  }),
]);

@Controller('bank-files')
export class BankFilesController {
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return withContext(dbContext(ctx), async (_db, client) =>
      (
        await client.query(
          `select f.id, f.company_id as "companyId", co.name as "companyName", f.filename, f.bankgiro, f.test_file as "testFile",
                  f.status, f.payment_count as "paymentCount", f.total_ore::float as "totalOre", f.created_at as "createdAt",
                  f.booked_at as "bookedAt", (select name from app_user u where u.id = f.created_by) as "createdByName",
                  (select min(t.payment_date)::text from bank_transaction t where t.bank_file_id = f.id) as "paymentDate",
                  (select count(*)::int from bank_transaction t where t.bank_file_id = f.id and t.status = 'unmatched') as "unmatchedCount",
                  (select count(*)::int from bank_transaction t where t.bank_file_id = f.id and t.status = 'duplicate') as "duplicateCount"
           from bank_file f join company co on co.id = f.company_id
           order by f.created_at desc limit 200`,
        )
      ).rows,
    );
  }

  /**
   * Läser in en BgMax-fil som ett utkast. Betalningarna matchas mot fakturor men
   * ingenting bokförs förrän filen har granskats och bokförts.
   */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    const companyId = requireCompany(ctx, 'payment.write');
    if (!file?.buffer?.length) throw new BadRequestException('Välj en fil');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    let parsed;
    try {
      // Bankgirots filer är i ISO 8859-1
      parsed = parseBgMax(file.buffer.toString('latin1'));
    } catch (err) {
      if (err instanceof BgMaxError) throw new BadRequestException(err.message);
      throw err;
    }
    return withContext(dbContext(ctx), async (_db, client) => {
      const company = (await client.query('select bankgiro from company where id = $1', [companyId])).rows[0];
      if (!sameBankgiro(company?.bankgiro, parsed.bankgiro)) {
        throw new BadRequestException(
          `Filen gäller bankgiro ${parsed.bankgiro}, men bolagets bankgiro är ${company?.bankgiro ?? 'inte angivet'}. Välj rätt bolag eller rätta bankgirot under Bolag.`,
        );
      }
      const dup = await client.query('select id, filename from bank_file where company_id = $1 and sha256 = $2', [companyId, sha256]);
      if (dup.rows[0]) throw new ConflictException(`Filen är redan inläst (${dup.rows[0].filename})`);
      const total = parsed.payments.reduce((s, p) => s + (p.kind === 'payment' ? p.amountOre : 0), 0);
      const f = await client.query(
        `insert into bank_file (company_id, format, filename, sha256, bankgiro, file_timestamp, test_file, payment_count, total_ore)
         values ($1, 'bgmax', $2, $3, $4, $5, $6, $7, $8) returning id`,
        [companyId, (file.originalname || 'bgmax.txt').slice(0, 200), sha256, parsed.bankgiro, parsed.timestamp, parsed.test,
         parsed.payments.filter((p) => p.kind === 'payment').length, total],
      );
      const fileId = f.rows[0].id;
      let pos = 0;
      for (const p of parsed.payments) {
        pos += 1;
        const seen = p.bgcSerial
          ? (await client.query(`select 1 from bank_transaction where company_id = $1 and bgc_serial = $2 and status <> 'duplicate'`, [companyId, p.bgcSerial])).rows[0]
          : null;
        let m: { status: string; rule: string | null; customerId: string | null; invoiceId: string | null; note: string | null };
        if (seen) m = { status: 'duplicate', rule: null, customerId: null, invoiceId: null, note: 'Betalningen finns redan i en tidigare inläst fil' };
        else if (p.kind === 'deduction') m = { status: 'unmatched', rule: null, customerId: null, invoiceId: null, note: 'Avdrag från Bankgirot, hanteras manuellt' };
        else if (p.extraReferences.length) {
          const first = await matchPayment(client, companyId, p.reference, p.payerName);
          m = { ...first, status: 'unmatched', note: 'Betalningen avser flera fakturor. Välj hur den ska fördelas.' };
        } else m = await matchPayment(client, companyId, p.reference, p.payerName);
        await client.query(
          `insert into bank_transaction (company_id, bank_file_id, position, kind, amount_ore, payment_date, reference, reference_code,
             sender_bankgiro, payer_name, payer_address, payer_org_nr, information, extra_references, bgc_serial, deposit_serial,
             status, match_rule, customer_id, invoice_id, note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [companyId, fileId, pos, p.kind, p.amountOre, p.paymentDate, p.reference, p.referenceCode, p.senderBankgiro, p.payerName,
           p.payerAddress, p.payerOrgNr, p.information.join(' ') || null, JSON.stringify(p.extraReferences), p.bgcSerial, p.depositSerial,
           m.status, m.rule, m.customerId, m.invoiceId, m.note],
        );
      }
      return { id: fileId };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return withContext(dbContext(ctx), async (_db, client) => {
      const f = (
        await client.query(
          `select f.id, f.company_id as "companyId", co.name as "companyName", f.filename, f.bankgiro, f.file_timestamp as "fileTimestamp",
                  f.test_file as "testFile", f.status, f.payment_count as "paymentCount", f.total_ore::float as "totalOre",
                  f.created_at as "createdAt", f.booked_at as "bookedAt",
                  (select name from app_user u where u.id = f.created_by) as "createdByName",
                  (select name from app_user u where u.id = f.booked_by) as "bookedByName"
           from bank_file f join company co on co.id = f.company_id where f.id = $1`,
          [id],
        )
      ).rows[0];
      if (!f) throw new BadRequestException('Filen finns inte');
      const transactions = (await client.query(`${TX_SQL} where t.bank_file_id = $1 order by t.position`, [id])).rows;
      return { ...f, transactions };
    });
  }

  /** Bokför alla matchade betalningar i filen. Omatchade ligger kvar att hantera senare. */
  @Post(':id/book')
  book(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const companyId = requireCompany(ctx, 'payment.write');
    return withContext(dbContext(ctx), async (_db, client) => {
      const f = (await client.query('select status from bank_file where id = $1 for update', [id])).rows[0];
      if (!f) throw new BadRequestException('Filen finns inte i valt bolag');
      if (f.status !== 'draft') throw new ConflictException('Filen är redan bokförd');
      const txs = (await client.query(`select id from bank_transaction where bank_file_id = $1 and status = 'matched' order by position`, [id])).rows;
      for (const t of txs) await bookTransaction(client, companyId, t.id);
      await client.query(`update bank_file set status = 'booked', booked_at = now(), booked_by = app.current_user_id() where id = $1`, [id]);
      const left = (await client.query(`select count(*)::int as n from bank_transaction where bank_file_id = $1 and status = 'unmatched'`, [id])).rows[0].n;
      return { booked: txs.length, unmatched: left };
    });
  }

  /** Tar bort en fil som inte bokförts, t.ex. om fel fil lästs in. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    requireCompany(ctx, 'payment.write');
    await withContext(dbContext(ctx), async (_db, client) => {
      const f = (await client.query('select status from bank_file where id = $1 for update', [id])).rows[0];
      if (!f) throw new BadRequestException('Filen finns inte i valt bolag');
      if (f.status !== 'draft') throw new ConflictException('En bokförd fil kan inte tas bort. Ta bort enskilda betalningar i stället.');
      await client.query('delete from bank_file where id = $1', [id]);
    });
  }
}

@Controller('bank-transactions')
export class BankTransactionsController {
  /** Transaktioner i alla filer, till exempel de omatchade som väntar på hantering. */
  @Get()
  list(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    if (status && !['matched', 'unmatched', 'ignored', 'booked', 'duplicate'].includes(status)) throw new BadRequestException('Ogiltig status');
    return withContext(dbContext(ctx), async (_db, client) =>
      (await client.query(`${TX_SQL} where ($1::text is null or t.status = $1) order by t.payment_date desc, t.position limit 500`, [status || null])).rows,
    );
  }

  /**
   * Pekar ut kund och faktura för en inbetalning, eller markerar den som hanterad utanför systemet.
   * Ligger filen redan bokförd bokförs betalningen direkt.
   */
  @Patch(':id')
  assign(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const companyId = requireCompany(ctx, 'payment.write');
    const data = parse(assignSchema, body);
    return withContext(dbContext(ctx), async (_db, client) => {
      const t = (
        await client.query(
          `select t.status, t.kind, f.status as file_status from bank_transaction t join bank_file f on f.id = t.bank_file_id where t.id = $1 for update of t`,
          [id],
        )
      ).rows[0];
      if (!t) throw new BadRequestException('Transaktionen finns inte i valt bolag');
      if (t.status === 'booked') throw new ConflictException('Betalningen är redan bokförd. Ta bort betalningen först om den blivit fel.');
      if (t.status === 'duplicate') throw new ConflictException('Betalningen finns redan i en tidigare fil och bokförs inte igen');
      if (data.ignore) {
        await client.query(`update bank_transaction set status = 'ignored', note = $2, customer_id = null, invoice_id = null, match_rule = null where id = $1`, [id, data.note]);
      } else {
        if (t.kind !== 'payment') throw new ConflictException('Avdrag kan bara markeras som hanterade');
        let customerId = data.customerId;
        const invoiceId = data.invoiceId ?? null;
        if (invoiceId) {
          const inv = (await client.query(`select customer_id, status, kind from invoice where id = $1`, [invoiceId])).rows[0];
          if (!inv || inv.status !== 'issued' || inv.kind === 'credit_note') throw new BadRequestException('Välj en utfärdad faktura');
          if (customerId && inv.customer_id !== customerId) throw new BadRequestException('Fakturan tillhör en annan kund');
          customerId = inv.customer_id;
        }
        if (customerId) {
          const ok = (await client.query('select 1 from customer where id = $1', [customerId])).rows[0];
          if (!ok) throw new BadRequestException('Kunden finns inte i valt bolag');
        }
        await client.query(
          `update bank_transaction set status = $2, customer_id = $3, invoice_id = $4, match_rule = $5, note = $6 where id = $1`,
          [id, customerId ? 'matched' : 'unmatched', customerId, invoiceId, customerId ? 'manual' : null, data.note ?? null],
        );
        if (customerId && t.file_status === 'booked') await bookTransaction(client, companyId, id);
      }
      return (await client.query(`${TX_SQL} where t.id = $1`, [id])).rows[0];
    });
  }
}
