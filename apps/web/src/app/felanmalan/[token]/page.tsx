'use client';

import { FormEvent, use, useEffect, useRef, useState } from 'react';
import { NotFound, PublicFrame } from '@/components/public-frame';
import { Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { TextArea } from '@/components/work-order-form';

interface FormInfo {
  enabled: boolean;
  property: { name: string; addressLine: string | null; postalCode: string | null; city: string | null; companyName: string };
  intro: string | null;
  objects: { id: string; objectNr: string; type: string; apartmentNr: string | null; addressLine: string | null }[];
  categories: { value: string; label: string }[];
  ticket: string | null;
}

const TYPE: Record<string, string> = {
  apartment: 'Lägenhet',
  commercial: 'Lokal',
  office: 'Kontor',
  restaurant: 'Restaurang',
  parking: 'Parkering',
  storage: 'Förråd',
  hotel_room: 'Hotellrum',
  hotel_apartment: 'Hotellägenhet',
  other: 'Övrigt',
};

/** Felanmälan för en fastighet. Öppen för alla som har länken. */
export default function FaultReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ orderNr: number | null; statusUrl: string | null } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/public/fault-forms/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) setMissing(body.message ?? 'Länken till felanmälan finns inte.');
        else setInfo(body);
      })
      .catch(() => setMissing('Kunde inte nå tjänsten. Försök igen om en stund.'));
  }, [token]);

  if (missing) return <NotFound message={missing} />;
  if (!info) return null;
  const p = info.property;
  const address = [p.addressLine, [p.postalCode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  if (!info.enabled) {
    return (
      <PublicFrame company={p.companyName} title="Felanmälan" subtitle={p.name}>
        <Card className="p-5 text-[14px] text-ink-2">Felanmälan via webben är inte öppen för den här fastigheten just nu. Kontakta din hyresvärd.</Card>
      </PublicFrame>
    );
  }

  if (done) {
    return (
      <PublicFrame company={p.companyName} title="Tack för din felanmälan">
        <Card className="space-y-3 p-5 text-[14px]">
          {done.orderNr ? (
            <>
              <p>
                Vi har tagit emot din anmälan. Ditt ärendenummer är <b className="tabular">{done.orderNr}</b>.
              </p>
              <p className="text-ink-2">Har du angett din e-post får du en bekräftelse där också. Du kan följa ärendet och skriva till oss på statussidan.</p>
              {done.statusUrl && (
                <a href={done.statusUrl}>
                  <Button>Följ ditt ärende</Button>
                </a>
              )}
            </>
          ) : (
            <p>Vi har tagit emot din anmälan.</p>
          )}
        </Card>
      </PublicFrame>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const fd = new FormData(e.currentTarget);
    fd.set('ticket', info!.ticket ?? '');
    fd.delete('photos');
    for (const f of files) fd.append('photos', f);
    try {
      const r = await fetch(`/api/public/fault-forms/${encodeURIComponent(token)}`, { method: 'POST', body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.message === 'Ogiltiga uppgifter' ? 'Kontrollera uppgifterna nedan.' : (body.message ?? 'Något gick fel. Försök igen.'));
        setFields(Object.fromEntries((body.fields ?? []).map((f: { path: string; message: string }) => [f.path, f.message])));
        setBusy(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      setDone({ orderNr: body.orderNr, statusUrl: body.statusUrl ? new URL(body.statusUrl).pathname : null });
    } catch {
      setError('Kunde inte skicka. Kontrollera din internetanslutning och försök igen.');
      setBusy(false);
    }
  }

  return (
    <PublicFrame company={p.companyName} title="Felanmälan" subtitle={`${p.name}${address ? ` · ${address}` : ''}`}>
      {info.intro && <Card className="mb-4 whitespace-pre-wrap border-l-4 border-accent p-4 text-[13.5px]">{info.intro}</Card>}
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote message={error} />
        <Card className="space-y-4 p-5">
          <Field label="Lägenhet eller lokal" hint="Välj din lägenhet, eller lämna tomt om felet gäller trapphus, tvättstuga eller utemiljö.">
            <Select name="objectId" defaultValue="">
              <option value="">Gemensamma utrymmen / vet inte</option>
              {info.objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {TYPE[o.type] ?? 'Objekt'} {o.apartmentNr ?? o.objectNr}
                  {o.apartmentNr ? ` (${o.objectNr})` : ''}
                  {o.addressLine ? `, ${o.addressLine}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Typ av fel">
            <Select name="category" defaultValue="other">
              {info.categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vad är fel?" error={fields.title}>
            <Input name="title" required minLength={3} maxLength={200} placeholder="T.ex. Kranen i köket droppar" className="h-10 text-[14px]" />
          </Field>
          <Field label="Beskriv gärna mer" error={fields.description}>
            <TextArea name="description" rows={4} maxLength={5000} placeholder="När började det? Hur ofta händer det?" className="text-[14px]" />
          </Field>
          <Field label="Var i lägenheten?">
            <Input name="location" maxLength={200} placeholder="T.ex. badrummet" className="h-10 text-[14px]" />
          </Field>
          <div>
            <span className="text-[12px] font-medium text-ink-2">Bilder (frivilligt, högst 5)</span>
            <input
              ref={fileRef}
              type="file"
              name="photos"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => setFiles((cur) => [...cur, ...Array.from(e.target.files ?? [])].slice(0, 5))}
            />
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-1 text-[12px]">
                  {f.name.slice(0, 24)}
                  <button type="button" className="text-ink-3 hover:text-bad" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label="Ta bort bilden">
                    ×
                  </button>
                </span>
              ))}
              {files.length < 5 && (
                <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                  Lägg till bild
                </Button>
              )}
            </div>
          </div>
          <label className="flex items-start gap-2 text-[13.5px]">
            <input type="checkbox" name="urgent" value="true" className="mt-0.5" />
            <span>
              Det är brådskande
              <span className="block text-[12px] text-ink-3">Vid vattenläcka, strömavbrott, inbrott eller om du är utelåst: ring din hyresvärd eller jouren direkt.</span>
            </span>
          </label>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="text-[13px] font-semibold">Dina uppgifter</div>
          <Field label="Namn" error={fields.name}>
            <Input name="name" required minLength={2} maxLength={200} autoComplete="name" className="h-10 text-[14px]" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Telefon" error={fields.phone}>
              <Input name="phone" type="tel" maxLength={50} autoComplete="tel" className="h-10 text-[14px]" />
            </Field>
            <Field label="E-post" error={fields.email} hint="För bekräftelse och besked om ärendet">
              <Input name="email" type="email" maxLength={200} autoComplete="email" className="h-10 text-[14px]" />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-[13.5px]">
            <input type="checkbox" name="masterKeyOk" value="true" className="mt-0.5" />
            <span>Hantverkaren får gå in med huvudnyckel om jag inte är hemma</span>
          </label>
          <Field label="Något mer vi behöver veta?" hint="T.ex. husdjur, när du är hemma eller portkod">
            <Input name="accessNote" maxLength={1000} className="h-10 text-[14px]" />
          </Field>
          {/* Fält som bara robotar fyller i */}
          <div aria-hidden="true" className="absolute -left-[10000px] h-0 w-0 overflow-hidden">
            <label>
              Webbplats
              <input type="text" name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
        </Card>

        <p className="text-[12px] text-ink-3">
          Uppgifterna används för att åtgärda felet och kontakta dig om det. De delas med den hantverkare som utför arbetet och tas bort när de inte längre behövs.
        </p>
        <Button type="submit" disabled={busy} className="h-10 w-full text-[14px]">
          {busy ? 'Skickar …' : 'Skicka felanmälan'}
        </Button>
      </form>
    </PublicFrame>
  );
}
