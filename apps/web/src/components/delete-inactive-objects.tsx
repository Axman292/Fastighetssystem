'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Dialog, ErrorNote } from './ui';

interface Item {
  id: string;
  objectNr: string;
  propertyName: string;
  reasons?: string[];
}
interface Summary {
  deleted: Item[];
  skipped: Item[];
}

/**
 * Tar bort alla inaktiva objekt som saknar historik. Visar först vad som kommer
 * att tas bort och vad som hoppas över, och efteråt vad som faktiskt gjordes.
 */
export function DeleteInactiveObjects({ propertyId, onDone }: { propertyId?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Summary | null>(null);
  const [result, setResult] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (dryRun: boolean) =>
    api<Summary>('/objects/delete-inactive', {
      method: 'POST',
      body: { propertyId, dryRun },
    });

  async function start() {
    setOpen(true);
    setPreview(null);
    setResult(null);
    setError(null);
    try {
      setPreview(await run(true));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      setResult(await run(false));
      onDone();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = result ?? preview;
  return (
    <>
      <Button variant="danger" size="sm" onClick={start}>
        Ta bort inaktiva objekt
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={result ? 'Klart' : 'Ta bort inaktiva objekt'} wide>
        <ErrorNote message={error} />
        {!shown && !error && <div className="text-[13px] text-ink-3">Kontrollerar objekten…</div>}
        {shown && (
          <div className="space-y-4 text-[13px]">
            {shown.deleted.length === 0 && shown.skipped.length === 0 ? (
              <p className="text-ink-2">Det finns inga inaktiva objekt.</p>
            ) : (
              <>
                <List
                  title={
                    result
                      ? `${shown.deleted.length} objekt togs bort`
                      : shown.deleted.length
                        ? `${shown.deleted.length} objekt tas bort för gott`
                        : 'Inga objekt kan tas bort'
                  }
                  items={shown.deleted}
                />
                {shown.skipped.length > 0 && (
                  <List
                    title={`${shown.skipped.length} objekt ${result ? 'hoppades över' : 'hoppas över'} och finns kvar som inaktiva`}
                    hint="Objekt som har avtal, fakturor, kostnader eller dokument sparas för historikens och bokföringens skull."
                    items={shown.skipped}
                  />
                )}
              </>
            )}
            <div className="flex justify-end gap-2 pt-1">
              {result || !shown.deleted.length ? (
                <Button onClick={() => setOpen(false)}>Stäng</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => setOpen(false)}>
                    Avbryt
                  </Button>
                  <Button variant="danger" onClick={confirm} disabled={busy}>
                    {busy ? 'Tar bort…' : `Ta bort ${shown.deleted.length} objekt`}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function List({ title, hint, items }: { title: string; hint?: string; items: Item[] }) {
  return (
    <section>
      <h3 className="font-semibold">{title}</h3>
      {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
      {items.length > 0 && (
        <ul className="mt-2 max-h-60 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3 px-3 py-1.5">
              <span>
                <span className="font-medium">{i.objectNr}</span> <span className="text-ink-3">{i.propertyName}</span>
              </span>
              {i.reasons && <span className="text-right text-ink-2">{i.reasons.join(', ')}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
