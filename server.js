require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const { pool, migrate } = require('./src/db');
const authRoutes = require('./src/routes/auth');
const wbRoutes = require('./src/routes/wb');
const { syncUserProducts } = require('./src/syncService');
const syncStatus = require('./src/syncStatus');

const PgSession = pgSessionFactory(session);
const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn('⚠ SESSION_SECRET не задан в .env — используется небезопасное значение по умолчанию.');
}

app.set('trust proxy', 1); // Render и любой reverse proxy с HTTPS

app.use(express.json());
app.use(
  session({
    store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7, // неделя
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/wb', wbRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// ВРЕМЕННЫЙ диагностический роут — проверяет, отдаёт ли card.wb.ru (публичный
// JSON API карточки товара, тот же, что использует фронтенд самого WB для
// показа цены на странице товара) данные при прямом запросе с сервера Render,
// без прокси и без браузера. Если отдаёт — весь мобильный прокси можно не
// поднимать вообще, потому что цену покупателя можно брать этим запросом.
// Удалить после проверки (см. README, раздел про card.wb.ru).
app.get('/api/debug/wb-card-test', async (req, res) => {
  const nm = req.query.nm || '191634653'; // артикул по умолчанию для теста
  const dest = req.query.dest || '-1257786'; // Москва
  const url =
    `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=${dest}` +
    `&hide_dtype=13&spp=30&ab_testing=false&lang=ru&nm=${nm}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.wildberries.ru/',
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* не JSON — оставим сырой текст ниже */
    }
    res.json({
      requestedUrl: url,
      status: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 500),
      hasProducts: !!(parsed?.data?.products || parsed?.products),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, requestedUrl: url });
  }
});

// ВРЕМЕННЫЙ диагностический роут — проверяет, отдаёт ли официальный API
// Wildberries "Цены и скидки" данные при обращении с сервера Render по
// личному API-токену продавца (токен передаётся через переменную окружения
// WB_TEST_API_TOKEN, в код не зашит). Если отвечает нормально — свою цену
// продавца можно получать этим способом вместо разбора страницы кабинета.
// Удалить после проверки.
app.get('/api/debug/wb-prices-test', async (req, res) => {
  const token = process.env.WB_TEST_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'WB_TEST_API_TOKEN не задан на сервере' });
    return;
  }
  const limit = req.query.limit || '10';
  const url = `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=${limit}&offset=0`;
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: token,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* не JSON — оставим сырой текст ниже */
    }
    res.json({
      requestedUrl: url,
      status: r.status,
      ok: r.ok,
      bodyPreview: text.slice(0, 800),
      goodsCount: parsed?.data?.listGoods?.length ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, requestedUrl: url });
  }
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    // Без этого браузеры иногда продолжают показывать старую версию dashboard.js/style.css
    // после деплоя новой — no-cache не отключает кэш полностью, а заставляет браузер каждый
    // раз спросить сервер "не изменился ли файл", прежде чем показать закэшированную копию.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Единообразные ответы на ошибки в async-роутах, которые не поймали исключение сами.
app.use((err, req, res, next) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

async function start() {
  await migrate();

  app.listen(PORT, () => {
    console.log(`marketradar слушает на http://localhost:${PORT}`);
  });

  const autoSyncMinutes = Number(process.env.AUTO_SYNC_MINUTES || 0);
  if (autoSyncMinutes > 0) {
    console.log(`Автосинхронизация включена: каждые ${autoSyncMinutes} мин.`);
    // Получение цены на сайте теперь идёт через настоящий браузер (Playwright) —
    // на пользователя с большим каталогом один проход может занять несколько минут
    // (см. src/priceScraper.js). Этот флаг не даёт следующему тику автосинхронизации
    // начаться поверх предыдущего, если тот ещё не закончился — иначе на маленьком
    // Render-инстансе быстро накопится несколько параллельных Chromium.
    let autoSyncRunning = false;
    setInterval(async () => {
      if (autoSyncRunning) {
        console.warn('Автосинхронизация: предыдущий проход ещё не завершился, пропускаем тик');
        return;
      }
      autoSyncRunning = true;
      try {
        const { rows } = await pool.query('SELECT user_id FROM wb_credentials');
        for (const { user_id: userId } of rows) {
          // Пропускаем, если продавец сам сейчас нажал "Синхронизировать" (см.
          // src/syncStatus.js и src/routes/wb.js) — не запускаем на один аккаунт два
          // параллельных прохода браузера сразу.
          if (syncStatus.getStatus(userId).running) {
            console.log(`Автосинхронизация: user ${userId} — уже идёт ручная синхронизация, пропускаем`);
            continue;
          }
          try {
            syncStatus.startSync(userId, { total: null });
            const result = await syncUserProducts(userId, (done, total) =>
              syncStatus.updateProgress(userId, done, total)
            );
            syncStatus.finishSync(userId, result);
            console.log(`Автосинхронизация: user ${userId} — ${result.count} товаров`);
          } catch (err) {
            syncStatus.failSync(userId, 'Синхронизация не удалась');
            console.error(`Автосинхронизация: user ${userId} — ошибка:`, err.message);
          }
        }
      } finally {
        autoSyncRunning = false;
      }
    }, autoSyncMinutes * 60 * 1000);
  }
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});
