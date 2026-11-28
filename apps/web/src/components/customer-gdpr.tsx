'use client';

import { useState } from 'react';
import { Button, Dialog, ErrorNote } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Status {
  anonymizedAt: string | null;
  accountingPurgedAt: string | null;
  canAnonymize: boolean;
  blockers: string[];
  mode: 'full' | 'contacts' | null;
}

/** Registerutdrag och anonymisering på begäran för en kund. */
export function CustomerGdprActions({ customerId, companyId, anonymizedAt, onChange }: { customerId: string; companyId: string; anonymizedAt: string | null; onChange: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      {can('gdpr.extract', companyId) && (
        <a href={`/api/gdpr/customers/${customerId}/extract.pdf`} target="_blank" rel="noreferrer">
          <Button variant="secondary">Registerutdrag</Button>
        </a>
      )}
      {!anonymizedAt && can('gdpr.manage', companyId) && (
        <Button
          variant="ghost"
          onClick={async () => {
            setError(null);
            setStatus(null);
            setOpen(true);
            try {
              setStatus(await api<Status>(`/gdpr/customers/${customerId}/status`));
            } catch (e) {
              setError((e as ApiError).message);
            }
          }}
        >
          Anonymisera
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Anonymisera hyresgästen">
        <div className="space-y-3 text-[13px]">
          <ErrorNote message={error} />
          {status && !status.canAnonymize && (
            <>
              <p>Hyresgästen kan inte anonymiseras än:</p>
              <ul className="list-disc pl-5 text-warn">
                {(status.blockers.length ? status.blockers : ['Har ett gällande avtal']).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <div className="flex justify-end pt-2">
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Stäng
                </Button>
              </div>
            </>
          )}
          {status?.canAnonymize && (
            <>
              <p>
                Använd det här när en tidigare hyresgäst begär att bli raderad. {status.mode === 'contacts'
                  ? 'Kontaktpersoner och anteckningar tas bort. Företagsnamn och organisationsnummer behålls.'
                  : 'Namn, personnummer, kontaktuppgifter, adresser, anteckningar, kontaktpersoner och dokument tas bort, även ur revisionsloggen.'}
              </p>
              <p className="text-ink-2">
                Fakturor och betalningar behåller mottagarens namn och adress så länge bokföringslagen kräver det. Ta gärna ut ett registerutdrag först om hyresgästen vill ha ett.
              </p>
              <p className="text-bad">Det här går inte att ångra.</p>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Avbryt
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/gdpr/customers/${customerId}/anonymize`, { method: 'POST' });
                      setOpen(false);
                      onChange();
                    } catch (e) {
                      setError((e as ApiError).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Anonymiserar …' : 'Anonymisera'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
