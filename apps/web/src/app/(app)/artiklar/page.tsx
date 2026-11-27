'use client';

import { useEffect, useState } from 'react';
import { FieldDef, FormDialog } from '@/components/form';
import { Badge, Button, ErrorNote, PageHeader, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { Article, useArticles } from '@/lib/articles';
import { VAT_LABEL } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Account } from '@/lib/suppliers';

const VAT_OPTIONS: Record<string, string> = { follow: 'Följer avtalet och objektet', ...VAT_LABEL };

/** Artikelregister: artiklar på hyresrader, extra debiteringar och fakturor, med konto och moms. */
export default function ArticlesPage() {
  const { active, can, version } = useSession();
  const { articles, reload } = useArticles();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editing, setEditing] = useState<Article | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Account[]>('/accounts').then(setAccounts);
  }, [version]);

  const editable = can('article.write');
  const shown = active ? articles?.filter((a) => a.companyId === active.companyId) : articles;
  const article = editing && editing !== 'new' ? editing : null;

  const accountOptions = Object.fromEntries(
    accounts
      .filter((a) => a.companyId === active?.companyId && a.type === 'revenue' && (a.active || a.number === article?.accountNumber))
      .map((a) => [a.number, `${a.number} ${a.name}`]),
  );
  const fields: FieldDef[] = [
    { key: 'name', label: 'Namn', required: true, half: true, placeholder: 'Till exempel Bredband', hint: 'Visas i listor. Texten på avin anges per rad.' },
    { key: 'accountNumber', label: 'Intäktskonto', type: 'select', options: accountOptions, required: true, half: true },
    {
      key: 'vatRateBp',
      label: 'Moms',
      type: 'select',
      options: VAT_OPTIONS,
      required: true,
      half: true,
      hint: 'Fylls i när artikeln väljs. Bostäder får aldrig moms.',
    },
    { key: 'position', label: 'Ordning på avin', type: 'number', half: true, hint: 'Lägre nummer kommer först' },
  ];

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Artiklar"
        description={
          active
            ? `Artiklar för ${active.companyName}: hyra, tillägg som bredband och fastighetsskatt, avgifter med mera. Varje artikel har ett intäktskonto och kan ha en egen moms.`
            : 'Artikelregister i hela koncernen. Välj ett bolag för att ändra.'
        }
        actions={editable && <Button onClick={() => setEditing('new')}>Ny artikel</Button>}
      />
      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}
      <Table head={['Artikel', ...(active ? [] : ['Bolag']), 'Intäktskonto', 'Moms', 'Används', '']} empty={articles ? 'Inga artiklar.' : 'Laddar…'}>
        {shown?.map((a) => (
          <tr key={a.id} className={a.active ? '' : 'opacity-60'}>
            <Td className="font-medium">
              {a.name}
              {!a.active && (
                <span className="ml-2">
                  <Badge>Inaktiv</Badge>
                </span>
              )}
              {a.system && (
                <span className="ml-2">
                  <Badge tone="accent">Standard</Badge>
                </span>
              )}
            </Td>
            {!active && <Td className="text-ink-2">{a.companyName}</Td>}
            <Td className="tabular text-ink-2">
              {a.accountNumber} {a.accountName && <span className="text-ink-3">{a.accountName}</span>}
            </Td>
            <Td className="text-ink-2">{a.vatRateBp === null ? <span className="text-ink-3">Följer avtalet</span> : VAT_LABEL[String(a.vatRateBp)]}</Td>
            <Td className="tabular text-ink-3">{a.useCount ? `${a.useCount} rader` : '–'}</Td>
            <Td className="whitespace-nowrap text-right">
              {editable && a.companyId === active?.companyId && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                    Ändra
                  </Button>
                  {!a.alwaysActive && (
                    <Button size="sm" variant="ghost" onClick={() => run(() => api(`/articles/${a.id}`, { method: 'PATCH', body: { active: !a.active } }))}>
                      {a.active ? 'Gör inaktiv' : 'Aktivera'}
                    </Button>
                  )}
                  {!a.system && a.useCount === 0 && (
                    <Button size="sm" variant="ghost" onClick={() => run(() => api(`/articles/${a.id}`, { method: 'DELETE' }))}>
                      Ta bort
                    </Button>
                  )}
                </>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-[12px] text-ink-3">
        Standardartiklarna används av systemet och kan döpas om men inte tas bort. En artikel som används på avtal eller fakturor kan göras inaktiv,
        då visas den inte längre när nya rader läggs till. Utfärdade fakturor behåller det konto de fick när de skapades.
      </p>
      <FormDialog
        open={editing !== null}
        title={article ? `Ändra ${article.name}` : 'Ny artikel'}
        fields={fields}
        initial={
          article
            ? { ...article, vatRateBp: article.vatRateBp === null ? 'follow' : String(article.vatRateBp) }
            : { accountNumber: accountOptions['3990'] ? '3990' : undefined, vatRateBp: 'follow' }
        }
        onClose={() => setEditing(null)}
        submit={async (body) => {
          const payload: Record<string, unknown> = { ...body, vatRateBp: body.vatRateBp === 'follow' ? null : body.vatRateBp };
          if (payload.position === null) delete payload.position;
          if (article) await api(`/articles/${article.id}`, { method: 'PATCH', body: payload });
          else await api('/articles', { method: 'POST', body: payload });
          setEditing(null);
          reload();
        }}
        submitLabel={article ? 'Spara' : 'Lägg till'}
      />
    </>
  );
}
