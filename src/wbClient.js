// Клиент для двух источников цены по одному и тому же товару:
//
//  1. "Цена продавца" — официальный API Wildberries для продавцов
//     (Цены и скидки: https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter).
//     Это подтверждённый, документированный эндпоинт — см. https://dev.wildberries.ru.
//
//  2. "Цена на сайте" — витринная цена товара, которую видит покупатель на wildberries.ru.
//     У WB нет официального публичного API "дай мне текущую цену с учётом СПП для этого
//     nmId" — те же данные получают все сторонние СПП-трекеры (репрайсеры, боты в Telegram),
//     дергая внутренний эндпоинт карточки товара (card.wb.ru), который использует сам сайт.
//     Такой эндпоинт нигде официально не задокументирован и может измениться без предупреждения —
//     см. предупреждение и инструкцию по проверке в README ("Что может сломаться").
//
// СПП считается очень просто, как и было описано в задаче:
//   СПП% = (цена_продавца − цена_на_сайте) / цена_продавца × 100

const PRICES_HOST = 'https://discounts-prices-api.wildberries.ru';
const CARD_HOST = 'https://card.wb.ru';
const DEST_REGION = process.env.DEST_REGION || '-1257786'; // регион по умолчанию — Москва
const CARD_BATCH_SIZE = 50; // сколько nmId запрашивать за один вызов card.wb.ru
const CARD_BATCH_DELAY_MS = 250; // пауза между батчами, чтобы не долбить публичный эндпоинт

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class WbApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WbApiError';
    this.status = status;
  }
}

/**
 * Тянет ВСЕ товары продавца с ценами через официальный API "Цены и скидки".
 * Возвращает массив { nmId, vendorCode, price, discount, sellerPrice }.
 */
async function fetchAllSellerPrices(token) {
  const items = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const url = `${PRICES_HOST}/api/v2/list/goods/filter?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: token },
    });

    if (res.status === 401 || res.status === 403) {
      throw new WbApiError(
        'Wildberries отклонил токен (401/403). Проверьте, что токен действителен и у него есть права на категорию "Цены и скидки".',
        res.status
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WbApiError(`WB API вернул ошибку ${res.status}: ${body.slice(0, 300)}`, res.status);
    }

    const json = await res.json();
    // Официальная схема ответа: { data: { listGoods: [...] } }. На случай изменений
    // в WB API проверяем и альтернативные варианты формы ответа.
    const list = json?.data?.listGoods || json?.listGoods || json?.data || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const item of list) {
      const size = Array.isArray(item.sizes) && item.sizes.length > 0 ? item.sizes[0] : null;
      const price = size?.price ?? item.price ?? null;
      const discount = item.discount ?? 0;
      const discountedPrice =
        size?.discountedPrice ?? (price != null ? Math.round(price * (1 - discount / 100)) : null);

      items.push({
        nmId: item.nmID ?? item.nmId,
        vendorCode: item.vendorCode ?? null,
        price,
        discount,
        sellerPrice: discountedPrice, // это и есть "цена, указанная продавцом", которую видно на витрине до СПП
      });
    }

    if (list.length < limit) break;
    offset += limit;
  }

  return items.filter((i) => i.nmId);
}

/**
 * Достаёт текущую цену товара на сайте (как её видит обычный посетитель) для набора nmId.
 * Возвращает Map(nmId -> цена в рублях) — только для тех nmId, которые удалось получить.
 */
// card.wb.ru — не официальный API, и в 2026 году он стал заметно строже проверять,
// что запрос похож на настоящий браузер. Без этих заголовков WB отвечает 403 на
// КАЖДЫЙ запрос (а не только на некоторые) — именно поэтому раньше "цена на сайте"
// могла быть пустой абсолютно у всех товаров сразу.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://www.wildberries.ru/',
  Origin: 'https://www.wildberries.ru',
};

async function fetchSitePrices(nmIds) {
  const result = new Map();
  let failedBatches = 0;
  let lastError = null;

  for (let i = 0; i < nmIds.length; i += CARD_BATCH_SIZE) {
    const batch = nmIds.slice(i, i + CARD_BATCH_SIZE);
    const url = `${CARD_HOST}/cards/v2/detail?appType=1&curr=rub&dest=${DEST_REGION}&spp=0&nm=${batch.join(';')}`;

    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) {
        const json = await res.json();
        const products = json?.data?.products || [];
        for (const p of products) {
          const nmId = p.id ?? p.nmId;
          // Разные версии этого эндпоинта отдавали цену в разных местах и в копейках —
          // проверяем несколько известных вариантов и берём первый, который нашёлся.
          const kopecks =
            p.salePriceU ??
            p.sizes?.[0]?.price?.total ??
            p.sizes?.[0]?.price?.product ??
            p.priceU ??
            null;
          if (nmId && kopecks != null) {
            result.set(Number(nmId), kopecks / 100);
          }
        }
      } else {
        failedBatches += 1;
        const body = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        console.warn(`[wbClient] card.wb.ru батч ${i}-${i + batch.length} вернул ${res.status}`);
      }
    } catch (err) {
      failedBatches += 1;
      lastError = err.message;
      console.warn(`[wbClient] card.wb.ru батч ${i}-${i + batch.length} упал:`, err.message);
    }

    if (i + CARD_BATCH_SIZE < nmIds.length) {
      await sleep(CARD_BATCH_DELAY_MS);
    }
  }

  const totalBatches = Math.ceil(nmIds.length / CARD_BATCH_SIZE);
  if (result.size === 0 && nmIds.length > 0) {
    result.error =
      `Не удалось получить ни одной цены с сайта (${failedBatches} из ${totalBatches} запросов не удались). ` +
      `Последняя ошибка: ${lastError || 'неизвестна'}. Возможно, Wildberries заблокировал источник, с которого работает сервис.`;
  }

  return result;
}

function computeSppPercent(sellerPrice, sitePrice) {
  if (!sellerPrice || sellerPrice <= 0 || sitePrice == null) return null;
  const raw = (1 - sitePrice / sellerPrice) * 100;
  return Math.round(Math.max(0, raw) * 10) / 10; // одна десятая процента, отрицательные значения (шум) обрезаем в 0
}

/** Лёгкая проверка токена — используется при подключении аккаунта. */
async function verifyToken(token) {
  const url = `${PRICES_HOST}/api/v2/list/goods/filter?limit=1&offset=0`;
  const res = await fetch(url, { headers: { Authorization: token } });
  if (res.status === 401 || res.status === 403) {
    throw new WbApiError('Wildberries не принял этот токен. Проверьте, что он скопирован полностью и не истёк.');
  }
  if (!res.ok) {
    throw new WbApiError(`Не удалось проверить токен: WB API вернул ${res.status}`);
  }
  return true;
}

module.exports = {
  fetchAllSellerPrices,
  fetchSitePrices,
  computeSppPercent,
  verifyToken,
  WbApiError,
};
