require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const { pool, migrate } = require('./src/db');
const authRoutes = require('./src/routes/auth');
const wbRoutes = require('./src/routes/wb');
const { syncUserProducts } = require('./src/syncService');

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

app.use(express.static(path.join(__dirname, 'public')));

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
    setInterval(async () => {
      const { rows } = await pool.query('SELECT user_id FROM wb_credentials');
      for (const { user_id: userId } of rows) {
        try {
          const result = await syncUserProducts(userId);
          console.log(`Автосинхронизация: user ${userId} — ${result.count} товаров`);
        } catch (err) {
          console.error(`Автосинхронизация: user ${userId} — ошибка:`, err.message);
        }
      }
    }, autoSyncMinutes * 60 * 1000);
  }
}

start().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});
