import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, startApp } from './helpers';

/**
 * Fas 2 är klar när fastigheter och objekt kan registreras, hyror och moms
 * följs över tid och befintliga fastigheter kan läsas in från Excel.
 */
let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;
let companyA: string;
let companyB: string;

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_fas2'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const byName = (n: string) => me.body.companies.find((c: { companyName: string }) => c.companyName === n).companyId;
  companyA = byName('Fastighet AB Hemporten K');
  companyB = byName('Fastighets AB Hardebergabanan');
  await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
});

afterAll(async () => stop());

describe('fastigheter', () => {
  let propertyId: string;

  it('skapar en fastighet och visar den i listan', async () => {
    const res = await agent
      .post('/properties')
      .send({ name: 'Kvarnen', designation: 'Malmö Kvarnen 4', category: 'mixed', constructionYear: 1931, areaBoaM2: 820, areaLoaM2: 240 })
      .expect(201);
    propertyId = res.body.id;
    const list = await agent.get('/properties').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Kvarnen', companyName: 'Fastighet AB Hemporten K', objectCount: 0 });
  });

  it('nekar dubbla fastighetsbeteckningar i samma bolag', async () => {
    await agent.post('/properties').send({ name: 'Igen', designation: 'Malmö Kvarnen 4', category: 'mixed' }).expect(409);
  });

  it('hanterar underregister: taxering, värdering, lån, försäkring och underhåll', async () => {
    await agent
      .post(`/properties/${propertyId}/tax-assessments`)
      .send({ assessmentYear: 2025, typeCode: '320', landValueSek: 4_000_000, buildingValueSek: 11_000_000, propertyTaxOre: 46_350.5 })
      .expect(201);
    await agent.post(`/properties/${propertyId}/valuations`).send({ valuationDate: '2026-06-30', valueSek: 32_000_000 }).expect(201);
    await agent.post(`/properties/${propertyId}/loans`).send({ lender: 'Handelsbanken', principalOre: 18_500_000, interestBp: 395 }).expect(201);
    await agent.post(`/properties/${propertyId}/insurances`).send({ insurer: 'Länsförsäkringar', validFrom: '2026-01-01', premiumOre: 42_000 }).expect(201);
    await agent.post(`/properties/${propertyId}/maintenance`).send({ component: 'Tak', plannedYear: 2028, estimatedCostOre: 900_000 }).expect(201);
    await agent.put(`/properties/${propertyId}/technical`).send({ heating: 'Fjärrvärme', elevators: 1, ovkDate: '2025-09-01' }).expect(200);
    await agent.get(`/properties/${propertyId}/unknown`).expect(404);

    const p = await agent.get(`/properties/${propertyId}`).expect(200);
    expect(p.body).toMatchObject({ valueSek: 32_000_000, loansOre: 1_850_000_000, taxValueSek: 15_000_000, propertyTaxOre: 4_635_050 });
  });

  describe('hyresobjekt', () => {
    let lgh: string;
    let lokal: string;

    it('skapar objekt med hyra och momsstatus', async () => {
      lgh = (
        await agent
          .post('/objects')
          .send({ propertyId, objectNr: '1001', type: 'apartment', areaM2: 64, rooms: 2, monthlyRent: 7850, rentValidFrom: '2026-01-01' })
          .expect(201)
      ).body.id;
      lokal = (
        await agent
          .post('/objects')
          .send({ propertyId, objectNr: '2001', type: 'commercial', areaM2: 120, monthlyRent: 14500, rentValidFrom: '2026-01-01', vatLiable: true })
          .expect(201)
      ).body.id;
      const list = await agent.get(`/objects?propertyId=${propertyId}`).expect(200);
      expect(list.body.map((o: { objectNr: string; monthlyRentOre: number; vatLiable: boolean }) => [o.objectNr, o.monthlyRentOre, o.vatLiable])).toEqual([
        ['1001', 785_000, false],
        ['2001', 1_450_000, true],
      ]);
      const p = await agent.get('/properties').expect(200);
      expect(p.body[0]).toMatchObject({ objectCount: 2, objectAreaM2: 184, monthlyRentOre: 2_235_000 });
    });

    it('bostäder kan aldrig bli momspliktiga', async () => {
      await agent.post('/objects').send({ propertyId, objectNr: '1002', type: 'apartment', vatLiable: true }).expect(400);
      const res = await agent.post(`/objects/${lgh}/vat`).send({ vatLiable: true, validFrom: '2026-07-01' }).expect(400);
      expect(res.body.message).toBe('Bostäder kan inte vara momspliktiga');
      await agent.patch(`/objects/${lokal}`).send({ type: 'apartment' }).expect(400);
    });

    it('ny hyra avslutar den föregående och historiken finns kvar', async () => {
      await agent.post(`/objects/${lgh}/prices`).send({ monthlyRent: 8100, validFrom: '2026-04-01', reason: 'Hyresförhandling' }).expect(201);
      const o = await agent.get(`/objects/${lgh}`).expect(200);
      expect(o.body.monthlyRentOre).toBe(810_000);
      expect(o.body.prices.map((p: { monthlyRentOre: number; validFrom: string; validTo: string | null }) => [p.monthlyRentOre, p.validFrom, p.validTo])).toEqual([
        [810_000, '2026-04-01', null],
        [785_000, '2026-01-01', '2026-03-31'],
      ]);
      // En hyra som börjar före den senaste nekas, så att historiken inte skrivs över
      await agent.post(`/objects/${lgh}/prices`).send({ monthlyRent: 9000, validFrom: '2026-02-01' }).expect(409);
    });

    it('ett objekt kan inte läggas på en fastighet i ett annat bolag', async () => {
      await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
      await agent.post('/objects').send({ propertyId, objectNr: 'X1', type: 'storage' }).expect(400);
      // Bolag B ser inte HPK:s fastigheter i sin lista
      expect((await agent.get('/properties').expect(200)).body).toHaveLength(0);
      await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
    });

    it('tar bort ett objekt utan historik men aldrig ett som ingår i ett avtal', async () => {
      const tmp = (
        await agent
          .post('/objects')
          .send({
            propertyId,
            objectNr: 'F99',
            type: 'storage',
            monthlyRent: 100,
          })
          .expect(201)
      ).body.id;
      expect((await agent.get(`/objects/${tmp}/delete-check`).expect(200)).body.reasons).toEqual([]);
      await agent.delete(`/objects/${tmp}`).expect(204);
      await agent.get(`/objects/${tmp}`).expect(404);

      const customer = (
        await agent
          .post('/customers')
          .send({
            kind: 'person',
            name: 'Tolvan Tolvansson',
            nationalId: '191212121212',
            email: 'tolvan@example.se',
            addressLine: 'Kvarngatan 4',
            postalCode: '211 11',
            city: 'Malmö',
          })
          .expect(201)
      ).body.id;
      await agent
        .post('/contracts')
        .send({
          type: 'residential',
          customerId: customer,
          startDate: '2026-01-01',
          objectIds: [lgh],
        })
        .expect(201);
      expect((await agent.get(`/objects/${lgh}/delete-check`).expect(200)).body.reasons).toEqual(['Ingår i ett hyresavtal']);
      const res = await agent.delete(`/objects/${lgh}`).expect(409);
      expect(res.body.message).toContain('inaktivt');
      await agent.get(`/objects/${lgh}`).expect(200);
    });

    it('tar bort alla inaktiva objekt och redovisar vilka som hoppades över', async () => {
      const a = (await agent.post('/objects').send({ propertyId, objectNr: 'P01', type: 'parking' }).expect(201)).body.id;
      const b = (await agent.post('/objects').send({ propertyId, objectNr: 'P02', type: 'parking' }).expect(201)).body.id;
      await agent.patch(`/objects/${a}`).send({ active: false }).expect(200);
      await agent.patch(`/objects/${lgh}`).send({ active: false }).expect(200);

      const preview = (await agent.post('/objects/delete-inactive').send({ dryRun: true }).expect(200)).body;
      expect(preview.deleted.map((o: { objectNr: string }) => o.objectNr)).toEqual(['P01']);
      expect(preview.skipped).toMatchObject([{ objectNr: '1001', reasons: ['Ingår i ett hyresavtal'] }]);
      await agent.get(`/objects/${a}`).expect(200);

      const done = (await agent.post('/objects/delete-inactive').send({}).expect(200)).body;
      expect(done.deleted).toHaveLength(1);
      await agent.get(`/objects/${a}`).expect(404);
      await agent.get(`/objects/${b}`).expect(200); // aktivt objekt rörs inte
      await agent.get(`/objects/${lgh}`).expect(200);
    });

    it('ett annat bolag kan inte ta bort objektet', async () => {
      const own = (await agent.post('/objects').send({ propertyId, objectNr: 'F98', type: 'storage' }).expect(201)).body.id;
      await agent.patch(`/objects/${own}`).send({ active: false }).expect(200);
      await agent.post('/auth/switch-company').send({ companyId: companyB }).expect(200);
      await agent.delete(`/objects/${own}`).expect(404);
      expect((await agent.post('/objects/delete-inactive').send({}).expect(200)).body.deleted).toEqual([]);
      await agent.post('/auth/switch-company').send({ companyId: companyA }).expect(200);
      await agent.get(`/objects/${own}`).expect(200);
    });
  });
});

describe('import från Excel', () => {
  async function workbook(objects: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ps = wb.addWorksheet('Fastigheter');
    ps.addRow(['Fastighetsbeteckning', 'Namn', 'Kategori', 'Adress', 'Postnummer', 'Ort', 'Kommun', 'Byggår', 'BOA', 'LOA']);
    ps.addRow(['Lund Hästen 12', 'Hästen', 'Bostad', 'Stora gatan 3', '222 21', 'Lund', 'Lund', 1972, '1 240,5', 0]);
    ps.addRow(['Lund Ugglan 3', 'Ugglan', 'Kommersiell', null, null, 'Lund', 'Lund', 1988, null, 900]);
    const os = wb.addWorksheet('Objekt');
    os.addRow(['Fastighetsbeteckning', 'Objektsnummer', 'Typ', 'Area', 'Rum', 'Våning', 'Lägenhetsnummer', 'Adress', 'Månadshyra', 'Hyra från', 'Momspliktig']);
    for (const r of objects) os.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('mallen kan laddas ner', async () => {
    const res = await agent.get('/import/template').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Fastigheter', 'Objekt', 'Instruktioner']);
  });

  it('förhandsgranskningen visar fel och sparar ingenting', async () => {
    const file = await workbook([
      ['Lund Hästen 12', 'H-1001', 'Lägenhet', 71, 3, 2, '1201', null, 8400, '2026-01-01', 'Nej'],
      ['Lund Hästen 12', 'H-1002', 'Lägenhet', 55, 2, 2, '1202', null, 7100, null, 'Ja'],
      ['Okänd 1:1', 'X-1', 'Lokal', 10, null, null, null, null, 1000, null, 'Ja'],
      ['Lund Ugglan 3', 'U-1', 'Rymdskepp', 10, null, null, null, null, 1000, null, null],
    ]);
    const res = await agent.post('/import/preview').attach('file', file, 'import.xlsx').expect(200);
    expect(res.body.errors.map((e: { row: number; message: string }) => `${e.row}: ${e.message}`)).toEqual([
      '3: Bostäder kan inte vara momspliktiga',
      '5: Okänd typ "rymdskepp"',
      '4: Fastigheten Okänd 1:1 finns inte',
    ]);
    await agent.post('/import/commit').attach('file', file, 'import.xlsx').expect(400);
    const list = await agent.get('/properties').expect(200);
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['Kvarnen']);
  });

  it('en korrekt fil sparas i en transaktion', async () => {
    const file = await workbook([
      ['Lund Hästen 12', 'H-1001', 'Lägenhet', 71, 3, 2, '1201', null, 8400, '2026-01-01', 'Nej'],
      ['Lund Hästen 12', 'H-1002', 'Lägenhet', 55, 2, 2, '1202', null, '7 100', null, null],
      ['Lund Ugglan 3', 'U-1', 'Lokal', 300, null, 0, null, null, 32000.5, '2026-01-01', 'Ja'],
      ['Malmö Kvarnen 4', 'K-P1', 'Parkering', null, null, null, null, null, 450, '2026-01-01', 'Ja'],
    ]);
    const preview = await agent.post('/import/preview').attach('file', file, 'import.xlsx').expect(200);
    expect(preview.body).toMatchObject({ properties: 2, objects: 4, errors: [] });
    const res = await agent.post('/import/commit').attach('file', file, 'import.xlsx').expect(200);
    expect(res.body).toEqual({ properties: 2, objects: 4 });

    const list = await agent.get('/properties').expect(200);
    const hasten = list.body.find((p: { name: string }) => p.name === 'Hästen');
    expect(hasten).toMatchObject({ areaBoaM2: 1240.5, objectCount: 2, monthlyRentOre: 1_550_000 });
    const ugglan = await agent.get('/objects?q=U-1').expect(200);
    expect(ugglan.body[0]).toMatchObject({ monthlyRentOre: 3_200_050, vatLiable: true });

    // Samma fil igen: allt finns redan och hoppas över
    const again = await agent.post('/import/preview').attach('file', file, 'import.xlsx').expect(200);
    expect(again.body).toMatchObject({ properties: 0, objects: 0, errors: [] });
    expect(again.body.warnings).toHaveLength(6);
  });
});
