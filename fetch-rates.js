// fetch-rates.js
// Scheduled job (run via cron, a serverless scheduled function, or a simple
// `setInterval` in a long-running worker) that pulls FX rates and writes them
// into TimescaleDB. Daily rates come from Frankfurter (no key needed).
// Intraday rates come from Twelve Data (needs TWELVE_DATA_API_KEY).
//
// Suggested schedule: this script itself every 60s for intraday, and once a
// day for the Frankfurter daily close (or just call fetchDaily() once and
// let fetchIntraday() run on the 60s loop).

import pg from "pg";

const DAILY_CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY",
  "BGN", "BRL", "CZK", "DKK", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD",
  "THB", "TRY", "ZAR",
];
// Twelve Data's free tier can't sustain a 930-pair request every 60s (31×30
// currencies). Intraday polling stays scoped to the 8 majors, which is what
// "live" actually needs to feel meaningful for — the other 23 still get a
// real, current rate once a day from Frankfurter via fetchDaily().
const INTRADAY_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY"];
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // postgres://user:pass@host:5432/fx
});

async function fetchDaily() {
  for (const base of DAILY_CURRENCIES) {
    const others = DAILY_CURRENCIES.filter((c) => c !== base).join(",");
    const res = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${others}`);
    const data = await res.json();
    const ts = new Date();
    for (const [quote, rate] of Object.entries(data.rates || {})) {
      await pool.query(
        `INSERT INTO fx_rates (ts, base_ccy, quote_ccy, rate, source)
         VALUES ($1, $2, $3, $4, 'frankfurter')`,
        [ts, base, quote, rate]
      );
    }
  }
  console.log(`[${new Date().toISOString()}] daily Frankfurter rates written`);
}

async function fetchIntraday() {
  if (!TWELVE_DATA_API_KEY) {
    console.warn("TWELVE_DATA_API_KEY not set — skipping intraday poll");
    return;
  }
  const pairs = [];
  for (const base of INTRADAY_CURRENCIES) {
    for (const quote of INTRADAY_CURRENCIES) {
      if (base !== quote) pairs.push(`${base}/${quote}`);
    }
  }
  // Twelve Data supports batching multiple symbols in one call.
  const symbolParam = pairs.join(",");
  const res = await fetch(
    `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbolParam)}&apikey=${TWELVE_DATA_API_KEY}`
  );
  const data = await res.json();
  const ts = new Date();

  const entries = pairs.length === 1 ? { [pairs[0]]: data } : data;
  for (const [pair, payload] of Object.entries(entries)) {
    if (!payload?.price) continue;
    const [base, quote] = pair.split("/");
    await pool.query(
      `INSERT INTO fx_rates (ts, base_ccy, quote_ccy, rate, source)
       VALUES ($1, $2, $3, $4, 'twelvedata')`,
      [ts, base, quote, Number(payload.price)]
    );
  }
  console.log(`[${new Date().toISOString()}] intraday Twelve Data rates written`);
}

async function main() {
  const mode = process.argv[2] || "intraday";
  try {
    if (mode === "daily") await fetchDaily();
    else await fetchIntraday();
  } catch (err) {
    console.error("fetch-rates failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
