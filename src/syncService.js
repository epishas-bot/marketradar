const { pool } = require('./db');
const { decrypt } = require('./crypto');
const { fetchAllSellerPrices, computeSppPercent } = require('./wbClient');
const { fetchSitePricesViaBrowser } = require('./priceScraper');

/**
 * Полная синхронизация одного пользователя за один шаг (то, что происходит по нажатию
 * "Синхронизировать сейчас"): тянет все его товары и цену продавца через официальный
 * API Wildberries "Цены и скидки", затем цену на сайте (после СПП) через управляемый
 * браузер за резидентным/мобильным прокси (см. priceScraper.js), считает СПП и
 * сохраняет снимок по каждому товару. Продавцу не нужно ничего дополнительно
 * настраивать — обе цены получает сам сервер.
 *
 * Вторая часть (цена на сайте) ощутимо медленнее первой — на каждый товар нужна
 * полноценная загрузка страницы в браузере плюс пауза, чтобы не выглядеть ботом
 * (см. priceScraper.js). Для каталогов от нескольких десятков товаров синхронизация
 * может занимать несколько минут — это ожидаемо, не зависание.
 *
 * Снимок по каждому товару сохраняется в базу сразу, как только для него получена (или
 * не получена) цена на сайте — не пачкой в самом конце. Это значит, что продавец видит
 * товар в таблице «Товары и СПП» сразу по ходу синхронизации, а не только после того,
 * как обработаются вообще все товары каталога (при синхронизации в несколько минут это
 * ощутимая разница).
 *
 * onProgress(done, total), если передан, вызывается по ходу получения цены на сайте —
 * см. priceScraper.js и src/syncStatus.js (используется, чтобы показать реальный
 * прогресс синхронизации, идущей в фоне, независимо от того, какая страница открыта).
 *
 * Возвращает { count, skipped, syncedAt, siteWarning }.
 */
async function syncUserProducts(userId, onProgress) {
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

  const nmIds = sellerItems.map((item) => item.nmId);
  const sellerByNmId = new Map(sellerItems.map((item) => [item.nmId, item]));

  const insertSql = `
    INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;

  // Вызывается из priceScraper.js сразу после каждого товара — здесь и происходит
  // собственно "появление строки в таблице": как только снимок сохранён в базу,
  // GET /api/wb/products на следующем опросе с фронтенда уже его отдаст.
  const onItemDone = async (nmId, sitePrice, done, total) => {
    const item = sellerByNmId.get(nmId);
    if (item) {
      const sppPercent = computeSppPercent(item.sellerPrice, sitePrice);
      try {
        await pool.query(insertSql, [
          userId,
          item.nmId,
          item.vendorCode,
          item.sellerPrice,
          sitePrice,
          sppPercent,
        ]);
      } catch (err) {
        // Не прерываем всю синхронизацию из-за проблемы с одной строкой — просто
        // логируем и идём дальше к следующему товару.
        console.error(`syncService: не удалось сохранить снимок nmId ${nmId}:`, err.message);
      }
    }
    if (onProgress) onProgress(done, total);
  };

  const sitePrices = await fetchSitePricesViaBrowser(nmIds, onItemDone);

  return {
    count: sellerItems.length,
    skipped,
    syncedAt: new Date().toISOString(),
    siteWarning: sitePrices.error || null,
  };
}

module.exports = { syncUserProducts };
