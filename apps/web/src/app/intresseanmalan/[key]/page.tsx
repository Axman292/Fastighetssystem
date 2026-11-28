'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EMPTY_REGISTRATION, RegistrationFields, toRegistrationBody } from '@/components/interest';
import { ThemeToggle } from '@/components/theme';
import { Button, Card, ErrorNote, Logo } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface PublicForm {
  companyName: string;
  introText: string | null;
  consentText: string;
  objectTypes: string[];
  properties: { id: string; name: string; city: string | null }[];
}

/** Publikt formulär för intresseanmälan. Kräver ingen inloggning. */
export default function PublicInterestPage() {
  const { key } = useParams<{ key: string }>();
  const [form, setForm] = useState<PublicForm | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [v, setV] = useState(EMPTY_REGISTRATION);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<PublicForm>(`/public/interest/${encodeURIComponent(key)}`)
      .then(setForm)
      .catch((e: ApiError) => setLoadErr(e.message));
  }, [key]);

  return (
    <main className="relative min-h-screen bg-canvas px-4 py-10">
      <ThemeToggle className="absolute right-4 top-4 w-24" />
      <div className="mx-auto w-full max-w-[640px]">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold">{form?.companyName ?? 'Intresseanmälan'}</span>
        </div>
        {loadErr ? (
          <Card className="px-6 py-10 text-center text-[14px]">{loadErr}</Card>
        ) : !form ? null : done ? (
          <Card className="px-6 py-10 text-center">
            <h1 className="text-[18px] font-semibold">Tack för din anmälan</h1>
            <p className="mt-2 text-[13px] text-ink-2">Vi hör av oss när vi har något ledigt som passar dig.</p>
          </Card>
        ) : (
          <>
            <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Anmäl intresse</h1>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">
              {form.introText || `Anmäl dig till ${form.companyName}s intresselista, så kontaktar vi dig när något ledigt passar dina önskemål.`}
            </p>
            <Card className="mt-6 px-5 py-5">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setErr(null);
                  try {
                    await api(`/public/interest/${encodeURIComponent(key)}`, {
                      method: 'POST',
                      body: { ...toRegistrationBody(v, false), consent, website },
                    });
                    setDone(true);
                  } catch (e) {
                    setErr(e as ApiError);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RegistrationFields value={v} onChange={setV} error={err} properties={form.properties} objectTypes={form.objectTypes} internal={false} />
                {/* Fältet syns inte för människor och fångar robotar */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden
                  className="absolute -left-[9999px] h-0 w-0 opacity-0"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
                <label className="mt-5 flex items-start gap-2.5 rounded-md bg-subtle px-3 py-2.5 text-[12.5px] text-ink-2">
                  <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span className="whitespace-pre-wrap">{form.consentText}</span>
                </label>
                {err?.fields.find((f) => f.path === 'consent') && <div className="mt-1 text-[12px] text-bad">Du behöver godkänna att uppgifterna sparas</div>}
                <div className="mt-4">
                  <ErrorNote message={err && !err.fields.length ? err.message : null} />
                </div>
                <div className="mt-4 flex justify-end">
                  <Button disabled={busy || !consent}>Skicka anmälan</Button>
                </div>
              </form>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
