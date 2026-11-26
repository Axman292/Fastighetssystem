import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { kronorToOre, today } from '../common/money';
import { withContext } from '../db/db';
import { property, rentalObject, rentalObjectPrice, rentalObjectVat } from '../db/schema';
import { Ctx, dbContext, RequestContext, requireCompany } from '../auth/request-context';
import { RESIDENTIAL_TYPES } from './property.schemas';

const CATEGORY: Record<string, string> = {
  bostad: 'residential',
  kommersiell: 'commercial',
  blandad: 'mixed',
  parkering: 'parking',
  hotell: 'hotel',
  industri: 'industrial',
  mark: 'land',
  övrigt: 'other',
};
const TYPE: Record<string, string> = {
  lägenhet: 'apartment',
  bostad: 'apartment',
  lokal: 'commercial',
  kontor: 'office',
  restaurang: 'restaurant',
  parkering: 'parking',
  'p-plats': 'parking',
  förråd: 'storage',
  hotellrum: 'hotel_room',
  hotellägenhet: 'hotel_apartment',
  övrigt: 'other',
};

const PROPERTY_COLUMNS = [
  'Fastighetsbeteckning',
  'Namn',
  'Kategori',
  'Adress',
  'Postnummer',
  'Ort',
  'Kommun',
  'Byggår',
  'BOA',
  'LOA',
  'BTA',
  'Tomtarea',
];
const OBJECT_COLUMNS = [
  'Fastighetsbeteckning',
  'Objektsnummer',
  'Typ',
  'Area',
  'Rum',
  'Våning',
  'Lägenhetsnummer',
  'Adress',
  'Månadshyra',
  'Hyra från',
  'Momspliktig',
];

type Issue = { sheet: string; row: number; message: string };
type PropertyRow = typeof property.$inferInsert;
type ObjectRow = typeof rentalObject.$inferInsert & {
  designation: string;
  monthlyRentOre: number | null;
  rentFrom: string;
  vatLiable: boolean;
};

interface Parsed {
  properties: (Omit<PropertyRow, 'companyId'> & { row: number })[];
  objects: (Omit<ObjectRow, 'companyId' | 'propertyId'> & { row: number })[];
  errors: Issue[];
  warnings: Issue[];
}

/** Import av fastigheter och objekt från Excel, med förhandsgranskning innan något sparas. */
@Controller('import')
export class ImportController {
  @Get('template')
  async template(@Res() res: Response) {
    const wb = new ExcelJS.Workbook();
    const ps = wb.addWorksheet('Fastigheter');
    ps.addRow(PROPERTY_COLUMNS).font = { bold: true };
    ps.addRow(['Lund Exempel 1:23', 'Exempelhuset', 'Bostad', 'Storgatan 1', '222 22', 'Lund', 'Lund', 1965, 1240, 180, 1650, 2100]);
    const os = wb.addWorksheet('Objekt');
    os.addRow(OBJECT_COLUMNS).font = { bold: true };
    os.addRow(['Lund Exempel 1:23', '1001', 'Lägenhet', 64, 2, 1, '1101', 'Storgatan 1', 7850, '2026-01-01', 'Nej']);
    os.addRow(['Lund Exempel 1:23', '2001', 'Lokal', 120, null, 0, null, 'Storgatan 1', 14500, '2026-01-01', 'Ja']);
    const help = wb.addWorksheet('Instruktioner');
    help.addRows([
      ['Kategori', Object.keys(CATEGORY).join(', ')],
      ['Typ', Object.keys(TYPE).join(', ')],
      ['Månadshyra', 'I kronor, exklusive moms'],
      ['Hyra från', 'Datum ÅÅÅÅ-MM-DD, tomt = idag'],
      ['Momspliktig', 'Ja eller Nej. Bostäder är alltid momsfria.'],
      ['Fastighetsbeteckning', 'Objekt kopplas till fastighet via beteckningen, i filen eller redan i systemet'],
    ]);
    for (const s of [ps, os]) s.columns.forEach((c) => (c.width = 18));
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', 'attachment; filename="importmall-fastigheter.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }

  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async preview(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    requireCompany(ctx, 'property.import');
    const parsed = await this.parseAndCheck(ctx, file);
    return {
      properties: parsed.properties.length,
      objects: parsed.objects.length,
      propertyRows: parsed.properties.slice(0, 200),
      objectRows: parsed.objects.slice(0, 500),
      errors: parsed.errors,
      warnings: parsed.warnings,
    };
  }

  /** Sparar allt i en transaktion. Finns ett enda fel sparas ingenting. */
  @Post('commit')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async commit(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    const companyId = requireCompany(ctx, 'property.import');
    const parsed = await this.parseAndCheck(ctx, file);
    if (parsed.errors.length) {
      throw new BadRequestException({ message: 'Filen innehåller fel. Inget har sparats.', errors: parsed.errors });
    }
    return withContext(dbContext(ctx), async (db, client) => {
      const ids = new Map<string, string>(
        (await client.query('select id, designation from property')).rows.map((r) => [r.designation, r.id]),
      );
      for (const { row: _row, ...p } of parsed.properties) {
        const [created] = await db.insert(property).values({ ...p, companyId }).returning({ id: property.id });
        ids.set(p.designation, created.id);
      }
      for (const { row: _row, designation, monthlyRentOre, rentFrom, vatLiable, ...o } of parsed.objects) {
        const [obj] = await db
          .insert(rentalObject)
          .values({ ...o, companyId, propertyId: ids.get(designation)! })
          .returning({ id: rentalObject.id });
        if (monthlyRentOre !== null) {
          await db.insert(rentalObjectPrice).values({
            companyId,
            objectId: obj.id,
            monthlyRentOre,
            validFrom: rentFrom,
            reason: 'Import',
          });
        }
        await db.insert(rentalObjectVat).values({ companyId, objectId: obj.id, vatLiable, validFrom: rentFrom });
      }
      return { properties: parsed.properties.length, objects: parsed.objects.length };
    });
  }

  private async parseAndCheck(ctx: RequestContext, file?: Express.Multer.File): Promise<Parsed> {
    if (!file) throw new BadRequestException('Välj en Excel-fil');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('Filen kunde inte läsas. Spara den som .xlsx.');
    }
    const parsed = parseWorkbook(wb);
    // Jämför med det som redan finns i valt bolag
    await withContext(dbContext(ctx), async (_db, client) => {
      const existingProps = new Set<string>(
        (await client.query('select designation from property')).rows.map((r) => r.designation),
      );
      const existingObjs = new Set<string>(
        (await client.query('select object_nr from rental_object')).rows.map((r) => r.object_nr),
      );
      parsed.properties = parsed.properties.filter((p) => {
        if (!existingProps.has(p.designation)) return true;
        parsed.warnings.push({ sheet: 'Fastigheter', row: p.row, message: `${p.designation} finns redan och hoppas över` });
        return false;
      });
      const known = new Set([...existingProps, ...parsed.properties.map((p) => p.designation)]);
      parsed.objects = parsed.objects.filter((o) => {
        if (!known.has(o.designation)) {
          parsed.errors.push({ sheet: 'Objekt', row: o.row, message: `Fastigheten ${o.designation} finns inte` });
          return false;
        }
        if (existingObjs.has(o.objectNr)) {
          parsed.warnings.push({ sheet: 'Objekt', row: o.row, message: `Objekt ${o.objectNr} finns redan och hoppas över` });
          return false;
        }
        return true;
      });
    });
    return parsed;
  }
}

export function parseWorkbook(wb: ExcelJS.Workbook): Parsed {
  const out: Parsed = { properties: [], objects: [], errors: [], warnings: [] };
  const ps = wb.getWorksheet('Fastigheter');
  const os = wb.getWorksheet('Objekt');
  if (!ps && !os) {
    out.errors.push({ sheet: '', row: 0, message: 'Filen saknar flikarna Fastigheter och Objekt. Utgå från importmallen.' });
    return out;
  }

  if (ps) {
    const col = headerIndex(ps, PROPERTY_COLUMNS, 'Fastigheter', out.errors);
    const seen = new Set<string>();
    eachDataRow(ps, (r, n) => {
      const err = (m: string) => out.errors.push({ sheet: 'Fastigheter', row: n, message: m });
      const designation = str(r, col.Fastighetsbeteckning);
      const name = str(r, col.Namn);
      const catText = str(r, col.Kategori)?.toLowerCase();
      const category = catText ? CATEGORY[catText] : undefined;
      if (!designation) return err('Fastighetsbeteckning saknas');
      if (seen.has(designation)) return err(`${designation} förekommer flera gånger`);
      seen.add(designation);
      if (!name) return err('Namn saknas');
      if (!category) return err(`Okänd kategori "${catText ?? ''}"`);
      const year = numOrErr(r, col['Byggår'], 'Byggår', err);
      out.properties.push({
        row: n,
        designation,
        name,
        category,
        addressLine: str(r, col.Adress),
        postalCode: str(r, col.Postnummer),
        city: str(r, col.Ort),
        municipality: str(r, col.Kommun),
        constructionYear: year === null ? null : Math.round(year),
        areaBoaM2: numOrErr(r, col.BOA, 'BOA', err),
        areaLoaM2: numOrErr(r, col.LOA, 'LOA', err),
        areaBtaM2: numOrErr(r, col.BTA, 'BTA', err),
        siteAreaM2: numOrErr(r, col.Tomtarea, 'Tomtarea', err),
      });
    });
  }

  if (os) {
    const col = headerIndex(os, OBJECT_COLUMNS, 'Objekt', out.errors);
    const seen = new Set<string>();
    eachDataRow(os, (r, n) => {
      const err = (m: string) => out.errors.push({ sheet: 'Objekt', row: n, message: m });
      const designation = str(r, col.Fastighetsbeteckning);
      const objectNr = str(r, col.Objektsnummer);
      const typeText = str(r, col.Typ)?.toLowerCase();
      const type = typeText ? TYPE[typeText] : undefined;
      if (!designation) return err('Fastighetsbeteckning saknas');
      if (!objectNr) return err('Objektsnummer saknas');
      if (seen.has(objectNr)) return err(`Objektsnummer ${objectNr} förekommer flera gånger`);
      seen.add(objectNr);
      if (!type) return err(`Okänd typ "${typeText ?? ''}"`);
      const rent = numOrErr(r, col['Månadshyra'], 'Månadshyra', err);
      if (rent !== null && rent < 0) return err('Månadshyran kan inte vara negativ');
      const from = dateOrErr(r, col['Hyra från'], err);
      if (from === undefined) return;
      const vatText = str(r, col.Momspliktig)?.toLowerCase();
      const vatLiable = vatText === 'ja' || vatText === 'j' || vatText === 'x';
      if (vatText && !['ja', 'j', 'x', 'nej', 'n'].includes(vatText)) return err('Momspliktig ska vara Ja eller Nej');
      if (vatLiable && RESIDENTIAL_TYPES.has(type)) return err('Bostäder kan inte vara momspliktiga');
      const floor = numOrErr(r, col['Våning'], 'Våning', err);
      out.objects.push({
        row: n,
        designation,
        objectNr,
        type,
        areaM2: numOrErr(r, col.Area, 'Area', err),
        rooms: numOrErr(r, col.Rum, 'Rum', err),
        floor: floor === null ? null : Math.round(floor),
        apartmentNr: str(r, col['Lägenhetsnummer']),
        addressLine: str(r, col.Adress),
        monthlyRentOre: rent === null ? null : kronorToOre(rent),
        rentFrom: from ?? today(),
        vatLiable,
      });
    });
  }
  return out;
}

function headerIndex(ws: ExcelJS.Worksheet, columns: string[], sheet: string, errors: Issue[]) {
  const header = ws.getRow(1);
  const map: Record<string, number> = {};
  header.eachCell((cell, i) => {
    const name = cellText(cell.value)?.replace(/\*$/, '').trim();
    if (name) map[name] = i;
  });
  for (const required of columns.slice(0, 3)) {
    if (!map[required]) errors.push({ sheet, row: 1, message: `Kolumnen ${required} saknas` });
  }
  return map;
}

function eachDataRow(ws: ExcelJS.Worksheet, fn: (r: ExcelJS.Row, n: number) => void) {
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const empty = (r.values as unknown[]).every((v) => v === null || v === undefined || cellText(v as ExcelJS.CellValue) === null);
    if (!empty) fn(r, n);
  });
}

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text).trim() || null;
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

function str(r: ExcelJS.Row, i?: number): string | null {
  return i ? cellText(r.getCell(i).value) : null;
}

function numOrErr(r: ExcelJS.Row, i: number | undefined, label: string, err: (m: string) => void): number | null {
  if (!i) return null;
  const v = r.getCell(i).value;
  const raw = typeof v === 'object' && v && 'result' in v ? v.result : v;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) {
    err(`${label} är inte ett tal: "${raw}"`);
    return null;
  }
  return n;
}

function dateOrErr(r: ExcelJS.Row, i: number | undefined, err: (m: string) => void): string | null | undefined {
  if (!i) return null;
  const v = r.getCell(i).value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cellText(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    err(`Ogiltigt datum "${s}", använd ÅÅÅÅ-MM-DD`);
    return undefined;
  }
  return s;
}
