// Строит URL миниатюры товара WB по артикулу (nmId) — используется в таблице "Товары
// и СПП", чтобы продавцу было видно, какой именно товар в строке, а не только числовой
// артикул.
//
// У Wildberries нет официального API "дай мне картинку по nmId" — адрес картинки
// собирается по формуле из самого артикула:
//   vol  = nmId // 100000
//   part = nmId // 1000
//   URL  = https://basket-{NN}.wbbasket.ru/vol{vol}/part{part}/{nmId}/images/c246x328/1.webp
// где {NN} — номер "корзины" (сервера-хранилища), который зависит от диапазона, в
// который попадает vol. Это тот же приём, которым пользуется большинство сторонних
// WB-инструментов — прямого способа получить номер корзины по артикулу у самого WB нет.
//
// Проблема: WB время от времени добавляет новые корзины (диапазоны vol растут), и любая
// зашитая в код таблица со временем устаревает — тогда для САМЫХ НОВЫХ товаров ссылка на
// картинку соберётся неверно (у старых товаров диапазоны исторически не меняются, они
// продолжат работать). Чтобы не зависеть только от таблицы на момент написания кода,
// модуль при старте пытается подтянуть актуальный список диапазонов с самого WB (тем же
// файлом, которым пользуется сайт) и держит его в памяти, обновляя раз в несколько
// часов; если подтянуть не удалось (сеть, эндпоинт изменился) — используется запасная
// таблица ниже. В любом случае ничего не ломается: если конкретная картинка всё равно не
// найдётся по собранному URL (устаревший диапазон, товар без фото и т.п.), фронтенд
// просто скрывает битую миниатюру, а не показывает "сломанную картинку" (см.
// public/js/dashboard.js).

const FALLBACK_RANGES = [
  { maxVol: 143, basket: 1 },
  { maxVol: 287, basket: 2 },
  { maxVol: 431, basket: 3 },
  { maxVol: 719, basket: 4 },
  { maxVol: 1007, basket: 5 },
  { maxVol: 1061, basket: 6 },
  { maxVol: 1115, basket: 7 },
  { maxVol: 1169, basket: 8 },
  { maxVol: 1313, basket: 9 },
  { maxVol: 1601, basket: 10 },
  { maxVol: 1655, basket: 11 },
  { maxVol: 1919, basket: 12 },
  { maxVol: 2045, basket: 13 },
  { maxVol: 2189, basket: 14 },
  { maxVol: 2405, basket: 15 },
  { maxVol: 2621, basket: 16 },
  { maxVol: 2837, basket: 17 },
  { maxVol: 3053, basket: 18 },
  { maxVol: 3269, basket: 19 },
  { maxVol: 3485, basket: 20 },
  { maxVol: 3701, basket: 21 },
  { maxVol: 3917, basket: 22 },
  { maxVol: 4133, basket: 23 },
  { maxVol: 4349, basket: 24 },
  { maxVol: 4565, basket: 25 },
];

let liveRanges = null; // подтянутые с WB диапазоны, если получилось
let refreshing = false;

async function refreshRangesFromWb() {
  if (refreshing) return;
  refreshing = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res;
    try {
      res = await fetch('https://static-basket-01.wbbasket.ru/vol0/data/basket-vol.json', {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      console.warn(`[wbImage] не удалось обновить таблицу корзин: WB ответил ${res.status}`);
      return;
    }
    const json = await res.json();
    if (Array.isArray(json) && json.length > 0) {
      const parsed = json
        .map((r) => ({ maxVol: Number(r.max ?? r.maxVol), basket: Number(r.basket) }))
        .filter((r) => Number.isFinite(r.maxVol) && Number.isFinite(r.basket))
        .sort((a, b) => a.maxVol - b.maxVol);
      if (parsed.length > 0) {
        liveRanges = parsed;
        console.log(
          `[wbImage] таблица корзин обновлена: ${parsed.length} диапазонов, покрывает vol до ${parsed[parsed.length - 1].maxVol}`
        );
      } else {
        console.warn('[wbImage] WB отдал пустой/нераспознанный формат таблицы корзин, оставляем запасную');
      }
    }
  } catch (err) {
    // Не критично для работы сервиса в целом (миниатюра — не обязательная часть), но
    // логируем, иначе непонятно, почему картинки не находятся: используется устаревшая
    // запасная таблица (см. FALLBACK_RANGES выше), и это стоит знать при диагностике.
    console.warn(`[wbImage] не удалось обновить таблицу корзин, используем запасную: ${err.message}`);
  } finally {
    refreshing = false;
  }
}

// Пробуем обновиться сразу при старте процесса и затем раз в 6 часов, в фоне, не
// блокируя ничего (первый вызов миниатюр использует запасную таблицу, если не успел).
refreshRangesFromWb();
const refreshTimer = setInterval(refreshRangesFromWb, 6 * 60 * 60 * 1000);
if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

let warnedBeyondRange = false;

function basketForVol(vol) {
  const ranges = liveRanges || FALLBACK_RANGES;
  for (const r of ranges) {
    if (vol <= r.maxVol) return r.basket;
  }
  // Диапазон новее всех известных — берём последнюю известную корзину как лучшую догадку
  // (скорее всего неверную для по-настоящему новых товаров). Предупреждаем об этом в
  // логах один раз за запуск процесса, а не на каждый товар, чтобы не засорять лог.
  if (!warnedBeyondRange) {
    warnedBeyondRange = true;
    console.warn(
      `[wbImage] vol ${vol} выходит за пределы известных диапазонов корзин ` +
        `(максимум ${ranges[ranges.length - 1].maxVol}) — миниатюра для таких товаров, ` +
        `скорее всего, будет собрана неверно, если реальный адрес не поймать из браузера`
    );
  }
  return ranges[ranges.length - 1].basket;
}

/**
 * Собирает URL главной миниатюры товара по артикулу. Не требует ни токена, ни браузера,
 * ни прокси — считается напрямую из числа nmId, поэтому доступен даже если получение
 * цены на сайте (priceScraper.js) не сработало. Может ошибиться для самых новых
 * товаров, если таблица диапазонов ещё не успела обновиться, — это ожидаемо и не ломает
 * интерфейс (см. комментарий в начале файла).
 */
function buildThumbnailUrl(nmId) {
  const id = Number(nmId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  const basket = String(basketForVol(vol)).padStart(2, '0');
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${id}/images/c246x328/1.webp`;
}

module.exports = { buildThumbnailUrl };
