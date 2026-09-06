// Одноразовый РУЧНОЙ инструмент (запускается не на Render, а локально/на VPS человеком) —
// открывает НЕ-headless (видимый) браузер за тем же прокси, что использует боевой
// скрейпинг цены на сайте (priceScraper.js), чтобы человек вручную вошёл в личный
// кабинет ПОКУПАТЕЛЯ Wildberries по номеру телефона + коду из SMS. После входа сохраняет
// получившуюся АВТОРИЗОВАННУЮ сессию (куки) в ту же таблицу app_state и под тем же
// ключом ('wb_browser_session'), которую priceScraper.js уже читает при каждом запуске
// синхронизации (см. loadStorageState/saveStorageState там же) — то есть основной код
// трогать не пришлось вообще: он просто увидит более "доверенную" сессию со следующего
// прогона, ничего в нём для этого менять не нужно.
//
// ЗАЧЕМ ЭТО ЛУЧШЕ, ЧЕМ ПРОСТО НАКОПЛЕННЫЕ АНОНИМНЫЕ КУКИ: настоящий, подтверждённый по
// SMS аккаунт покупателя — гораздо более сильный сигнал "живой человек, не бот" для
// антибота WB, чем анонимная сессия, которая просто дольше живёт. Это тот же принцип,
// что и у EVIRMA (расширение в настоящем залогиненном браузере продавца), только здесь
// не нужно ставить расширение в браузер покупателя — один раз входим сами и переиспользуем
// сессию на сервере.
//
// ВАЖНО, ЧЕСТНО: цена на сайте у залогиненного покупателя ТЕОРЕТИЧЕСКИ может быть
// персонализирована под конкретный аккаунт (история покупок, статус и т.п.) — то, что вы
// увидите после входа, это цена именно для ЭТОГО аккаунта, а не гарантированно то же
// самое, что видит случайный анонимный посетитель. Стоит несколько дней сверять цены на
// одних и тех же товарах до и после входа, прежде чем полностью полагаться на
// залогиненную сессию как на основной источник (см. README).
//
// КАК ЗАПУСТИТЬ (с той же машины/VPS, что и боевой прокси, чтобы вход и последующий
// боевой скрейпинг шли с одного и того же IP — иначе для WB это будет выглядеть как
// "чужой" вход с нового устройства, что тоже может насторожить антибот):
//   1. В .env на этой машине укажите DATABASE_URL — ВНЕШНИЙ (External) адрес подключения
//      к Postgres из панели Render (не тот, что используется самим сервисом на Render —
//      тот внутренний и снаружи Render insight недоступен), и RESIDENTIAL_PROXIES — тот
//      же прокси (VPS_IP:порт:логин:пароль), что уже прописан на Render.
//   2. node scripts/loginAndSaveSession.js
//   3. В открывшемся окне браузера — иконка профиля → «Войти» → по номеру телефона →
//      ввести код из SMS. Дождитесь, чтобы в углу появилось «Профиль» / имя аккаунта.
//   4. Вернуться в терминал и нажать Enter — сессия сохранится в базу.

require('dotenv').config();
const { chromium } = require('playwright');
const { pool } = require('../src/db');

const SESSION_STATE_KEY = 'wb_browser_session';

function parseProxies(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':');
      const [host, port, username, password] = parts;
      if (!host || !port) return null;
      return {
        server: `http://${host}:${port}`,
        username: username || undefined,
        password: password || undefined,
      };
    })
    .filter(Boolean);
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    console.log(promptText);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function main() {
  const proxies = parseProxies(process.env.RESIDENTIAL_PROXIES);
  if (proxies.length === 0) {
    console.error(
      'RESIDENTIAL_PROXIES не задан в .env этой машины — без прокси нет смысла логиниться: ' +
        'сессия должна создаваться с того же IP, с которого потом пойдёт боевой скрейпинг.'
    );
    process.exit(1);
  }
  const proxy = proxies[0];

  console.log(`Открываю браузер за прокси ${proxy.server}...`);
  const browser = await chromium.launch({
    headless: false, // окно должно быть видно — вход по SMS делает человек вручную
    proxy,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded' });

  await waitForEnter(
    '\nВ открывшемся окне: иконка профиля (обычно справа сверху) → «Войти» → номер телефона → ' +
      'код из SMS. Когда увидите, что вход выполнен (в углу — имя/иконка аккаунта), вернитесь ' +
      'сюда и нажмите Enter...'
  );

  const state = await context.storageState();
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SESSION_STATE_KEY, JSON.stringify(state)]
  );
  console.log('Готово — сессия сохранена в базу. priceScraper.js подхватит её при следующей синхронизации.');

  await browser.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
