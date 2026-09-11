# FX Dashboard backend — Docker Compose stack

Four containers:

- **db** — TimescaleDB (Postgres 16). Runs `schema.sql` automatically the
  first time the volume is created.
- **api** — `server.js`, the thin API the frontend artifact talks to.
  Exposed on `localhost:8080`.
- **worker-intraday** — loops `fetch-rates.js intraday` every 60s (Twelve Data).
- **worker-daily** — loops `fetch-rates.js daily` every 24h (Frankfurter).

## Run it

1. Copy the env template and fill in your keys:
   ```
   cp .env.example .env
   ```
   At minimum set `POSTGRES_PASSWORD`. `TWELVE_DATA_API_KEY`, `MARKETAUX_API_KEY`,
   and `FMP_API_KEY` can stay blank to start — the intraday worker will just
   log a warning and skip until you add a Twelve Data key, and the API's
   `/api/news` / `/api/calendar` will return empty until Marketaux/FMP keys
   are set.

2. Build and start everything:
   ```
   docker compose up -d --build
   ```

3. Check it's alive:
   ```
   curl http://localhost:8080/api/rates/latest?base=USD
   docker compose logs -f worker-daily
   ```

4. Point the frontend artifact at it: turn on "Use my backend" and enter
   `http://localhost:8080` (or your droplet's address) in the backend URL
   field.

## Backfilling historical data

`fetch-rates.js` only writes rates going forward from whenever it starts
running. To fill in years of history for your 8 currencies (so the 1Y/5Y/All
chart ranges have data on day one instead of growing slowly from an empty
table), run the one-time backfill after the stack is up:

```
docker compose exec api node backfill-history.js
```

Notes:
- Pulls daily rates back to 1999-01-04 (the earliest ECB/Frankfurter data
  goes) for all 8 base currencies — a few hundred thousand rows, finishes in
  well under a minute.
- Safe to re-run: it skips rows that already exist instead of duplicating them.
- It also refreshes the `fx_rates_daily` continuous aggregate over the
  backfilled range — without that step, TimescaleDB won't automatically
  reflect data inserted into the past, and your 5Y/All charts would look
  empty even though the raw rows are there.
- This only backfills daily closes. There's no way to backfill intraday
  (60-second) history — that only exists from whenever `worker-intraday`
  actually started running.

## Deploying on a droplet

Same steps, just:
- Open port `8080` (or put it behind Nginx/Caddy with TLS if the frontend
  will be served over HTTPS — most browsers block a plain-HTTP API call
  from an HTTPS page).
- Use a real `POSTGRES_PASSWORD` and keep `.env` out of version control.
- `docker compose up -d --build` picks up code changes; add `--pull always`
  if you're pulling a prebuilt image instead of building from source.

## Resetting the database

The schema only runs on a *fresh* volume. To start over:
```
docker compose down -v
docker compose up -d --build
```
