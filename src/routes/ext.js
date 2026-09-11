// Роуты для браузерного расширения MarketRadar (см. wb-extension/) — работают по
// личному ключу расширения (см. src/middleware/extensionAuth.js), а не по сессии
// сайта. Смысл всей связки: расширение бегает по обычным страницам товаров Wildberries
// с настоящего браузера продавца (поэтому антибот WB его не блокирует, в отличие от
// запросов с сервера — см. README, раздел про card.wb.ru), достаёт там текущую цену на
// сайте и присылает её сюда. Цену ПРОДАВЦА расширению для этого знать не нужно и
// доставать самому не нужно — она уже посчитана официальным API при обычной
// синхронизации (см. syncService.js, wbClient.js) и просто читается из базы.
const express = require('express');
const { pool } = require('../db');
const { requireExtensionKey } = require('../middleware/extensionAuth');
const { computeSppPercent } = require('../wbClient');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();
router.use(requireExtensionKey);

router.get('/seller-price', asyncHandler(async (req, res) => {
  const nmId = Number(req.query.nm);
  if (!Number.isFinite(nmId)) return res.status(400).json({ error: 'Некорректный артикул' });

  const result = await pool.query(
    `SELECT seller_price AS "sellerPrice", checked_at AS "checkedAt"
     FROM price_snapshots
     WHERE user_id = $1 AND nm_id = $2
     ORDER BY checked_at DESC LIMIT 1`,
    [req.extUserId, nmId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Товар ещё не синхронизирован — нажмите "Синхронизировать" в кабинете' });
  }
  res.json(result.rows[0]);
}));

// Расширение прислало реальную цену на сайте, увиденную прямо в браузере продавца, —
// берём последнюю известную цену продавца по этому же артикулу (она означает и то, что
// артикул точно принадлежит именно этому продавцу: чужие товары просто не найдутся в
// его price_snapshots), считаем СПП и сохраняем снимок в ту же таблицу, что и обычная
// синхронизация (source='extension') — история и графики сразу подхватывают такие
// точки наравне с обычными.
router.post('/site-price', asyncHandler(async (req, res) => {
  const nmId = Number(req.body?.nmId);
  const sitePrice = Number(req.body?.sitePrice);
  if (!Number.isFinite(nmId) || !Number.isFinite(sitePrice)) {
    return res.status(400).json({ error: 'Нужны nmId и sitePrice числом' });
  }

  const sellerRes = await pool.query(
    `SELECT seller_price AS "sellerPrice", vendor_code AS "vendorCode"
     FROM price_snapshots
     WHERE user_id = $1 AND nm_id = $2
     ORDER BY checked_at DESC LIMIT 1`,
    [req.extUserId, nmId]
  );
  if (sellerRes.rows.length === 0) {
    return res.status(404).json({ error: 'Товар ещё не синхронизирован — нажмите "Синхронизировать" в кабинете' });
  }
  const { sellerPrice, vendorCode } = sellerRes.rows[0];
  const sppPercent = computeSppPercent(sellerPrice, sitePrice);

  await pool.query(
    `INSERT INTO price_snapshots (user_id, nm_id, vendor_code, seller_price, site_price, spp_percent, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'extension')`,
    [req.extUserId, nmId, vendorCode, sellerPrice, sitePrice, sppPercent]
  );

  res.json({ sellerPrice, sitePrice, sppPercent });
}));

module.exports = router;
