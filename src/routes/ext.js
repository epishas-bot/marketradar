// Роуты для браузерного расширения MarketRadar (см. wb-extension/) — работают по
// личному ключу расширения (см. src/middleware/extensionAuth.js), а не по сессии
// сайта. Смысл всей связки: расширение бегает по обычным страницам товаров Wildberries
// с настоящего браузера продавца (поэтому антибот WB его не блокирует, в отличие от
// запросов с сервера — см. README, раздел про card.wb.ru), достаёт там текущую цену на
// сайте и присылает её сюда. Цену ПРОДАВЦА расширению для этого знать не нужно и
// доставать самому не нужно — сервер сам её находит (см. lookupOwnSellerPrice ниже).
const express = require('express');
const { pool } = require('../db');
const { requireExtensionKey } = require('../middleware/extensionAuth');
const { computeSppPercent, fetchAllSellerPrices } = require('../wbClient');
const { decrypt } = require('../crypto');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();
router.use(requireExtensionKey);

// Находит цену продавца по артикулу — сначала в уже посчитанном кэше (последняя
// синхронизация или прошлый визит расширения на страницу этого товара), а если там
// пусто — сразу же, прямо в рамках этого запроса, спрашивает официальный API
// Wildberries по сохранённому токену продавца. Это значит, что продавцу НЕ нужно
// заранее заходить в кабинет MarketRadar и нажимать "Синхронизировать" — первый же
// заход на страницу своего товара с расширением сработает сам, кэш просто появится по
// ходу дела. Возвращает null, только если товар и правда не принадлежит этому
// продавцу (или у аккаунта вообще не подключён токен WB).
async function lookupOwnSellerPrice(userId, nmId) {
  const cached = await pool.query(
    `SELECT seller_price AS "sellerPrice", vendor_code AS "vendorCode"
     FROM price_snapshots
     WHERE user_id = $1 AND nm_id = $2
     ORDER BY checked_at DESC LIMIT 1`,
    [userId, nmId]
  );
  if (cached.rows.length > 0) return cached.rows[0];

  const credRes = await pool.query('SELECT token_encrypted FROM wb_credentials WHERE user_id = $1', [userId]);
  if (credRes.rows.length === 0) return null; // WB вообще не подключён у этого аккаунта

  let items;
  try {
    const token = decrypt(credRes.rows[0].token_encrypted);
    items = await fetchAllSellerPrices(token);
  } catch (err) {
    console.error(`ext: не удалось получить цены по официальному API для user ${userId}:`, err.message);
    return null;
  }

  const match = items.find((item) => item.nmId === nmId);
  if (!match) return null; // спросили WB напрямую — этого артикула у продавца правда нет

  return { sellerPrice: match.sellerPrice, vendorCode: match.vendorCode };
}

router.get('/seller-price', asyncHandler(async (req, res) => {
  const nmId = Number(req.query.nm);
  if (!Number.isFinite(nmId)) return res.status(400).json({ error: 'Некорректный артикул' });

  const found = await lookupOwnSellerPrice(req.extUserId, nmId);
  if (!found) {
    return res.status(404).json({ error: 'Это не ваш товар или WB ещё не подключён в MarketRadar' });
  }
  res.json(found);
}));

// Расширение прислало реальную цену на сайте, увиденную прямо в браузере продавца, —
// находим цену продавца по этому же артикулу (см. lookupOwnSellerPrice — заодно
// проверяет, что артикул точно принадлежит именно этому продавцу), считаем СПП и
// сохраняем снимок в ту же таблицу, что и обычная синхронизация (source='extension')
// — история и графики сразу подхватывают такие точки наравне с обычными.
router.post('/site-price', asyncHandler(async (req, res) => {
  const nmId = Number(req.body?.nmId);
  const sitePrice = Number(req.body?.sitePrice);
  if (!Number.isFinite(nmId) || !Number.isFinite(sitePrice)) {
    return res.status(400).json({ error: 'Нужны nmId и sitePrice числом' });
  }

  const found = await lookupOwnSellerPrice(req.extUserId, nmId);
  if (!found) {
    return res.status(404).json({ error: 'Это не ваш товар или WB ещё не подключён в MarketRadar' });
  }
  const { sellerPrice, vendorCode } = found;
  const sppPercent = computeSppPercent(sellerPrice, sitePrice);

  await pool.query(
    `INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'extension')`,
    [req.extUserId, nmId, vendorCode, sellerPrice, sitePrice, sppPercent]
  );

  res.json({ sellerPrice, sitePrice, sppPercent });
}));

module.exports = router;
