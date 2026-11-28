'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, PageHeader, Select, Stat, Table, Tabs, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtOre, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

interface InterestCandidate {
  invoiceId: string;
  invoiceNr: number;
  dueDate: string;
  totalOre: number;
  balanceOre: number;
  customerId: string;
  customerName: string;
  contractNr: number | null;
  fromDate: string;
  toDate: string;
  days: number;
  amountOre: number;
  rateText: string;
  belowMinimum: boolean;
  canUseNotice: boolean;
  paidInFull: boolean;
  inPlan: boolean;
}
interface InterestSuggestion {
  date: string;
  settings: { useReference: boolean; marginBp: number; fixedBp: number; minOre: number; method: 'next_notice' | 'invoice'; fromDate: string } | null;
  currentRate: string | null;
  referenceRate: { validFrom: string; rateBp: number } | null;
  candidates: InterestCandidate[];
}
interface InterestCharge {
  id: string;
  invoiceId: string;
  invoiceNr: number;
  customerId: string;
  customerName: string;
  fromDate: string;
  toDate: string;
  amountOre: number;
  rateText: string;
  method: string;
  interestInvoiceId: string | null;
  interestInvoiceNr: number | null;
  contractId: string | null;
  contractNr: number | null;
  noticeNr: number | null;
  runDate: string;
}
interface Installment { nr: number; dueDate: string; amountOre: number; coveredOre: number; state: 'paid' | 'partial' | 'due' | 'overdue' }
interface Plan {
  id: string;
  planNr: number;
  customerId: string;
  customerName: string;
  state: string;
  agreedDate: string;
  totalOre: number;
  paidOre: number;
  remainingOre: number;
  chargeInterest: boolean;
  note: string | null;
  closedDate: string | null;
  closedReason: string | null;
  ocr: string | null;
  invoices: { invoiceId: string; invoiceNr: number; dueDate: string; startBalanceOre: number; balanceOre: number }[];
  installments: Installment[];
  nextDue: Installment | null;
  overdueOre: number;
}
interface ReadyRow {
  invoiceId: string;
  invoiceNr: number;
  dueDate: string;
  balanceOre: number;
  customerId: string;
  customerName: string;
  daysOverdue: number;
  interestOre: number;
  lastReminderDate: string | null;
}
interface CaseRow {
  id: string;
  caseNr: number;
  customerId: string;
  customerName: string;
  status: string;
  agency: string | null;
  agencyReference: string | null;
  capitalOre: number;
  interestOre: number;
  remainingOre: number;
  sentDate: string | null;
  closedDate: string | null;
}
interface CaseDetail extends CaseRow {
  nationalId: string | null;
  rateText: string;
  note: string | null;
  claims: { invoiceId: string; invoiceNr: number; kind: string; dueDate: string; capitalOre: number; balanceOre: number; interestOre: number; isFee: boolean; isInterest: boolean; active: boolean }[];
  events: { eventDate: string; description: string }[];
}

const PLAN_STATE: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Följs', tone: 'good' },
  behind: { label: 'Försenad', tone: 'bad' },
  completed: { label: 'Klar', tone: 'neutral' },
  broken: { label: 'Bruten', tone: 'bad' },
  cancelled: { label: 'Makulerad', tone: 'neutral' },
};
const INSTALLMENT_STATE: Record<string, { label: string; tone: Tone }> = {
  paid: { label: 'Betald', tone: 'good' },
  partial: { label: 'Delvis betald', tone: 'warn' },
  due: { label: 'Kommande', tone: 'neutral' },
  overdue: { label: 'Försenad', tone: 'bad' },
};
const CASE_STATUS: Record<string, { label: string; tone: Tone }> = {
  prepared: { label: 'Förberett', tone: 'warn' },
  sent: { label: 'Hos inkassobolaget', tone: 'accent' },
  enforcement: { label: 'Betalningsföreläggande', tone: 'bad' },
  paid: { label: 'Betalt', tone: 'good' },
  withdrawn: { label: 'Återkallat', tone: 'neutral' },
  written_off: { label: 'Avskrivet', tone: 'neutral' },
};
const OPEN_CASE = ['prepared', 'sent', 'enforcement'];

type Tab = 'interest' | 'plans' | 'ready' | 'cases';

export default function CollectionPage() {
  const { active, can, version } = useSession();
  const [tab, setTab] = useState<Tab>('interest');
  const canManage = !!active && can('collection.manage');
  const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({});
  const setCount = useCallback((t: Tab, n: number) => setCounts((c) => (c[t] === n ? c : { ...c, [t]: n })), []);

  return (
    <>
      <PageHeader
        title="Ränta och inkasso"
        description={
          active
            ? `Dröjsmålsränta, avbetalningsplaner och inkasso för ${active.companyName}.`
            : 'Välj ett bolag för att debitera ränta, göra avbetalningsplaner och lämna till inkasso.'
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'interest', label: 'Dröjsmålsränta', count: counts.interest },
          { key: 'plans', label: 'Avbetalningsplaner', count: counts.plans },
          { key: 'ready', label: 'Redo för inkasso', count: counts.ready },
          { key: 'cases', label: 'Inkassoärenden', count: counts.cases },
        ]}
      />
      {tab === 'interest' && <InterestTab canManage={canManage} version={version} setCount={setCount} />}
      {tab === 'plans' && <PlansTab canManage={canManage} version={version} setCount={setCount} />}
      {tab === 'ready' && <ReadyTab canManage={canManage} version={version} setCount={setCount} onCreated={() => setTab('cases')} />}
      {tab === 'cases' && <CasesTab canManage={canManage} canWriteOff={canManage && can('invoice.issue')} version={version} setCount={setCount} />}
    </>
  );
}

type TabProps = { canManage: boolean; version: number; setCount: (t: Tab, n: number) => void };

function Done({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Card className="mb-4 px-4 py-3 text-[13px]">
      <span className="font-medium text-good">Klart.</span> {text}
    </Card>
  );
}

// ---------------------------------------------------------------------
// Dröjsmålsränta
// ---------------------------------------------------------------------

function InterestTab({ canManage, version, setCount }: TabProps) {
  const [date, setDate] = useState(todayIso());
  const [s, setS] = useState<InterestSuggestion | null>(null);
  const [history, setHistory] = useState<InterestCharge[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<'next_notice' | 'invoice'>('next_notice');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<InterestSuggestion>(`/late-interest/suggestion?date=${date}`).then((r) => {
      setS(r);
      if (r.settings) setMethod(r.settings.method);
      setSelected(new Set(r.candidates.filter((c) => !c.belowMinimum).map((c) => c.invoiceId)));
    });
    api<InterestCharge[]>('/late-interest').then(setHistory);
  }, [date]);
  useEffect(load, [load, version]);

  const list = s?.candidates ?? [];
  const chosen = list.filter((c) => selected.has(c.invoiceId));
  useEffect(() => setCount('interest', list.filter((c) => !c.belowMinimum).length), [list, setCount]);

  async function charge() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ charged: number; amountOre: number; onNotice: number; interestInvoiceIds: string[]; skipped: unknown[]; delivery: { sent: number; test: number; post: number; failed: number } }>(
        '/late-interest',
        { method: 'POST', body: { date, invoiceIds: chosen.map((c) => c.invoiceId), method } },
      );
      setResult(
        [
          `Ränta på ${r.charged} fakturor debiterades, ${fmtOre(r.amountOre, true)}.`,
          r.onNotice ? `${r.onNotice} läggs på nästa hyresavi.` : '',
          r.interestInvoiceIds.length ? `${r.interestInvoiceIds.length} räntefakturor skapades.` : '',
          r.delivery.sent ? `${r.delivery.sent} skickades med e-post.` : '',
          r.delivery.test ? `${r.delivery.test} e-post sparades i testläge.` : '',
          r.delivery.post ? `${r.delivery.post} ska skrivas ut under Fakturor.` : '',
          r.skipped.length ? `${r.skipped.length} hoppades över.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const st = s?.settings;
  return (
    <>
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Räntesats nu" value={s?.currentRate ?? '–'} sub={st ? (st.useReference ? `referensräntan ${s?.referenceRate ? fmtBp(s.referenceRate.rateBp) : '–'} + ${fmtBp(st.marginBp)}` : 'fast ränta') : 'välj ett bolag'} />
        <Stat label="Att debitera" value={s ? chosen.length : '–'} sub={fmtOre(chosen.reduce((a, c) => a + c.amountOre, 0), true)} />
        <Stat label="Under lägsta belopp" value={s ? list.filter((c) => c.belowMinimum).length : '–'} sub={st ? `under ${fmtOre(st.minOre)}, väntar till nästa gång` : undefined} />
        <Stat label="Debiterat totalt" value={history ? fmtOre(history.reduce((a, h) => a + h.amountOre, 0)) : '–'} sub={history ? `${history.length} debiteringar` : undefined} />
      </div>
      <Done text={result} />
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
      <Card className="mb-4 flex flex-wrap items-end gap-4 px-4 py-3.5">
        <div className="w-44">
          <Field label="Ränta till och med">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className="w-60">
          <Field label="Debiteras">
            <Select value={method} onChange={(e) => setMethod(e.target.value as 'next_notice' | 'invoice')}>
              <option value="next_notice">På nästa hyresavi</option>
              <option value="invoice">Som egen räntefaktura</option>
            </Select>
          </Field>
        </div>
        <div className="flex-1" />
        {canManage && (
          <Button onClick={charge} disabled={busy || !chosen.length}>
            {busy ? 'Debiterar…' : `Debitera ränta på ${chosen.length} fakturor`}
          </Button>
        )}
      </Card>
      <p className="mb-3 text-[12px] text-ink-3">
        Räntan räknas per dag från dagen efter förfallodagen på det som var obetalt, även för fakturor som redan betalats för sent.
        Samma dagar debiteras aldrig två gånger. Räntan är momsfri och bokförs på 8313. Fakturor utan avtal får alltid räntefaktura.
        {st && ` Ingen ränta räknas före ${st.fromDate}.`}
      </p>
      <Table head={['', 'Kund', 'Faktura', 'Förföll', 'Period', 'Dagar', 'Ränta', 'Belopp', '']} empty="Ingen ränta att debitera.">
        {list.map((c) => (
          <tr key={c.invoiceId}>
            <Td>
              <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={selected.has(c.invoiceId)} disabled={!canManage} onChange={(e) => toggle(selected, setSelected, c.invoiceId, e.target.checked)} />
            </Td>
            <Td>
              <Link href={`/kunder/${c.customerId}`} className="hover:underline">{c.customerName}</Link>
            </Td>
            <Td className="tabular">
              <Link href={`/fakturor/${c.invoiceId}`} className="hover:underline">{c.invoiceNr}</Link>
              {c.paidInFull && <span className="ml-1.5 text-[12px] text-ink-3">betald för sent</span>}
              {c.inPlan && <span className="ml-1.5 text-[12px] text-ink-3">i avbetalningsplan</span>}
            </Td>
            <Td className="tabular text-ink-2">{c.dueDate}</Td>
            <Td className="tabular text-ink-2">{c.fromDate} – {c.toDate}</Td>
            <Td className="tabular text-ink-2">{c.days}</Td>
            <Td className="tabular text-ink-2">{c.rateText}</Td>
            <Td className="tabular font-medium">{fmtOre(c.amountOre, true)}</Td>
            <Td>
              {c.belowMinimum ? <Badge>Under lägsta belopp</Badge> : method === 'next_notice' && !c.canUseNotice ? <Badge tone="warn">Räntefaktura</Badge> : null}
            </Td>
          </tr>
        ))}
      </Table>

      <h2 className="mb-3 mt-8 text-[14px] font-semibold">Debiterad ränta</h2>
      <Table head={['Datum', 'Kund', 'Faktura', 'Period', 'Ränta', 'Belopp', 'Debiterad på']} empty="Ingen ränta har debiterats ännu.">
        {history?.map((h) => (
          <tr key={h.id}>
            <Td className="tabular text-ink-2">{h.runDate}</Td>
            <Td>
              <Link href={`/kunder/${h.customerId}`} className="hover:underline">{h.customerName}</Link>
            </Td>
            <Td className="tabular">
              <Link href={`/fakturor/${h.invoiceId}`} className="hover:underline">{h.invoiceNr}</Link>
            </Td>
            <Td className="tabular text-ink-2">{h.fromDate} – {h.toDate}</Td>
            <Td className="tabular text-ink-2">{h.rateText}</Td>
            <Td className="tabular">{fmtOre(h.amountOre, true)}</Td>
            <Td className="text-ink-2">
              {h.interestInvoiceId ? (
                <Link href={`/fakturor/${h.interestInvoiceId}`} className="text-accent hover:underline">Räntefaktura {h.interestInvoiceNr}</Link>
              ) : h.noticeNr ? (
                `Hyresavi ${h.noticeNr}`
              ) : (
                <Link href={`/avtal/${h.contractId}`} className="hover:underline">Nästa avi, avtal {h.contractNr}</Link>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

// ---------------------------------------------------------------------
// Avbetalningsplaner
// ---------------------------------------------------------------------

function PlansTab({ canManage, version, setCount }: TabProps) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [open, setOpen] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    api<Plan[]>('/payment-plans').then(setPlans);
  }, []);
  useEffect(load, [load, version]);
  useEffect(() => setCount('plans', plans?.filter((p) => p.state === 'active' || p.state === 'behind').length ?? 0), [plans, setCount]);

  const activeList = plans?.filter((p) => p.state === 'active' || p.state === 'behind') ?? [];
  return (
    <>
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Aktiva planer" value={plans ? activeList.length : '–'} sub={fmtOre(activeList.reduce((a, p) => a + p.remainingOre, 0)) + ' kvar'} />
        <Stat label="Försenade" value={plans ? activeList.filter((p) => p.state === 'behind').length : '–'} sub={fmtOre(activeList.reduce((a, p) => a + p.overdueOre, 0)) + ' försenat'} />
        <Stat label="Klara" value={plans ? plans.filter((p) => p.state === 'completed').length : '–'} />
        <Card className="flex items-center justify-center px-4 py-3.5">
          {canManage ? <Button onClick={() => setCreating(true)}>Ny avbetalningsplan</Button> : <span className="text-[12px] text-ink-3">Välj ett bolag</span>}
        </Card>
      </div>
      <p className="mb-3 text-[12px] text-ink-3">
        Fakturor i en aktiv plan påminns inte och lämnas inte till inkasso. Hyresgästen betalar med OCR-numret på planens första faktura,
        och betalningen fördelas på planens fakturor, äldst först.
      </p>
      <Table head={['Plan', 'Kund', 'Avtalad', 'Skuld', 'Betalt', 'Kvar', 'Nästa delbetalning', 'Status']} empty="Inga avbetalningsplaner ännu.">
        {plans?.map((p) => {
          const st = PLAN_STATE[p.state] ?? PLAN_STATE.active;
          return (
            <tr key={p.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => setOpen(p)}>
              <Td className="tabular font-medium">{p.planNr}</Td>
              <Td>{p.customerName}</Td>
              <Td className="tabular text-ink-2">{p.agreedDate}</Td>
              <Td className="tabular">{fmtOre(p.totalOre, true)}</Td>
              <Td className="tabular text-ink-2">{fmtOre(p.paidOre, true)}</Td>
              <Td className="tabular font-medium">{fmtOre(p.remainingOre, true)}</Td>
              <Td className="tabular text-ink-2">{p.nextDue && ['active', 'behind'].includes(p.state) ? `${p.nextDue.dueDate}, ${fmtOre(p.nextDue.amountOre - p.nextDue.coveredOre)}` : '–'}</Td>
              <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
            </tr>
          );
        })}
      </Table>
      {open && <PlanDialog plan={open} canManage={canManage} onClose={() => setOpen(null)} onChanged={(p) => { setOpen(p); load(); }} />}
      {creating && <NewPlanDialog onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); load(); setOpen(p); }} />}
    </>
  );
}

function PlanDialog({ plan, canManage, onClose, onChanged }: { plan: Plan; canManage: boolean; onClose: () => void; onChanged: (p: Plan) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const st = PLAN_STATE[plan.state] ?? PLAN_STATE.active;
  const live = plan.state === 'active' || plan.state === 'behind';
  async function close(status: 'completed' | 'broken' | 'cancelled') {
    setError(null);
    try {
      onChanged(await api<Plan>(`/payment-plans/${plan.id}/close`, { method: 'POST', body: { status, reason: reason || null } }));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Avbetalningsplan ${plan.planNr}, ${plan.customerName}`} wide>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-ink-2">Skuld {fmtOre(plan.totalOre, true)} · betalt {fmtOre(plan.paidOre, true)} · kvar {fmtOre(plan.remainingOre, true)}</span>
        <span className="text-ink-2">OCR {plan.ocr}</span>
        <div className="flex-1" />
        <a href={`/api/payment-plans/${plan.id}/pdf`} target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">Brev till hyresgästen (PDF)</a>
      </div>
      <Table head={['Nr', 'Betala senast', 'Belopp', 'Betalt', 'Status']}>
        {plan.installments.map((i) => (
          <tr key={i.nr}>
            <Td className="tabular">{i.nr}</Td>
            <Td className="tabular text-ink-2">{i.dueDate}</Td>
            <Td className="tabular">{fmtOre(i.amountOre, true)}</Td>
            <Td className="tabular text-ink-2">{fmtOre(i.coveredOre, true)}</Td>
            <Td><Badge tone={INSTALLMENT_STATE[i.state].tone}>{INSTALLMENT_STATE[i.state].label}</Badge></Td>
          </tr>
        ))}
      </Table>
      <div className="mt-4 text-[13px] text-ink-2">
        Fakturor:{' '}
        {plan.invoices.map((i, n) => (
          <span key={i.invoiceId}>
            {n > 0 && ', '}
            <Link href={`/fakturor/${i.invoiceId}`} className="text-accent hover:underline">{i.invoiceNr}</Link> ({fmtOre(i.balanceOre)} kvar)
          </span>
        ))}
        . {plan.chargeInterest ? 'Dröjsmålsränta debiteras under planen.' : 'Ingen dröjsmålsränta under planen.'}
        {plan.note && <div className="mt-1">{plan.note}</div>}
        {plan.closedDate && <div className="mt-1">Avslutad {plan.closedDate}{plan.closedReason ? `: ${plan.closedReason}` : ''}</div>}
      </div>
      {live && canManage && (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <Field label="Anteckning när planen avslutas"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Till exempel: andra delbetalningen kom inte" /></Field>
          <ErrorNote message={error} />
          <div className="flex flex-wrap gap-2">
            {plan.remainingOre <= 0 && <Button onClick={() => close('completed')}>Markera som klar</Button>}
            <Button variant="danger" onClick={() => close('broken')}>Planen följs inte</Button>
            <Button variant="ghost" onClick={() => close('cancelled')}>Makulera planen</Button>
          </div>
          <p className="text-[12px] text-ink-3">När planen avslutas kan fakturorna påminnas och lämnas till inkasso igen.</p>
        </div>
      )}
    </Dialog>
  );
}

interface LedgerCustomer { customerId: string; customerName: string; customerNr: number; openOre: number; companyId: string }
interface OpenInvoice { invoiceId: string; invoiceNr: number; dueDate: string; balanceOre: number; reminderLevel: number }

function NewPlanDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Plan) => void }) {
  const [customers, setCustomers] = useState<LedgerCustomer[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [open, setOpen] = useState<OpenInvoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'count' | 'amount'>('count');
  const [count, setCount] = useState('3');
  const [amount, setAmount] = useState('');
  const [firstDue, setFirstDue] = useState(nextMonth25());
  const [chargeInterest, setChargeInterest] = useState(true);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ customers: LedgerCustomer[] }>('/ledger').then((r) => setCustomers(r.customers.filter((c) => c.openOre > 0)));
  }, []);
  useEffect(() => {
    if (!customerId) return setOpen([]);
    api<{ open: OpenInvoice[] }>(`/ledger/customers/${customerId}`).then((r) => {
      setOpen(r.open);
      setSelected(new Set(r.open.map((o) => o.invoiceId)));
    });
  }, [customerId]);
  const total = open.filter((o) => selected.has(o.invoiceId)).reduce((a, o) => a + o.balanceOre, 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const p = await api<Plan>('/payment-plans', {
        method: 'POST',
        body: {
          customerId,
          invoiceIds: [...selected],
          firstDueDate: firstDue,
          installments: mode === 'count' ? Number(count) : undefined,
          monthlyAmount: mode === 'amount' ? Number(amount.replace(/\s/g, '').replace(',', '.')) : undefined,
          chargeInterest,
          note: note || null,
        },
      });
      onCreated(p);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Ny avbetalningsplan" wide>
      <div className="space-y-4">
        <Field label="Hyresgäst">
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Välj hyresgäst med obetalda fakturor</option>
            {customers.map((c) => (
              <option key={c.customerId} value={c.customerId}>{c.customerName} ({fmtOre(c.openOre)})</option>
            ))}
          </Select>
        </Field>
        {open.length > 0 && (
          <div className="space-y-1.5">
            {open.map((o) => (
              <label key={o.invoiceId} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={selected.has(o.invoiceId)} onChange={(e) => toggle(selected, setSelected, o.invoiceId, e.target.checked)} />
                Faktura {o.invoiceNr}, förföll {o.dueDate}, {fmtOre(o.balanceOre, true)}
              </label>
            ))}
            <div className="text-[13px] font-medium">Skuld i planen: {fmtOre(total, true)}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dela upp">
            <Select value={mode} onChange={(e) => setMode(e.target.value as 'count' | 'amount')}>
              <option value="count">I ett antal lika delbetalningar</option>
              <option value="amount">Med ett belopp per månad</option>
            </Select>
          </Field>
          {mode === 'count' ? (
            <Field label="Antal delbetalningar" hint={total && Number(count) ? `ungefär ${fmtOre(total / Number(count))} per månad` : undefined}>
              <Input type="number" min={1} max={60} value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
          ) : (
            <Field label="Belopp per månad (kr)">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          )}
          <Field label="Första delbetalningen senast">
            <Input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Field label="Anteckning">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={chargeInterest} onChange={(e) => setChargeInterest(e.target.checked)} />
          Dröjsmålsränta fortsätter att löpa under planen
        </label>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Avbryt</Button>
          <Button onClick={save} disabled={busy || !customerId || !selected.size}>{busy ? 'Sparar…' : 'Skapa plan'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// Inkasso
// ---------------------------------------------------------------------

function ReadyTab({ canManage, version, setCount, onCreated }: TabProps & { onCreated: () => void }) {
  const [rows, setRows] = useState<ReadyRow[] | null>(null);
  const [agency, setAgency] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api<ReadyRow[]>(`/collection-cases/ready?date=${todayIso()}`).then(setRows);
  }, []);
  useEffect(load, [load, version]);
  useEffect(() => setCount('ready', rows?.length ?? 0), [rows, setCount]);

  const groups = useMemo(() => {
    const m = new Map<string, ReadyRow[]>();
    for (const r of rows ?? []) m.set(r.customerId, [...(m.get(r.customerId) ?? []), r]);
    return [...m.values()];
  }, [rows]);

  async function create(list: ReadyRow[]) {
    setBusy(list[0].customerId);
    setError(null);
    try {
      await api('/collection-cases', { method: 'POST', body: { customerId: list[0].customerId, invoiceIds: list.map((r) => r.invoiceId), agency: agency || null } });
      onCreated();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="mb-3 text-[13px] text-ink-2">
        Båda påminnelserna är skickade och fristen har gått ut. Skapa ett inkassoärende per hyresgäst. Fakturornas påminnelseavgifter och räntefakturor följer med.
        Kontakta gärna hyresgästen först, en avbetalningsplan kan vara ett alternativ.
      </p>
      <Card className="mb-4 flex flex-wrap items-end gap-4 px-4 py-3.5">
        <div className="w-72">
          <Field label="Inkassobolag" hint="Till exempel det bolag ni har avtal med">
            <Input value={agency} onChange={(e) => setAgency(e.target.value)} />
          </Field>
        </div>
      </Card>
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}
      <Table head={['Kund', 'Fakturor', 'Obetalt', 'Upplupen ränta', 'Äldsta förfallodag', '']} empty="Inga fakturor är redo för inkasso.">
        {groups.map((g) => (
          <tr key={g[0].customerId}>
            <Td><Link href={`/kunder/${g[0].customerId}`} className="hover:underline">{g[0].customerName}</Link></Td>
            <Td className="tabular text-ink-2">{g.map((r) => r.invoiceNr).join(', ')}</Td>
            <Td className="tabular font-medium">{fmtOre(g.reduce((a, r) => a + r.balanceOre, 0), true)}</Td>
            <Td className="tabular text-ink-2">{fmtOre(g.reduce((a, r) => a + r.interestOre, 0), true)}</Td>
            <Td className="tabular text-ink-2">{g[0].dueDate} ({g[0].daysOverdue} dagar)</Td>
            <Td className="text-right">
              {canManage && <Button size="sm" onClick={() => create(g)} disabled={busy === g[0].customerId}>Skapa inkassoärende</Button>}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function CasesTab({ canManage, canWriteOff, version, setCount }: TabProps & { canWriteOff: boolean }) {
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api<CaseRow[]>('/collection-cases').then(setCases);
  }, []);
  useEffect(load, [load, version]);
  const openCases = cases?.filter((c) => OPEN_CASE.includes(c.status)) ?? [];
  useEffect(() => setCount('cases', openCases.length), [openCases.length, setCount]);
  const prepared = cases?.filter((c) => c.status === 'prepared') ?? [];

  return (
    <>
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Förberedda" value={cases ? prepared.length : '–'} sub="ska lämnas till inkassobolaget" />
        <Stat label="Hos inkassobolaget" value={cases ? openCases.length - prepared.length : '–'} sub={fmtOre(openCases.filter((c) => c.status !== 'prepared').reduce((a, c) => a + c.remainingOre, 0)) + ' obetalt'} />
        <Stat label="Avslutade" value={cases ? cases.length - openCases.length : '–'} />
        <Card className="flex flex-col items-center justify-center gap-1.5 px-4 py-3.5 text-[13px]">
          {prepared.length > 0 ? (
            <>
              <span className="text-ink-3">Ärendefil för de förberedda</span>
              <span className="flex gap-3">
                <a className="text-accent hover:underline" href="/api/collection-cases/export.xlsx">Excel</a>
                <a className="text-accent hover:underline" href="/api/collection-cases/export.csv">CSV</a>
                <a className="text-accent hover:underline" href="/api/collection-cases/export.pdf" target="_blank" rel="noreferrer">PDF</a>
              </span>
            </>
          ) : (
            <span className="text-ink-3">Inga förberedda ärenden</span>
          )}
        </Card>
      </div>
      <Table head={['Ärende', 'Kund', 'Inkassobolag', 'Kapital', 'Kvar', 'Skickat', 'Status']} empty="Inga inkassoärenden ännu.">
        {cases?.map((c) => {
          const st = CASE_STATUS[c.status];
          return (
            <tr key={c.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => setOpen(c.id)}>
              <Td className="tabular font-medium">{c.caseNr}</Td>
              <Td>{c.customerName}</Td>
              <Td className="text-ink-2">{c.agency ?? '–'}{c.agencyReference ? ` · ${c.agencyReference}` : ''}</Td>
              <Td className="tabular">{fmtOre(c.capitalOre, true)}</Td>
              <Td className="tabular font-medium">{c.remainingOre > 0 ? fmtOre(c.remainingOre, true) : <span className="text-good">Betalt</span>}</Td>
              <Td className="tabular text-ink-2">{c.sentDate ?? '–'}</Td>
              <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
            </tr>
          );
        })}
      </Table>
      {open && <CaseDialog id={open} canManage={canManage} canWriteOff={canWriteOff} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function CaseDialog({ id, canManage, canWriteOff, onClose, onChanged }: { id: string; canManage: boolean; canWriteOff: boolean; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<CaseDetail | null>(null);
  const [agency, setAgency] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [writeOffReason, setWriteOffReason] = useState('');
  const [confirmWriteOff, setConfirmWriteOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<CaseDetail>(`/collection-cases/${id}`).then((r) => {
      setC(r);
      setAgency(r.agency ?? '');
      setReference(r.agencyReference ?? '');
    });
  }, [id]);

  async function status(s: string) {
    setError(null);
    try {
      setC(await api<CaseDetail>(`/collection-cases/${id}/status`, { method: 'POST', body: { status: s, agency: agency || null, agencyReference: reference || null, note: note || null } }));
      setNote('');
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  async function writeOff() {
    setError(null);
    try {
      setC(await api<CaseDetail>(`/collection-cases/${id}/write-off`, { method: 'POST', body: { reason: writeOffReason } }));
      setConfirmWriteOff(false);
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  if (!c) return null;
  const st = CASE_STATUS[c.status];
  const live = OPEN_CASE.includes(c.status);
  return (
    <Dialog open onClose={onClose} title={`Inkassoärende ${c.caseNr}, ${c.customerName}`} wide>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-ink-2">Kapital {fmtOre(c.capitalOre, true)} · kvar {fmtOre(c.remainingOre, true)} · ränta {c.rateText}</span>
        <div className="flex-1" />
        <a className="text-accent hover:underline" href={`/api/collection-cases/export.xlsx?ids=${c.id}`}>Excel</a>
        <a className="text-accent hover:underline" href={`/api/collection-cases/export.csv?ids=${c.id}`}>CSV</a>
        <a className="text-accent hover:underline" href={`/api/collection-cases/${c.id}/pdf`} target="_blank" rel="noreferrer">Kravsammanställning</a>
      </div>
      <Table head={['Avser', 'Förföll', 'Kapital', 'Kvar', 'Upplupen ränta']}>
        {c.claims.map((x) => (
          <tr key={x.invoiceId}>
            <Td>
              <Link href={`/fakturor/${x.invoiceId}`} className="hover:underline">
                {x.isFee ? 'Påminnelseavgift' : x.isInterest ? 'Räntefaktura' : 'Faktura'} {x.invoiceNr}
              </Link>
            </Td>
            <Td className="tabular text-ink-2">{x.dueDate}</Td>
            <Td className="tabular">{fmtOre(x.capitalOre, true)}</Td>
            <Td className="tabular">{x.balanceOre > 0 ? fmtOre(x.balanceOre, true) : <span className="text-good">Betald</span>}</Td>
            <Td className="tabular text-ink-2">{x.interestOre ? fmtOre(x.interestOre, true) : '–'}</Td>
          </tr>
        ))}
      </Table>
      <div className="mt-4 space-y-1 text-[12px] text-ink-2">
        {c.events.map((e, i) => (
          <div key={i}><span className="tabular text-ink-3">{e.eventDate}</span> {e.description}</div>
        ))}
      </div>
      {live && canManage && (
        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Inkassobolag"><Input value={agency} onChange={(e) => setAgency(e.target.value)} /></Field>
            <Field label="Inkassobolagets ärendenummer"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          </div>
          <Field label="Anteckning"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <ErrorNote message={error} />
          <div className="flex flex-wrap gap-2">
            {c.status === 'prepared' && <Button onClick={() => status('sent')}>Markera som skickat till inkasso</Button>}
            {c.status === 'sent' && <Button variant="secondary" onClick={() => status('enforcement')}>Betalningsföreläggande sökt</Button>}
            {c.status !== 'prepared' && <Button variant="secondary" onClick={() => status(c.status)}>Spara uppgifter</Button>}
            <Button variant="secondary" onClick={() => status('paid')}>Betalt, avsluta</Button>
            <Button variant="ghost" onClick={() => status('withdrawn')}>Återkalla</Button>
            {canWriteOff && c.remainingOre > 0 && <Button variant="danger" onClick={() => setConfirmWriteOff(true)}>Skriv av som kundförlust</Button>}
          </div>
          <p className="text-[12px] text-ink-3">
            Inbetalningar, från hyresgästen eller från inkassobolaget, registreras som vanligt under Inbetalningar och syns här direkt.
            Återkallas ärendet kan fakturorna påminnas igen.
          </p>
          {confirmWriteOff && (
            <Card className="space-y-3 px-4 py-3.5">
              <div className="text-[13px]">
                {fmtOre(c.remainingOre, true)} skrivs av med kreditfakturor som bokförs som kundförlust. Momsen på momspliktiga fakturor återförs. Det går inte att ångra.
              </div>
              <Field label="Orsak"><Input value={writeOffReason} onChange={(e) => setWriteOffReason(e.target.value)} placeholder="Till exempel: Kronofogden har inte hittat tillgångar" /></Field>
              <div className="flex gap-2">
                <Button variant="danger" onClick={writeOff} disabled={writeOffReason.trim().length < 2}>Skriv av</Button>
                <Button variant="ghost" onClick={() => setConfirmWriteOff(false)}>Avbryt</Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------

function toggle(set: Set<string>, update: (s: Set<string>) => void, id: string, on: boolean) {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  update(next);
}

function fmtBp(bp: number) {
  return `${(bp / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} %`;
}

function nextMonth25(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 25));
  return t.toISOString().slice(0, 10);
}
