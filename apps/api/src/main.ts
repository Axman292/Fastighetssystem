import { createApp } from './app';
import { startBankFetchScheduler } from './payments/bank-fetch';

async function main() {
  const app = await createApp();
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '127.0.0.1');
  console.log(`API lyssnar på http://127.0.0.1:${port}`);
  // Hämtar inbetalningsfiler från banken med jämna mellanrum (BANK_FETCH=off stänger av)
  startBankFetchScheduler();
}

void main();
