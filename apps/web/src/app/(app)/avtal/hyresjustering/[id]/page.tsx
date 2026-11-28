'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, ErrorNote, PageHeader, Stat, Table, Td, formatDateTime } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { CONTRACT_TYPE_LABEL, OBJECT_TYPE_LABEL, fmtOre, formatDate } from '@/lib/format';
import { changeLabel, RentAdjustment } from '@/lib/rent-adjustments';
import { useSession } from '@/lib/session';

interface Item {
  id: string;
  kind: 'line' | 'object';
  contractId: string | null;
  contractNr: number | null;
  customerName: string | null;
  objectId: string | null;
  objectNr: string | null;
  objectType: string | null;
  propertyName: string | null;
  description: string;
  oldOre: number;
  newOre: number;
}

interface Detail extends RentAdjustment {
  rounding: string;
  reason: string | null;
  criteria: { objectTypes?: string[]; contractTypes?: string[]; articles?: string[]; includeIndexed?: boolean; updateObjectRent?: boolean };
  revertedByName: string | null;
  canRevert: boolean;
  revertBlocker: string | null;
  items: Item[];
}

const ROUNDING: Record<string, string> = { none: 'ingen avrundning', krona: 'avrundat till hel krona', ten: 'avrundat till tiotal kronor' };

export default function RentAdjustmentPage() {
  const { id } = useParams<{ id: string }>();
  const { active, can, version } = useSession();
  const [a, setA] = useState<Detail | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Detail>(`/rent-adjustments/${id}`).then(setA);
  }, [id]);
  useEffect(load, [load, version]);

  if (!a) return <div className="text-[13px] text-ink-3">Hämtar…</div>;
  const lines = a.items.filter((i) => i.kind === 'line');
  const objects = a.items.filter((i) => i.kind === 'object');
  const diff = a.afterOre - a.beforeOre;

  return (
    <>
      <div className="mb-2 text-[12px] text-ink-3">
        <Link href="/avtal" className="hover:text-ink">
          Avtal
        </Link>{' '}
        /{' '}
        <Link href="/avtal/hyresjustering" className="hover:text-ink">
          Hyresjustering
        </Link>{' '}
        / {a.adjustmentNr}
      </div>
      <PageHeader
        title={a.name}
        description={`${changeLabel(a)} från ${formatDate(a.effectiveDate)}, ${ROUNDING[a.rounding] ?? ''}. ${a.companyName}.`}
        actions={
          a.status === 'applied' &&
          active?.companyId === a.companyId &&
          can('contract.write') && (
            <Button variant="danger" onClick={() => setConfirm(true)} disabled={!a.canRevert} title={a.revertBlocker ?? undefined}>
              Ångra justeringen
            </Button>
          )
        }
      />
      {a.status === 'reverted' && (
        <div className="mb-4 rounded-md bg-subtle px-3 py-2 text-[13px] text-ink-2">
          Justeringen ångrades {a.revertedAt && formatDateTime(a.revertedAt)}
          {a.revertedByName && ` av ${a.revertedByName}`}. Den tidigare hyran gäller igen.
        </div>
      )}
      {a.status === 'applied' && !a.canRevert && a.revertBlocker && (
        <div className="mb-4 rounded-md bg-subtle px-3 py-2 text-[13px] text-ink-2">Kan inte ångras: {a.revertBlocker}</div>
      )}
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Status" value={a.status === 'applied' ? <Badge tone="good">Genomförd</Badge> : <Badge>Ångrad</Badge>} />
        <Stat label="Avtalsrader" value={a.lineCount} sub={`${new Set(lines.map((l) => l.contractId)).size} avtal`} />
        <Stat label="Objektens hyra" value={a.objectCount} sub="objekt fick ny hyra" />
        <Stat label="Ökning av avtalens hyra" value={fmtOre(diff)} sub={`per månad, ${fmtOre(diff * 12)} per år`} />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-x-8 gap-y-1 text-[13px]">
        <Info label="Objekttyper" value={list(a.criteria.objectTypes, OBJECT_TYPE_LABEL) ?? 'Alla'} />
        <Info label="Avtalstyper" value={list(a.criteria.contractTypes, CONTRACT_TYPE_LABEL) ?? 'Alla'} />
        <Info label="Avtal med indexklausul" value={a.criteria.includeIndexed ? 'Togs med' : 'Hoppades över'} />
        <Info label="Gjord" value={`${formatDateTime(a.createdAt)}${a.createdByName ? ` av ${a.createdByName}` : ''}`} />
        {a.reason && <Info label="Anledning" value={a.reason} />}
      </div>

      <h2 className="mb-2 text-[14px] font-semibold">Avtal</h2>
      <Table head={['Objekt', 'Avtal', 'Hyresgäst', 'Rad', 'Före', 'Efter']} empty="Inga avtalsrader ändrades.">
        {lines.map((i) => (
          <tr key={i.id}>
            <Td>
              <span className="font-medium">{i.objectNr}</span> <span className="text-ink-3">{i.propertyName}</span>
            </Td>
            <Td className="tabular">{i.contractId ? <Link href={`/avtal/${i.contractId}`}>{i.contractNr}</Link> : '–'}</Td>
            <Td>{i.customerName}</Td>
            <Td className="text-ink-2">{i.description}</Td>
            <Td className="tabular text-ink-2">{fmtOre(i.oldOre, true)}</Td>
            <Td className="tabular font-medium">{fmtOre(i.newOre, true)}</Td>
          </tr>
        ))}
      </Table>

      {objects.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-[14px] font-semibold">Objektens hyra</h2>
          <Table head={['Objekt', 'Typ', 'Före', 'Efter']}>
            {objects.map((i) => (
              <tr key={i.id}>
                <Td>
                  <Link href={`/objekt/${i.objectId}`} className="font-medium">
                    {i.objectNr}
                  </Link>{' '}
                  <span className="text-ink-3">{i.propertyName}</span>
                </Td>
                <Td className="text-ink-2">{i.objectType ? OBJECT_TYPE_LABEL[i.objectType] : ''}</Td>
                <Td className="tabular text-ink-2">{fmtOre(i.oldOre, true)}</Td>
                <Td className="tabular font-medium">{fmtOre(i.newOre, true)}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Ångra hyresjusteringen">
        <div className="space-y-4 text-[13px]">
          <p className="text-ink-2">
            De nya hyresraderna tas bort och den tidigare hyran gäller igen för {a.lineCount} avtalsrader och {a.objectCount} objekt. Ångringen
            noteras i avtalens historik.
          </p>
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Avbryt
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api(`/rent-adjustments/${a.id}/revert`, { method: 'POST' });
                  setConfirm(false);
                  load();
                } catch (e) {
                  setError((e as ApiError).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Ångrar…' : 'Ångra justeringen'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-44 shrink-0 text-ink-3">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

function list(values: string[] | undefined, labels: Record<string, string>): string | null {
  return values?.length ? values.map((v) => labels[v] ?? v).join(', ') : null;
}
