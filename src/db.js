const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL не задан. На Render он подставляется автоматически при подключённой базе; локально задайте его в .env (см. .env.example).'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres требует SSL; для локальной разработки (localhost) SSL обычно выключен.
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'seller',       -- 'seller' | 'admin'
      plan TEXT NOT NULL DEFAULT 'trial',        -- 'trial' | 'starter' | 'pro' — тарифы, биллинг подключается отдельно
      plan_status TEXT NOT NULL DEFAULT 'active',-- 'active' | 'past_due' | 'canceled'
      sku_limit INTEGER NOT NULL DEFAULT 100,    -- мягкий лимит товаров на тарифе, пока нет биллинга
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS wb_credentials (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token_encrypted TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nm_id BIGINT NOT NULL,
      vendor_code TEXT,
      seller_price NUMERIC,
      site_price NUMERIC,
      spp_percent NUMERIC,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_user_nm_time
      ON price_snapshots (user_id, nm_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_snapshots_user_time
      ON price_snapshots (user_id, checked_at);
  `);

  // Добавлено позже исходной схемы — ADD COLUMN IF NOT EXISTS безопасно применяется и на
  // свежей базе (после CREATE TABLE выше), и на уже существующей в проде.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
  `);
}

module.exports = { pool, migrate };
