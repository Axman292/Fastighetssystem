import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { closePool } from '../db/db';

/**
 * Fyller en tom testmiljö med påhittade fastigheter, hyresgäster, avtal, avier och betalningar
 * så att alla delar av systemet går att prova. Allt läggs in genom API:et, så samma regler och
 * kontroller gäller som när en användare arbetar i systemet.
 *
 * Inga verkliga personer eller bolag: namnen är påhittade, personnumren har serienummer 98xx
 * och e-postadresserna slutar på example.se (som aldrig tar emot post).
 *
 * Körs bara om inga fastigheter finns, så det går att köra vid varje start.
 */

type Json = Record<string, unknown>;

class Session {
  private cookies = new Map<string, string>();
  constructor(private base: string) {}

  async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} gav ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  get = <T = Json>(p: string) => this.call<T>('GET', p);
  post = <T = Json>(p: string, b: unknown = {}) => this.call<T>('POST', p, b);
  patch = <T = Json>(p: string, b: unknown) => this.call<T>('PATCH', p, b);
}

/** Lägger till Luhn-kontrollsiffra (personnummer, 10 siffror ÅÅMMDDNNNK). */
function luhn(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(nine[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return nine + ((10 - (sum % 10)) % 10);
}
const pnr = (century: string, yymmdd: string, serial3: string) => century + luhn(yymmdd + serial3);

function monthOffset(offset: number): string {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  return m.toISOString().slice(0, 7);
}

export async function seedDemo(email: string, password: string, log = console.log): Promise<void> {
  const app = await createApp();
  app.useLogger(['error', 'warn']);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const s = new Session(`http://127.0.0.1:${port}`);
  try {
    await s.post('/auth/login', { email, password });
    const me = await s.get<{ companies: { companyId: string; companyName: string }[] }>('/auth/me');
    const company = (name: string) => {
      const c = me.companies.find((x) => x.companyName === name);
      if (!c) throw new Error(`Bolaget ${name} saknas`);
      return c.companyId;
    };
    const pdf = company('P Dahlqvist Förvaltning AB');
    const hpk = company('HPK AB');
    const hbb = company('Hardebergabanan AB');

    await s.post('/auth/switch-company', { companyId: pdf });
    if ((await s.get<unknown[]>('/properties')).length) {
      log('Demodata finns redan, inget lades till.');
      return;
    }

    const start = `${monthOffset(-2)}-01`;
    const companyData: [string, Json][] = [
      [pdf, { bankgiro: '5050-1055', vatNr: 'SE559000001301', invoiceEmail: 'hyror@example.se' }],
      [hpk, { bankgiro: '5050-1063', vatNr: 'SE559000002201', invoiceEmail: 'ekonomi@example.se' }],
      [hbb, { bankgiro: '5050-1071', vatNr: 'SE559000003101', invoiceEmail: 'info@example.se' }],
    ];
    for (const [id, body] of companyData) await s.patch(`/companies/${id}`, body);

    const contracts: { id: string; customerId: string; companyId: string }[] = [];
    let customerSerial = 980;

    const property = (body: Json) => s.post<{ id: string }>('/properties', body);
    const object = async (propertyId: string, body: Json) =>
      (await s.post<{ id: string }>('/objects', { propertyId, rentValidFrom: '2024-01-01', ...body })).id;
    const person = async (name: string, born: string, street: string, postal: string, city: string) =>
      (
        await s.post<{ id: string }>('/customers', {
          kind: 'person',
          name,
          nationalId: pnr(born.slice(0, 2), born.slice(2), String(customerSerial++)),
          email: `${name.split(' ')[0].toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o')}@example.se`,
          addressLine: street,
          postalCode: postal,
          city,
        })
      ).id;
    const org = async (name: string, orgNine: string, street: string, postal: string, city: string, deliveryMethod = 'email') =>
      (
        await s.post<{ id: string }>('/customers', {
          kind: 'organization',
          name,
          nationalId: luhn(orgNine),
          deliveryMethod,
          email: deliveryMethod === 'email' ? 'faktura@example.se' : undefined,
          addressLine: street,
          postalCode: postal,
          city,
        })
      ).id;
    const contract = async (companyId: string, body: Json, deposit?: Json) => {
      const k = await s.post<{ id: string }>('/contracts', { startDate: start, ...body });
      if (deposit) await s.post(`/contracts/${k.id}/deposits`, deposit);
      await s.post(`/contracts/${k.id}/activate`, {});
      contracts.push({ id: k.id, customerId: body.customerId as string, companyId });
      return k.id;
    };

    // ---------- P Dahlqvist Förvaltning AB: bostäder och en blandfastighet ----------
    const eken = await property({
      name: 'Eken',
      designation: 'Höör Eken 3',
      category: 'residential',
      addressLine: 'Ekgatan 3',
      postalCode: '243 30',
      city: 'Höör',
      constructionYear: 1962,
      areaBoaM2: 620,
    });
    const apts: string[] = [];
    const aptData: [string, number, number, number][] = [
      ['1001', 42, 1, 6150],
      ['1002', 64, 2, 8200],
      ['1101', 78, 3, 9650],
      ['1102', 64, 2, 8250],
      ['1201', 78, 3, 9700],
      ['1202', 35, 1, 5400],
    ];
    for (const [nr, area, rooms, rent] of aptData)
      apts.push(await object(eken.id, { objectNr: nr, type: 'apartment', areaM2: area, rooms, monthlyRent: rent }));
    const p1 = await object(eken.id, { objectNr: 'P01', type: 'parking', monthlyRent: 450 });
    await object(eken.id, { objectNr: 'P02', type: 'parking', monthlyRent: 450 });
    await object(eken.id, { objectNr: 'F01', type: 'storage', areaM2: 6, monthlyRent: 250, vatLiable: true });

    const kvarnen = await property({
      name: 'Kvarnen',
      designation: 'Höör Kvarnen 12',
      category: 'mixed',
      addressLine: 'Storgatan 12',
      postalCode: '243 31',
      city: 'Höör',
      constructionYear: 1938,
      areaBoaM2: 210,
      areaLoaM2: 340,
    });
    const shop = await object(kvarnen.id, { objectNr: 'L01', type: 'commercial', areaM2: 160, monthlyRent: 18500, vatLiable: true });
    const cafe = await object(kvarnen.id, { objectNr: 'L02', type: 'restaurant', areaM2: 110, monthlyRent: 14200, vatLiable: true });
    await object(kvarnen.id, { objectNr: 'K01', type: 'office', areaM2: 70, monthlyRent: 7800, vatLiable: true });
    const kApt1 = await object(kvarnen.id, { objectNr: '2001', type: 'apartment', areaM2: 95, rooms: 4, monthlyRent: 11200 });
    const kApt2 = await object(kvarnen.id, { objectNr: '2002', type: 'apartment', areaM2: 115, rooms: 4, monthlyRent: 12900 });

    const people = [
      await person('Anna Lindqvist', '19850314', 'Ekgatan 3', '243 30', 'Höör'),
      await person('Erik Bergström', '19720921', 'Ekgatan 3', '243 30', 'Höör'),
      await person('Sara Nilsson', '19930602', 'Ekgatan 3', '243 30', 'Höör'),
      await person('Mohammed Karimi', '19880117', 'Ekgatan 3', '243 30', 'Höör'),
      await person('Lena Holm', '19590830', 'Ekgatan 3', '243 30', 'Höör'),
      await person('Johan Ek', '19810411', 'Storgatan 12', '243 31', 'Höör'),
      await person('Maria Persson', '19770225', 'Storgatan 12', '243 31', 'Höör'),
    ];
    for (let i = 0; i < 5; i++)
      await contract(pdf, { type: 'residential', customerId: people[i], objectIds: [apts[i]] });
    // Lägenhet 1202 är vakant. Erik har också en parkeringsplats.
    await contract(pdf, { type: 'parking', customerId: people[1], objectIds: [p1] });
    await contract(pdf, { type: 'residential', customerId: people[5], objectIds: [kApt1] });
    await contract(pdf, { type: 'residential', customerId: people[6], objectIds: [kApt2] });

    const blomman = await org('Blomsterhörnan i Höör AB', '559000101', 'Storgatan 12', '243 31', 'Höör');
    const kaffe = await org('Kaffekvarnen HB', '969000102', 'Storgatan 12', '243 31', 'Höör', 'post');
    await contract(
      pdf,
      { type: 'commercial', customerId: blomman, objectIds: [shop], endDate: `${Number(start.slice(0, 4)) + 3}-${start.slice(5, 7)}-01`, billingInterval: 'quarter' },
      { kind: 'deposit', amount: 55500, dueDate: start },
    );
    await contract(pdf, { type: 'commercial', customerId: kaffe, objectIds: [cafe], endDate: `${Number(start.slice(0, 4)) + 5}-${start.slice(5, 7)}-01` });
    // Kontoret K01 är vakant.

    // ---------- HPK AB: kontorsfastighet ----------
    await s.post('/auth/switch-company', { companyId: hpk });
    const verkstan = await property({
      name: 'Verkstan',
      designation: 'Hässleholm Verkstan 7',
      category: 'commercial',
      addressLine: 'Industrigatan 7',
      postalCode: '281 41',
      city: 'Hässleholm',
      constructionYear: 1989,
      areaLoaM2: 900,
    });
    const o1 = await object(verkstan.id, { objectNr: 'K101', type: 'office', areaM2: 240, monthlyRent: 26000, vatLiable: true });
    const o2 = await object(verkstan.id, { objectNr: 'K102', type: 'office', areaM2: 180, monthlyRent: 19500, vatLiable: true });
    await object(verkstan.id, { objectNr: 'L201', type: 'commercial', areaM2: 480, monthlyRent: 38000, vatLiable: true });
    const bygg = await org('Nordbygg Skåne AB', '559000201', 'Industrigatan 7', '281 41', 'Hässleholm');
    const redo = await org('Redovisningsbyrån Siffran AB', '559000202', 'Industrigatan 7', '281 41', 'Hässleholm');
    await contract(
      hpk,
      { type: 'commercial', customerId: bygg, objectIds: [o1], endDate: `${Number(start.slice(0, 4)) + 3}-${start.slice(5, 7)}-01`, billingInterval: 'quarter' },
      { kind: 'bank_guarantee', amount: 78000, dueDate: start },
    );
    await contract(hpk, { type: 'commercial', customerId: redo, objectIds: [o2], endDate: `${Number(start.slice(0, 4)) + 2}-${start.slice(5, 7)}-01` });

    // ---------- Hardebergabanan AB: hotell och stationshus ----------
    await s.post('/auth/switch-company', { companyId: hbb });
    const station = await property({
      name: 'Stationen',
      designation: 'Höör Stationen 1',
      category: 'hotel',
      addressLine: 'Banvägen 1',
      postalCode: '243 32',
      city: 'Höör',
      constructionYear: 1903,
    });
    for (let i = 1; i <= 4; i++) await object(station.id, { objectNr: `H0${i}`, type: 'hotel_room', areaM2: 22, monthlyRent: 0 });
    const vant = await object(station.id, { objectNr: 'V01', type: 'commercial', areaM2: 85, monthlyRent: 6500, vatLiable: true });
    const turist = await org('Ringsjöbygdens Turism ek. för.', '769000301', 'Banvägen 1', '243 32', 'Höör');
    await contract(hbb, { type: 'commercial', customerId: turist, objectIds: [vant], endDate: `${Number(start.slice(0, 4)) + 3}-${start.slice(5, 7)}-01` });

    // ---------- Avier för tre månader bakåt, denna och nästa månad ----------
    const months = [-2, -1, 0, 1].map(monthOffset);
    const invoicesByMonth: { id: string; totalOre: number; companyId: string; dueDate: string }[][] = [];
    for (const month of months) {
      const prev = monthOffset(months.indexOf(month) - 3);
      const all: { id: string; totalOre: number; companyId: string; dueDate: string }[] = [];
      for (const companyId of [pdf, hpk, hbb]) {
        await s.post('/auth/switch-company', { companyId });
        const run = await s.post<{ id: string }>('/billing-runs', { periodMonth: month, invoiceDate: `${prev}-20` });
        const detail = await s.get<{ fingerprint: string; invoices: { id: string; totalOre: number; dueDate: string }[] }>(
          `/billing-runs/${run.id}`,
        );
        await s.post(`/billing-runs/${run.id}/approve`, { fingerprint: detail.fingerprint, acknowledgeWarnings: true });
        const done = await s.get<{ invoices: { id: string; totalOre: number; dueDate: string }[] }>(`/billing-runs/${run.id}`);
        all.push(...done.invoices.map((i) => ({ ...i, companyId })));
      }
      invoicesByMonth.push(all);
    }

    // ---------- Betalningar: nästan alla har betalat, några ligger efter ----------
    const today = new Date().toISOString().slice(0, 10);
    const pay = async (inv: { id: string; totalOre: number; companyId: string; dueDate: string }, share = 1) => {
      if (inv.totalOre <= 0 || inv.dueDate > today) return;
      await s.post('/auth/switch-company', { companyId: inv.companyId });
      const amount = Math.round((inv.totalOre * share) / 100);
      await s.post(`/invoices/${inv.id}/payments`, { amount, paymentDate: inv.dueDate });
    };
    for (const [m, invs] of invoicesByMonth.entries()) {
      for (const [i, inv] of invs.entries()) {
        if (i === 2 && m >= 1) continue; // en hyresgäst har inte betalat de två senaste avierna
        if (i === 4 && m === 2) {
          await pay(inv, 0.5); // en delbetalning
          continue;
        }
        if (i === invs.length - 1 && m === 2) continue; // en företagskund har inte betalat denna månad
        await pay(inv);
      }
    }

    // ---------- Leverantörer och leverantörsfakturor ----------
    await s.post('/auth/switch-company', { companyId: pdf });
    const props = await s.get<{ id: string; name: string; category: string }[]>('/properties');
    const supplier = (body: Json) => s.post<{ id: string }>('/suppliers', { bankgiro: '5050-1055', paymentTermsDays: 30, ...body });
    const energy = await supplier({ name: 'Skånes Energi Exempel AB', defaultAccount: '5130' });
    const care = await supplier({ name: 'Fastighetsservice Demo AB', defaultAccount: '5193' });
    const builder = await supplier({ name: 'Byggfirman Påhittad AB', defaultAccount: '5170', paymentTermsDays: 20 });
    let invoiceSerial = 5000;
    const supplierInvoice = async (supplierId: string, date: string, lines: Json[], status: 'registered' | 'approved' | 'paid') => {
      const net = lines.reduce((t, l) => t + (l.net as number), 0);
      const vat = lines.reduce((t, l) => t + ((l.vat as number) ?? 0), 0);
      const r = await s.post<{ id: string }>('/supplier-invoices', { supplierId, invoiceNr: String(invoiceSerial++), invoiceDate: date, net, vat, lines });
      if (status !== 'registered') await s.post(`/supplier-invoices/${r.id}/approve`, {});
      if (status === 'paid') await s.post(`/supplier-invoices/${r.id}/payments`, { paidDate: date });
    };
    const coded = (account: string, net: number, description: string) =>
      props.slice(0, 2).map((p, i) => {
        const part = Math.round(net * (i === 0 ? 0.6 : 0.4));
        const residential = p.category === 'residential';
        return { accountNumber: account, propertyId: p.id, net: part, vat: part / 4, vatDeductible: !residential, description };
      });
    for (const [i, month] of months.slice(0, 3).entries()) {
      const status = i < 2 ? 'paid' : 'registered';
      await supplierInvoice(energy.id, `${month}-05`, coded('5130', 18000 - i * 2000, 'Fjärrvärme'), status);
      await supplierInvoice(care.id, `${month}-01`, coded('5193', 9000, 'Fastighetsskötsel'), i < 2 ? 'paid' : 'approved');
    }
    await supplierInvoice(builder.id, `${months[1]}-14`, coded('5170', 24000, 'Byte av ytterdörrar'), 'approved');

    log(
      `Demodata upplagd: 4 fastigheter, ${contracts.length} avtal och avier för ${months[0]} till ${months[months.length - 1]}.`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.se';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('SEED_ADMIN_PASSWORD saknas');
  seedDemo(email, password)
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
