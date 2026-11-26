'use client';

import { FormEvent, useState } from 'react';
import { Button, ErrorNote, Field, Input, Logo } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kunde inte logga in');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold">Fastighetssystem</span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Logga in</h1>
        <p className="mt-1 text-[13px] text-ink-2">Använd ditt e-postkonto. Inloggning med BankID kommer senare.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="E-post">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Lösenord">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Loggar in…' : 'Logga in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
