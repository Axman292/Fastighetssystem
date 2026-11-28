'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Något gick fel');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Glömt lösenordet" subtitle="Vi skickar en länk där du väljer ett nytt lösenord.">
      {sent ? (
        <div className="space-y-4">
          <div className="rounded-md bg-good-soft px-3 py-2 text-[13px] text-good">
            Om det finns ett konto för {email} har vi skickat en länk dit. Den gäller i 1 timme. Titta även i skräpposten.
          </div>
          <Link href="/login" className="text-[13px] text-accent hover:underline">
            Tillbaka till inloggningen
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-post">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Skickar…' : 'Skicka länk'}
          </Button>
          <Link href="/login" className="block text-[13px] text-ink-3 hover:text-ink">
            Tillbaka till inloggningen
          </Link>
        </form>
      )}
    </AuthFrame>
  );
}
