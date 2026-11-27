'use client';

import { FormEvent, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button, Dialog, ErrorNote, Field, Input, Select } from './ui';

export type FieldDef = {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'kronor' | 'date' | 'select' | 'checkbox' | 'textarea';
  options?: Record<string, string>;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  /** Halv bredd i tvåkolumnslayout */
  half?: boolean;
  /** Fyller i andra fält när ett val görs, t.ex. moms och text för en artikel */
  onSelect?: (value: string, values: Record<string, string | boolean>) => Record<string, string | boolean> | undefined;
};

type Values = Record<string, string | boolean>;

/** Gör om formulärvärden till API-format: tomt = null, tal som tal (kommatecken tillåtet). */
export function toBody(fields: FieldDef[], values: Values): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'checkbox') {
      body[f.key] = !!v;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (s === '') {
      body[f.key] = null;
    } else if (f.type === 'number' || f.type === 'kronor') {
      const n = Number(s.replace(/\s/g, '').replace(',', '.'));
      body[f.key] = Number.isFinite(n) ? n : s;
    } else {
      body[f.key] = s;
    }
  }
  return body;
}

/** Värden från API till formulär. Fält av typen kronor kommer som öre. */
export function fromRow(fields: FieldDef[], row: Record<string, unknown> | null | undefined): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = row?.[f.key];
    if (f.type === 'checkbox') out[f.key] = !!v;
    else if (v === null || v === undefined) out[f.key] = f.type === 'select' && f.required && f.options ? Object.keys(f.options)[0] : '';
    else if (f.type === 'kronor') out[f.key] = String(Number(v) / 100);
    else out[f.key] = String(v);
  }
  return out;
}

export function FormFields({
  fields,
  values,
  onChange,
  error,
  disabled,
}: {
  fields: FieldDef[];
  values: Values;
  onChange: (v: Values) => void;
  error?: ApiError | null;
  disabled?: boolean;
}) {
  const fe = (k: string) => error?.fields.find((f) => f.path === k)?.message;
  return (
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-x-4 gap-y-3.5">
      {fields.map((f) => (
        <div key={f.key} className={f.half ? '' : 'col-span-2'}>
          {f.type === 'checkbox' ? (
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={!!values[f.key]}
                onChange={(e) => onChange({ ...values, [f.key]: e.target.checked })}
                className="size-4 accent-[var(--color-accent)]"
              />
              {f.label}
              {f.hint && <span className="text-[12px] text-ink-3">{f.hint}</span>}
            </label>
          ) : (
            <Field label={f.label + (f.required ? '' : '')} error={fe(f.key)} hint={f.hint}>
              {f.type === 'select' ? (
                <Select
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => onChange({ ...values, ...f.onSelect?.(e.target.value, values), [f.key]: e.target.value })}
                >
                  {!f.required && <option value="">–</option>}
                  {Object.entries(f.options ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              ) : f.type === 'textarea' ? (
                <textarea
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
              ) : (
                <Input
                  type={f.type === 'date' ? 'date' : 'text'}
                  inputMode={f.type === 'number' || f.type === 'kronor' ? 'decimal' : undefined}
                  value={String(values[f.key] ?? '')}
                  placeholder={f.placeholder ?? (f.type === 'kronor' ? 'kr' : undefined)}
                  required={f.required}
                  onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
                />
              )}
            </Field>
          )}
        </div>
      ))}
    </fieldset>
  );
}

/** Dialog med formulär. submit får färdig body; fel från API visas vid rätt fält. */
export function FormDialog({
  open,
  title,
  fields,
  initial,
  onClose,
  submit,
  submitLabel = 'Spara',
}: {
  open: boolean;
  title: string;
  fields: FieldDef[];
  initial?: Record<string, unknown> | null;
  onClose: () => void;
  submit: (body: Record<string, unknown>) => Promise<unknown>;
  submitLabel?: string;
}) {
  const [values, setValues] = useState<Values>(() => fromRow(fields, initial));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setValues(fromRow(fields, initial));
      setError(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submit(toBody(fields, values));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} wide={fields.length > 6}>
      <form onSubmit={onSubmit} className="space-y-4">
        <FormFields fields={fields} values={values} onChange={setValues} error={error} />
        {error && !error.fields.length && <ErrorNote message={error.message} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
