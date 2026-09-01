const express = require('express');
const { pool } = require('../db');
const { encrypt } = require('../crypto');
const { verifyToken, WbApiError } = require('../wbClient');
const { syncUserProducts } = require('../syncService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.post('/token', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || token.trim().length < 10) {
    return res.status(400).json({ error: 'Вставьте API-токен продавца Wildberries целиком' });
  }
  const trimmed = token.trim();

  try {
    await verifyToken(trimmed);
  } catch (err) {
    const message = err instanceof WbApiError ? err.message : 'Не удалось проверить токен';
    return res.status(400).json({ error: message });
  }

  const encrypted = encrypt(trimmed);
  await pool.query(
    `INSERT INTO wb_credentials (user_id, token_encrypted, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET token_encrypted = excluded.token_encrypted, updated_at = now()`,
    [req.session.userId, encrypted]
  );

  res.json({ connected: true });
}));

router.get('/token/status', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT updated_at FROM wb_credentials WHERE user_id = $1', [
    req.session.userId,
  ]);
  const row = result.rows[0];
  res.json({ connected: !!row, updatedAt: row ? row.updated_at : null });
}));

router.post('/sync', async (req, res) => {
  try {
    const result = await syncUserProducts(req.session.userId);
    res.json(result);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(400).json({ error: err.message });
    }
    const message = err instanceof WbApiError ? err.message : 'Синхронизация не удалась';
    console.error('sync error:', err);
    res.status(502).json({ error: message });
  }
});

router.get('/products', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ps.nm_id AS "nmId", ps.vendor_code AS "vendorCode", ps.seller_price AS "sellerPrice",
            ps.site_price AS "sitePrice", ps.spp_percent AS "sppPercent", ps.checked_at AS "checkedAt"
     FROM price_snapshots ps
     INNER JOIN (
       SELECT nm_id, MAX(checked_at) AS max_checked
       FROM price_snapshots
       WHERE user_id = $1
       GROUP BY nm_id
     ) latest ON latest.nm_id = ps.nm_id AND latest.max_checked = ps.checked_at
     WHERE ps.user_id = $1
     ORDER BY ps.spp_percent DESC NULLS LAST, ps.nm_id ASC`,
    [req.session.userId]
  );
  res.json({ products: result.rows });
}));

// История СПП по одному товару — для линейного графика на карточке товара.
router.get('/products/:nmId/history', asyncHandler(async (req, res) => {
  const nmId = Number(req.params.nmId);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  if (!Number.isFinite(nmId)) return res.status(400).json({ error: 'Некорректный артикул' });

  const result = await pool.query(
    `SELECT checked_at AS "checkedAt", seller_price AS "sellerPrice",
            site_price AS "sitePrice", spp_percent AS "sppPercent"
     FROM price_snapshots
     WHERE user_id = $1 AND nm_id = $2 AND checked_at >= now() - ($3 || ' days')::interval
     ORDER BY checked_at ASC`,
    [req.session.userId, nmId, days]
  );
  res.json({ nmId, days, points: result.rows });
}));

// Факторы: тренд по дням, разбивка по дню недели и по ценовым диапазонам, топ движений.
// Всё построено только на собственной истории синхронизаций продавца — Wildberries не
// раскрывает, что именно определяет СПП, поэтому это статистика по фактам, а не
// подтверждённые площадкой причины.
router.get('/factors', asyncHandler(async (req, res) => {
  const userId = req.session.userId;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);

  const [trendRes, weekdayRes, moversRes, latestRes] = await Promise.all([
    pool.query(
      `SELECT date_trunc('day', checked_at AT TIME ZONE 'Europe/Moscow') AS day,
              ROUND(AVG(spp_percent), 1) AS "avgSpp", COUNT(*) AS n
       FROM price_snapshots
       WHERE user_id = $1 AND checked_at >= now() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [userId, days]
    ),
    pool.query(
      `SELECT EXTRACT(DOW FROM checked_at AT TIME ZONE 'Europe/Moscow')::int AS dow,
              ROUND(AVG(spp_percent), 1) AS "avgSpp", COUNT(*) AS n
       FROM price_snapshots
       WHERE user_id = $1 AND checked_at >= now() - ($2 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [userId, days]
    ),
    pool.query(
      `WITH bounds AS (
         SELECT nm_id, vendor_code,
           FIRST_VALUE(spp_percent) OVER (PARTITION BY nm_id ORDER BY checked_at ASC) AS first_spp,
           FIRST_VALUE(spp_percent) OVER (PARTITION BY nm_id ORDER BY checked_at DESC) AS last_spp,
           ROW_NUMBER() OVER (PARTITION BY nm_id ORDER BY checked_at DESC) AS rn
         FROM price_snapshots
         WHERE user_id = $1 AND checked_at >= now() - ($2 || ' days')::interval
       )
       SELECT nm_id AS "nmId", vendor_code AS "vendorCode",
              first_spp AS "firstSpp", last_spp AS "lastSpp",
              (last_spp - first_spp) AS delta
       FROM bounds
       WHERE rn = 1
       ORDER BY delta DESC`,
      [userId, days]
    ),
    // текущая цена по каждому товару — источник для разбивки по ценовым диапазонам
    pool.query(
      `SELECT ps.nm_id AS "nmId", ps.seller_price AS "sellerPrice", ps.spp_percent AS "sppPercent"
       FROM price_snapshots ps
       INNER JOIN (
         SELECT nm_id, MAX(checked_at) AS max_checked FROM price_snapshots WHERE user_id = $1 GROUP BY nm_id
       ) latest ON latest.nm_id = ps.nm_id AND latest.max_checked = ps.checked_at
       WHERE ps.user_id = $1`,
      [userId]
    ),
  ]);

  const BUCKETS = [
    { label: 'до 500 ₽', max: 500 },
    { label: '500–1000 ₽', max: 1000 },
    { label: '1000–2000 ₽', max: 2000 },
    { label: '2000–5000 ₽', max: 5000 },
    { label: 'от 5000 ₽', max: Infinity },
  ];
  const bucketTotals = BUCKETS.map((b) => ({ label: b.label, sum: 0, n: 0 }));
  for (const row of latestRes.rows) {
    const price = Number(row.sellerPrice);
    const spp = Number(row.sppPercent);
    if (!Number.isFinite(price) || !Number.isFinite(spp)) continue;
    const idx = BUCKETS.findIndex((b) => price <= b.max);
    const bucket = bucketTotals[idx === -1 ? bucketTotals.length - 1 : idx];
    bucket.sum += spp;
    bucket.n += 1;
  }
  const byPriceBucket = bucketTotals
    .filter((b) => b.n > 0)
    .map((b) => ({ label: b.label, avgSpp: Math.round((b.sum / b.n) * 10) / 10, n: b.n }));

  res.json({
    days,
    trend: trendRes.rows,
    byWeekday: weekdayRes.rows,
    byPriceBucket,
    movers: moversRes.rows.filter((m) => m.firstSpp != null && m.lastSpp != null),
  });
}));

module.exports = router;
