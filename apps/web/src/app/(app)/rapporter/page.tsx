'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, ErrorNote, PageHeader } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { ReportInfo } from '@/lib/reports';

export default function ReportsPage() {
  const [list, setList] = useState<ReportInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ReportInfo[]>('/reports')
      .then(setList)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  return (
    <>
      <PageHeader title="Rapporter" description="Välj en rapport. Alla rapporter kan filtreras på bolag, fastighet och period och hämtas som Excel eller PDF." />
      <ErrorNote message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list?.map((r) => (
          <Link key={r.key} href={`/rapporter/${r.key}`} className="group">
            <Card className="h-full px-4 py-3.5 transition-colors group-hover:bg-subtle">
              <div className="text-[14px] font-semibold text-ink">{r.title}</div>
              <p className="mt-1 text-[13px] text-ink-2">{r.description}</p>
              <div className="mt-2 text-[12px] text-ink-3">{r.mode === 'date' ? 'Per ett datum' : 'För en period'}</div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
