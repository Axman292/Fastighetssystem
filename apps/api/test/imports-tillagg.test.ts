import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, startApp } from './helpers';

/**
 * En egen Excelfil (källsystem "Annat system") med medhyresgäst och tillägg
 * som bredband och fastighetsskatt ska ge avtal med extra rader.
 */
let app: INestApplication;
let stop: () => Promise<void>;
let agent: Awaited<ReturnType<typeof login>>;

const HEAD = ['Fastighetsbeteckning', 'Objektsnummer', 'Typ', 'Area', 'Gatuadress', 'Månadshyra', 'Hyra från', 'Momspliktig',
  'Hyresgäst', 'E-post', 'Medhyresgäst', 'Medhyresgäst, e-post', 'Avtalsnummer', 'Startdatum', 'Tillägg', 'Tilläggsbelopp', 'Tillägg moms'];

async function file() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Objekt och avtal');
  ws.addRow(HEAD);
  // Blockavtal med bredband per lägenhet
  ws.addRow(['Lund Tillägg 1', 'T1', 'Lägenhet', 50, 'Testgatan 1', 8000, '2026-11-01', 'Nej', 'Testhotellet AB', 'hotell@example.se', null, null, 'A1', '2025-07-01', 'Bredband', 275, 'Nej']);
  ws.addRow(['Lund Tillägg 1', 'T2', 'Lägenhet', 60, 'Testgatan 1', 9000, '2026-11-01', 'Nej', 'Testhotellet AB', 'hotell@example.se', null, null, 'A1', '2025-07-01', 'Bredband', 275, 'Nej']);
  // Privatperson med medhyresgäst
  ws.addRow(['Lund Tillägg 1', 'T3', 'Lägenhet', 40, 'Testgatan 1', 6000, '2026-11-01', 'Nej', 'Anna Exempel', 'anna@example.se', 'Bo Exempel', 'bo@example.se', 'A2', '2024-01-01', null, null, null]);
  // Lokal med momspliktig fastighetsskatt
  ws.addRow(['Lund Tillägg 1', 'T4', 'Lokal', 300, 'Testgatan 1', 50000, '2026-11-01', 'Ja', 'Testhotellet AB', 'hotell@example.se', null, null, 'A3', '2026-01-01', 'Fastighetsskatt', 4000, 'Ja']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  ({ app, stop } = await startApp('fastighet_test_import_tillagg'));
  agent = await login(app);
  const me = await agent.get('/auth/me').expect(200);
  const company = me.body.companies.find((c: { companyName: string }) => c.companyName === 'P Dahlqvist Förvaltning AB').companyId;
  await agent.post('/auth/switch-company').send({ companyId: company }).expect(200);
});

afterAll(async () => stop());

describe('importcentral, tillägg och medhyresgäster', () => {
  it('läser tillägg och medhyresgäst och skapar extra avtalsrader', async () => {
    const batch = (await agent.post('/imports').send({ name: 'Tillägg', sourceSystem: 'generic' }).expect(201)).body.id;
    await agent.post(`/imports/${batch}/files`).attach('files', await file(), 'objekt.xlsx').expect(200);
    const v = (await agent.post(`/imports/${batch}/validate`).expect(200)).body;
    expect(v.perEntity.contract).toMatchObject({ new: 3, error: 0 });
    expect(v.perEntity.cotenant).toMatchObject({ new: 1 });

    const t = (await agent.post(`/imports/${batch}/test`).expect(200)).body;
    expect(t.ok).toBe(true);
    // Hyror 8000 + 9000 + 6000 + 50000 och tillägg 275 + 275 + 4000
    expect(t.reconciliation.batch.monthlyRentOre).toBe(7_755_000);

    await agent.post(`/imports/${batch}/commit`).expect(200);
    const list = (await agent.get('/contracts').expect(200)).body;
    const block = list.find((k: any) => k.objects.includes('T1'));
    expect(block.objects).toContain('T2');
    expect(block.objects).not.toContain('T3');
    const full = (await agent.get(`/contracts/${block.id}`).expect(200)).body;
    const lines = full.lines.map((l: any) => [l.article, l.description, Number(l.amountOre)]);
    expect(lines).toEqual(expect.arrayContaining([['service', 'Bredband', 27500], ['service', 'Bredband', 27500]]));

    const lok = list.find((k: any) => k.objects.includes('T4'));
    const lokFull = (await agent.get(`/contracts/${lok.id}`).expect(200)).body;
    expect(lokFull.lines.find((l: any) => l.description === 'Fastighetsskatt')).toMatchObject({ vatRateBp: 2500 });
    expect(Number(lokFull.lines.find((l: any) => l.description === 'Fastighetsskatt').amountOre)).toBe(400000);

    const customers = (await agent.get('/customers').expect(200)).body;
    const anna = customers.find((c: any) => c.name === 'Anna Exempel');
    const annaFull = (await agent.get(`/customers/${anna.id}`).expect(200)).body;
    expect(annaFull.contacts[0]).toMatchObject({ name: 'Bo Exempel', role: 'Medhyresgäst' });
  });

  it('tillägg på bostadsavtal kan inte vara momspliktigt', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Objekt');
    ws.addRow(HEAD);
    ws.addRow(['Lund Tillägg 2', 'T9', 'Lägenhet', 50, 'Testgatan 2', 8000, '2026-11-01', 'Nej', 'Cecilia Exempel', 'c@example.se', null, null, 'B1', '2025-01-01', 'Bredband', 275, 'Ja']);
    const batch = (await agent.post('/imports').send({ name: 'Fel moms', sourceSystem: 'generic' }).expect(201)).body.id;
    await agent.post(`/imports/${batch}/files`).attach('files', Buffer.from(await wb.xlsx.writeBuffer()), 'fel.xlsx').expect(200);
    const v = (await agent.post(`/imports/${batch}/validate`).expect(200)).body;
    expect(v.perEntity.contract.error).toBe(1);
  });
});
