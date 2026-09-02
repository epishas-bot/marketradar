// Получение "цены на сайте" (то, что реально платит покупатель — после скидки продавца
// и после СПП) через настоящий управляемый браузер (Playwright/Chromium), а не голый
// HTTP-запрос. Это не было прихотью: проверено вживую и подтверждено на реальных данных
// в этом проекте, что более простые пути тупиковые —
//
//   1. Голый HTTP-запрос (с сервера или из браузера продавца к card.wb.ru) — Wildberries
//      в 2026 году поставил перед данными о цене настоящую антибот-проверку (JS-челлендж),
//      которую не пройти без реального исполнения JS. Прямой запрос получает HTTP 498
//      с заглушкой-челленджем вместо данных.
//   2. Готовые сторонние API (WBCON и подобные) — да, они умеют получать цену, но их
//      данные оказались неточными (разошлись с реальной ценой на ~2% в тесте) и это
//      чужой, непрозрачный конвейер, за надёжность которого мы не отвечаем.
//   3. Обычный дата-центровый прокси (даже дорогой "stealth" уровень) — проходит JS-
//      антибот, но Wildberries ОТДЕЛЬНО, на уровне репутации IP, помечает дата-центровые
//      адреса как VPN/прокси и вместо карточки товара отдаёт главную страницу
//      (см. `<div id="blockedVpn">` в ответе — проверено вживую).
//
// Рабочий вариант — настоящий IP российского мобильного оператора (проверено вживую:
// LTE-прокси + обычный Chrome показали реальную карточку с реальной ценой без единой
// блокировки) плюс настоящий браузер, который честно проходит антибот-проверку сам.
//
// ВАЖНО про сессию/куки (добавлено после того, как в проде поймали блокировку "WB
// заблокировал доступ с текущего IP как подозрительную активность" при полностью рабочем
// прокси): разобрали, как это решают сторонние сервисы аналитики (EVIRMA, WBCON) — они
// либо ставят расширение прямо в реальный браузер продавца (то есть используют его же
// настоящую, годами живущую сессию с куками), либо явно контролируют "валидность и
// работоспособность кукис" на своей стороне. Ни один не бьёт по WB с абсолютно пустого,
// свежесозданного профиля без единой куки — а именно так раньше работал этот файл:
// `browser.newContext()` заново на КАЖДЫЙ товар. Для антибота это один из самых
// характерных признаков автоматизации (у настоящего человека в браузере уже есть история
// куки с прошлых визитов). Поэтому теперь один и тот же браузерный профиль (контекст)
// используется на весь прогон синхронизации и его куки (storageState) сохраняются в базу
// между запусками (см. loadStorageState/saveStorageState ниже) — так профиль копит
// историю совсем как настоящий браузер, а не начинает с нуля каждый раз.
//
// Как это устроено технически: страница товара сама, уже пройдя антибот-проверку,
// делает подгружаемый JS-запрос к внутреннему (не публичному) эндпоинту
// `www.wildberries.ru/__internal/u-card/cards/v4/detail?...&nm=<id>` — мы не бьём по
// этому URL напрямую (без сессии и куки антибота он тоже заблокирован), а перехватываем
// ответ на этот запрос, пока Playwright дожидается загрузки самой страницы товара.
// Формат ответа — тот же, что был у старого публичного card.wb.ru/cards/v4/detail.
//
// ВАЖНО про title: страница обновляет <title> вида "... купить за N ₽ ..." только
// референсной ценой БЕЗ учёта временных акций (проверено вживую: title показывал
// 2740 ₽, когда реальная цена с флеш-акцией была 2685 ₽) — поэтому цену нельзя брать
// из title, только из перехваченного JSON.

const { chromium } = require('playwright');
const { pool } = require('./db');

const SESSION_STATE_KEY = 'wb_browser_session';

const NAV_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS) || 8000; // пауза между товарами
const ROTATE_EVERY = Number(process.env.SCRAPE_ROTATE_EVERY) || 8; // смена IP раз в N товаров
const NAV_TIMEOUT_MS = Number(process.env.SCRAPE_NAV_TIMEOUT_MS) || 25000;
// Сколько раз подряд можно словить явную блокировку антибота WB ("Подозрительная
// активность"), прежде чем прекратить прогон досрочно. Смысл — не тратить время на
// оставшиеся товары каталога, если текущий IP уже точно заблокирован: WB сам называет
// время до разблокировки (обычно 15-20 минут), и до этого момента КАЖДЫЙ следующий
// запрос всё равно провалится тем же образом — упорствовать бессмысленно и только
// портит репутацию IP ещё сильнее.
const BLOCK_CIRCUIT_THRESHOLD = Number(process.env.SCRAPE_BLOCK_THRESHOLD) || 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Распознаёт характерную заглушку антибота WB ("Что-то не так... Подозрительная
// активность... Новая попытка через MM:SS") — проверено вживую (см. логи синхронизации):
// WB в открытую называет причину и даже время до снятия блокировки. Возвращает время до
// разблокировки в секундах, если удалось его найти в тексте, иначе null (значит просто
// "заблокировано", без известного таймера).
function detectAntibotBlock(bodyText) {
  if (!bodyText) return null;
  if (!/подозрительн|что-то не так/i.test(bodyText)) return null;
  const match = bodyText.match(/через\s+(\d{1,2}):(\d{2})/);
  if (match) {
    return Number(match[1]) * 60 + Number(match[2]);
  }
  return 0; // блокировка распознана, но время до снятия в тексте не нашли
}

// Небольшой случайный разброс вокруг базовой паузы — так последовательность запросов
// не выглядит машинно-регулярной (по совету профильных гайдов по обходу антибота
// маркетплейсов: случайные, а не фиксированные интервалы).
function jitter(baseMs) {
  return baseMs + Math.random() * baseMs * 0.6;
}

/**
 * Разбирает список прокси из переменной окружения RESIDENTIAL_PROXIES.
 * Формат одной записи — как выдают такие сервисы (LTE.Center и подобные):
 *   host:port:username:password
 * Несколько прокси — через запятую. Пример:
 *   RESIDENTIAL_PROXIES=77.37.141.90:2018:user1:pass1,1.2.3.4:2019:user2:pass2
 */
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

// Загружает сохранённые куки браузера (storageState) из прошлых прогонов — если их ещё
// не было (первый запуск) или чтение не удалось, возвращает undefined, и Playwright
// просто откроет чистый профиль (тогда накопление истории начнётся с этого раза).
async function loadStorageState() {
  try {
    const res = await pool.query('SELECT value FROM app_state WHERE key = $1', [SESSION_STATE_KEY]);
    if (res.rows.length > 0 && res.rows[0].value) {
      return JSON.parse(res.rows[0].value);
    }
  } catch (err) {
    console.warn('[priceScraper] не удалось загрузить сохранённую сессию браузера:', err.message);
  }
  return undefined;
}

// Сохраняет текущие куки контекста в базу, чтобы следующий запуск синхронизации (даже
// после перезапуска сервиса) продолжил с тем же "прожитым" профилем, а не с нуля.
// Best-effort: сбой сохранения не должен ронять саму синхронизацию.
async function saveStorageState(context) {
  if (!context) return;
  try {
    const state = await context.storageState();
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SESSION_STATE_KEY, JSON.stringify(state)]
    );
  } catch (err) {
    console.warn('[priceScraper] не удалось сохранить сессию браузера:', err.message);
  }
}

function extractKopecks(product) {
  if (!product) return null;
  return (
    product.sizes?.[0]?.price?.total ??
    product.sizes?.[0]?.price?.product ??
    product.salePriceU ??
    null
  );
}

/**
 * Достаёт цену на сайте (после скидки продавца и после СПП) для набора nmId через
 * настоящий браузер, за резидентными/мобильными прокси из RESIDENTIAL_PROXIES.
 * Возвращает Map(nmId -> цена в рублях); на самой Map — `.error`, если не получилось
 * получить ни одной цены (например, прокси не настроены или все запросы заблокированы),
 * или если прогон остановился досрочно из-за блокировки антибота (см. ниже).
 *
 * Это ощутимо медленнее одного HTTP-запроса: на каждый товар — полноценная загрузка
 * страницы плюс пауза (по умолчанию ~8 сек) перед следующей, чтобы не выглядеть ботом.
 * Для каталога в 50 товаров это несколько минут — предупреждение об этом есть в интерфейсе.
 *
 * Защита от блокировки антибота WB: если несколько товаров подряд (см.
 * SCRAPE_BLOCK_THRESHOLD, по умолчанию 3) упираются в явную заглушку WB "Подозрительная
 * активность" (см. detectAntibotBlock), прогон останавливается досрочно вместо того,
 * чтобы вхолостую перебрать весь оставшийся список — если WB заблокировал именно этот
 * IP, следующий товар провалится точно так же, а лишние попытки только продлевают
 * подозрение на IP. Необработанные товары просто останутся со старыми данными до
 * следующей синхронизации.
 *
 * onItemDone(nmId, sitePrice, name, imageUrl, done, total), если передан, вызывается
 * после каждого товара (успешного или нет — тогда все три будут null) и может быть
 * async: вызывающий код (syncService.js) использует это, чтобы сразу сохранить снимок
 * цены в базу и обновить прогресс — так продавец видит товар в таблице сразу, как
 * только он обработан, а не ждёт, пока обработаются вообще все. `name` — название
 * товара из того же перехваченного JSON (официальный API "Цены и скидки" его не
 * возвращает, поэтому единственный источник — сайт). `imageUrl` — реальный адрес
 * главного фото, который загрузила сама страница товара (см. комментарий у
 * imageResponsePromise ниже) — если по какой-то причине его поймать не удалось,
 * syncService.js сам подставит запасной вариант, собранный по формуле (wbImage.js).
 */
async function fetchSitePricesViaBrowser(nmIds, onItemDone) {
  const result = new Map();
  const proxies = parseProxies(process.env.RESIDENTIAL_PROXIES);

  if (proxies.length === 0) {
    result.error =
      'RESIDENTIAL_PROXIES не настроен — нет ни одного прокси для получения цены на сайте. ' +
      'См. README → «Откуда берутся две цены».';
    return result;
  }

  let browser = null;
  let context = null;
  let proxyIndex = 0;
  let requestsOnCurrentProxy = 0;
  let failedCount = 0;
  let lastError = null;
  let consecutiveBlocks = 0;
  let stoppedEarly = null; // текст причины, если прогон прервался досрочно из-за блокировки

  // Куки этого профиля переживают и смену прокси внутри одного прогона, и сам прогон —
  // при смене IP (openBrowserWithNextProxy) новый контекст открывается с теми же
  // накопленными куками, а не с чистого листа (см. заголовок файла: не выглядеть
  // "свежесозданным" профилем без единой куки — характерный признак бота). Загружаем
  // единожды перед стартом; после каждой ротации и в самом конце — сохраняем обратно.
  let sessionState = await loadStorageState();

  async function openBrowserWithNextProxy() {
    if (context) {
      // Забираем актуальные куки перед закрытием, чтобы следующий контекст (новый IP)
      // продолжил ту же историю, а не начал с той версии, что была загружена в начале.
      sessionState = await context.storageState().catch(() => sessionState);
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    const proxy = proxies[proxyIndex % proxies.length];
    proxyIndex += 1;
    browser = await chromium.launch({
      headless: true,
      proxy,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      locale: 'ru-RU',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      storageState: sessionState,
    });
    requestsOnCurrentProxy = 0;
  }

  const isFreshProfile = !sessionState;
  await openBrowserWithNextProxy();

  if (isFreshProfile) {
    // Самый первый запуск (ещё нет ни одной сохранённой куки) — заходим сначала на
    // главную страницу, как обычный посетитель, а не сразу открываем товар за товаром.
    // Это даёт профилю первые обычные куки WB (аналитика, регион и т.п.) ещё до того,
    // как он вообще коснётся карточек товаров. Не критично, если это не удастся — цикл
    // ниже всё равно продолжит работу и накопит историю по ходу самих товаров.
    try {
      const warmupPage = await context.newPage();
      await warmupPage.goto('https://www.wildberries.ru/', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      await sleep(jitter(2000));
      await warmupPage.close().catch(() => {});
    } catch (err) {
      console.warn('[priceScraper] не удалось "прогреть" новый профиль на главной странице:', err.message);
    }
  }

  try {
    for (let i = 0; i < nmIds.length; i++) {
      const nmId = Number(nmIds[i]);

      if (requestsOnCurrentProxy >= ROTATE_EVERY && proxies.length > 1) {
        await openBrowserWithNextProxy();
      }

      // Одна вкладка на товар, но КОНТЕКСТ (и его куки) — общий на весь прогон, а не
      // новый на каждый товар: так профиль постепенно копит настоящую историю визитов
      // вместо того, чтобы каждый раз выглядеть как "первый визит" случайного человека.
      const page = await context.newPage();

      let sitePrice = null;
      let name = null;
      let imageUrl = null;
      let blockSecondsLeft = null; // распознанная блокировка антибота WB на этом товаре

      try {
        const responsePromise = page
          .waitForResponse(
            (res) => res.url().includes('/u-card/cards/v4/detail') && res.url().includes(`nm=${nmId}`),
            { timeout: NAV_TIMEOUT_MS }
          )
          .catch(() => null);

        // Реальную картинку товара берём прямо из того, что грузит сама страница, а не
        // собираем URL по формуле (см. wbImage.js): страница уже точно знает, на каком
        // сервере-"корзине" лежит фото этого конкретного товара, а формула по vol/part
        // зависит от таблицы диапазонов, которая у WB время от времени меняется и может
        // устареть. Раз мы всё равно уже открываем страницу товара за прокси, это
        // "бесплатно" — второй запрос сайт делает сам, без нашего участия.
        const imageResponsePromise = page
          .waitForResponse(
            (res) => res.url().includes(`/${nmId}/images/`) && res.status() === 200,
            { timeout: NAV_TIMEOUT_MS }
          )
          .catch(() => null);

        await page.goto(`https://www.wildberries.ru/catalog/${nmId}/detail.aspx`, {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        });

        const [response, imageResponse] = await Promise.all([responsePromise, imageResponsePromise]);
        if (imageResponse) {
          imageUrl = imageResponse.url();
        }
        if (response) {
          const json = await response.json().catch(() => null);
          const products = json?.products || json?.data?.products || [];
          const product =
            products.find((p) => Number(p.id ?? p.nmId) === nmId) || products[0] || null;
          // Название берём отдельно от цены — даже если формат цены в ответе вдруг
          // изменится, само название почти наверняка останется на месте.
          name = product?.name || null;
          const kopecks = extractKopecks(product);
          if (kopecks != null) {
            sitePrice = kopecks / 100;
            result.set(nmId, sitePrice);
          } else {
            failedCount += 1;
            lastError = `nmId ${nmId}: ответ пришёл, но цена не нашлась в ожидаемых полях`;
            console.warn(`[priceScraper] ${lastError}`);
          }
        } else {
          failedCount += 1;
          // Раньше этот случай (страница загрузилась, но нужный внутренний запрос так и
          // не пришёл) не попадал в лог вообще — виден был только явный сетевой сбой
          // (типа ERR_TUNNEL_CONNECTION_FAILED), а такой "тихий" таймаут выглядел как
          // будто всё в порядке. Добавляем сюда же название вкладки и проверку на
          // известный признак блокировки (см. заголовок файла про blockedVpn) — это
          // помогает отличить "антибот не пропустил" от "прокси просто не достучался".
          let diagnostic = '';
          try {
            const title = await page.title();
            const url = page.url();
            const vpnBlock = await page.$('#blockedVpn').catch(() => null);
            // Короткий кусок видимого текста страницы — то, что реально показывается в
            // браузере: если это капча/антибот-заглушка, здесь почти наверняка будет
            // что-то вроде "проверьте, что вы не робот" или похожее, а не обычный текст
            // карточки товара. Обрезаем, чтобы не раздувать лог.
            const bodyText = await page
              .evaluate(() => document.body?.innerText?.slice(0, 200) || '')
              .catch(() => '');
            blockSecondsLeft = detectAntibotBlock(bodyText);
            diagnostic =
              ` — адрес: "${url}", заголовок: "${title}"` +
              `${vpnBlock ? ', обнаружен блок VPN/прокси (#blockedVpn)' : ''}` +
              `${bodyText ? `, текст на странице: "${bodyText.replace(/\s+/g, ' ').trim()}"` : ', текст на странице пуст'}`;
          } catch (diagErr) {
            // Не смогли прочитать даже это — не страшно, просто без диагностики.
          }
          lastError = `nmId ${nmId}: не дождались внутреннего запроса цены (антибот/блокировка/таймаут)${diagnostic}`;
          console.warn(`[priceScraper] ${lastError}`);
        }
      } catch (err) {
        failedCount += 1;
        lastError = `nmId ${nmId}: ${err.message}`;
        console.warn(`[priceScraper] ${lastError}`);
      } finally {
        // Закрываем только вкладку — сам контекст (и его куки) остаётся жить до конца
        // прогона или до следующей ротации прокси, см. комментарий выше.
        await page.close().catch(() => {});
      }

      requestsOnCurrentProxy += 1;
      // onItemDone получает результат сразу по каждому товару (а не пачкой в конце) —
      // это то, что позволяет syncService.js сохранять снимок в базу и продавцу видеть
      // строку в таблице сразу, как только она обработалась, а не ждать весь прогон.
      if (onItemDone) await onItemDone(nmId, sitePrice, name, imageUrl, i + 1, nmIds.length);

      if (blockSecondsLeft !== null) {
        // WB явно заблокировал именно этот IP (см. detectAntibotBlock выше) — продолжать
        // бить в него следующими товарами бессмысленно, каждый провалится точно так же.
        // Сразу переключаемся на новую попытку подключения (при ротации это может дать
        // другой IP — LTE Center и подобные сервисы меняют адрес за хостом каждые
        // несколько минут) и ждём заметно дольше обычного, а не как между обычными
        // товарами.
        consecutiveBlocks += 1;
        console.warn(
          `[priceScraper] блокировка антибота WB подряд №${consecutiveBlocks}` +
            (blockSecondsLeft > 0 ? ` (сам WB просит подождать ~${blockSecondsLeft} сек)` : '')
        );
        if (consecutiveBlocks >= BLOCK_CIRCUIT_THRESHOLD) {
          stoppedEarly =
            `WB заблокировал доступ с текущего IP как подозрительную активность ` +
            `${consecutiveBlocks} раз(а) подряд — дальше проверять товары сейчас бессмысленно, ` +
            `каждый следующий провалится так же. ${blockSecondsLeft > 0 ? `WB просит подождать ~${Math.ceil(blockSecondsLeft / 60)} мин. ` : ''}` +
            `Остановил синхронизацию досрочно (обработано ${i + 1} из ${nmIds.length} товаров) — ` +
            `остальные попробуются в следующий раз.`;
          console.warn(`[priceScraper] ${stoppedEarly}`);
          break;
        }
        if (proxies.length > 0) {
          await openBrowserWithNextProxy();
        }
        await sleep(jitter(NAV_DELAY_MS * 3));
        continue;
      }

      // Успешный или "обычный" (не блокировочный) неудачный товар — сбрасываем счётчик
      // подряд идущих блокировок, раз серия прервалась.
      consecutiveBlocks = 0;

      if (i < nmIds.length - 1) {
        await sleep(jitter(NAV_DELAY_MS));
      }
    }
  } finally {
    // Сохраняем накопленные куки в базу перед закрытием — следующий прогон (даже после
    // перезапуска сервиса) продолжит с этим же "прожитым" профилем, а не с нуля.
    await saveStorageState(context);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  if (stoppedEarly) {
    result.error = stoppedEarly;
  } else if (result.size === 0 && nmIds.length > 0) {
    result.error =
      `Не удалось получить ни одной цены с сайта (${failedCount} из ${nmIds.length} товаров не удались). ` +
      `Последняя ошибка: ${lastError || 'неизвестна'}.`;
  }

  return result;
}

module.exports = { fetchSitePricesViaBrowser };
