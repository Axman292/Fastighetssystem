'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RegistrationDialog } from '@/components/interest';
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Table, Tabs, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { OBJECT_TYPE_LABEL } from '@/lib/format';
import { useSession } from '@/lib/session';
import { describeWishes, INTEREST_STATUS, InterestSettings, publicFormUrl, Registration } from '@/lib/vacancies';

type Tab = 'active' | 'converted' | 'closed' | 'all' | 'settings';

export default function InterestListPage() {
  const { active, can, version } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('active');
  const [rows, setRows] = useState<Registration[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const canManage = !!active && can('interest.manage');

  useEffect(() => {
    const t = setTimeout(
      () => api<Registration[]>(`/interests${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(setRows),
      q ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [q, version]);

  const isActive = (r: Registration) => ['new', 'contacted', 'offered'].includes(r.status);
  const shown = rows?.filter((r) =>
    tab === 'active' ? isActive(r) : tab === 'converted' ? r.status === 'converted' : tab === 'closed' ? ['declined', 'withdrawn'].includes(r.status) : true,
  );

  return (
    <>
      <PageHeader
        title="Intresselista"
        description="Personer och företag som vill hyra. De som anmält sig först står först."
        actions={
          <>
            <Link href="/lediga">
              <Button variant="secondary">Lediga objekt</Button>
            </Link>
            {canManage && <Button onClick={() => setCreating(true)}>Ny anmälan</Button>}
          </>
        }
      />
      <Tabs<Tab>
        tabs={[
          { key: 'active', label: 'Aktuella', count: rows?.filter(isActive).length },
          { key: 'converted', label: 'Blev hyresgäster', count: rows?.filter((r) => r.status === 'converted').length },
          { key: 'closed', label: 'Avslutade', count: rows?.filter((r) => ['declined', 'withdrawn'].includes(r.status)).length },
          { key: 'all', label: 'Alla' },
          ...(canManage ? [{ key: 'settings' as Tab, label: 'Formulär och inställningar' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'settings' ? (
        <SettingsTab />
      ) : (
        <>
          <div className="mb-3 flex gap-2">
            <Input className="max-w-sm" placeholder="Sök namn, e-post, telefon eller nummer" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="ml-auto self-center text-[12px] text-ink-3">{shown?.length ?? 0} anmälningar</div>
          </div>
          {rows && rows.length === 0 && !q ? (
            <Card className="px-6 py-12 text-center">
              <div className="text-[14px] font-medium">Intresselistan är tom</div>
              <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
                {active
                  ? 'Lägg till en anmälan för hand, eller slå på det publika formuläret under Formulär och inställningar och lägg länken på er webbplats.'
                  : 'Välj ett bolag i menyn uppe till vänster för att lägga till anmälningar.'}
              </p>
            </Card>
          ) : (
            <Table head={['Nr', 'Namn', ...(active ? [] : ['Bolag']), 'Söker', 'Anmäld', 'Passar', 'Status']} empty="Ingen anmälan matchar.">
              {shown?.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-subtle/60" onClick={() => router.push(`/intresse/${r.id}`)}>
                  <Td className="tabular text-ink-3">{r.registrationNr}</Td>
                  <Td className="font-medium">
                    <Link href={`/intresse/${r.id}`}>{r.name}</Link>
                    <div className="text-[12px] font-normal text-ink-3">{[r.email, r.phone].filter(Boolean).join(' · ')}</div>
                  </Td>
                  {!active && <Td className="text-ink-2">{r.companyName}</Td>}
                  <Td className="text-ink-2">{describeWishes(r, OBJECT_TYPE_LABEL)}</Td>
                  <Td className="tabular text-ink-2">
                    {r.createdAt.slice(0, 10)}
                    {r.source === 'form' && <div className="text-[12px] text-ink-3">via formuläret</div>}
                  </Td>
                  <Td className="tabular" sortValue={r.matchingObjects ?? 0}>
                    {isActive(r) && r.matchingObjects ? (
                      <span className="font-medium text-accent">{r.matchingObjects} {r.matchingObjects === 1 ? "ledigt" : "lediga"}</span>
                    ) : (
                      <span className="text-ink-3">–</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={INTEREST_STATUS[r.status]?.tone}>{INTEREST_STATUS[r.status]?.label ?? r.status}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
      <RegistrationDialog open={creating} onClose={() => setCreating(false)} onSaved={(id) => router.push(`/intresse/${id}`)} />
    </>
  );
}

function SettingsTab() {
  const { version } = useSession();
  const [saved, setSaved] = useState<InterestSettings | null>(null);
  const [s, setS] = useState<InterestSettings | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<InterestSettings>('/interests/settings')
      .then((r) => {
        setSaved(r);
        setS(r);
      })
      .catch((e: ApiError) => setErr(e));
  }, [version]);
  if (!s || !saved) return <ErrorNote message={err?.message} />;
  const url = publicFormUrl(s.publicKey);
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const fieldErr = (k: string) => err?.fields.find((f) => f.path === k)?.message;
  const area =
    'w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20';

  return (
    <div className="space-y-6">
      <Card className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[14px] font-semibold">Publikt anmälningsformulär</div>
            <div className="mt-0.5 text-[13px] text-ink-2">
              {s.formEnabled
                ? 'Påslaget. Den som har länken kan anmäla intresse utan att logga in. Lägg länken på er webbplats eller i annonser.'
                : 'Avstängt. Slå på det för att ta emot anmälningar via en länk.'}
            </div>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" checked={s.formEnabled} onChange={(e) => setS({ ...s, formEnabled: e.target.checked })} />
            Påslaget
          </label>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Input readOnly value={url} className="font-mono text-[12px]" onFocus={(e) => e.target.select()} />
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard?.writeText(url).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Kopierad' : 'Kopiera länk'}
          </Button>
          {saved.formEnabled && (
            <a href={url} target="_blank" rel="noreferrer">
              <Button type="button" variant="ghost">
                Öppna
              </Button>
            </a>
          )}
        </div>
      </Card>

      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setOk(false);
          try {
            const r = await api<InterestSettings>('/interests/settings', {
              method: 'PUT',
              body: { formEnabled: s.formEnabled, introText: s.introText, consentText: s.consentText, retentionMonths: s.retentionMonths },
            });
            setSaved(r);
            setS(r);
            setOk(true);
          } catch (e) {
            setErr(e as ApiError);
          }
        }}
      >
        <Field label="Text överst i formuläret" hint="Till exempel vilka objekt ni har och hur ni fördelar dem.">
          <textarea className={area} rows={3} value={s.introText ?? ''} onChange={(e) => setS({ ...s, introText: e.target.value })} />
        </Field>
        <Field
          label="Samtyckestext"
          error={fieldErr('consentText')}
          hint="Den som anmäler sig måste kryssa i att hen godkänner texten. Texten sparas på varje anmälan, så att det går att visa vad som godkändes."
        >
          <textarea className={area} rows={4} value={s.consentText} onChange={(e) => setS({ ...s, consentText: e.target.value })} />
        </Field>
        <div className="max-w-xs">
          <Field label="Ta bort anmälningar efter, månader" error={fieldErr('retentionMonths')} hint="Räknas från senaste kontakt. Gallras under Dataskydd.">
            <Input type="number" min={1} max={120} value={s.retentionMonths} onChange={(e) => setS({ ...s, retentionMonths: Number(e.target.value) })} />
          </Field>
        </div>
        <ErrorNote message={err && !err.fields.length ? err.message : null} />
        <div className="flex items-center gap-3">
          <Button disabled={!dirty}>Spara</Button>
          {ok && !dirty && <span className="text-[13px] text-good">Sparat</span>}
        </div>
      </form>
    </div>
  );
}
