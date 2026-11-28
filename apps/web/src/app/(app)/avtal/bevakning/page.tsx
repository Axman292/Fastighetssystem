'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertList, ContractAlert, KIND_DOT, alertTone } from '@/components/contract-alerts';
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Select, Stat, Tabs, cx } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { MONTH_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'todo' | 'calendar' | 'handled' | 'settings';

const KIND_FILTER: Record<string, string> = {
  notice: 'Uppsägning och förlängning',
  ending: 'Avtal som upphör',
  renegotiate: 'Omförhandling',
  index: 'KPI-uppräkning',
  rent: 'Hyresändringar',
  security: 'Säkerheter',
  other: 'Utkast och avtal utan hyra',
};
const FILTER_KINDS: Record<string, string[]> = {
  notice: ['notice_deadline', 'auto_extended'],
  ending: ['ending'],
  renegotiate: ['renegotiate'],
  index: ['index'],
  rent: ['rent_change', 'line_ends'],
  security: ['security_expiry', 'deposit_due'],
  other: ['draft', 'no_lines'],
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function ContractAlertsPage() {
  const { active, version } = useSession();
  const [tab, setTab] = useState<Tab>('todo');
  const [items, setItems] = useState<ContractAlert[] | null>(null);
  const [handled, setHandled] = useState<ContractAlert[] | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api<ContractAlert[]>('/contract-alerts').then(setItems);
    api<ContractAlert[]>('/contract-alerts?handled=1').then((all) => setHandled(all.filter((a) => a.ack)));
  }, []);
  useEffect(load, [load, version]);

  const shown = (items ?? []).filter((a) => !filter || FILTER_KINDS[filter].includes(a.kind));
  const today = todayIso();
  const in30 = addDaysIso(today, 30);
  const groups: [string, ContractAlert[]][] = [
    ['Försenat', shown.filter((a) => a.date < today)],
    ['Närmaste 30 dagarna', shown.filter((a) => a.date >= today && a.date <= in30)],
    ['Längre fram', shown.filter((a) => a.date > in30)],
  ];
  const count = (k: string[]) => (items ?? []).filter((a) => k.includes(a.kind)).length;

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        / Bevakning
      </div>
      <PageHeader
        title="Avtalsbevakning"
        description={`Påminnelser om uppsägning, avtalsslut, omförhandling, KPI-uppräkning, hyresändringar och säkerheter${active ? ` i ${active.companyName}` : ' i hela koncernen'}.`}
        actions={
          <a href="/api/contract-alerts/calendar.ics">
            <Button variant="secondary">Ladda ner till kalendern</Button>
          </a>
        }
      />
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Att hantera" value={items ? items.length : '–'} sub={items ? `${items.filter((i) => i.overdue).length} försenade` : undefined} />
        <Stat label="Uppsägning och förlängning" value={items ? count(FILTER_KINDS.notice) : '–'} sub="sista dag att säga upp eller omförhandla" />
        <Stat label="KPI-uppräkningar" value={items ? count(FILTER_KINDS.index) : '–'} sub="som ska göras" />
        <Stat label="Säkerheter" value={items ? count(FILTER_KINDS.security) : '–'} sub="saknas eller löper ut" />
      </div>

      <Tabs
        tabs={[
          { key: 'todo', label: 'Att göra', count: items?.length },
          { key: 'calendar', label: 'Kalender' },
          { key: 'handled', label: 'Hanterade', count: handled?.length },
          { key: 'settings', label: 'Inställningar' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'todo' && (
        <>
          <div className="mb-3 flex gap-2">
            <Select className="max-w-64" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Alla typer</option>
              {Object.entries(KIND_FILTER).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          {items && shown.length === 0 ? (
            <Card className="px-6 py-12 text-center">
              <div className="text-[14px] font-medium">Inget att hantera just nu</div>
              <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
                Påminnelserna dyker upp här i god tid enligt framförhållningen under Inställningar.
              </p>
            </Card>
          ) : (
            groups
              .filter(([, list]) => list.length)
              .map(([title, list]) => (
                <section key={title} className="mb-6">
                  <h2 className="mb-2 text-[13px] font-semibold">
                    {title} <span className="font-normal text-ink-3">{list.length}</span>
                  </h2>
                  <Card>
                    <AlertList items={list} onChanged={load} />
                  </Card>
                </section>
              ))
          )}
        </>
      )}

      {tab === 'calendar' && <CalendarView />}

      {tab === 'handled' && (
        <Card>
          <AlertList
            items={(handled ?? []).sort((a, b) => b.date.localeCompare(a.date))}
            onChanged={load}
            empty="Inga påminnelser har markerats som klara eller skjutits upp."
          />
        </Card>
      )}

      {tab === 'settings' && <SettingsView />}
    </>
  );
}

function CalendarView() {
  const { version } = useSession();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [events, setEvents] = useState<ContractAlert[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;

  const load = useCallback(() => {
    api<ContractAlert[]>(`/contract-alerts/calendar?from=${first}&to=${last}`).then(setEvents);
  }, [first, last]);
  useEffect(load, [load, version]);

  const byDay = useMemo(() => {
    const map = new Map<string, ContractAlert[]>();
    for (const e of events ?? []) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [events]);

  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
    setSelected(null);
  };
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // måndag först
  const cells: (string | null)[] = [
    ...Array(offset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
  while (cells.length % 7) cells.push(null);
  const today = todayIso();
  const list = selected ? (byDay.get(selected) ?? []) : (events ?? []);

  return (
    <div className="grid grid-cols-[3fr_2fr] gap-6">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => shift(-1)} aria-label="Föregående månad">
            ‹
          </Button>
          <Button size="sm" variant="secondary" onClick={() => shift(1)} aria-label="Nästa månad">
            ›
          </Button>
          <div className="ml-1 text-[14px] font-semibold capitalize">
            {MONTH_LABEL[m - 1]} {y}
          </div>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (setMonth(today.slice(0, 7)), setSelected(null))}>
            I dag
          </Button>
        </div>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line text-center text-[11.5px] font-medium text-ink-3">
            {['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'].map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d, i) => {
              const ev = d ? (byDay.get(d) ?? []) : [];
              return (
                <button
                  key={i}
                  disabled={!d}
                  onClick={() => d && setSelected(selected === d ? null : d)}
                  className={cx(
                    'h-20 border-b border-r border-line p-1.5 text-left align-top',
                    !d && 'bg-subtle/40',
                    d && 'hover:bg-subtle/60',
                    selected === d && 'bg-accent-soft',
                  )}
                >
                  {d && (
                    <>
                      <div className={cx('text-[12px] tabular', d === today ? 'font-semibold text-accent' : 'text-ink-2')}>{Number(d.slice(8))}</div>
                      <div className="mt-1 space-y-0.5">
                        {ev.slice(0, 3).map((e) => (
                          <div key={e.key} className="flex items-center gap-1 truncate text-[11px] text-ink-2">
                            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', KIND_DOT[e.kind] ?? 'bg-ink-3', e.ack?.action === 'done' && 'opacity-40')} />
                            <span className="truncate">{e.customerName}</span>
                          </div>
                        ))}
                        {ev.length > 3 && <div className="text-[11px] text-ink-3">+{ev.length - 3} till</div>}
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </Card>
      </div>
      <div>
        <h2 className="mb-2 text-[13px] font-semibold">
          {selected ? selected : `Hela ${MONTH_LABEL[m - 1]}`} <span className="font-normal text-ink-3">{list.length}</span>
        </h2>
        <Card className="divide-y divide-line">
          {list.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-ink-3">Inga avtalsdatum.</div>}
          {list.map((e) => (
            <Link key={e.key} href={`/avtal/${e.contractId}`} className="block px-4 py-2.5 hover:bg-subtle/60">
              <div className="flex items-center gap-2">
                <span className="text-[12px] tabular text-ink-3">{e.date}</span>
                <Badge tone={alertTone(e)}>{e.label}</Badge>
                {e.ack && <span className="text-[11.5px] text-ink-3">{e.ack.action === 'done' ? 'Klar' : `Uppskjuten till ${e.ack.snoozeUntil}`}</span>}
              </div>
              <div className="mt-0.5 text-[13px] font-medium">
                {e.customerName} <span className="font-normal text-ink-3">· avtal {e.contractNr}</span>
              </div>
              <div className="text-[12px] text-ink-2">{e.message}</div>
            </Link>
          ))}
        </Card>
        <p className="mt-2 text-[12px] text-ink-3">Kalendern visar alla datum, även de som ligger utanför framförhållningen.</p>
      </div>
    </div>
  );
}

interface Settings {
  noticeDays: number;
  endingDays: number;
  renegotiateDays: number;
  indexDays: number;
  rentChangeDays: number;
  securityDays: number;
  digestEnabled: boolean;
  digestFrequency: 'daily' | 'weekly';
  digestWeekday: number;
  lastDigestAt: string | null;
  lastDigestNote: string | null;
  users: { id: string; name: string; email: string; selected: boolean }[];
}

const LEAD_FIELDS: [keyof Settings, string, string][] = [
  ['noticeDays', 'Sista dag för uppsägning', 'Tidsbestämda avtal som annars förlängs, och lokalavtal som ska omförhandlas'],
  ['endingDays', 'Avtal som upphör', 'Uppsagda avtal och avtal utan förlängning'],
  ['renegotiateDays', 'Omförhandling', 'Datum för omförhandling som angetts på avtalet'],
  ['indexDays', 'KPI-uppräkning', 'Före den dag hyran räknas upp enligt indexklausulen'],
  ['rentChangeDays', 'Hyresändringar', 'Nya hyresrader, trappor och rader som upphör'],
  ['securityDays', 'Säkerheter', 'Deposition som ska lämnas, bankgaranti och borgen som löper ut'],
];
const WEEKDAYS = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];

function SettingsView() {
  const { active, can, version } = useSession();
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active) return;
    setError(null);
    api<Settings>('/contract-alerts/settings').then(setS).catch((e: ApiError) => setError(e.message));
  }, [active, version]);

  if (!active) {
    return (
      <Card className="px-6 py-12 text-center text-[13px] text-ink-2">Välj ett bolag i bolagsväljaren för att ändra inställningarna. De gäller per bolag.</Card>
    );
  }
  if (error && !s) return <ErrorNote message={error} />;
  if (!s) return null;
  const write = can('contract.write');
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const saved = await api<Settings>('/contract-alerts/settings', {
        method: 'PUT',
        body: {
          noticeDays: s.noticeDays,
          endingDays: s.endingDays,
          renegotiateDays: s.renegotiateDays,
          indexDays: s.indexDays,
          rentChangeDays: s.rentChangeDays,
          securityDays: s.securityDays,
          digestEnabled: s.digestEnabled,
          digestFrequency: s.digestFrequency,
          digestWeekday: s.digestWeekday,
          recipientIds: s.users.filter((u) => u.selected).map((u) => u.id),
        },
      });
      setS(saved);
      setNote('Sparat.');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async (toMe: boolean) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api<{ note: string; items: number }>('/contract-alerts/digest/send', { method: 'POST', body: { toMe } });
      setNote(toMe ? (r.items ? 'Sammanfattningen är skickad till dig.' : 'Inga påminnelser att skicka.') : r.note);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-6">
      <section>
        <h2 className="mb-1 text-[13px] font-semibold">Framförhållning</h2>
        <p className="mb-3 text-[12.5px] text-ink-2">Hur många dagar innan datumet påminnelsen ska dyka upp under Att göra och i sammanfattningen.</p>
        <Card className="divide-y divide-line">
          {LEAD_FIELDS.map(([key, label, hint]) => (
            <div key={key} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{label}</div>
                <div className="text-[12px] text-ink-3">{hint}</div>
              </div>
              <div className="flex items-center gap-2 text-[13px] text-ink-2">
                <Input
                  type="number"
                  min={1}
                  max={730}
                  className="w-20 text-right"
                  disabled={!write}
                  value={String(s[key])}
                  onChange={(e) => set({ [key]: Math.max(1, Math.min(730, Number(e.target.value) || 1)) } as Partial<Settings>)}
                />
                dagar
              </div>
            </div>
          ))}
        </Card>
      </section>
      <section>
        <h2 className="mb-1 text-[13px] font-semibold">Sammanfattning per e-post</h2>
        <p className="mb-3 text-[12.5px] text-ink-2">
          Valda användare får ett mejl med allt som ska hanteras. Den som får mejlet för flera bolag får ett samlat mejl. Inget skickas när det inte finns något att
          hantera.
        </p>
        <Card className="space-y-4 px-4 py-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!write} checked={s.digestEnabled} onChange={(e) => set({ digestEnabled: e.target.checked })} />
            Skicka sammanfattning automatiskt
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hur ofta">
              <Select disabled={!write} value={s.digestFrequency} onChange={(e) => set({ digestFrequency: e.target.value as Settings['digestFrequency'] })}>
                <option value="weekly">En gång i veckan</option>
                <option value="daily">Varje dag</option>
              </Select>
            </Field>
            {s.digestFrequency === 'weekly' && (
              <Field label="Veckodag">
                <Select disabled={!write} value={String(s.digestWeekday)} onChange={(e) => set({ digestWeekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={String(i + 1)}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium">Mottagare</div>
            <div className="space-y-1.5">
              {s.users.map((u) => (
                <label key={u.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!write}
                    checked={u.selected}
                    onChange={(e) => set({ users: s.users.map((x) => (x.id === u.id ? { ...x, selected: e.target.checked } : x)) })}
                  />
                  {u.name} <span className="text-ink-3">{u.email}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="text-[12px] text-ink-3">
            Skickas efter kl. 07.{' '}
            {s.lastDigestAt ? `Senast ${new Date(s.lastDigestAt).toLocaleString('sv-SE')}: ${s.lastDigestNote ?? ''}` : 'Har inte skickats än.'}
          </div>
        </Card>
        {write && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={save}>
              Spara
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => sendNow(true)}>
              Skicka till mig nu
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => sendNow(false)}>
              Skicka till mottagarna nu
            </Button>
            {note && <span className="text-[13px] text-good">{note}</span>}
          </div>
        )}
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      </section>
    </div>
  );
}
