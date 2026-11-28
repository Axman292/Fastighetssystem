'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { AuthFrame } from '@/components/auth-frame';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('utloggad')) setNotice('Du har loggats ut. Logga in igen för att fortsätta.');
    if (q.get('losenord')) setNotice('Ditt lösenord är sparat. Logga in med det nya lösenordet.');
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ok: boolean; mfaRequired?: boolean; ticket?: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (r.mfaRequired && r.ticket) {
        setTicket(r.ticket);
        setNotice(null);
        setBusy(false);
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kunde inte logga in');
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login/mfa', { method: 'POST', body: { ticket, code } });
      window.location.href = '/';
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Kunde inte logga in';
      setError(msg);
      setBusy(false);
      if (msg.includes('gått ut')) {
        setTicket(null);
        setCode('');
      }
    }
  }

  if (ticket) {
    return (
      <AuthFrame title="Tvåstegsverifiering" subtitle={useRecovery ? 'Skriv en av dina reservkoder.' : 'Öppna autentiseringsappen i telefonen och skriv den sexsiffriga koden.'}>
        <form onSubmit={submitCode} className="space-y-4">
          <Field label={useRecovery ? 'Reservkod' : 'Engångskod'}>
            <Input
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={useRecovery ? 'abcd-efgh' : '123 456'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              className="text-center text-[16px] tracking-[0.2em]"
            />
          </Field>
          <ErrorNote message={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Kontrollerar…' : 'Logga in'}
          </Button>
        </form>
        <div className="mt-4 flex justify-between text-[13px]">
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? 'Använd kod från appen' : 'Har du inte telefonen? Använd reservkod'}
          </button>
          <button
            type="button"
            className="text-ink-3 hover:text-ink"
            onClick={() => {
              setTicket(null);
              setCode('');
              setError(null);
            }}
          >
            Avbryt
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Logga in" subtitle="Använd ditt e-postkonto.">
      {notice && <div className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent">{notice}</div>}
      <form onSubmit={submit} className="space-y-4">
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
      <div className="mt-4 text-[13px]">
        <Link href="/glomt-losenord" className="text-accent hover:underline">
          Glömt lösenordet?
        </Link>
      </div>
    </AuthFrame>
  );
}
