import { Client } from 'pg';

/**
 * Bara för testmiljön (TEST_COMPANY_DATA=true): fyller i påhittade betaluppgifter på bolagen
 * så att avier kan godkännas. Bara tomma fält fylls i, inget som redan är ifyllt skrivs över.
 * Bankgironumren 5050-1055, 5050-1063 och 5050-1071 är Bankgirots egna exempelnummer
 * (giltig kontrollsiffra, används i deras testfiler) och tillhör inget riktigt bolag.
 */
const FAKE_BANKGIROS = ['5050-1055', '5050-1063', '5050-1071'];

export async function seedTestCompanyData(connectionString: string, log = console.log) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; name: string; org_nr: string }>(
      'select id, name, org_nr from company order by created_at, name',
    );
    let changed = 0;
    for (const [i, c] of rows.entries()) {
      const digits = c.org_nr.replace(/\D/g, '');
      const res = await client.query(
        `update company set
           bankgiro      = case when bankgiro is null and plusgiro is null then $2 else bankgiro end,
           vat_nr        = coalesce(nullif(vat_nr, ''), $3),
           address_line  = coalesce(nullif(address_line, ''), $4),
           postal_code   = coalesce(nullif(postal_code, ''), '123 45'),
           city          = coalesce(nullif(city, ''), 'Teststad'),
           invoice_email = coalesce(nullif(invoice_email, ''), $5),
           updated_at    = now()
         where id = $1
           and ((bankgiro is null and plusgiro is null) or coalesce(vat_nr, '') = '' or coalesce(address_line, '') = ''
                or coalesce(postal_code, '') = '' or coalesce(city, '') = '' or coalesce(invoice_email, '') = '')`,
        [
          c.id,
          FAKE_BANKGIROS[i % FAKE_BANKGIROS.length],
          `SE${digits}01`,
          `Testgatan ${i + 1}`,
          `faktura${i + 1}@example.se`,
        ],
      );
      if (res.rowCount) {
        changed++;
        log(`Påhittade uppgifter ifyllda där de saknades: ${c.name}`);
      }
    }
    if (!changed) log('Alla bolag har redan betaluppgifter, inget ändrades.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL saknas');
  if (process.env.TEST_COMPANY_DATA !== 'true') {
    console.log('TEST_COMPANY_DATA är inte "true", inga påhittade bolagsuppgifter läggs in.');
  } else {
    seedTestCompanyData(url).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
