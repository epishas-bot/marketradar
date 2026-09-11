// Авторизация запросов от браузерного расширения (см. wb-extension/) — отдельная от
// обычной сессии сайта (см. auth.js), потому что расширение работает в другом
// браузерном контексте и не имеет доступа к cookie сессии сайта. Вместо логина/пароля
// продавец один раз копирует свой личный ключ расширения со страницы "Настройки" в
// попап расширения — дальше оно присылает его в заголовке X-MarketRadar-Key на каждый
// запрос к /api/ext/*.
const { pool } = require('../db');

async function requireExtensionKey(req, res, next) {
  const key = req.header('X-MarketRadar-Key');
  if (!key) {
    return res.status(401).json({ error: 'Не хватает ключа расширения (заголовок X-MarketRadar-Key)' });
  }
  try {
    const result = await pool.query('SELECT id FROM users WHERE extension_api_key = $1', [key]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Ключ расширения не найден или отозван' });
    }
    req.extUserId = result.rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireExtensionKey };
