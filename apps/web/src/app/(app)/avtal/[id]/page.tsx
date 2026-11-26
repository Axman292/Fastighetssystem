'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useState } from 'react';
import { EditForm, SectionHeader } from '@/components/edit-form';
import { FieldDef, FormDialog } from '@/components/form';
import type { ObjectRow } from '@/components/object-table';
import { Badge, Button, Card, ErrorNote, PageHeader, Stat, Table, Td, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { contractTermsFields, depositFields, lineFields } from '@/lib/fields';
import {
  ARTICLE_LABEL,
  CONTRACT_TYPE_LABEL,
  DEPOSIT_LABEL,
  MONTH_LABEL,
  OBJECT_TYPE_LABEL,
  contractStatus,
  fmtM2,
  fmtOre,
  todayIso,
} from '@/lib/format';
import { useSession } from '@/lib/session';
import { ContractBilling } from '@/components/contract-billing';

interface Line {
  id: string;
  objectId: string | null;
  article: string;
  description: string;
  amountOre: number;
  vatRateBp: number;
  indexed: boolean;
  baseAmountOre: number | null;
  validFrom: string;
  validTo: string | null;
  reason: string | null;
}

interface Deposit {
  id: string;
  kind: string;
  amountOre: number;
  dueDate: string | null;
  receivedDate: string | null;
  returnedDate: string | null;
  note: string | null;
}

interface ContractDetail {
  id: string;
  companyId: string;
  companyName: string;
  contractNr: number;
  type: string;
  status: string;
  customerId: string;
  startDate: string;
  endDate: string | null;
  noticeMonths: number;
  extensionMonths: number | null;
  signedDate: string | null;
  terminationReceived: string | null;
  terminatedBy: string | null;
  terminationReason: string | null;
  customer: { id: string; customerNr: number; name: string; nationalId: string | null; email: string | null; phone: string | null };
  objects: {
    id: string;
    objectId: string;
    objectNr: string;
    type: string;
    areaM2: number | null;
    propertyId: string;
    propertyName: string;
    validFrom: string;
    validTo: string | null;
  }[];
  lines: Line[];
  indexClause: {
    baseYear: number;
    baseMonth: number;
    baseValue: number;
    sharePct: number;
    floorAtBase: boolean;
    adjustMonth: number;
    lastAdjusted: string | null;
  } | null;
  deposits: Deposit[];
  events: { id: string; kind: string; eventDate: string; description: string; createdAt: string }[];
  monthlyOre: number;
  monthlyVatOre: number;
  noticeDeadline: string | null;
  [k: string]: unknown;
}

type DialogState =
  | { kind: 'activate' | 'terminate' | 'extend' | 'cancel' | 'withdraw' | 'addLine' | 'index' | 'runIndex' | 'addDeposit' | 'note' | 'addObject' }
  | { kind: 'editLine' | 'changeLine' | 'endLine'; line: Line }
  | { kind: 'editDeposit'; deposit: Deposit };

const MONTH_OPTIONS = Object.fromEntries(MONTH_LABEL.map((m, i) => [String(i + 1), m]));

const indexFields: FieldDef[] = [
  { key: 'baseYear', label: 'Basår', type: 'number', required: true, half: true },
  { key: 'baseMonth', label: 'Basmånad', type: 'select', options: MONTH_OPTIONS, required: true, half: true },
  { key: 'baseValue', label: 'KPI för basmånaden', type: 'number', half: true, hint: 'Tom = hämtas ur KPI-tabellen' },
  { key: 'sharePct', label: 'Andel av förändringen (%)', type: 'number', half: true },
  { key: 'adjustMonth', label: 'Räknas om från', type: 'select', options: MONTH_OPTIONS, required: true, half: true },
  { key: 'floorAtBase', label: 'Hyran sänks aldrig under bashyran', type: 'checkbox' },
];

const BY_LABEL: Record<string, string> = { tenant: 'Hyresgästen', landlord: 'Hyresvärden', mutual: 'Överenskommelse' };

export default function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const router = useRouter();
  const [k, setK] = useState<ContractDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [freeObjects, setFreeObjects] = useState<ObjectRow[]>([]);

  const load = useCallback(() => {
    api<ContractDetail>(`/contracts/${id}`)
      .then((d) => {
        setK(d);
        setFormKey((n) => n + 1);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ErrorNote message={error} />;
  if (!k) return null;

  const opts = { companyId: k.companyId };
  const write = can('contract.write', k.companyId);
  const draft = k.status === 'draft';
  const open = k.status !== 'cancelled';
  const status = contractStatus(k);
  const ref = k.startDate > todayIso() ? k.startDate : todayIso();
  const isCurrent = (l: Line) => l.validFrom <= ref && (!l.validTo || l.validTo >= ref);
  const lines = showHistory ? k.lines : k.lines.filter((l) => isCurrent(l) || l.validFrom > ref);
  const area = k.objects.reduce((s, o) => s + (o.areaM2 ?? 0), 0);

  const post = (path: string, body: Record<string, unknown> = {}) => api(`/contracts/${id}${path}`, { method: 'POST', body, ...opts });
  const done = () => {
    setDialog(null);
    load();
  };

  const actions = (
    <>
      <a href={`/api/contracts/${id}/pdf`} target="_blank" rel="noreferrer">
        <Button variant="secondary">{draft ? 'Förhandsgranska PDF' : 'Avtal som PDF'}</Button>
      </a>
      {write && draft && (
        <Button variant="ghost" onClick={() => setDialog({ kind: 'cancel' })}>
          Makulera
        </Button>
      )}
      {draft && can('contract.activate', k.companyId) && <Button onClick={() => setDialog({ kind: 'activate' })}>Aktivera avtal</Button>}
      {write && k.status === 'active' && k.startDate > todayIso() && (
        <Button variant="ghost" onClick={() => setDialog({ kind: 'cancel' })}>
          Makulera
        </Button>
      )}
      {write && k.status === 'active' && k.endDate && (
        <Button variant="secondary" onClick={() => setDialog({ kind: 'extend' })}>
          Förläng
        </Button>
      )}
      {write && k.status === 'active' && (
        <Button variant="danger" onClick={() => setDialog({ kind: 'terminate' })}>
          Säg upp
        </Button>
      )}
      {write && k.status === 'terminated' && (
        <Button variant="secondary" onClick={() => setDialog({ kind: 'withdraw' })}>
          Återkalla uppsägning
        </Button>
      )}
    </>
  );

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        / {k.contractNr}
      </div>
      <PageHeader
        title={`${CONTRACT_TYPE_LABEL[k.type]}savtal ${k.contractNr}`}
        description={`${k.customer.name} · ${k.companyName}`}
        actions={actions}
      />
      <div className="-mt-3 mb-6 flex items-center gap-2 text-[13px]">
        <Badge tone={status.tone}>{status.label}</Badge>
        {k.status === 'terminated' && (
          <span className="text-ink-2">
            {BY_LABEL[k.terminatedBy ?? ''] ?? 'Uppsagt'} sade upp avtalet {k.terminationReceived}. Upphör {k.endDate}.
          </span>
        )}
        {draft && <span className="text-ink-2">Utkast. Kontrollera objekt och hyresrader och aktivera när avtalet är undertecknat.</span>}
      </div>

      <div className="mb-8 grid grid-cols-4 gap-3">
        <Stat label="Hyra per månad" value={fmtOre(k.monthlyOre)} sub={k.monthlyVatOre ? `+ ${fmtOre(k.monthlyVatOre)} moms` : 'momsfri'} />
        <Stat label="Årshyra" value={fmtOre(k.monthlyOre * 12)} sub={area ? `${Math.round((k.monthlyOre * 12) / 100 / area).toLocaleString('sv-SE')} kr/m² · ${fmtM2(area)}` : undefined} />
        <Stat
          label="Avtalstid"
          value={<span className="text-[16px]">{k.endDate ? `till ${k.endDate}` : 'Tills vidare'}</span>}
          sub={`från ${k.startDate}${k.extensionMonths ? ` · förlängs ${k.extensionMonths} mån` : ''}`}
        />
        <Stat
          label="Uppsägning"
          value={<span className="text-[16px]">{k.noticeDeadline ? `senast ${k.noticeDeadline}` : `${k.noticeMonths} månader`}</span>}
          sub={k.noticeDeadline ? `${k.noticeMonths} månaders uppsägningstid` : 'från närmaste månadsskifte'}
        />
      </div>

      <div className="grid grid-cols-[3fr_2fr] gap-6">
        <section>
          <SectionHeader
            title="Hyresgäst"
            actions={
              <Link href={`/kunder/${k.customer.id}`}>
                <Button size="sm" variant="ghost">
                  Visa kund
                </Button>
              </Link>
            }
          />
          <Card className="px-4 py-3 text-[13px]">
            <div className="font-medium">{k.customer.name}</div>
            <div className="text-ink-2">
              Kund {k.customer.customerNr}
              {k.customer.nationalId ? ` · ${k.customer.nationalId}` : ''}
              {k.customer.email ? ` · ${k.customer.email}` : ''}
              {k.customer.phone ? ` · ${k.customer.phone}` : ''}
            </div>
          </Card>
        </section>
        <section>
          <SectionHeader
            title="Objekt"
            actions={
              write &&
              draft && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    api<ObjectRow[]>('/objects', opts).then((rows) =>
                      setFreeObjects(rows.filter((o) => o.active && !k.objects.some((x) => x.objectId === o.id))),
                    );
                    setDialog({ kind: 'addObject' });
                  }}
                >
                  Lägg till
                </Button>
              )
            }
          />
          <Card className="divide-y divide-line">
            {k.objects.map((o) => (
              <div key={o.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <Link href={`/objekt/${o.objectId}`} className="min-w-0 flex-1 hover:text-accent">
                  <span className="font-medium">{o.objectNr}</span>{' '}
                  <span className="text-ink-3">
                    · {OBJECT_TYPE_LABEL[o.type]} · {o.propertyName}
                  </span>
                </Link>
                <span className="text-[12px] tabular text-ink-3">{fmtM2(o.areaM2)}</span>
                {write && draft && (
                  <button
                    className="text-[12px] text-ink-3 hover:text-bad"
                    onClick={async () => {
                      await api(`/contracts/${id}/objects/${o.objectId}`, { method: 'DELETE', ...opts });
                      load();
                    }}
                  >
                    Ta bort
                  </button>
                )}
              </div>
            ))}
            {k.objects.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-ink-3">Inga objekt.</div>}
          </Card>
        </section>
      </div>

      <section className="mt-10">
        <SectionHeader
          title="Hyresrader"
          description={draft ? 'Raderna kan ändras fritt tills avtalet aktiveras.' : 'En ändring gäller från ett datum. Tidigare belopp finns kvar i historiken.'}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)}>
                {showHistory ? 'Dölj historik' : 'Visa historik'}
              </Button>
              {write && open && (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'addLine' })}>
                  Ny rad
                </Button>
              )}
            </>
          }
        />
        <Table head={['Text', 'Artikel', 'Belopp/mån', 'Moms', 'Gäller', '']} empty="Avtalet har inga hyresrader.">
          {lines.map((l) => {
            const current = isCurrent(l);
            const future = l.validFrom > ref;
            return (
              <tr key={l.id} className={cx(!current && !future && 'text-ink-3')}>
                <Td>
                  <span className={cx(current && 'font-medium')}>{l.description}</span>
                  {l.indexed && (
                    <span className="ml-2">
                      <Badge tone="accent">Index</Badge>
                    </span>
                  )}
                  {future && (
                    <span className="ml-2">
                      <Badge>Kommande</Badge>
                    </span>
                  )}
                  {l.reason && <div className="text-[12px] text-ink-3">{l.reason}</div>}
                </Td>
                <Td className="text-ink-2">{ARTICLE_LABEL[l.article]}</Td>
                <Td className="tabular">{fmtOre(l.amountOre, true)}</Td>
                <Td className="tabular text-ink-2">{l.vatRateBp ? `${l.vatRateBp / 100} %` : '–'}</Td>
                <Td className="tabular text-[12px] text-ink-2">
                  {l.validFrom} – {l.validTo ?? 'tills vidare'}
                </Td>
                <Td className="text-right">
                  {write && open && (current || future) && (
                    <div className="flex justify-end gap-1">
                      {draft ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'editLine', line: l })}>
                            Ändra
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-bad"
                            onClick={async () => {
                              await api(`/contracts/${id}/lines/${l.id}`, { method: 'DELETE', ...opts });
                              load();
                            }}
                          >
                            Ta bort
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'changeLine', line: l })}>
                            Nytt belopp
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'endLine', line: l })}>
                            Avsluta
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </section>

      <div className="mt-10 grid grid-cols-2 gap-6">
        <section>
          <SectionHeader
            title="Indexklausul"
            actions={
              write &&
              open && (
                <>
                  {k.indexClause && !draft && can('index.write', k.companyId) && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'runIndex' })}>
                      Räkna upp
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'index' })}>
                    {k.indexClause ? 'Ändra' : 'Lägg till'}
                  </Button>
                </>
              )
            }
          />
          <Card className="px-4 py-3 text-[13px]">
            {k.indexClause ? (
              <dl className="grid grid-cols-2 gap-y-1.5">
                <dt className="text-ink-3">Bas</dt>
                <dd className="tabular">
                  KPI {MONTH_LABEL[k.indexClause.baseMonth - 1]} {k.indexClause.baseYear}: {k.indexClause.baseValue.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                </dd>
                <dt className="text-ink-3">Andel</dt>
                <dd>{k.indexClause.sharePct} % av förändringen</dd>
                <dt className="text-ink-3">Omräkning</dt>
                <dd>1 {MONTH_LABEL[k.indexClause.adjustMonth - 1]} varje år</dd>
                <dt className="text-ink-3">Golv</dt>
                <dd>{k.indexClause.floorAtBase ? 'Aldrig under bashyran' : 'Inget golv'}</dd>
                <dt className="text-ink-3">Senast uppräknad</dt>
                <dd className="tabular">{k.indexClause.lastAdjusted ?? 'aldrig'}</dd>
              </dl>
            ) : (
              <span className="text-ink-3">Hyran är inte indexreglerad.</span>
            )}
          </Card>
        </section>
        <section>
          <SectionHeader
            title="Säkerheter"
            actions={
              write && (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'addDeposit' })}>
                  Lägg till
                </Button>
              )
            }
          />
          <Table head={['Typ', 'Belopp', 'Status', '']} empty="Ingen säkerhet.">
            {k.deposits.map((d) => (
              <tr key={d.id}>
                <Td>
                  {DEPOSIT_LABEL[d.kind]}
                  {d.note && <div className="text-[12px] text-ink-3">{d.note}</div>}
                </Td>
                <Td className="tabular">{fmtOre(d.amountOre)}</Td>
                <Td className="text-[12px]">
                  {d.returnedDate ? (
                    <Badge>Återbetald {d.returnedDate}</Badge>
                  ) : d.receivedDate ? (
                    <Badge tone="good">Mottagen {d.receivedDate}</Badge>
                  ) : d.dueDate && d.dueDate < todayIso() ? (
                    <Badge tone="bad">Saknas sedan {d.dueDate}</Badge>
                  ) : (
                    <Badge tone="warn">Väntas{d.dueDate ? ` ${d.dueDate}` : ''}</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  {write && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'editDeposit', deposit: d })}>
                      Ändra
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      </div>

      <div className="mt-10 grid grid-cols-[3fr_2fr] gap-6">
        <section>
          <SectionHeader title="Villkor" />
          <EditForm
            key={formKey}
            fields={contractTermsFields}
            row={k}
            editable={write && open}
            save={async (body) => {
              await api(`/contracts/${id}`, { method: 'PATCH', body, ...opts });
              load();
            }}
          />
        </section>
        <section>
          <SectionHeader
            title="Händelser"
            actions={
              write && (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'note' })}>
                  Anteckning
                </Button>
              )
            }
          />
          <Card className="px-4 py-3">
            <ol className="relative space-y-3 border-l border-line pl-4">
              {k.events.map((e) => (
                <li key={e.id} className="text-[13px]">
                  <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full bg-line-strong" />
                  <div className="text-[12px] tabular text-ink-3">{e.eventDate}</div>
                  <div>{e.description}</div>
                </li>
              ))}
            </ol>
          </Card>
        </section>
      </div>

      {!draft && <ContractBilling contract={k} canWrite={can('invoice.write', k.companyId)} onChange={load} />}

      <Dialogs
        dialog={dialog}
        contract={k}
        freeObjects={freeObjects}
        onClose={() => setDialog(null)}
        post={post}
        done={done}
        afterCancel={() => router.push('/avtal')}
      />
    </>
  );
}

function Dialogs({
  dialog,
  contract: k,
  freeObjects,
  onClose,
  post,
  done,
  afterCancel,
}: {
  dialog: DialogState | null;
  contract: ContractDetail;
  freeObjects: ObjectRow[];
  onClose: () => void;
  post: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  done: () => void;
  afterCancel: () => void;
}) {
  const opts = { companyId: k.companyId };
  const kind = dialog?.kind;
  const line = dialog && 'line' in dialog ? dialog.line : null;
  const deposit = dialog && 'deposit' in dialog ? dialog.deposit : null;
  const thisYear = new Date().getFullYear();
  const objectOptions = Object.fromEntries(
    freeObjects.map((o) => [o.id, `${o.objectNr} · ${OBJECT_TYPE_LABEL[o.type]} · ${o.propertyName}${o.status && o.status !== 'vacant' ? ` (${o.status === 'occupied' ? 'uthyrd' : o.status === 'notice' ? 'uppsagd' : 'kommande'})` : ''}`]),
  );

  return (
    <>
      <FormDialog
        open={kind === 'activate'}
        title="Aktivera avtal"
        fields={[{ key: 'signedDate', label: 'Undertecknat', type: 'date', required: true, hint: 'Avtalet låses för ändring av typ, hyresgäst och avtalstid.' }]}
        initial={{ signedDate: todayIso() }}
        onClose={onClose}
        submit={async (body) => {
          await post('/activate', body);
          done();
        }}
        submitLabel="Aktivera"
      />
      <FormDialog
        open={kind === 'terminate'}
        title="Säg upp avtal"
        fields={[
          { key: 'terminationReceived', label: 'Uppsägningen mottagen', type: 'date', required: true, half: true },
          { key: 'terminatedBy', label: 'Uppsagt av', type: 'select', options: { tenant: 'Hyresgästen', landlord: 'Hyresvärden', mutual: 'Överenskommelse' }, required: true, half: true },
          {
            key: 'endDate',
            label: 'Avtalet upphör',
            type: 'date',
            hint: k.endDate
              ? `Tom = räknas fram. Sista dag för uppsägning till ${k.endDate} är ${k.noticeDeadline}.`
              : `Tom = räknas fram: ${k.noticeMonths} månader från närmaste månadsskifte.`,
          },
          { key: 'reason', label: 'Orsak', type: 'textarea' },
        ]}
        initial={{ terminationReceived: todayIso(), terminatedBy: 'tenant' }}
        onClose={onClose}
        submit={async (body) => {
          await post('/terminate', { ...body, endDate: body.endDate ?? undefined });
          done();
        }}
        submitLabel="Säg upp"
      />
      <FormDialog
        open={kind === 'extend'}
        title="Förläng avtal"
        fields={[
          {
            key: 'endDate',
            label: 'Nytt slutdatum',
            type: 'date',
            hint: k.extensionMonths ? `Tom = förlängs ${k.extensionMonths} månader enligt avtalet.` : 'Avtalet saknar förlängningstid, ange datum.',
          },
        ]}
        onClose={onClose}
        submit={async (body) => {
          await post('/extend', body.endDate ? body : {});
          done();
        }}
        submitLabel="Förläng"
      />
      <FormDialog
        open={kind === 'withdraw'}
        title="Återkalla uppsägning"
        fields={[{ key: 'endDate', label: 'Avtalet löper till', type: 'date', hint: 'Tom = tills vidare' }]}
        onClose={onClose}
        submit={async (body) => {
          await post('/withdraw-termination', body);
          done();
        }}
        submitLabel="Återkalla"
      />
      <FormDialog
        open={kind === 'cancel'}
        title="Makulera avtal"
        fields={[{ key: 'reason', label: 'Orsak', hint: 'Objekten blir lediga igen. Avtalet finns kvar som makulerat.' }]}
        onClose={onClose}
        submit={async (body) => {
          await post('/cancel', body.reason ? body : {});
          afterCancel();
        }}
        submitLabel="Makulera"
      />
      <FormDialog
        open={kind === 'addObject'}
        title="Lägg till objekt"
        fields={[
          { key: 'objectId', label: 'Objekt', type: 'select', options: objectOptions, required: true },
          { key: 'prefill', label: 'Lägg till hyresrad från objektets hyra', type: 'checkbox' },
        ]}
        initial={{ prefill: true }}
        onClose={onClose}
        submit={async (body) => {
          await post('/objects', body);
          done();
        }}
      />
      <FormDialog
        open={kind === 'addLine'}
        title="Ny hyresrad"
        fields={lineFields}
        initial={{ article: 'rent', vatRateBp: k.type === 'residential' ? '0' : '2500', validFrom: k.status === 'draft' ? null : todayIso() }}
        onClose={onClose}
        submit={async (body) => {
          await post('/lines', body);
          done();
        }}
      />
      <FormDialog
        open={kind === 'editLine'}
        title="Ändra hyresrad"
        fields={lineFields}
        initial={line ? { ...line, amount: line.amountOre } : null}
        onClose={onClose}
        submit={async (body) => {
          await api(`/contracts/${k.id}/lines/${line!.id}`, { method: 'PATCH', body, ...opts });
          done();
        }}
      />
      <FormDialog
        open={kind === 'changeLine'}
        title={`Nytt belopp: ${line?.description ?? ''}`}
        fields={[
          { key: 'amount', label: 'Nytt belopp per månad (kr)', type: 'kronor', required: true, half: true },
          { key: 'validFrom', label: 'Gäller från', type: 'date', required: true, half: true },
          { key: 'reason', label: 'Orsak', placeholder: `Hyresförhandling ${thisYear + 1}` },
          ...(line?.indexed ? [{ key: 'newBase', label: 'Nytt belopp blir ny bashyra för indexuppräkning', type: 'checkbox' as const }] : []),
        ]}
        initial={line ? { amount: line.amountOre, validFrom: `${thisYear + 1}-01-01`, newBase: true } : null}
        onClose={onClose}
        submit={async (body) => {
          await post(`/lines/${line!.id}/change`, body);
          done();
        }}
      />
      <FormDialog
        open={kind === 'endLine'}
        title={`Avsluta: ${line?.description ?? ''}`}
        fields={[{ key: 'validTo', label: 'Sista dag', type: 'date', required: true }]}
        onClose={onClose}
        submit={async (body) => {
          await post(`/lines/${line!.id}/end`, body);
          done();
        }}
      />
      <FormDialog
        open={kind === 'index'}
        title="Indexklausul"
        fields={indexFields}
        initial={
          k.indexClause ?? {
            baseYear: Number(k.startDate.slice(0, 4)) - 1,
            baseMonth: 10,
            sharePct: 100,
            adjustMonth: 1,
            floorAtBase: true,
          }
        }
        onClose={onClose}
        submit={async (body) => {
          await api(`/contracts/${k.id}/index-clause`, {
            method: 'PUT',
            body: { ...body, baseMonth: Number(body.baseMonth), adjustMonth: Number(body.adjustMonth), baseValue: body.baseValue ?? undefined, sharePct: body.sharePct ?? 100 },
            ...opts,
          });
          done();
        }}
      />
      <FormDialog
        open={kind === 'runIndex'}
        title="Indexuppräkning av avtalet"
        fields={[{ key: 'year', label: 'År', type: 'number', required: true, hint: 'Indextillägget läggs som en egen rad från omräkningsdatumet.' }]}
        initial={{ year: thisYear + 1 }}
        onClose={onClose}
        submit={async (body) => {
          await post('/index', body);
          done();
        }}
        submitLabel="Räkna upp"
      />
      <FormDialog
        open={kind === 'addDeposit' || kind === 'editDeposit'}
        title={deposit ? 'Ändra säkerhet' : 'Ny säkerhet'}
        fields={depositFields}
        initial={deposit ? { ...deposit, amount: deposit.amountOre } : { kind: 'deposit' }}
        onClose={onClose}
        submit={async (body) => {
          if (deposit) await api(`/contracts/${k.id}/deposits/${deposit.id}`, { method: 'PATCH', body, ...opts });
          else await post('/deposits', body);
          done();
        }}
      />
      <FormDialog
        open={kind === 'note'}
        title="Anteckning"
        fields={[
          { key: 'description', label: 'Anteckning', type: 'textarea', required: true },
          { key: 'eventDate', label: 'Datum', type: 'date', hint: 'Tom = i dag' },
        ]}
        onClose={onClose}
        submit={async (body) => {
          await post('/events', body.eventDate ? body : { description: body.description });
          done();
        }}
      />
    </>
  );
}
