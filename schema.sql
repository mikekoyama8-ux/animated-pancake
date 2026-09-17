-- schema.sql
-- Run on a Postgres instance with the TimescaleDB extension enabled.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS fx_rates (
    ts          TIMESTAMPTZ NOT NULL,
    base_ccy    TEXT NOT NULL,
    quote_ccy   TEXT NOT NULL,
    rate        DOUBLE PRECISION NOT NULL,
    source      TEXT NOT NULL,           -- 'frankfurter' | 'twelvedata'
    PRIMARY KEY (ts, base_ccy, quote_ccy, source)
);

-- Turns the table into a hypertable partitioned by time — this is what
-- makes range queries ("give me all-time EUR/USD") fast at scale.
SELECT create_hypertable('fx_rates', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_fx_rates_pair
    ON fx_rates (base_ccy, quote_ccy, ts DESC);

-- Optional: a continuous aggregate for daily closes, so "All" range charts
-- don't have to scan every 60s tick.
CREATE MATERIALIZED VIEW IF NOT EXISTS fx_rates_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', ts) AS day,
    base_ccy,
    quote_ccy,
    last(rate, ts) AS close_rate
FROM fx_rates
GROUP BY day, base_ccy, quote_ccy;

-- Email signups from the landing page.
CREATE TABLE IF NOT EXISTS email_signups (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    signed_up_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
