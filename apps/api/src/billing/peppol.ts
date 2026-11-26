import type { InvoiceDetail } from './invoice-store';

/**
 * E-faktura enligt Peppol BIS Billing 3.0 (UBL 2.1), som är standard för
 * e-faktura i Sverige. Filen kan skickas via en Peppol-accesspunkt.
 */
export function peppolXml(d: InvoiceDetail): string {
  const credit = d.kind === 'credit_note';
  const sign = credit ? -1 : 1;
  const root = credit ? 'CreditNote' : 'Invoice';
  const c = d.company;
  const b = d.billTo;
  const amt = (ore: number) => `currencyID="SEK">${((ore * sign) / 100).toFixed(2)}`;
  const orgDigits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
  const [buyerScheme, buyerId] = splitPeppol(b.peppolId, b.nationalId);

  const rates = new Map<number, { net: number; vat: number }>();
  for (const l of d.lines) {
    const r = rates.get(l.vatRateBp) ?? { net: 0, vat: 0 };
    r.net += l.netOre;
    r.vat += l.vatOre;
    rates.set(l.vatRateBp, r);
  }
  const category = (rate: number) =>
    rate > 0
      ? `<cbc:ID>S</cbc:ID><cbc:Percent>${rate / 100}</cbc:Percent>`
      : `<cbc:ID>E</cbc:ID><cbc:Percent>0</cbc:Percent>`;

  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="UTF-8"?>');
  x.push(
    `<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`,
  );
  x.push('<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>');
  x.push('<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>');
  x.push(`<cbc:ID>${esc(String(d.invoiceNr ?? 'UTKAST'))}</cbc:ID>`);
  x.push(`<cbc:IssueDate>${d.invoiceDate}</cbc:IssueDate>`);
  if (!credit) x.push(`<cbc:DueDate>${d.dueDate}</cbc:DueDate>`);
  x.push(credit ? '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>' : '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
  if (d.message) x.push(`<cbc:Note>${esc(d.message)}</cbc:Note>`);
  x.push('<cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>');
  x.push(`<cbc:BuyerReference>${esc(d.yourReference ?? b.reference ?? String(b.customerNr ?? d.customerNr))}</cbc:BuyerReference>`);
  if (d.periodFrom && d.periodTo) {
    x.push(`<cac:InvoicePeriod><cbc:StartDate>${d.periodFrom}</cbc:StartDate><cbc:EndDate>${d.periodTo}</cbc:EndDate></cac:InvoicePeriod>`);
  }
  if (credit && d.credited) {
    x.push(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${d.credited.invoiceNr}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`);
  }
  if (d.contractNr) {
    x.push(`<cac:ContractDocumentReference><cbc:ID>${d.contractNr}</cbc:ID></cac:ContractDocumentReference>`);
  }

  // Säljare
  x.push('<cac:AccountingSupplierParty><cac:Party>');
  x.push(`<cbc:EndpointID schemeID="0007">${orgDigits(c.orgNr)}</cbc:EndpointID>`);
  x.push(`<cac:PartyName><cbc:Name>${esc(c.name)}</cbc:Name></cac:PartyName>`);
  x.push(address(c.addressLine, c.city, c.postalCode, 'SE'));
  if (c.vatNr) x.push(`<cac:PartyTaxScheme><cbc:CompanyID>${esc(c.vatNr.replace(/\s/g, ''))}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`);
  if (c.fTax) x.push('<cac:PartyTaxScheme><cbc:CompanyID>Godkänd för F-skatt</cbc:CompanyID><cac:TaxScheme><cbc:ID>TAX</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>');
  x.push(`<cac:PartyLegalEntity><cbc:RegistrationName>${esc(c.name)}</cbc:RegistrationName><cbc:CompanyID schemeID="0007">${orgDigits(c.orgNr)}</cbc:CompanyID></cac:PartyLegalEntity>`);
  if (c.invoiceEmail) x.push(`<cac:Contact><cbc:ElectronicMail>${esc(c.invoiceEmail)}</cbc:ElectronicMail></cac:Contact>`);
  x.push('</cac:Party></cac:AccountingSupplierParty>');

  // Köpare
  x.push('<cac:AccountingCustomerParty><cac:Party>');
  if (buyerId) x.push(`<cbc:EndpointID schemeID="${buyerScheme}">${esc(buyerId)}</cbc:EndpointID>`);
  x.push(`<cac:PartyName><cbc:Name>${esc(b.name ?? '')}</cbc:Name></cac:PartyName>`);
  x.push(address(b.addressLine, b.city, b.postalCode, b.country ?? 'SE'));
  if (b.vatNr) x.push(`<cac:PartyTaxScheme><cbc:CompanyID>${esc(b.vatNr.replace(/\s/g, ''))}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`);
  x.push(`<cac:PartyLegalEntity><cbc:RegistrationName>${esc(b.name ?? '')}</cbc:RegistrationName>${b.kind === 'organization' && b.nationalId ? `<cbc:CompanyID schemeID="0007">${orgDigits(b.nationalId)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>`);
  x.push('</cac:Party></cac:AccountingCustomerParty>');

  // Betalning
  if (!credit && (c.bankgiro || c.iban)) {
    x.push('<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>');
    if (d.ocr) x.push(`<cbc:PaymentID>${d.ocr}</cbc:PaymentID>`);
    if (c.bankgiro) {
      x.push(`<cac:PayeeFinancialAccount><cbc:ID>${orgDigits(c.bankgiro)}</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>SE:BANKGIRO</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount>`);
    } else if (c.iban) {
      x.push(`<cac:PayeeFinancialAccount><cbc:ID>${esc(c.iban.replace(/\s/g, ''))}</cbc:ID>${c.bic ? `<cac:FinancialInstitutionBranch><cbc:ID>${esc(c.bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ''}</cac:PayeeFinancialAccount>`);
    }
    x.push('</cac:PaymentMeans>');
  }

  // Moms
  x.push(`<cac:TaxTotal><cbc:TaxAmount ${amt(d.vatOre)}</cbc:TaxAmount>`);
  for (const [rate, r] of [...rates.entries()].sort((a, b2) => b2[0] - a[0])) {
    x.push(
      `<cac:TaxSubtotal><cbc:TaxableAmount ${amt(r.net)}</cbc:TaxableAmount><cbc:TaxAmount ${amt(r.vat)}</cbc:TaxAmount>` +
        `<cac:TaxCategory>${category(rate)}${rate === 0 ? '<cbc:TaxExemptionReason>Uthyrning av fastighet, undantagen från moms (3 kap. 2 § ML)</cbc:TaxExemptionReason>' : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`,
    );
  }
  x.push('</cac:TaxTotal>');

  x.push('<cac:LegalMonetaryTotal>');
  x.push(`<cbc:LineExtensionAmount ${amt(d.netOre)}</cbc:LineExtensionAmount>`);
  x.push(`<cbc:TaxExclusiveAmount ${amt(d.netOre)}</cbc:TaxExclusiveAmount>`);
  x.push(`<cbc:TaxInclusiveAmount ${amt(d.netOre + d.vatOre)}</cbc:TaxInclusiveAmount>`);
  if (d.roundingOre) x.push(`<cbc:PayableRoundingAmount ${amt(d.roundingOre)}</cbc:PayableRoundingAmount>`);
  x.push(`<cbc:PayableAmount ${amt(d.totalOre)}</cbc:PayableAmount>`);
  x.push('</cac:LegalMonetaryTotal>');

  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  d.lines.forEach((l, i) => {
    x.push(`<cac:${lineTag}><cbc:ID>${i + 1}</cbc:ID>`);
    x.push(`<cbc:${qtyTag} unitCode="C62">${l.quantity}</cbc:${qtyTag}>`);
    x.push(`<cbc:LineExtensionAmount ${amt(l.netOre)}</cbc:LineExtensionAmount>`);
    if (l.periodFrom && l.periodTo) x.push(`<cac:InvoicePeriod><cbc:StartDate>${l.periodFrom}</cbc:StartDate><cbc:EndDate>${l.periodTo}</cbc:EndDate></cac:InvoicePeriod>`);
    x.push(`<cac:Item><cbc:Name>${esc(l.description.slice(0, 200))}</cbc:Name><cac:ClassifiedTaxCategory>${category(l.vatRateBp)}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`);
    const unit = l.quantity ? l.netOre / l.quantity : l.netOre;
    x.push(`<cac:Price><cbc:PriceAmount ${amt(Math.round(unit))}</cbc:PriceAmount></cac:Price>`);
    x.push(`</cac:${lineTag}>`);
  });
  x.push(`</${root}>`);
  return x.join('\n');
}

/** "0007:5560000000" eller "5560000000" till schema och id. Utan Peppol-id används orgnr. */
function splitPeppol(peppolId: string | null | undefined, nationalId: string | null | undefined): [string, string | null] {
  if (peppolId) {
    const m = peppolId.match(/^(\d{4}):(.+)$/);
    if (m) return [m[1], m[2]];
    return ['0007', peppolId.replace(/\D/g, '')];
  }
  const digits = (nationalId ?? '').replace(/\D/g, '');
  return ['0007', digits.length === 10 ? digits : null];
}

function address(line: string | null | undefined, city: string | null | undefined, zip: string | null | undefined, country: string) {
  return (
    '<cac:PostalAddress>' +
    (line ? `<cbc:StreetName>${esc(line)}</cbc:StreetName>` : '') +
    (city ? `<cbc:CityName>${esc(city)}</cbc:CityName>` : '') +
    (zip ? `<cbc:PostalZone>${esc(zip)}</cbc:PostalZone>` : '') +
    `<cac:Country><cbc:IdentificationCode>${esc(country || 'SE')}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
