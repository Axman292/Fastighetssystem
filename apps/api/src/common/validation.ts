import { BadRequestException } from '@nestjs/common';
import { z, ZodTypeAny } from 'zod';

/** Luhn-kontroll (modulus 10) som används för organisationsnummer, personnummer och OCR. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Normaliserar till NNNNNN-NNNN och kontrollerar kontrollsiffran. */
export function normalizeOrgNr(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length === 12 ? digits.slice(2) : digits;
  if (ten.length !== 10 || !luhnValid(ten)) return null;
  return `${ten.slice(0, 6)}-${ten.slice(6)}`;
}

export const orgNrSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeOrgNr(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ogiltigt organisationsnummer' });
      return z.NEVER;
    }
    return n;
  });

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const text = { optional: optionalText };

export function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      message: 'Ogiltiga uppgifter',
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
