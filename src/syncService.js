const { pool } = require('./db');
const { decrypt } = require('./crypto');
const { fetchAllSellerPrices, fetchSitePrices, computeSppPercent } = require('./wbClient');

/**
 * Полная синхронизация одного пользователя: тянет его товары и цены продавца из WB,
 * тянет цены на сайте, считает СПП и сохраняет снимок по каждому товару.
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

  const nmIds = sellerItems.map((i) => i.nmId);
  const sitePrices = await fetchSitePrices(nmIds);
  const siteWarning = sitePrices.error || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertSql = `
      INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    for (const item of sellerItems) {
      const sitePrice = sitePrices.has(item.nmId) ? sitePrices.get(item.nmId) : null;
      const sppPercent = computeSppPercent(item.sellerPrice, sitePrice);
      await client.query(insertSql, [
        userId,
        item.nmId,
        item.vendorCode,
        item.sellerPrice,
        sitePrice,
        sppPercent,
      ]);
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
    warning: siteWarning,
  };
}

module.exports = { syncUserProducts };
