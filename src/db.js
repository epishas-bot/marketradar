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

    -- Название и миниатюра товара — отдельно от price_snapshots, потому что они почти
    -- никогда не меняются и не нуждаются в истории по времени (в отличие от цены и
    -- СПП): по одной строке на товар, которая просто обновляется при каждой
    -- синхронизации, а не размножается на каждый снимок. См. src/syncService.js и
    -- src/wbImage.js.
    CREATE TABLE IF NOT EXISTS products (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nm_id BIGINT NOT NULL,
      name TEXT,
      image_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, nm_id)
    );

    -- Небольшое общесервисное хранилище "ключ → значение" — сейчас используется только
    -- под одну вещь: сохранённые куки браузера для получения цены на сайте (см.
    -- priceScraper.js, ключ 'wb_browser_session'). Смысл — не создавать для каждого
    -- товара новый "пустой" браузерный профиль без единой куки (это и есть один из
    -- явных признаков бота для антибота WB), а копить и переиспользовать один и тот же
    -- профиль между запусками синхронизации, как это делает настоящий человек, у
    -- которого браузер помнит его между визитами на сайт.
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Добавлено позже исходной схемы — ADD COLUMN IF NOT EXISTS безопасно применяется и на
  // свежей базе (после CREATE TABLE выше), и на уже существующей в проде.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
  `);
}

module.exports = { pool, migrate };
