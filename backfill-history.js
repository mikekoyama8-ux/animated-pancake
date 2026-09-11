// backfill-history.js
// Run ONCE, manually, after the stack is up — not a recurring worker.
// Pulls full daily history for every base currency from Frankfurter (ECB
// data starts 1999-01-04) and bulk-inserts it into fx_rates, then refreshes
// the fx_rates_daily continuous aggregate so long-range charts pick it up.
//
// Usage: node backfill-history.js
// Safe to re-run: existing rows are skipped, not duplicated.

import pg from "pg";
import "dotenv/config";

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY"];
const ECB_START_DATE = "1999-01-04"; // earliest date Frankfurter/ECB has data for

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfillBase(base) {
  const others = CURRENCIES.filter((c) => c !== base).join(",");
  console.log(`Fetching ${base} history since ${ECB_START_DATE}...`);

  const res = await fetch(
    `https://api.frankfurter.app/${ECB_START_DATE}..?from=${base}&to=${others}`
  );
  if (!res.ok) {
    throw new Error(`Frankfurter request failed for base=${base}: ${res.status}`);
  }
  const data = await res.json();
  const dates = Object.keys(data.rates || {});
  console.log(`  ${dates.length} days returned for ${base}`);

  // Commit every BATCH_SIZE days instead of one giant transaction for the
  // whole currency — a single multi-decade transaction can exhaust
  // Postgres's shared lock-tracking memory on a small instance.
  const BATCH_SIZE = 250;
  const client = await pool.connect();
  let inserted = 0;
  try {
    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      await client.query("BEGIN");
      for (const date of batch) {
        const ts = new Date(`${date}T00:00:00Z`);
        const dayRates = data.rates[date];
        for (const [quote, rate] of Object.entries(dayRates)) {
          const result = await client.query(
            `INSERT INTO fx_rates (ts, base_ccy, quote_ccy, rate, source)
             VALUES ($1, $2, $3, $4, 'frankfurter')
             ON CONFLICT (ts, base_ccy, quote_ccy, source) DO NOTHING`,
            [ts, base, quote, rate]
          );
          inserted += result.rowCount;
        }
      }
      await client.query("COMMIT");
      console.log(`    ...committed through ${batch[batch.length - 1]}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  console.log(`  inserted ${inserted} new rows for ${base}`);
}

async function refreshDailyAggregate() {
  console.log("Refreshing fx_rates_daily continuous aggregate over the backfilled range...");
  await pool.query(
    `CALL refresh_continuous_aggregate('fx_rates_daily', $1::timestamptz, now());`,
    [`${ECB_START_DATE}T00:00:00Z`]
  );
  console.log("  done");
}

async function main() {
  try {
    for (const base of CURRENCIES) {
      await backfillBase(base);
    }
    await refreshDailyAggregate();
    console.log("Backfill complete.");
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
