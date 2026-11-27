'use client';

import { useState } from 'react';
import { DeleteInactiveObjects } from '@/components/delete-inactive-objects';
import { ObjectTable } from '@/components/object-table';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function ObjectsPage() {
  const { active, me, can } = useSession();
  const [version, setVersion] = useState(0);
  // I koncernvyn räcker det att få ändra i något bolag; borttagningen görs bara där.
  const writable = active ? can('property.write') : me.companies.some((c) => c.permissions.includes('property.write'));
  return (
    <>
      <PageHeader
        title="Objekt"
        description={`Alla uthyrningsbara objekt${active ? ` i ${active.companyName}` : ' i koncernen'}. Nya objekt läggs till från fastighetens sida.`}
        actions={writable ? <DeleteInactiveObjects onDone={() => setVersion((v) => v + 1)} /> : undefined}
      />
      <ObjectTable version={version} />
    </>
  );
}
