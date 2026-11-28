'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface TokenInfo {
  valid: boolean;
  purpose?: 'invite' | 'password_reset';
  email?: string;
  name?: string;
}

/** Välj lösenord från en inbjudan eller en länk för nytt lösenord. */
export default function SetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    setToken(t);
    if (!t) {
      setInfo({ valid: false });
      return;
    }
    api<TokenInfo>(`/auth/token/${encodeURIComponent(t)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeat) {
      setError('Lösenorden är inte likadana');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/set', { method: 'POST', body: { token, password } });
      window.location.href = '/login?losenord=1';
    } catch (err) {
      setError(err instanceof ApiError ? err.fields[0]?.message ?? err.message : 'Något gick fel');
      setBusy(false);
    }
  }

  if (!info) return <AuthFrame title="Laddar…">{null}</AuthFrame>;

  if (!info.valid) {
    return (
      <AuthFrame title="Länken fungerar inte" subtitle="Den har redan använts eller gått ut.">
        <p className="text-[13px] text-ink-2">
          Be om en ny länk via <Link href="/glomt-losenord" className="text-accent hover:underline">Glömt lösenordet</Link>, eller be
          administratören skicka en ny inbjudan.
        </p>
      </AuthFrame>
    );
  }

  const invite = info.purpose === 'invite';
  return (
    <AuthFrame
      title={invite ? `Välkommen, ${info.name}` : 'Välj nytt lösenord'}
      subtitle={invite ? `Välj ett lösenord för ${info.email}.` : `För kontot ${info.email}.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <input type="email" autoComplete="username" value={info.email} readOnly hidden />
        <Field label="Nytt lösenord" hint="Minst 12 tecken. En mening med några ord är lätt att komma ihåg och svår att gissa.">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </Field>
        <Field label="Upprepa lösenordet">
          <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
        <ErrorNote message={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Sparar…' : 'Spara lösenord'}
        </Button>
      </form>
    </AuthFrame>
  );
}
