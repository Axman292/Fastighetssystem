'use client';

import { ObjectTable } from '@/components/object-table';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function ObjectsPage() {
  const { active } = useSession();
  return (
    <>
      <PageHeader
        title="Objekt"
        description={`Alla uthyrningsbara objekt${active ? ` i ${active.companyName}` : ' i koncernen'}. Nya objekt läggs till från fastighetens sida.`}
      />
      <ObjectTable />
    </>
  );
}
