const { pool } = require('./db');
const { decrypt } = require('./crypto');
const { fetchAllSellerPrices, computeSppPercent } = require('./wbClient');
const { fetchAllProductContent } = require('./wbContentClient');
const { fetchRealizationHistory } = require('./wbStatisticsClient');
const { fetchSitePricesViaBrowser } = require('./priceScraper');
const { buildThumbnailUrl } = require('./wbImage');

// Ключ в app_state (см. db.js) под курсор пагинации отчёта о реализации — на каждого
// продавца свой, чтобы при повторных синхронизациях не перекачивать одну и ту же
// историю за последние 3 месяца заново, а получать только то, что появилось нового
// с прошлого раза (см. wbStatisticsClient.js).
const realizationCursorKey = (userId) => `wb_realization_cursor:${userId}`;

async function loadRealizationCursor(userId) {
  try {
    const res = await pool.query('SELECT value FROM app_state WHERE key = $1', [realizationCursorKey(userId)]);
    return res.rows.length > 0 ? Number(res.rows[0].value) || 0 : 0;
  } catch (err) {
    console.warn(`syncService: не удалось загрузить курсор отчёта о реализации (user ${userId}):`, err.message);
    return 0;
  }
}

async function saveRealizationCursor(userId, rrdId) {
  try {
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [realizationCursorKey(userId), String(rrdId)]
    );
  } catch (err) {
    console.warn(`syncService: не удалось сохранить курсор отчёта о реализации (user ${userId}):`, err.message);
  }
}

/**
 * Полная синхронизация одного пользователя за один шаг (то, что происходит по нажатию
 * "Синхронизировать сейчас"): тянет все его товары и цену продавца через официальный
 * API Wildberries "Цены и скидки", затем цену на сайте (после СПП) через управляемый
 * браузер за резидентным/мобильным прокси (см. priceScraper.js), считает СПП и
 * сохраняет снимок по каждому товару. Попутно тянет ещё два официальных источника тем
 * же токеном — название/фото (см. ниже) и историю РЕАЛЬНО состоявшихся продаж с
 * настоящей СПП от самого WB за последние ~3 месяца (см. wbStatisticsClient.js) —
 * ложится в ту же таблицу price_snapshots, поэтому графики истории и "Факторы СПП"
 * сразу показывают проверенные исторические точки, а не только то, что успел поймать
 * браузер с момента, когда сервис начал следить за товаром. Продавцу не нужно ничего
 * дополнительно настраивать — все источники получает сам сервер по уже сохранённому
 * токену (нужно только, чтобы у токена были включены соответствующие категории доступа
 * в личном кабинете — см. README).
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
 * Название и фото товара — то, что показывается в таблице «Товары и СПП» рядом с
 * артикулом, чтобы было видно, какой именно это товар, — сохраняются из ДВУХ
 * источников, в порядке приоритета:
 *   1. Официальный API WB "Контент" (см. wbContentClient.js) — тот же токен продавца,
 *      что и для цен, обычный подписанный HTTP-запрос без браузера и без прокси.
 *      Тянется сразу в начале синхронизации, параллельно с ценами, и сохраняется для
 *      ВСЕХ товаров сразу — не зависит от того, получится ли следом получить цену на
 *      сайте через браузер (см. ниже) или нет. Требует, чтобы у токена в кабинете была
 *      включена категория доступа "Контент" — если нет, WB отвечает 401/403, это не
 *      ломает синхронизацию (см. contentWarning в возвращаемом объекте).
 *   2. Реальные название/фото, пойманные во время получения цены на сайте
 *      (priceScraper.js) — используются, только если для конкретного товара пришли
 *      (COALESCE в апсерте ниже: не затирают уже сохранённое из API "Контент" пустотой,
 *      а перезаписывают его, если браузеру всё же удалось загрузить страницу товара).
 * Формула по артикулу (wbImage.js) остаётся последним запасным вариантом на случай,
 * если оба источника выше не сработали ни разу.
 *
 * Возвращает { count, skipped, syncedAt, siteWarning, contentWarning }.
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
  const realizationCursor = await loadRealizationCursor(userId);

  // Цены, контент (название/фото) и история реальных продаж тянем параллельно — это три
  // независимых запроса на тот же токен, ни один не ждёт другой. Сбой любого из
  // дополнительных двух (чаще всего — не включена соответствующая категория доступа у
  // токена: "Контент" или "Статистика") не должен ронять всю синхронизацию, поэтому оба
  // отдельно обёрнуты и никогда не бросают исключение наружу (см. wbContentClient.js,
  // wbStatisticsClient.js).
  const [sellerItemsRaw, contentMap, realization] = await Promise.all([
    fetchAllSellerPrices(token),
    fetchAllProductContent(token).catch((err) => {
      console.error('syncService: не удалось получить контент (название/фото) от WB:', err.message);
      const empty = new Map();
      empty.error = err.message;
      return empty;
    }),
    fetchRealizationHistory(token, realizationCursor).catch((err) => {
      console.error('syncService: не удалось получить историю продаж от WB:', err.message);
      return { rows: [], lastRrdId: realizationCursor, error: err.message };
    }),
  ]);
  let sellerItems = sellerItemsRaw;

  const skipped = Math.max(0, sellerItems.length - skuLimit);
  if (skipped > 0) {
    sellerItems = sellerItems.slice(0, skuLimit);
  }

  const nmIds = sellerItems.map((item) => item.nmId);
  const sellerByNmId = new Map(sellerItems.map((item) => [item.nmId, item]));

  // source='scrape' — эта строка от периодической проверки цены на сайте через браузер
  // (см. db.js — колонка source нужна, чтобы позже можно было отдельно сверить точность
  // наших собственных замеров против source='realization' ниже — настоящих подтверждённых
  // WB продаж того же товара примерно за тот же период).
  const insertSql = `
    INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent, source)
    VALUES ($1, $2, $3, $4, $5, $6, 'scrape')
  `;

  // То же самое, но с явно заданным checked_at и source='realization' — для исторических
  // точек из отчёта о реализации (см. ниже), где момент события — это дата реальной
  // продажи в прошлом, а не "сейчас" (в insertSql выше это всегда now() по умолчанию).
  const insertHistoricalSql = `
    INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent, checked_at, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'realization')
  `;

  // История реальных продаж (см. wbStatisticsClient.js) — настоящая, подтверждённая
  // WB-ем СПП по каждой проданной единице товара за последние ~3 месяца, без браузера и
  // антибота. Ложится в ту же таблицу price_snapshots, что и обычные периодические
  // проверки цены на сайте, — поэтому сразу подхватывается существующими графиками
  // истории товара и страницей "Факторы СПП" без каких-либо изменений там. ВАЖНО: это
  // срез только по факту продаж — товары, которые не продавались, тут не появятся, и
  // среднее по датам может быть немного смещено в сторону моментов с более выгодной СПП
  // (когда её видел и купил кто-то ещё) — это дополняет, а не заменяет данные из
  // priceScraper.js.
  if (realization.rows && realization.rows.length > 0) {
    for (const row of realization.rows) {
      const saleDate = new Date(row.saleDate);
      if (Number.isNaN(saleDate.getTime())) continue;
      try {
        await pool.query(insertHistoricalSql, [
          userId,
          row.nmId,
          row.vendorCode,
          row.sellerPrice,
          row.buyerPrice,
          row.sppPercent,
          saleDate.toISOString(),
        ]);
      } catch (err) {
        console.error(`syncService: не удалось сохранить историческую продажу nmId ${row.nmId}:`, err.message);
      }
    }
  }
  if (realization.lastRrdId != null && realization.lastRrdId !== realizationCursor) {
    await saveRealizationCursor(userId, realization.lastRrdId);
  }

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

  // Сохраняем название/фото из API "Контент" сразу для ВСЕХ товаров — до того, как
  // вообще начнётся (медленная и не всегда успешная) часть с ценой на сайте через
  // браузер. Так продавец видит нормальные названия и фото даже если браузерная часть
  // ниже вся целиком провалится (например, из-за блокировки антибота WB) — эти два
  // источника теперь полностью независимы друг от друга. Если для конкретного товара
  // API "Контент" не дал фото (нет карточки в ответе, нет прав на категорию и т.п.) —
  // как и раньше, подстраховываемся формулой по артикулу (wbImage.js): это лишь
  // наилучшая догадка, но лучше, чем совсем пустая миниатюра.
  for (const item of sellerItems) {
    const content = contentMap.get(item.nmId);
    const name = content?.name || null;
    const imageUrl = content?.imageUrl || buildThumbnailUrl(item.nmId);
    try {
      await pool.query(productUpsertSql, [userId, item.nmId, name, imageUrl]);
    } catch (err) {
      console.error(`syncService: не удалось сохранить контент (название/фото) nmId ${item.nmId}:`, err.message);
    }
  }

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

      // Реальные название/фото, пойманные прямо во время загрузки страницы товара
      // (priceScraper.js), — обновляем ими карточку, только если браузеру в этот раз
      // действительно удалось её поймать (scrapedImageUrl не null). Если нет — НЕ
      // подставляем сюда формулу по артикулу заново: строка уже была заведена чуть выше
      // (см. цикл по API "Контент" перед стартом браузерной части), и COALESCE в
      // апсерте сохранит то, что там уже есть, вместо того чтобы затирать хорошее фото
      // из API "Контент" менее надёжной догадкой по формуле на каждый неудачный скрейп.
      if (name || scrapedImageUrl) {
        try {
          await pool.query(productUpsertSql, [userId, item.nmId, name, scrapedImageUrl]);
        } catch (err) {
          console.error(`syncService: не удалось сохранить карточку товара nmId ${nmId}:`, err.message);
        }
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
    contentWarning: contentMap.error || null,
    realizationWarning: realization.error || null,
    realizationImported: realization.rows ? realization.rows.length : 0,
  };
}

module.exports = { syncUserProducts };
