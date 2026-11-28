'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Td, cx, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre, MONTH_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Settings {
  series: string;
  startDate: string | null;
  bankAccount: string;
  receivableAccount: string;
  prepaymentAccount: string;
  payableAccount: string;
  inputVatAccount: string;
  outputVat25Account: string;
  outputVat12Account: string;
  outputVat6Account: string;
  roundingAccount: string;
  includeDimensions: boolean;
}

interface PreviewRow {
  account: string;
  accountName: string | null;
  debitOre: number;
  creditOre: number;
  costCenter: string | null;
  project: string | null;
}

interface Preview {
  from: string;
  to: string;
  blocked: boolean;
  issues: { severity: 'blocking' | 'warning' | 'info'; message: string; href?: string }[];
  summary: {
    byKind: { kind: string; label: string; count: number; debitOre: number }[];
    accounts: { account: string; name: string; debitOre: number; creditOre: number; netOre: number }[];
    debitOre: number;
  };
  vouchers: { key: string; kindLabel: string; date: string; text: string; correction: boolean; late: boolean; href: string | null; rows: PreviewRow[] }[];
}

interface ExportRow {
  id: string;
  exportNr: number;
  from: string;
  to: string;
  series: string;
  voucherCount: number;
  correctionCount: number;
  debitOre: number;
  filename: string;
  createdAt: string;
  createdBy: string | null;
  latest: boolean;
}

type Mode = 'month' | 'week' | 'day' | 'custom';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string) => new Date(`${s}T12:00:00`);
const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: iso(new Date(y, m, 0, 12)) };
}

/** Måndag till söndag för veckan som innehåller dagen. */
function weekRange(day: string) {
  const d = parse(day);
  const monday = addDays(day, -((d.getDay() + 6) % 7));
  return { from: monday, to: addDays(monday, 6) };
}

function weekNr(day: string) {
  const d = parse(day);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function previousMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return iso(d).slice(0, 7);
}

function rangeLabel(from: string, to: string) {
  if (from === to) return from;
  if (from.endsWith('-01') && monthRange(from.slice(0, 7)).to === to) return `${MONTH_LABEL[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  return `${from} – ${to}`;
}

const SEVERITY_TONE = { blocking: 'bad', warning: 'warn', info: 'neutral' } as const;
const SEVERITY_LABEL = { blocking: 'Stoppar', warning: 'Varning', info: 'Info' } as const;

export default function AccountingExportPage() {
  const { active, can, version } = useSession();
  const allowed = !!active && can('accounting.export');

  const [mode, setMode] = useState<Mode>('month');
  const [month, setMonth] = useState(previousMonth());
  const [day, setDay] = useState(todayIso());
  const [custom, setCustom] = useState({ from: `${previousMonth()}-01`, to: todayIso() });
  const range = useMemo(() => {
    if (mode === 'month') return monthRange(month);
    if (mode === 'week') return weekRange(day);
    if (mode === 'day') return { from: day, to: day };
    return custom;
  }, [mode, month, day, custom]);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ExportRow | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [undo, setUndo] = useState<ExportRow | null>(null);

  const loadExports = useCallback(() => {
    if (!allowed) return;
    api<ExportRow[]>('/accounting/sie/exports').then(setExports).catch((e: ApiError) => setError(e.message));
    api<Settings>('/accounting/settings').then(setSettings).catch(() => undefined);
  }, [allowed]);

  const loadPreview = useCallback(() => {
    if (!allowed || range.to < range.from) return;
    setLoading(true);
    setError(null);
    api<Preview>(`/accounting/sie/preview?from=${range.from}&to=${range.to}`)
      .then(setPreview)
      .catch((e: ApiError) => {
        setPreview(null);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [allowed, range.from, range.to]);

  useEffect(loadExports, [loadExports, version]);
  useEffect(loadPreview, [loadPreview, version]);

  const latest = exports[0];
  const sinceLast = () => {
    if (!latest) return;
    setMode('custom');
    setCustom({ from: addDays(latest.to, 1), to: todayIso() });
  };

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ExportRow>('/accounting/sie/exports', { method: 'POST', body: range });
      setDone(r);
      window.location.href = `/api/accounting/sie/exports/${r.id}/file`;
      loadExports();
      loadPreview();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const doUndo = async (e: ExportRow) => {
    try {
      await api(`/accounting/sie/exports/${e.id}`, { method: 'DELETE' });
      setUndo(null);
      setDone(null);
      loadExports();
      loadPreview();
    } catch (err) {
      setError((err as ApiError).message);
    }
  };

  if (!active) {
    return (
      <>
        <PageHeader title="Bokföring" description="Export av verifikationer till Hogia eller annat ekonomiprogram med SIE-fil." />
        <Card className="px-5 py-6 text-[13px] text-ink-2">Välj ett bolag i menyn till vänster. Exporten görs alltid för ett bolag i taget.</Card>
      </>
    );
  }
  if (!allowed) {
    return (
      <>
        <PageHeader title="Bokföring" />
        <Card className="px-5 py-6 text-[13px] text-ink-2">Du saknar behörighet att exportera bokföringen för {active.companyName}. Det kräver rollen ekonomiansvarig eller koncernadministratör.</Card>
      </>
    );
  }

  const count = preview?.vouchers.length ?? 0;

  return (
    <>
      <PageHeader
        title="Bokföring"
        description={`Verifikationer för ${active.companyName} som SIE-fil (SIE 4) för inläsning i Hogia.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowHelp(true)}>
              Så läser du in filen
            </Button>
            <Button variant="secondary" onClick={() => setShowSettings(true)}>
              Inställningar
            </Button>
            <Button onClick={doExport} disabled={busy || loading || !preview || preview.blocked || count === 0}>
              {busy ? 'Exporterar…' : 'Exportera SIE'}
            </Button>
          </>
        }
      />

      <Card className="mb-6 flex flex-wrap items-end gap-4 px-4 py-3">
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-ink-2">Period</span>
          <Select className="w-36" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="month">Månad</option>
            <option value="week">Vecka</option>
            <option value="day">Dag</option>
            <option value="custom">Valfri period</option>
          </Select>
        </label>
        {mode === 'month' && (
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-ink-2">Månad</span>
            <Input type="month" className="w-44" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </label>
        )}
        {(mode === 'week' || mode === 'day') && (
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-ink-2">{mode === 'week' ? 'En dag i veckan' : 'Dag'}</span>
            <Input type="date" className="w-40" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        )}
        {mode === 'custom' && (
          <>
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-ink-2">Från</span>
              <Input type="date" className="w-40" value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label className="block space-y-1">
              <span className="text-[12px] font-medium text-ink-2">Till</span>
              <Input type="date" className="w-40" value={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
            </label>
          </>
        )}
        <div className="pb-1.5 text-[13px] text-ink-2">
          {mode === 'week' ? `Vecka ${weekNr(range.from)}: ` : ''}
          {range.from === range.to ? range.from : `${range.from} – ${range.to}`}
        </div>
        {latest && (
          <Button variant="ghost" size="sm" className="mb-0.5" onClick={sinceLast}>
            Allt sedan förra exporten
          </Button>
        )}
        <div className="ml-auto pb-1.5 text-[12px] text-ink-3">
          {loading ? 'Hämtar…' : latest ? `Senast exporterat: ${rangeLabel(latest.from, latest.to)}` : 'Ingen export gjord ännu'}
        </div>
      </Card>

      <div className="space-y-6">
        <ErrorNote message={error} />

        {done && (
          <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
            <Badge tone="good">Klar</Badge>
            <span>
              Export {done.exportNr} med {done.voucherCount} verifikationer är sparad och filen <strong>{done.filename}</strong> laddas ned. Läs in den i Hogia.
            </span>
            <a className="ml-auto text-accent hover:underline" href={`/api/accounting/sie/exports/${done.id}/file`}>
              Hämta filen igen
            </a>
          </Card>
        )}

        {preview && preview.issues.length > 0 && (
          <Card className="divide-y divide-line">
            {preview.issues.map((i, n) => (
              <div key={n} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                <Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge>
                <span className="text-ink-2">{i.message}</span>
                {i.href && (
                  <Link href={i.href} className="ml-auto shrink-0 text-accent hover:underline">
                    Visa
                  </Link>
                )}
              </div>
            ))}
          </Card>
        )}

        {preview && (
          <div className={cx('space-y-6 transition-opacity', loading && 'opacity-60')}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Verifikationer att exportera" value={count} sub={rangeLabel(preview.from, preview.to)} />
              {preview.summary.byKind.slice(0, 3).map((k) => (
                <Stat key={k.kind} label={k.label} value={k.count} sub={fmtOre(k.debitOre)} />
              ))}
            </div>

            {count === 0 ? (
              <Card className="px-5 py-8 text-center text-[13px] text-ink-3">
                Det finns inget nytt att exportera för perioden. Allt som hör till den är redan exporterat, eller så har inget hänt.
              </Card>
            ) : (
              <>
                <section>
                  <h2 className="mb-2 text-[14px] font-semibold">Summa per konto</h2>
                  <Table head={['Konto', 'Namn', <span key="d" className="block text-right">Debet</span>, <span key="k" className="block text-right">Kredit</span>]}>
                    {preview.summary.accounts.map((a) => (
                      <tr key={a.account}>
                        <Td className="tabular">{a.account}</Td>
                        <Td>{a.name || <span className="text-warn">Saknas i kontoplanen</span>}</Td>
                        <Td className="text-right tabular">{a.debitOre ? fmtOre(a.debitOre, true) : ''}</Td>
                        <Td className="text-right tabular">{a.creditOre ? fmtOre(a.creditOre, true) : ''}</Td>
                      </tr>
                    ))}
                    <tr className="font-medium">
                      <Td />
                      <Td>Summa</Td>
                      <Td className="text-right tabular">{fmtOre(preview.summary.debitOre, true)}</Td>
                      <Td className="text-right tabular">{fmtOre(preview.summary.accounts.reduce((s, a) => s + a.creditOre, 0), true)}</Td>
                    </tr>
                  </Table>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-[14px] font-semibold">Verifikationer</h2>
                    <Button variant="ghost" size="sm" onClick={() => setOpen(open.size ? new Set() : new Set(preview.vouchers.map((v) => v.key)))}>
                      {open.size ? 'Dölj kontering' : 'Visa all kontering'}
                    </Button>
                  </div>
                  <Table head={['Datum', 'Slag', 'Text', <span key="b" className="block text-right">Belopp</span>]}>
                    {preview.vouchers.map((v) => {
                      const isOpen = open.has(v.key);
                      const amount = v.rows.reduce((s, r) => s + r.debitOre, 0);
                      return (
                        <Fragment key={v.key}>
                          <tr
                            className="cursor-pointer hover:bg-subtle/60"
                            onClick={() => {
                              const n = new Set(open);
                              if (isOpen) n.delete(v.key);
                              else n.add(v.key);
                              setOpen(n);
                            }}
                          >
                            <Td className="tabular whitespace-nowrap">{v.date}</Td>
                            <Td className="whitespace-nowrap text-ink-2">{v.kindLabel}</Td>
                            <Td>
                              <span className="mr-2">{v.text}</span>
                              {v.correction && <Badge tone="warn">Rättelse</Badge>}
                              {v.late && <Badge tone="accent">Efterregistrerad</Badge>}
                            </Td>
                            <Td className="text-right tabular">{fmtOre(amount, true)}</Td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={4} className="bg-subtle/40 px-4 py-2">
                                <table className="w-full text-[12.5px]">
                                  <tbody>
                                    {v.rows.map((r, i) => (
                                      <tr key={i} className="text-ink-2">
                                        <td className="w-16 py-0.5 tabular">{r.account}</td>
                                        <td className="py-0.5">
                                          {r.accountName ?? ''}
                                          {r.costCenter && <span className="ml-2 text-ink-3">KS {r.costCenter}</span>}
                                          {r.project && <span className="ml-2 text-ink-3">Projekt {r.project}</span>}
                                        </td>
                                        <td className="w-32 py-0.5 text-right tabular">{r.debitOre ? fmtOre(r.debitOre, true) : ''}</td>
                                        <td className="w-32 py-0.5 text-right tabular">{r.creditOre ? fmtOre(r.creditOre, true) : ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                                {v.href && (
                                  <Link href={v.href} className="mt-1 inline-block text-[12px] text-accent hover:underline">
                                    Öppna underlaget
                                  </Link>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Table>
                </section>
              </>
            )}
          </div>
        )}

        <section>
          <h2 className="mb-2 text-[14px] font-semibold">Gjorda exporter</h2>
          <Table head={['Nr', 'Period', 'Verifikationer', <span key="b" className="block text-right">Omslutning</span>, 'Gjord', '']} empty="Ingen export är gjord ännu">
            {exports.map((e) => (
              <tr key={e.id}>
                <Td className="tabular">{e.exportNr}</Td>
                <Td>{rangeLabel(e.from, e.to)}</Td>
                <Td>
                  {e.voucherCount}
                  {e.correctionCount > 0 && <span className="ml-1 text-ink-3">(varav {e.correctionCount} rättelser)</span>}
                  <span className="ml-1 text-ink-3">serie {e.series}</span>
                </Td>
                <Td className="text-right tabular">{fmtOre(e.debitOre, true)}</Td>
                <Td className="text-ink-2">
                  {formatDateTime(e.createdAt)}
                  {e.createdBy ? `, ${e.createdBy}` : ''}
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <a className="text-accent hover:underline" href={`/api/accounting/sie/exports/${e.id}/file`}>
                    Hämta fil
                  </a>
                  {e.latest && (
                    <button className="ml-3 text-ink-3 hover:text-bad" onClick={() => setUndo(e)}>
                      Ångra
                    </button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      </div>

      <Dialog open={!!undo} onClose={() => setUndo(null)} title={`Ångra export ${undo?.exportNr ?? ''}`}>
        <p className="text-[13px] text-ink-2">
          Händelserna i exporten räknas som ej exporterade och kommer med i nästa export igen. Gör det bara om filen inte lästes in i Hogia, eller om du har tagit bort verifikationerna där. Annars blir de bokförda två gånger.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setUndo(null)}>
            Avbryt
          </Button>
          <Button variant="danger" onClick={() => undo && doUndo(undo)}>
            Ångra exporten
          </Button>
        </div>
      </Dialog>

      <SettingsDialog
        open={showSettings}
        settings={settings}
        onClose={() => setShowSettings(false)}
        onSaved={(s) => {
          setSettings(s);
          setShowSettings(false);
          loadPreview();
        }}
      />

      <Dialog open={showHelp} onClose={() => setShowHelp(false)} title="Så läser du in filen i Hogia" wide>
        <ol className="list-decimal space-y-2 pl-5 text-[13px] text-ink-2">
          <li>Välj period ovan (normalt förra månaden) och kontrollera verifikationerna och varningarna.</li>
          <li>Tryck på <strong>Exportera SIE</strong>. Filen (slutar på .se) sparas i Hämtade filer på datorn.</li>
          <li>Logga in i Hogia och välj rätt bolag.</li>
          <li>Gå till importen av SIE-fil (oftast under Arkiv, Verktyg eller Import, med ett val i stil med <em>Importera SIE</em> eller <em>Läs in verifikationer</em>).</li>
          <li>Välj filen. Hogia visar verifikationerna innan de bokförs. Kontrollera att serien är {settings?.series ?? 'A'} och att perioden är öppen.</li>
          <li>Bekräfta. Hogia ger verifikationerna nästa lediga nummer i serien.</li>
        </ol>
        <p className="mt-4 text-[13px] text-ink-2">
          Varje händelse exporteras bara en gång. Ändras något efteråt, till exempel en betalning som tas bort, kommer en rättelse med nästa export. Om inläsningen misslyckas kan du ångra den senaste exporten och göra om den.
        </p>
      </Dialog>
    </>
  );
}

const ACCOUNT_FIELDS: { key: keyof Settings; label: string }[] = [
  { key: 'bankAccount', label: 'Bank (in- och utbetalningar)' },
  { key: 'receivableAccount', label: 'Kundfordringar' },
  { key: 'prepaymentAccount', label: 'Förskott från kunder (ej fördelat)' },
  { key: 'payableAccount', label: 'Leverantörsskulder' },
  { key: 'inputVatAccount', label: 'Ingående moms' },
  { key: 'outputVat25Account', label: 'Utgående moms 25 %' },
  { key: 'outputVat12Account', label: 'Utgående moms 12 %' },
  { key: 'outputVat6Account', label: 'Utgående moms 6 %' },
  { key: 'roundingAccount', label: 'Öresavrundning' },
];

function SettingsDialog({ open, settings, onClose, onSaved }: { open: boolean; settings: Settings | null; onClose: () => void; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(settings);
      setErrors({});
      setError(null);
    }
  }, [open, settings]);
  if (!form) return null;
  const save = async () => {
    try {
      onSaved(await api<Settings>('/accounting/settings', { method: 'PUT', body: { ...form, startDate: form.startDate || null } }));
    } catch (e) {
      const err = e as ApiError;
      setErrors(Object.fromEntries(err.fields.map((f) => [f.path, f.message])));
      setError(err.fields.length ? null : err.message);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Inställningar för bokföringen" wide>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Verifikationsserie i Hogia" error={errors.series} hint="Serien som verifikationerna läses in i">
          <Input value={form.series} onChange={(e) => setForm({ ...form, series: e.target.value })} />
        </Field>
        <Field label="Exportera från och med" error={errors.startDate} hint="Det som hänt före datumet finns redan i bokföringen">
          <Input type="date" value={form.startDate ?? ''} onChange={(e) => setForm({ ...form, startDate: e.target.value || null })} />
        </Field>
        {ACCOUNT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} error={errors[f.key]}>
            <Input inputMode="numeric" maxLength={4} value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value.trim() })} />
          </Field>
        ))}
      </div>
      <label className="mt-4 flex items-start gap-2 text-[13px] text-ink-2">
        <input type="checkbox" className="mt-0.5" checked={form.includeDimensions} onChange={(e) => setForm({ ...form, includeDimensions: e.target.checked })} />
        <span>
          Ta med kostnadsställe och fastighet (som projekt) på raderna. Använd bara om samma kostnadsställen och projekt finns upplagda i Hogia.
        </span>
      </label>
      <p className="mt-3 text-[12px] text-ink-3">Intäktskontona kommer från artiklarna och kostnadskontona från konteringen på leverantörsfakturorna.</p>
      {error && <div className="mt-3"><ErrorNote message={error} /></div>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button onClick={save}>Spara</Button>
      </div>
    </Dialog>
  );
}
