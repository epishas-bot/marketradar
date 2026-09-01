const { pool } = require('./db');
const { decrypt } = require('./crypto');
const { fetchAllSellerPrices } = require('./wbClient');

// Раньше здесь же тянули "цену на сайте" через card.wb.ru прямо с сервера. Wildberries
// блокирует такие запросы на уровне edge-защиты, если они приходят с адресов облачных
// хостингов (Render и подобные) — сервер получает 403 ещё до своего кода (см. wbClient.js).
// Поэтому цену на сайте теперь дотягивает браузер самого продавца (см. public/js/dashboard.js,
// POST /api/wb/site-prices ниже) — синхронизация здесь отвечает только за цену продавца.

/**
 * Синхронизация цены продавца одного пользователя: тянет все его товары и цены
 * через официальный API "Цены и скидки", сохраняет снимок по каждому товару
 * (site_price/spp_percent пока NULL — их отдельно допишет браузер).
 * Возвращает { count, skipped, syncedAt }.
 */
async function syncUserProducts(userId) {
  const credRes = await pool.query('SELECT token_encrypted FROM wb_credentials WHERE user_id = $1', [
    userId,
  ]);
  if (credRes.rows.length === 0) {
    const err = new Error('Wildberries ещё не подключён для этого аккаунта');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const userRes = await pool.query('SELECT sku_limit FROM users WHERE id = $1', [userId]);
  const skuLimit = userRes.rows[0]?.sku_limit ?? 100;

  const token = decrypt(credRes.rows[0].token_encrypted);
  let sellerItems = await fetchAllSellerPrices(token);

  const skipped = Math.max(0, sellerItems.length - skuLimit);
  if (skipped > 0) {
    sellerItems = sellerItems.slice(0, skuLimit);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertSql = `
      INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent)
      VALUES ($1, $2, $3, $4, NULL, NULL)
    `;
    for (const item of sellerItems) {
      await client.query(insertSql, [userId, item.nmId, item.vendorCode, item.sellerPrice]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    count: sellerItems.length,
    skipped,
    syncedAt: new Date().toISOString(),
  };
}

module.exports = { syncUserProducts };
