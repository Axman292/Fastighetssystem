import { z } from 'zod';

/** Kronor (upp till två decimaler) till öre. Belopp lagras alltid som heltal i öre. */
export function kronorToOre(kr: number): number {
  return Math.round(kr * 100);
}

export function oreToKronor(ore: number | null | undefined): number | null {
  return ore === null || ore === undefined ? null : ore / 100;
}

/** Tar emot ett belopp i kronor och ger öre. */
export const kronor = z
  .number({ invalid_type_error: 'Ange ett belopp' })
  .finite()
  .min(0, 'Beloppet kan inte vara negativt')
  .max(1e12)
  .transform(kronorToOre);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ange datum som ÅÅÅÅ-MM-DD');

/** Dagen före ett ISO-datum. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
