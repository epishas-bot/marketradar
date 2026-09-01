// Клиент официального API Wildberries для продавцов — "цена продавца"
// (Цены и скидки: https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter).
// Это подтверждённый, документированный эндпоинт — см. https://dev.wildberries.ru.
//
// "Цена на сайте" (после скидки продавца и после СПП) получает отдельный модуль —
// src/priceScraper.js, через управляемый браузер за резидентным/мобильным прокси.
// Смотрите комментарий в начале того файла и README → «Откуда берутся две цены» о том,
// почему это не может быть простым HTTP-запросом отсюда же.
//
// СПП считается очень просто, как и было описано в задаче:
//   СПП% = (цена_продавца − цена_на_сайте) / цена_продавца × 100

const PRICES_HOST = 'https://discounts-prices-api.wildberries.ru';

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
  computeSppPercent,
  verifyToken,
  WbApiError,
};
