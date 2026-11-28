export interface RentAdjustment {
  id: string;
  companyId: string;
  companyName: string;
  adjustmentNr: number;
  name: string;
  effectiveDate: string;
  method: 'percent' | 'amount';
  percent: number | null;
  amountOre: number | null;
  status: 'applied' | 'reverted';
  lineCount: number;
  objectCount: number;
  beforeOre: number;
  afterOre: number;
  createdAt: string;
  createdByName: string | null;
  revertedAt: string | null;
}

/** "+3,5 %" eller "+250 kr/mån" */
export function changeLabel(a: { method: string; percent: number | null; amountOre: number | null }): string {
  if (a.method === 'percent') {
    const p = a.percent ?? 0;
    return `${p > 0 ? '+' : ''}${p.toLocaleString('sv-SE', { maximumFractionDigits: 3 })} %`;
  }
  const kr = (a.amountOre ?? 0) / 100;
  return `${kr > 0 ? '+' : ''}${kr.toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr/mån`;
}
