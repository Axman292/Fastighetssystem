'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { OBJECT_STATUS, OBJECT_TYPE_LABEL, fmtInt, fmtM2, fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Input, Select, Table, Td } from './ui';

export interface ObjectRow {
  id: string;
  companyId: string;
  companyName: string;
  propertyId: string;
  propertyName: string;
  designation: string;
  objectNr: string;
  type: string;
  areaM2: number | null;
  rooms: number | null;
  floor: number | null;
  apartmentNr: string | null;
  addressLine: string | null;
  active: boolean;
  monthlyRentOre: number | null;
  vatLiable: boolean | null;
  status: string | null;
  currentContractId: string | null;
  currentUntil: string | null;
  nextContractId: string | null;
  nextFrom: string | null;
  tenantName: string | null;
}

/** Objektregister med filter på typ, status och fritext. Status räknas fram ur avtalen. */
export function ObjectTable({ propertyId, version = 0, hideProperty }: { propertyId?: string; version?: number; hideProperty?: boolean }) {
  const { version: sessionVersion } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<ObjectRow[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (propertyId) params.set('propertyId', propertyId);
    if (type) params.set('type', type);
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    const t = setTimeout(() => api<ObjectRow[]>(`/objects?${params}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [propertyId, type, status, q, version, sessionVersion]);

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Input className="max-w-xs" placeholder="Sök objektsnummer, adress eller fastighet" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="max-w-44" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Alla typer</option>
          {Object.entries(OBJECT_TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select className="max-w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Alla statusar</option>
          {Object.entries(OBJECT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <div className="ml-auto self-center text-[12px] text-ink-3">{rows.length} objekt</div>
      </div>
      <Table
        head={['Objekt', ...(hideProperty ? [] : ['Fastighet']), 'Typ', 'Area', 'Månadshyra', 'Kr/m² och år', 'Moms', 'Status']}
        empty="Inga objekt matchar."
      >
        {rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/objekt/${r.id}`)}>
            <Td className="font-medium">
              <Link href={`/objekt/${r.id}`}>{r.objectNr}</Link>
              {r.addressLine && <div className="text-[12px] font-normal text-ink-3">{r.addressLine}</div>}
            </Td>
            {!hideProperty && <Td className="text-ink-2">{r.propertyName}</Td>}
            <Td>
              {OBJECT_TYPE_LABEL[r.type]}
              {!r.active && (
                <span className="ml-2">
                  <Badge>Inaktivt</Badge>
                </span>
              )}
            </Td>
            <Td className="tabular">{fmtM2(r.areaM2)}</Td>
            <Td className="tabular">{fmtOre(r.monthlyRentOre)}</Td>
            <Td className="tabular text-ink-2">{r.areaM2 && r.monthlyRentOre ? fmtInt((r.monthlyRentOre * 12) / 100 / r.areaM2) : '–'}</Td>
            <Td>{r.vatLiable ? <Badge tone="accent">25 %</Badge> : <span className="text-[12px] text-ink-3">Momsfri</span>}</Td>
            <Td>
              <StatusCell row={r} />
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export function StatusCell({ row }: { row: Pick<ObjectRow, 'status' | 'tenantName' | 'currentUntil' | 'nextFrom'> }) {
  const s = OBJECT_STATUS[row.status ?? 'vacant'];
  const sub =
    row.status === 'notice'
      ? `till ${row.currentUntil}`
      : row.status === 'upcoming'
        ? `från ${row.nextFrom}`
        : row.status === 'occupied'
          ? row.tenantName
          : null;
  return (
    <div className="leading-tight">
      <Badge tone={s.tone}>{s.label}</Badge>
      {sub && <div className="mt-0.5 max-w-40 truncate text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}
