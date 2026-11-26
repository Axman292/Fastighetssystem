'use client';

import { useEffect, useState } from 'react';
import { FormDialog } from '@/components/form';
import { Badge, Button, Input, PageHeader, Select, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { REPORT_GROUP_LABEL } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Account } from '@/lib/suppliers';

const SOURCE_LABEL: Record<string, string> = { local: 'BAS', hogia: 'Hogia', import: 'Import' };

export default function AccountsPage() {
  const { active, can, version } = useSession();
  const [rows, setRows] = useState<Account[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Account[]>('/accounts').then(setRows);
  useEffect(() => {
    load();
  }, [version]);

  const editable = can('account.write');
  const shown = rows?.filter((a) => !q.trim() || a.number.startsWith(q.trim()) || a.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Kontoplan"
        description={
          active
            ? `BAS-konton för ${active.companyName}. Rapportgruppen styr var kontot hamnar i fastigheternas resultaträkning.`
            : 'Kontoplaner i hela koncernen. Välj ett bolag för att ändra.'
        }
        actions={editable && <Button onClick={() => setCreating(true)}>Nytt konto</Button>}
      />
      <div className="mb-3 flex gap-2">
        <Input className="max-w-xs" placeholder="Sök kontonummer eller namn" value={q} onChange={(e) => setQ(e.target.value)} />
        {error && <span className="self-center text-[12px] text-bad">{error}</span>}
      </div>
      <Table head={['Konto', 'Namn', ...(active ? [] : ['Bolag']), 'Rapportgrupp', 'Källa', 'Används']} empty={rows ? 'Inga konton.' : 'Laddar…'}>
        {shown?.map((a) => (
          <tr key={a.id} className={a.active ? '' : 'opacity-60'}>
            <Td className="tabular font-medium">{a.number}</Td>
            <Td>
              {a.name}
              {!a.active && (
                <span className="ml-2">
                  <Badge>Inaktivt</Badge>
                </span>
              )}
            </Td>
            {!active && <Td className="text-ink-2">{a.companyName}</Td>}
            <Td className="w-80">
              {editable ? (
                <Select
                  aria-label={`Rapportgrupp för ${a.number}`}
                  value={a.reportGroupOverride ?? ''}
                  onChange={async (e) => {
                    setError(null);
                    try {
                      await api(`/accounts/${a.id}`, { method: 'PATCH', body: { reportGroup: e.target.value || null } });
                      load();
                    } catch (err) {
                      setError((err as ApiError).message);
                    }
                  }}
                >
                  <option value="">{REPORT_GROUP_LABEL[a.defaultReportGroup]} (standard)</option>
                  {Object.entries(REPORT_GROUP_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-ink-2">{a.reportGroupLabel}</span>
              )}
            </Td>
            <Td className="text-ink-3">{SOURCE_LABEL[a.source] ?? a.source}</Td>
            <Td className="tabular text-ink-3">{a.lineCount ? `${a.lineCount} rader` : '–'}</Td>
          </tr>
        ))}
      </Table>
      <FormDialog
        open={creating}
        title="Nytt konto"
        fields={[
          { key: 'number', label: 'Kontonummer', required: true, half: true, placeholder: '5150' },
          { key: 'name', label: 'Namn', required: true, half: true },
          { key: 'reportGroup', label: 'Rapportgrupp', type: 'select', options: REPORT_GROUP_LABEL, hint: 'Tomt = enligt kontonumret' },
        ]}
        onClose={() => setCreating(false)}
        submit={async (body) => {
          await api('/accounts', { method: 'POST', body });
          setCreating(false);
          load();
        }}
        submitLabel="Lägg till"
      />
    </>
  );
}

