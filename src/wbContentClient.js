// Клиент официального API Wildberries категории "Контент" — отдаёт название и фото
// карточки товара напрямую от WB, тем же самым токеном продавца, что уже используется
// в wbClient.js для цены (см. https://dev.wildberries.ru, раздел "Контент"). Это
// собственные карточки продавца, а не публичная витрина сайта — поэтому в отличие от
// "цены на сайте" (см. priceScraper.js) для этого НЕ нужен ни браузер, ни прокси, ни
// какая-либо имитация живого посетителя: обычный подписанный токеном HTTP-запрос,
// как и для цен.
//
// ВАЖНО про токен: у токена продавца в личном кабинете каждая категория API включается
// ОТДЕЛЬНЫМ чекбоксом (Профиль → Настройки → Доступ к API). Токен, которым уже
// пользуется wbClient.js, мог быть выпущен только с категорией "Цены и скидки" — для
// этого модуля в том же токене (или отдельном, не важно — WB проверяет права, а не то,
// какой именно токен) должна быть дополнительно включена категория "Контент". Если её
// нет, WB отвечает 401/403 — fetchAllProductContent в этом случае НЕ бросает исключение
// и не ломает всю синхронизацию, а возвращает пустой результат с `.error`, понятным
// текстом объясняющим, что нужно включить категорию в кабинете (см. syncService.js и
// dashboard.js, где это показывается продавцу как предупреждение).

const CONTENT_HOST = 'https://content-api.wildberries.ru';
const PAGE_LIMIT = 100;

class WbContentApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WbContentApiError';
    this.status = status;
  }
}

// WB отдаёт фото карточки сразу несколькими готовыми размерами (не нужно ничего
// собирать по формуле из артикула, как раньше приходилось делать в wbImage.js для
// запасного варианта) — но, на случай если названия полей в ответе когда-нибудь
// изменятся или будут другими для части товаров, перебираем несколько вариантов, а не
// полагаемся ровно на одно имя поля. `tm` (примерно 75x100) ближе всего по размеру к
// миниатюре 40x40 в интерфейсе — самый лёгкий вариант по трафику.
function extractMainPhotoUrl(card) {
  const photos = card?.photos;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const first = photos[0];
  if (!first) return null;
  if (typeof first === 'string') return first; // на случай другого формата ответа
  return first.tm || first.square || first.c246x328 || first.c516x688 || first.big || null;
}

/**
 * Тянет название и фото ВСЕХ карточек продавца через официальный API "Контент",
 * постранично (курсор — по последней карточке предыдущей страницы, см. документацию
 * WB). Возвращает Map(nmId -> { name, imageUrl }).
 *
 * Best-effort: сетевые сбои и отказ WB (401/403 — обычно означает, что у токена не
 * включена категория "Контент") не бросаются наружу как исключение, а помечаются полем
 * `.error` на самой Map — так один упавший шаг не должен ронять всю синхронизацию
 * (см. syncService.js).
 */
async function fetchAllProductContent(token) {
  const result = new Map();
  let cursor = { limit: PAGE_LIMIT };

  while (true) {
    let res;
    try {
      res = await fetch(`${CONTENT_HOST}/content/v2/get/cards/list`, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          settings: {
            cursor,
            filter: { withPhoto: -1 },
          },
        }),
      });
    } catch (err) {
      result.error = `Не удалось связаться с API "Контент" WB: ${err.message}`;
      return result;
    }

    if (res.status === 401 || res.status === 403) {
      result.error =
        'WB отклонил токен для категории "Контент" (401/403) — скорее всего, у токена в личном ' +
        'кабинете не включена эта категория доступа (Профиль → Настройки → Доступ к API → отметить ' +
        '"Контент"). Название и фото товаров не обновлены в этот раз — то, что уже было сохранено ' +
        'раньше (в том числе через сайт), осталось как было.';
      return result;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      result.error = `API "Контент" WB вернул ошибку ${res.status}: ${body.slice(0, 300)}`;
      return result;
    }

    const json = await res.json().catch(() => null);
    const cards = json?.cards || [];
    if (!Array.isArray(cards) || cards.length === 0) break;

    for (const card of cards) {
      const nmId = Number(card.nmID ?? card.nmId);
      if (!nmId) continue;
      result.set(nmId, {
        name: card.title || null,
        imageUrl: extractMainPhotoUrl(card),
      });
    }

    if (cards.length < PAGE_LIMIT) break; // последняя страница была неполной — дальше нет

    const last = cards[cards.length - 1];
    cursor = {
      limit: PAGE_LIMIT,
      updatedAt: last.updatedAt,
      nmID: last.nmID ?? last.nmId,
    };
  }

  return result;
}

module.exports = { fetchAllProductContent, WbContentApiError };
