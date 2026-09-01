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

const NAV_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS) || 5000; // пауза между товарами
const ROTATE_EVERY = Number(process.env.SCRAPE_ROTATE_EVERY) || 15; // смена IP раз в N товаров
const NAV_TIMEOUT_MS = Number(process.env.SCRAPE_NAV_TIMEOUT_MS) || 25000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * получить ни одной цены (например, прокси не настроены или все запросы заблокированы).
 *
 * Это ощутимо медленнее одного HTTP-запроса: на каждый товар — полноценная загрузка
 * страницы плюс пауза (по умолчанию ~5 сек) перед следующей, чтобы не выглядеть ботом.
 * Для каталога в 50 товаров это несколько минут — предупреждение об этом есть в интерфейсе.
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
  let proxyIndex = 0;
  let requestsOnCurrentProxy = 0;
  let failedCount = 0;
  let lastError = null;

  async function openBrowserWithNextProxy() {
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
    requestsOnCurrentProxy = 0;
  }

  await openBrowserWithNextProxy();

  try {
    for (let i = 0; i < nmIds.length; i++) {
      const nmId = Number(nmIds[i]);

      if (requestsOnCurrentProxy >= ROTATE_EVERY && proxies.length > 1) {
        await openBrowserWithNextProxy();
      }

      const context = await browser.newContext({
        locale: 'ru-RU',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      let sitePrice = null;
      let name = null;
      let imageUrl = null;

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
            const vpnBlock = await page.$('#blockedVpn').catch(() => null);
            diagnostic = ` — заголовок страницы: "${title}"${vpnBlock ? ', обнаружен блок VPN/прокси (#blockedVpn)' : ''}`;
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
        await context.close().catch(() => {});
      }

      requestsOnCurrentProxy += 1;
      // onItemDone получает результат сразу по каждому товару (а не пачкой в конце) —
      // это то, что позволяет syncService.js сохранять снимок в базу и продавцу видеть
      // строку в таблице сразу, как только она обработалась, а не ждать весь прогон.
      if (onItemDone) await onItemDone(nmId, sitePrice, name, imageUrl, i + 1, nmIds.length);

      if (i < nmIds.length - 1) {
        await sleep(jitter(NAV_DELAY_MS));
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (result.size === 0 && nmIds.length > 0) {
    result.error =
      `Не удалось получить ни одной цены с сайта (${failedCount} из ${nmIds.length} товаров не удались). ` +
      `Последняя ошибка: ${lastError || 'неизвестна'}.`;
  }

  return result;
}

module.exports = { fetchSitePricesViaBrowser };
