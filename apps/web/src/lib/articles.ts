'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { useSession } from './session';

export interface Article {
  id: string;
  companyId: string;
  companyName: string;
  code: string;
  name: string;
  accountNumber: string;
  accountName: string | null;
  /** Standardmoms. null = följer avtalet och objektet. */
  vatRateBp: number | null;
  system: boolean;
  alwaysActive: boolean;
  active: boolean;
  position: number;
  useCount: number;
}

/** Artikelregistret för de bolag användaren ser. Hämtas om vid bolagsbyte. */
export function useArticles(): { articles: Article[] | null; reload: () => void } {
  const { version } = useSession();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const reload = () => {
    api<Article[]>('/articles')
      .then(setArticles)
      .catch(() => setArticles([]));
  };
  useEffect(reload, [version]);
  return { articles, reload };
}

/** Val i en lista: bolagets aktiva artiklar, plus den som redan är vald även om den är inaktiv. */
export function articleOptions(articles: Article[] | null, companyId: string | null | undefined, current?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of articles ?? []) {
    if (a.companyId !== companyId) continue;
    if (a.active || a.code === current) out[a.code] = a.active ? a.name : `${a.name} (inaktiv)`;
  }
  return out;
}

/** Artikelns namn för visning. Okänd kod visas som den är. */
export function articleName(articles: Article[] | null, companyId: string | null | undefined, code: string): string {
  return articles?.find((a) => a.companyId === companyId && a.code === code)?.name ?? code;
}

/** Fält som fylls i när en artikel väljs: standardmoms (om den är tillåten) och text om den är tom. */
export function articleDefaults(
  articles: Article[] | null,
  companyId: string | null | undefined,
  code: string,
  values: Record<string, string | boolean>,
  opts: { residential?: boolean; descriptionKey?: string } = {},
): Record<string, string | boolean> {
  const a = articles?.find((x) => x.companyId === companyId && x.code === code);
  if (!a) return {};
  const out: Record<string, string | boolean> = {};
  if (a.vatRateBp !== null && !(opts.residential && a.vatRateBp > 0)) out.vatRateBp = String(a.vatRateBp);
  const dk = opts.descriptionKey ?? 'description';
  const prevName = articles?.find((x) => x.companyId === companyId && x.code === values.article)?.name;
  const desc = typeof values[dk] === 'string' ? (values[dk] as string).trim() : '';
  if (!desc || desc === prevName) out[dk] = a.name;
  return out;
}
