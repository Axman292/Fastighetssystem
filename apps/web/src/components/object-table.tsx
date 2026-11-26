'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { OBJECT_TYPE_LABEL, fmtInt, fmtM2, fmtNum, fmtOre } from '@/lib/format';
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
}

/** Objektregister med filter på typ och fritext. Status (uthyrd/ledig) kommer med avtalen i fas 3. */
export function ObjectTable({ propertyId, version = 0, hideProperty }: { propertyId?: string; version?: number; hideProperty?: boolean }) {
  const { version: sessionVersion } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<ObjectRow[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (propertyId) params.set('propertyId', propertyId);
    if (type) params.set('type', type);
    if (q.trim()) params.set('q', q.trim());
    const t = setTimeout(() => api<ObjectRow[]>(`/objects?${params}`).then(setRows), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [propertyId, type, q, version, sessionVersion]);

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
        <div className="ml-auto self-center text-[12px] text-ink-3">{rows.length} objekt</div>
      </div>
      <Table
        head={['Objekt', ...(hideProperty ? [] : ['Fastighet']), 'Typ', 'Area', 'Rum', 'Månadshyra', 'Kr/m² och år', 'Moms']}
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
            <Td className="tabular">{fmtNum(r.rooms)}</Td>
            <Td className="tabular">{fmtOre(r.monthlyRentOre)}</Td>
            <Td className="tabular text-ink-2">{r.areaM2 && r.monthlyRentOre ? fmtInt((r.monthlyRentOre * 12) / 100 / r.areaM2) : '–'}</Td>
            <Td>{r.vatLiable ? <Badge tone="accent">25 %</Badge> : <span className="text-[12px] text-ink-3">Momsfri</span>}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
