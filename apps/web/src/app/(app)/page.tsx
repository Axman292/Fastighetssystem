'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Card, PageHeader } from '@/components/ui';
import { api, Company } from '@/lib/api';
import { fmtOre, fmtPct } from '@/lib/format';
import { useSession } from '@/lib/session';

/**
 * Startsidan: nyckeltal för fastigheter och uthyrning, avtal att hantera och bolagen.
 * Ekonominyckeltal fylls på när avisering och reskontra byggs.
 */
export default function OverviewPage() {
  const { me, active, version } = useSession();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [properties, setProperties] = useState<PropertyStats[] | null>(null);
  const [attention, setAttention] = useState<Attention[] | null>(null);

  useEffect(() => {
    api<Company[]>('/companies').then(setCompanies);
    api<PropertyStats[]>('/properties').then(setProperties);
    api<Attention[]>('/contracts/attention').then(setAttention);
  }, [version]);

  const objects = properties?.reduce((s, p) => s + p.objectCount, 0) ?? 0;
  const occupied = properties?.reduce((s, p) => s + p.occupiedCount, 0) ?? 0;
  const vacantRent = properties?.reduce((s, p) => s + p.vacantRentOre, 0) ?? 0;

  const scope = active ? active.companyName : 'Hela koncernen';

  return (
    <>
      <PageHeader title={`God ${greeting()}, ${me.user.name.split(' ')[0]}`} description={`Visar ${scope}.`} />
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Bolag" value={companies?.length} />
        <Stat label="Fastigheter" value={properties?.length} />
        <Stat label="Uthyrningsbara objekt" value={properties ? objects : undefined} />
        <Stat label="Hyresvärde per år" text={properties ? fmtOre(properties.reduce((s, p) => s + p.monthlyRentOre, 0) * 12) : undefined} />
        <Stat label="Uthyrningsgrad" text={properties ? (objects ? fmtPct(occupied / objects) : '–') : undefined} sub={properties ? `${occupied} av ${objects} objekt` : undefined} />
        <Stat label="Vakanser per år" text={properties ? fmtOre(vacantRent * 12) : undefined} sub="listhyra för lediga objekt" />
        <Stat label="Aviserat denna månad" pending="Fas 4" />
        <Stat label="Obetalda fakturor" pending="Fas 5" />
      </div>

      <div className="mb-3 mt-10 flex items-end justify-between">
        <h2 className="text-[14px] font-semibold">Avtal att hantera</h2>
        <Link href="/avtal" className="text-[12px] text-accent hover:underline">
          Alla avtal
        </Link>
      </div>
      <Card className="divide-y divide-line">
        {attention?.slice(0, 6).map((a, i) => (
          <Link key={i} href={`/avtal/${a.contractId}`} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/60">
            <Badge tone={a.severity === 'high' ? 'warn' : 'neutral'}>{a.date}</Badge>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{a.customerName}</div>
              <div className="truncate text-[12px] text-ink-2">{a.message}</div>
            </div>
            <div className="text-[12px] text-ink-3">{a.objects}</div>
          </Link>
        ))}
        {attention && attention.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-ink-3">Inget att hantera just nu.</div>}
      </Card>

      <h2 className="mb-3 mt-10 text-[14px] font-semibold">Bolag</h2>
      <Card className="divide-y divide-line">
        {companies?.map((c) => (
          <Link key={c.id} href={`/bolag/${c.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-subtle/60">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{c.name}</div>
              <div className="text-[12px] text-ink-3 tabular">{c.orgNr}</div>
            </div>
            <div className="text-[12px] text-ink-3">{c.city ?? ''}</div>
          </Link>
        ))}
      </Card>
    </>
  );
}

interface PropertyStats {
  objectCount: number;
  monthlyRentOre: number;
  occupiedCount: number;
  vacantRentOre: number;
}

interface Attention {
  contractId: string;
  date: string;
  severity: 'high' | 'normal';
  message: string;
  customerName: string;
  objects: string;
}

function Stat({ label, value, text, pending, sub }: { label: string; value?: number; text?: string; pending?: string; sub?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      {pending ? (
        <div className="mt-1.5 text-[13px] text-ink-3">Kommer i {pending.toLowerCase()}</div>
      ) : (
        <div className="mt-1 text-[22px] font-semibold tabular tracking-[-0.01em]">{text ?? value ?? '–'}</div>
      )}
      {sub && <div className="mt-0.5 text-[12px] text-ink-3">{sub}</div>}
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 10 ? 'morgon' : h < 18 ? 'dag' : 'kväll';
}
