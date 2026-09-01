const daysSelect = document.getElementById('days-select');
const emptyPanel = document.getElementById('empty-panel');
const content = document.getElementById('factors-content');
const moversBody = document.getElementById('movers-body');

const WEEKDAY_LABELS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

async function init() {
  await renderNav('factors');
  await load();
}

daysSelect.addEventListener('change', load);

async function load() {
  const days = daysSelect.value;
  const res = await fetch(`/api/wb/factors?days=${days}`);
  if (!res.ok) return;
  const data = await res.json();

  const hasData = (data.trend && data.trend.length > 0) || (data.byPriceBucket && data.byPriceBucket.length > 0);
  if (!hasData) {
    emptyPanel.hidden = false;
    content.hidden = true;
    return;
  }
  emptyPanel.hidden = true;
  content.hidden = false;

  renderTrend(data.trend);
  renderWeekday(data.byWeekday);
  renderPriceBuckets(data.byPriceBucket);
  renderMovers(data.movers);
}

function renderTrend(trend) {
  const points = trend.map((r) => ({ x: new Date(r.day), y: Number(r.avgSpp) }));
  renderLineChart(document.getElementById('chart-trend'), points, { height: 200 });
}

function renderWeekday(byWeekday) {
  const byDow = new Map(byWeekday.map((r) => [Number(r.dow), r]));
  const data = WEEKDAY_LABELS.map((label, dow) => {
    const row = byDow.get(dow);
    return { label, value: row ? Number(row.avgSpp) : 0, n: row ? Number(row.n) : 0 };
  }).filter((d) => d.n > 0);
  renderBarChart(document.getElementById('chart-weekday'), data, { height: 200 });
}

function renderPriceBuckets(byPriceBucket) {
  const data = byPriceBucket.map((b) => ({ label: b.label, value: Number(b.avgSpp), n: b.n }));
  renderBarChart(document.getElementById('chart-price'), data, { height: 200 });
}

function renderMovers(movers) {
  if (!movers.length) {
    moversBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--ink-faint);">Нет данных за этот период</td></tr>';
    return;
  }
  const top = [...movers].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 10);
  moversBody.innerHTML = top
    .map((m) => {
      const delta = Number(m.delta);
      const arrow = delta > 0.05 ? '▲' : delta < -0.05 ? '▼' : '→';
      const sign = delta > 0 ? '+' : '';
      return `
        <tr>
          <td>${m.nmId}</td>
          <td>${m.vendorCode || '—'}</td>
          <td>${Number(m.firstSpp).toFixed(1)}%</td>
          <td>${Number(m.lastSpp).toFixed(1)}%</td>
          <td><span class="delta-pill">${arrow} ${sign}${delta.toFixed(1)} п.п.</span></td>
        </tr>`;
    })
    .join('');
}

init();
