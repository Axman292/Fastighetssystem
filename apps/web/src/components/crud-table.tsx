'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { FieldDef, FormDialog } from './form';
import { Button, Table, Td } from './ui';

export type Column<T> = { label: string; render: (row: T) => ReactNode; className?: string };

/**
 * Tabell med lägg till, ändra och ta bort för ett underregister,
 * t.ex. /properties/:id/loans. companyId skickas som bolagskontext.
 */
export function CrudTable<T extends { id: string }>({
  path,
  companyId,
  title,
  description,
  columns,
  fields,
  editable,
  empty,
  onChange,
}: {
  path: string;
  companyId: string;
  title: string;
  description?: string;
  columns: Column<T>[];
  fields: FieldDef[];
  editable: boolean;
  empty: string;
  onChange?: () => void;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [editing, setEditing] = useState<T | 'new' | null>(null);

  const load = useCallback(() => {
    api<T[]>(path, { companyId }).then(setRows);
  }, [path, companyId]);
  useEffect(load, [load]);

  const done = () => {
    setEditing(null);
    load();
    onChange?.();
  };

  return (
    <section>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {description && <p className="text-[12px] text-ink-3">{description}</p>}
        </div>
        {editable && (
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
            Lägg till
          </Button>
        )}
      </div>
      <Table head={[...columns.map((c) => c.label), '']} empty={empty}>
        {rows.map((r) => (
          <tr key={r.id} className={editable ? 'cursor-pointer hover:bg-subtle/60' : ''} onClick={() => editable && setEditing(r)}>
            {columns.map((c) => (
              <Td key={c.label} className={c.className}>
                {c.render(r)}
              </Td>
            ))}
            <Td className="w-24 text-right">
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm('Ta bort raden?')) return;
                    await api(`${path}/${r.id}`, { method: 'DELETE', companyId });
                    done();
                  }}
                >
                  Ta bort
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <FormDialog
        open={editing !== null}
        title={editing === 'new' ? `${title}: lägg till` : `${title}: ändra`}
        fields={fields}
        initial={editing === 'new' ? null : (editing as unknown as Record<string, unknown>)}
        onClose={() => setEditing(null)}
        submit={async (body) => {
          if (editing === 'new') await api(path, { method: 'POST', body, companyId });
          else if (editing) await api(`${path}/${editing.id}`, { method: 'PATCH', body, companyId });
          done();
        }}
      />
    </section>
  );
}
