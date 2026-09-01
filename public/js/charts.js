// Лёгкие SVG-графики без внешних библиотек — линия (история во времени) и бары
// (разбивка по фактору). Палитра и отступы — по методичке dataviz-скилла:
// тонкие линии, скруглённый конец бара, hairline-сетка, подпись только у
// значимых точек, hover с крестиком/тултипом.

const VIZ = {
  surface: '#fcfcfb',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  series1: '#2a78d6', // синий — единственная серия на графиках СПП, легенда не нужна
};

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step;
  const niceStep = err >= 7.5 ? 10 * step : err >= 3 ? 5 * step : err >= 1.5 ? 2 * step : step;
  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;
  const ticks = [];
  for (let t = niceMin; t <= niceMax + 1e-9; t += niceStep) ticks.push(Math.round(t * 100) / 100);
  return ticks;
}

function makeTooltip(container) {
  const tip = document.createElement('div');
  tip.style.cssText = `
    position: absolute; pointer-events: none; opacity: 0; transition: opacity 0.1s;
    background: ${VIZ.textPrimary}; color: #fff; font-size: 12px; padding: 6px 9px;
    border-radius: 6px; white-space: nowrap; z-index: 5; transform: translate(-50%, -100%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;
  container.style.position = 'relative';
  container.appendChild(tip);
  return tip;
}

/**
 * Линейный график одной серии (история СПП во времени).
 * points: [{ x: Date, y: number|null }], отсортированы по x.
 */
function renderLineChart(container, points, opts = {}) {
  const height = opts.height || 180;
  const valueSuffix = opts.valueSuffix ?? '%';
  const width = container.clientWidth || 560;
  const pad = { top: 16, right: 16, bottom: 26, left: 40 };

  container.innerHTML = '';
  const clean = points.filter((p) => p.y != null);
  if (clean.length === 0) {
    container.innerHTML = '<div class="empty-state">Недостаточно данных для графика.</div>';
    return;
  }

  const xs = clean.map((p) => +p.x);
  const ys = clean.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yTicks = niceTicks(Math.min(...ys, 0), Math.max(...ys), 4);
  const yMin = yTicks[0], yMax = yTicks[yTicks.length - 1];

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const sx = (x) => pad.left + (xMax === xMin ? innerW / 2 : ((x - xMin) / (xMax - xMin)) * innerW);
  const sy = (y) => pad.top + innerH - ((y - yMin) / (yMax - yMin || 1)) * innerH;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: 'display:block;overflow:visible;' });

  // сетка + подписи оси Y
  for (const t of yTicks) {
    const y = sy(t);
    svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: VIZ.grid, 'stroke-width': 1 }));
    const label = svgEl('text', { x: pad.left - 8, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: VIZ.muted });
    label.textContent = `${t}${valueSuffix}`;
    svg.appendChild(label);
  }

  // подписи оси X: первая и последняя дата
  const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  [clean[0], clean[clean.length - 1]].forEach((p, i) => {
    const label = svgEl('text', {
      x: i === 0 ? sx(+p.x) : sx(+p.x),
      y: height - 6,
      'text-anchor': i === 0 ? 'start' : 'end',
      'font-size': 10,
      fill: VIZ.muted,
    });
    label.textContent = fmtDate(p.x);
    svg.appendChild(label);
  });

  // область под линией
  const linePath = clean.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(+p.x)} ${sy(p.y)}`).join(' ');
  const areaPath = `${linePath} L ${sx(+clean[clean.length - 1].x)} ${pad.top + innerH} L ${sx(+clean[0].x)} ${pad.top + innerH} Z`;
  svg.appendChild(svgEl('path', { d: areaPath, fill: VIZ.series1, opacity: 0.1, stroke: 'none' }));
  svg.appendChild(svgEl('path', { d: linePath, fill: 'none', stroke: VIZ.series1, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // конечная точка + подпись значения
  const last = clean[clean.length - 1];
  svg.appendChild(svgEl('circle', { cx: sx(+last.x), cy: sy(last.y), r: 5, fill: VIZ.series1, stroke: VIZ.surface, 'stroke-width': 2 }));
  const endLabel = svgEl('text', {
    x: sx(+last.x) - 8, y: sy(last.y) - 10, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: VIZ.textPrimary,
  });
  endLabel.textContent = `${last.y}${valueSuffix}`;
  svg.appendChild(endLabel);

  // hover: крестик + тултип на ближайшую точку
  const hoverLine = svgEl('line', { y1: pad.top, y2: pad.top + innerH, stroke: VIZ.baseline, 'stroke-width': 1, opacity: 0 });
  const hoverDot = svgEl('circle', { r: 4, fill: VIZ.series1, stroke: VIZ.surface, 'stroke-width': 2, opacity: 0 });
  svg.appendChild(hoverLine);
  svg.appendChild(hoverDot);

  container.appendChild(svg);
  const tooltip = makeTooltip(container);

  const overlay = svgEl('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent' });
  svg.appendChild(overlay);

  overlay.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let nearest = clean[0], nd = Infinity;
    for (const p of clean) {
      const d = Math.abs(sx(+p.x) - mx);
      if (d < nd) { nd = d; nearest = p; }
    }
    hoverLine.setAttribute('x1', sx(+nearest.x));
    hoverLine.setAttribute('x2', sx(+nearest.x));
    hoverLine.setAttribute('opacity', 1);
    hoverDot.setAttribute('cx', sx(+nearest.x));
    hoverDot.setAttribute('cy', sy(nearest.y));
    hoverDot.setAttribute('opacity', 1);
    tooltip.style.left = `${sx(+nearest.x)}px`;
    tooltip.style.top = `${sy(nearest.y) - 10}px`;
    tooltip.style.opacity = 1;
    tooltip.textContent = `${new Date(nearest.x).toLocaleDateString('ru-RU')}: ${nearest.y}${valueSuffix}`;
  });
  overlay.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', 0);
    hoverDot.setAttribute('opacity', 0);
    tooltip.style.opacity = 0;
  });
}

/**
 * Столбчатая диаграмма одной серии (разбивка по фактору: день недели, ценовой диапазон).
 * data: [{ label: string, value: number, n?: number }]
 */
function renderBarChart(container, data, opts = {}) {
  const height = opts.height || 200;
  const valueSuffix = opts.valueSuffix ?? '%';
  const width = container.clientWidth || 560;
  const pad = { top: 24, right: 12, bottom: 30, left: 12 };

  container.innerHTML = '';
  if (!data.length) {
    container.innerHTML = '<div class="empty-state">Недостаточно данных.</div>';
    return;
  }

  const values = data.map((d) => d.value);
  const maxVal = Math.max(...values, 0.001);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const slot = innerW / data.length;
  const barW = Math.min(24, slot * 0.55);

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, style: 'display:block;overflow:visible;' });

  // базовая линия
  svg.appendChild(svgEl('line', {
    x1: pad.left, x2: width - pad.right, y1: pad.top + innerH, y2: pad.top + innerH,
    stroke: VIZ.baseline, 'stroke-width': 1,
  }));

  container.appendChild(svg);
  const tooltip = makeTooltip(container);

  data.forEach((d, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const barH = maxVal > 0 ? (d.value / maxVal) * innerH : 0;
    const y = pad.top + innerH - barH;

    const rect = svgEl('rect', {
      x: cx - barW / 2, y, width: barW, height: Math.max(barH, 1),
      rx: 4, ry: 4, fill: VIZ.series1, style: 'cursor:pointer;',
    });
    svg.appendChild(rect);

    const valueLabel = svgEl('text', {
      x: cx, y: y - 6, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: VIZ.textPrimary,
    });
    valueLabel.textContent = `${d.value}${valueSuffix}`;
    svg.appendChild(valueLabel);

    const xLabel = svgEl('text', {
      x: cx, y: height - 8, 'text-anchor': 'middle', 'font-size': 10, fill: VIZ.muted,
    });
    xLabel.textContent = d.label;
    svg.appendChild(xLabel);

    rect.addEventListener('mousemove', (e) => {
      const rectBox = container.getBoundingClientRect();
      tooltip.style.left = `${e.clientX - rectBox.left}px`;
      tooltip.style.top = `${y - 8}px`;
      tooltip.style.opacity = 1;
      tooltip.textContent = d.n != null ? `${d.label}: ${d.value}${valueSuffix} (n=${d.n})` : `${d.label}: ${d.value}${valueSuffix}`;
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.opacity = 0; });
  });
}
