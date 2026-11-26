'use client';

import { ReactNode, useState } from 'react';
import { ApiError } from '@/lib/api';
import { FieldDef, FormFields, fromRow, toBody } from './form';
import { Button, Card, ErrorNote } from './ui';

/** Formulär i ett kort som sparas på plats. Används för uppgifter på detaljsidor. */
export function EditForm({
  fields,
  row,
  editable,
  save,
  extraActions,
}: {
  fields: FieldDef[];
  row: Record<string, unknown>;
  editable: boolean;
  save: (body: Record<string, unknown>) => Promise<unknown>;
  extraActions?: ReactNode;
}) {
  const [values, setValues] = useState(() => fromRow(fields, row));
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-5">
      <FormFields
        fields={fields}
        values={values}
        onChange={(v) => {
          setSaved(false);
          setValues(v);
        }}
        error={error}
        disabled={!editable}
      />
      {editable && (
        <div className="mt-5 flex items-center justify-between gap-3">
          <div>{extraActions}</div>
          <div className="flex items-center gap-3">
            {saved && <span className="text-[12px] text-good">Sparat</span>}
            {error && !error.fields.length && <ErrorNote message={error.message} />}
            <Button
              disabled={busy}
              onClick={async () => {
                setError(null);
                setBusy(true);
                try {
                  await save(toBody(fields, values));
                  setSaved(true);
                } catch (e) {
                  setError(e as ApiError);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Spara
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Rubrik för en sektion på en detaljsida. */
export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {description && <p className="text-[12px] text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
