'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, PageHeader } from '@/components/ui';
import { api, Company } from '@/lib/api';
import { fmtOre } from '@/lib/format';
import { useSession } from '@/lib/session';

/**
 * Startsidan. I fas 1 visar den bolagen; nyckeltal för fastigheter,
 * uthyrning och ekonomi fylls på i takt med att modulerna byggs.
 */
export default function OverviewPage() {
  const { me, active, version } = useSession();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [properties, setProperties] = useState<{ objectCount: number; monthlyRentOre: number }[] | null>(null);

  useEffect(() => {
    api<Company[]>('/companies').then(setCompanies);
    api<{ objectCount: number; monthlyRentOre: number }[]>('/properties').then(setProperties);
  }, [version]);

  const scope = active ? active.companyName : 'Hela koncernen';

  return (
    <>
      <PageHeader title={`God ${greeting()}, ${me.user.name.split(' ')[0]}`} description={`Visar ${scope}.`} />
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Bolag" value={companies?.length} />
        <Stat label="Fastigheter" value={properties?.length} />
        <Stat label="Uthyrningsbara objekt" value={properties?.reduce((s, p) => s + p.objectCount, 0)} />
        <Stat label="Hyresvärde per år" text={properties ? fmtOre(properties.reduce((s, p) => s + p.monthlyRentOre, 0) * 12) : undefined} />
        <Stat label="Uthyrningsgrad" pending="Fas 3" />
        <Stat label="Aviserat denna månad" pending="Fas 4" />
        <Stat label="Obetalda fakturor" pending="Fas 5" />
        <Stat label="Driftnetto" pending="Fas 6" />
      </div>

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

function Stat({ label, value, text, pending }: { label: string; value?: number; text?: string; pending?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      {pending ? (
        <div className="mt-1.5 text-[13px] text-ink-3">Kommer i {pending.toLowerCase()}</div>
      ) : (
        <div className="mt-1 text-[22px] font-semibold tabular tracking-[-0.01em]">{text ?? value ?? '–'}</div>
      )}
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 10 ? 'morgon' : h < 18 ? 'dag' : 'kväll';
}
