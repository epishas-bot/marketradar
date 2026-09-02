// Клиент официального API WB категории "Статистика" — отчёт о продажах по реализации
// (https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod). Тем же
// принципом токена, что и цены/контент, но даёт совсем другую вещь: не текущую цену, а
// ФАКТИЧЕСКУЮ историю того, по какой цене товар реально продавался раньше — с реальным
// процентом СПП по каждой продаже, от самого WB, без браузера, прокси и антибота.
//
// Матчасть (см. README → «СПП из отчёта о реализации» и переписку с продавцом): СПП
// официально расшифровывается как "Скидка Постоянного Покупателя" — это ровно то, что
// WB в своём собственном отчёте о реализации называет полем `ppvz_spp_prc`. Отчёт даёт,
// по каждой проданной единице товара:
//   - retail_price               — розничная цена без скидок
//   - retail_price_withdisc_rub  — розничная цена с учётом СКИДКИ ПРОДАВЦА (то же самое
//                                   по смыслу, что discountedPrice в API "Цены и скидки")
//   - ppvz_spp_prc                — СПП, в процентах: дополнительная скидка от WB поверх
//                                   скидки продавца, которую в моменте видел покупатель
//   - doc_type_name               — "Продажа" или "Возврат"
//   - sale_dt / rr_dt             — дата продажи / дата отчёта
//   - nm_id, sa_name, rrd_id      — артикул, код продавца, уникальный ID строки отчёта
//
// Фактическая цена, которую заплатил покупатель, отсюда считается как:
//   цена_покупателя = retail_price_withdisc_rub × (1 − ppvz_spp_prc / 100)
// (это не официальная формула из документации, а наш вывод из описания полей —
// стоит свериться на реальных данных после первого прогона).
//
// ВАЖНО: это ИСТОРИЯ ПРОДАЖ, а не срез "какая СПП сейчас у товара, который никто не
// покупал" — строка появляется только в момент, когда товар реально купили. Для
// товаров без продаж за период тут ничего не будет — это дополняет, а не заменяет
// текущий мониторинг через priceScraper.js.
//
// Токен должен иметь включённую категорию доступа "Статистика" (это ОТДЕЛЬНАЯ
// категория от "Цены и скidki" и "Контент" — см. README). Без неё WB отвечает 401/403 —
// как и другие клиенты в этом проекте, это best-effort: ошибка не бросается наружу,
// а помечается полем `.error` (см. fetchRealizationHistory ниже).
//
// Ограничение отчёта — данные доступны примерно за последние 3 месяца (скользящее
// окно), не глубже. Пагинация — курсором rrd_id: передаём rrd_id последней уже
// обработанной строки, WB отдаёт только более новые. Это удобно и для повторных
// синхронизаций — можно сохранять этот курсор (см. syncService.js, таблица app_state)
// и каждый раз запрашивать только то, что появилось нового с прошлого раза, вместо
// того чтобы каждый раз перекачивать все 3 месяца заново.

const STATISTICS_HOST = 'https://statistics-api.wildberries.ru';
const PAGE_LIMIT = 100000; // максимум, который отдаёт WB за один запрос этого отчёта
// WB просит не дёргать этот конкретный отчёт чаще, чем примерно раз в минуту — это
// имеет значение только если отчёт не уместился в одну страницу (для большинства
// продавцов это редкость — сотни-тысячи строк в квартал, а не 100 000).
const BETWEEN_PAGES_DELAY_MS = 21000;

class WbStatisticsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WbStatisticsApiError';
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReturnRow(row) {
  const docType = row?.doc_type_name || row?.docTypeName;
  return typeof docType === 'string' && /возврат/i.test(docType);
}

/**
 * Тянет строки отчёта о реализации начиная с rrdIdFrom (0 — с самого начала окна WB,
 * т.е. примерно за последние 3 месяца; иначе — только новее сохранённого курсора).
 * Возвращает { rows, lastRrdId } либо { rows: [], error, lastRrdId: rrdIdFrom } при сбое
 * (сбой не бросается исключением — см. заголовок файла).
 *
 * rows — уже отфильтрованные (без "Возврат") и облегчённые объекты:
 *   { nmId, vendorCode, saleDate, sellerPrice, sppPercent, buyerPrice, rrdId }
 */
async function fetchRealizationHistory(token, rrdIdFrom = 0) {
  const rows = [];
  let rrdid = rrdIdFrom;
  let lastRrdId = rrdIdFrom;
  // WB требует диапазон дат параметром, даже когда реальная пагинация идёт по rrd_id —
  // берём заведомо широкое окно (документированный максимум глубины отчёта), дальше
  // WB сам ограничит тем, что реально есть.
  const dateFrom = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let page = 0;
  while (true) {
    let res;
    try {
      const url =
        `${STATISTICS_HOST}/api/v5/supplier/reportDetailByPeriod` +
        `?dateFrom=${dateFrom}&rrdid=${rrdid}&limit=${PAGE_LIMIT}`;
      res = await fetch(url, { headers: { Authorization: token } });
    } catch (err) {
      return { rows, lastRrdId, error: `Не удалось связаться с API "Статистика" WB: ${err.message}` };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        rows,
        lastRrdId,
        error:
          'WB отклонил токен для категории "Статистика" (401/403) — скорее всего, у токена в личном ' +
          'кабинете не включена эта категория доступа (Профиль → Настройки → Доступ к API → отметить ' +
          '"Статистика"). История продаж и реальная СПП по прошлым продажам не обновлены в этот раз.',
      };
    }
    // WB просит не дёргать этот отчёт слишком часто — на явное превышение лимита не
    // ломаем всю синхронизацию, а просто останавливаемся на том, что успели получить.
    if (res.status === 429) {
      return {
        rows,
        lastRrdId,
        error: 'WB ограничил частоту запросов к отчёту о реализации (429) — попробуем ещё раз в следующий раз.',
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { rows, lastRrdId, error: `API "Статистика" WB вернул ошибку ${res.status}: ${body.slice(0, 300)}` };
    }

    const json = await res.json().catch(() => null);
    const batch = Array.isArray(json) ? json : [];
    if (batch.length === 0) break;

    for (const row of batch) {
      const rowRrdId = Number(row.rrd_id ?? row.rrdId);
      if (Number.isFinite(rowRrdId) && rowRrdId > lastRrdId) lastRrdId = rowRrdId;

      if (isReturnRow(row)) continue;

      const nmId = Number(row.nm_id ?? row.nmId);
      const sppPercent = row.ppvz_spp_prc != null ? Number(row.ppvz_spp_prc) : null;
      const sellerPrice = row.retail_price_withdisc_rub != null ? Number(row.retail_price_withdisc_rub) : null;
      const saleDate = row.sale_dt || row.rr_dt || null;
      if (!nmId || !saleDate) continue;

      const buyerPrice =
        sellerPrice != null && sppPercent != null ? sellerPrice * (1 - sppPercent / 100) : null;

      rows.push({
        nmId,
        vendorCode: row.sa_name || row.vendorCode || null,
        saleDate,
        sellerPrice,
        sppPercent,
        buyerPrice,
        rrdId: rowRrdId,
      });
    }

    page += 1;
    if (batch.length < PAGE_LIMIT) break; // последняя страница
    rrdid = lastRrdId;
    await sleep(BETWEEN_PAGES_DELAY_MS); // не долбим отчёт слишком часто на многостраничных выгрузках
  }

  return { rows, lastRrdId };
}

module.exports = { fetchRealizationHistory, WbStatisticsApiError };
