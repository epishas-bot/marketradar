const { pool } = require('./db');
const { decrypt } = require('./crypto');
const { fetchAllSellerPrices, computeSppPercent } = require('./wbClient');
const { fetchSitePricesViaBrowser } = require('./priceScraper');
const { buildThumbnailUrl } = require('./wbImage');

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
 * Заодно, попутно (без отдельных запросов), сохраняет название и миниатюру каждого
 * товара — название из перехваченного JSON сайта, миниатюру по формуле прямо из
 * артикула (см. wbImage.js) — это то, что показывается в таблице «Товары и СПП» рядом
 * с артикулом, чтобы было видно, какой именно это товар.
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

  // Название и миниатюра хранятся отдельно от снимков цены (см. db.js) — одна строка на
  // товар, которая просто обновляется каждый раз. COALESCE в UPDATE — чтобы неудачная
  // попытка (например, name пришёл null, потому что скрейпинг сайта не сработал) не
  // затирала уже сохранённые ранее данные пустотой.
  const productUpsertSql = `
    INSERT INTO products (user_id, nm_id, name, image_url, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (user_id, nm_id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, products.name),
      image_url = COALESCE(EXCLUDED.image_url, products.image_url),
      updated_at = now()
  `;

  // Вызывается из priceScraper.js сразу после каждого товара — здесь и происходит
  // собственно "появление строки в таблице": как только снимок сохранён в базу,
  // GET /api/wb/products на следующем опросе с фронтенда уже его отдаст.
  const onItemDone = async (nmId, sitePrice, name, scrapedImageUrl, done, total) => {
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

      // Приоритет — реальный адрес картинки, который поймали прямо во время загрузки
      // страницы товара (priceScraper.js): он гарантированно верный, потому что это
      // именно то, что в этот момент загрузила сама страница. Если поймать его не
      // удалось (антибот/таймаут/прокси недоступен), считаем URL по формуле из артикула
      // (wbImage.js) — это лишь наилучшая догадка и иногда может промахнуться (см.
      // комментарий в wbImage.js), но лучше, чем совсем ничего не показывать.
      const imageUrl = scrapedImageUrl || buildThumbnailUrl(item.nmId);
      try {
        await pool.query(productUpsertSql, [userId, item.nmId, name, imageUrl]);
      } catch (err) {
        console.error(`syncService: не удалось сохранить карточку товара nmId ${nmId}:`, err.message);
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
