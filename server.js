// server.js
// Thin API layer: the frontend talks ONLY to this server, never directly to
// Frankfurter, Twelve Data, Marketaux, or FMP. That's what keeps API keys off
// the browser and lets you rate-limit/cache without touching the frontend.
//
// Run: npm i express pg cors dotenv && node server.js

import express from "express";
import cors from "cors";
import pg from "pg";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const RANGE_TO_DAYS = { "7D": 7, "1M": 30, "6M": 182, "1Y": 365, "5Y": 1825, All: 7300 };

// --- simple in-memory TTL cache, so repeat frontend requests (and every
// user's browser tab) don't each trigger a fresh call to a rate-limited
// third-party API ---
const cache = new Map();
function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return loader().then((value) => {
    cache.set(key, { value, at: Date.now() });
    return value;
  });
}

// GET /api/rates/latest?base=USD
// Returns the most recent rate for every quote currency against `base`,
// preferring the freshest Twelve Data intraday tick, falling back to the
// last Frankfurter close if intraday hasn't landed yet.
app.get("/api/rates/latest", async (req, res) => {
  const base = (req.query.base || "USD").toUpperCase();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (quote_ccy) quote_ccy, rate, source, ts
       FROM fx_rates
       WHERE base_ccy = $1
       ORDER BY quote_ccy, ts DESC`,
      [base]
    );
    res.json({ base, updatedAt: new Date().toISOString(), rates: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load latest rates" });
  }
});

// GET /api/rates/history?base=USD&quote=EUR&range=1M
app.get("/api/rates/history", async (req, res) => {
  const base = (req.query.base || "USD").toUpperCase();
  const quote = (req.query.quote || "EUR").toUpperCase();
  const days = RANGE_TO_DAYS[req.query.range] ?? 30;
  try {
    // Use the daily continuous aggregate for long ranges, raw ticks for short ones.
    const table = days > 90 ? "fx_rates_daily" : "fx_rates";
    const tsCol = days > 90 ? "day" : "ts";
    const { rows } = await pool.query(
      `SELECT ${tsCol} AS ts, ${days > 90 ? "close_rate AS rate" : "rate"}
       FROM ${table}
       WHERE base_ccy = $1 AND quote_ccy = $2 AND ${tsCol} > now() - interval '${days} days'
       ORDER BY ${tsCol} ASC`,
      [base, quote]
    );
    res.json({ base, quote, range: req.query.range || "1M", points: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load history" });
  }
});

// GET /api/news — proxies Marketaux, filtered to forex, cached 5 min
app.get("/api/news", async (req, res) => {
  try {
    const data = await cached("news", 5 * 60 * 1000, async () => {
      const url = new URL("https://api.marketaux.com/v1/news/all");
      url.searchParams.set("api_token", process.env.MARKETAUX_API_KEY);
      url.searchParams.set("search", "forex OR currency OR exchange rate");
      url.searchParams.set("language", "en");
      url.searchParams.set("limit", "10");
      const r = await fetch(url);
      return r.json();
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load news" });
  }
});

// GET /api/calendar — proxies Financial Modeling Prep's economic calendar, cached 1 hr
app.get("/api/calendar", async (req, res) => {
  try {
    const data = await cached("calendar", 60 * 60 * 1000, async () => {
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${process.env.FMP_API_KEY}`;
      const r = await fetch(url);
      return r.json();
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load calendar" });
  }
});

// POST /api/subscribe — stores an email signup from the landing page.
// Body: { "email": "someone@example.com" }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post("/api/subscribe", async (req, res) => {
  const email = (req.body && req.body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "invalid email" });
  }
  try {
    await pool.query(
      `INSERT INTO email_signups (email, signed_up_at)
       VALUES ($1, now())
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save signup" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FX API listening on :${PORT}`));
