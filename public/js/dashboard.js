const connectPanel = document.getElementById('connect-panel');
const productsPanel = document.getElementById('products-panel');
const tokenInput = document.getElementById('wb-token');
const tokenError = document.getElementById('token-error');
const saveTokenBtn = document.getElementById('save-token-btn');
const syncBtn = document.getElementById('sync-btn');
const syncStatus = document.getElementById('sync-status');
const filterInput = document.getElementById('filter-input');
const productsTable = document.getElementById('products-table');
const productsBody = document.getElementById('products-body');
const emptyState = document.getElementById('empty-state');

let allProducts = [];
let openNmId = null;

const fmtMoney = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽');
const fmtPct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
const fmtDate = (s) => (s ? new Date(s).toLocaleString('ru-RU') : '—');

function sppClass(pct) {
  if (pct == null) return '';
  if (pct >= 25) return 'spp-high';
  if (pct >= 10) return 'spp-mid';
  return 'spp-low';
}

// Цену на сайте сервер получить не может — Wildberries блокирует такие запросы с адресов
// облачных хостингов (см. README). Поэтому её достаёт браузер продавца — прямо отсюда,
// с обычного пользовательского адреса — и присылает результат на сервер.
const CARD_HOST = 'https://card.wb.ru';
const DEST_REGION = '-1257786'; // регион по умолчанию — Москва, как и на сервере
const CARD_BATCH_SIZE = 50;

async function fetchSitePricesFromBrowser(nmIds) {
  const prices = [];
  for (let i = 0; i < nmIds.length; i += CARD_BATCH_SIZE) {
    const batch = nmIds.slice(i, i + CARD_BATCH_SIZE);
    const url = `${CARD_HOST}/cards/v4/detail?appType=1&curr=rub&dest=${DEST_REGION}&spp=0&nm=${batch.join(';')}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const products = json?.products || json?.data?.products || [];
        for (const p of products) {
          const nmId = p.id ?? p.nmId;
          const kopecks = p.salePriceU ?? p.sizes?.[0]?.price?.total ?? p.sizes?.[0]?.price?.product ?? p.priceU ?? null;
          if (nmId && kopecks != null) {
            prices.push({ nmId: Number(nmId), sitePrice: kopecks / 100 });
          }
        }
      }
    } catch (err) {
      // один неудачный батч не должен обрывать остальные — просто пропускаем эти товары
    }
    if (i + CARD_BATCH_SIZE < nmIds.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return prices;
}

async function init() {
  await renderNav('products');
  await refreshStatus();
}

async function refreshStatus() {
  const statusRes = await fetch('/api/wb/token/status');
  const status = await statusRes.json();

  if (status.connected) {
    connectPanel.hidden = true;
    productsPanel.hidden = false;
    await loadProducts();
  } else {
    connectPanel.hidden = false;
    productsPanel.hidden = true;
  }
}

async function loadProducts() {
  const res = await fetch('/api/wb/products');
  const data = await res.json();
  allProducts = data.products || [];
  renderProducts();
}

function renderProducts() {
  const filter = filterInput.value.trim().toLowerCase();
  const rows = allProducts.filter((p) => {
    if (!filter) return true;
    return String(p.nmId).includes(filter) || (p.vendorCode || '').toLowerCase().includes(filter);
  });

  if (rows.length === 0) {
    productsTable.hidden = true;
    emptyState.hidden = false;
    emptyState.textContent =
      allProducts.length === 0
        ? 'Пока нет данных — нажмите «Синхронизировать сейчас».'
        : 'Ничего не найдено по фильтру.';
    return;
  }

  productsTable.hidden = false;
  emptyState.hidden = true;

  productsBody.innerHTML = rows
    .map(
      (p) => `
      <tr class="product-row" data-nm="${p.nmId}" style="cursor:pointer;">
        <td>${p.nmId}</td>
        <td>${p.vendorCode || '—'}</td>
        <td>${fmtMoney(p.sellerPrice)}</td>
        <td>${fmtMoney(p.sitePrice)}</td>
        <td class="spp-cell ${sppClass(p.sppPercent)}">${fmtPct(p.sppPercent)}</td>
        <td>${fmtDate(p.checkedAt)}</td>
      </tr>
      <tr class="history-row" data-nm-history="${p.nmId}" hidden>
        <td colspan="6"><div class="history-chart" id="history-${p.nmId}"></div></td>
      </tr>`
    )
    .join('');

  productsBody.querySelectorAll('.product-row').forEach((row) => {
    row.addEventListener('click', () => toggleHistory(Number(row.dataset.nm)));
  });
}

async function toggleHistory(nmId) {
  const historyRow = productsBody.querySelector(`[data-nm-history="${nmId}"]`);
  if (!historyRow) return;

  if (openNmId === nmId) {
    historyRow.hidden = true;
    openNmId = null;
    return;
  }
  if (openNmId != null) {
    const prevRow = productsBody.querySelector(`[data-nm-history="${openNmId}"]`);
    if (prevRow) prevRow.hidden = true;
  }

  historyRow.hidden = false;
  openNmId = nmId;

  const container = document.getElementById(`history-${nmId}`);
  container.innerHTML = '<div class="empty-state">Загрузка истории...</div>';

  const res = await fetch(`/api/wb/products/${nmId}/history?days=30`);
  const data = await res.json();
  const points = (data.points || []).map((p) => ({ x: new Date(p.checkedAt), y: p.sppPercent == null ? null : Number(p.sppPercent) }));
  renderLineChart(container, points, { height: 160 });
}

filterInput.addEventListener('input', renderProducts);

saveTokenBtn.addEventListener('click', async () => {
  tokenError.textContent = '';
  const token = tokenInput.value.trim();
  if (!token) {
    tokenError.textContent = 'Вставьте токен';
    return;
  }
  saveTokenBtn.disabled = true;
  saveTokenBtn.textContent = 'Проверяем...';

  try {
    const res = await fetch('/api/wb/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok) {
      tokenError.textContent = data.error || 'Не удалось подключить токен';
      return;
    }
    await refreshStatus();
  } catch (err) {
    tokenError.textContent = 'Не удалось связаться с сервером';
  } finally {
    saveTokenBtn.disabled = false;
    saveTokenBtn.textContent = 'Подключить';
  }
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncStatus.classList.remove('sync-warning');
  syncStatus.textContent = 'Синхронизация может занять до пары минут на больших каталогах...';

  try {
    const res = await fetch('/api/wb/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      syncStatus.textContent = data.error || 'Синхронизация не удалась';
      return;
    }
    const skippedNote = data.skipped > 0 ? ` (пропущено ${data.skipped} — лимит тарифа)` : '';
    await loadProducts();

    syncStatus.textContent = `Цены продавца обновлены (${data.count}${skippedNote}). Уточняем цены на сайте из вашего браузера...`;
    const nmIds = allProducts.map((p) => p.nmId);
    const sitePrices = await fetchSitePricesFromBrowser(nmIds);

    if (sitePrices.length > 0) {
      await fetch('/api/wb/site-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: sitePrices }),
      });
      await loadProducts();
      syncStatus.textContent =
        `Готово: ${data.count} товаров${skippedNote}, цены на сайте получены для ${sitePrices.length} из ${nmIds.length}, ${fmtDate(data.syncedAt)}`;
    } else {
      syncStatus.textContent =
        `Цены продавца обновлены (${data.count}${skippedNote}), но цены на сайте браузер получить не смог — возможно, Wildberries временно блокирует и эти запросы. Попробуйте синхронизировать ещё раз чуть позже.`;
      syncStatus.classList.add('sync-warning');
    }
  } catch (err) {
    syncStatus.textContent = 'Не удалось связаться с сервером';
  } finally {
    syncBtn.disabled = false;
  }
});

init();
