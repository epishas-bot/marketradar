// Общая шапка для всех страниц кабинета: логотип, вкладки модулей, e-mail и выход.
// Каждая страница вызывает renderNav('<ключ активной вкладки>') после того, как
// в разметке есть <div id="app-nav"></div>.

const NAV_ITEMS = [
  { key: 'products', href: '/dashboard.html', label: 'Товары и СПП' },
  { key: 'factors', href: '/factors.html', label: 'Факторы СПП' },
  { key: 'unit-economics', href: '/unit-economics.html', label: 'Юнит-экономика', soon: true },
  { key: 'card-transfer', href: '/card-transfer.html', label: 'Перенос карточек', soon: true },
  { key: 'labels', href: '/labels.html', label: 'Этикетки', soon: true },
  { key: 'content', href: '/content.html', label: 'Контент карточек', soon: true },
];

async function renderNav(activeKey) {
  const root = document.getElementById('app-nav');
  if (!root) return;

  root.innerHTML = `
    <div class="nav-bar">
      <div class="nav-brand">MarketRadar</div>
      <nav class="nav-tabs">
        ${NAV_ITEMS.map(
          (item) => `
          <a href="${item.href}" class="nav-tab ${item.key === activeKey ? 'active' : ''}">
            ${item.label}${item.soon ? '<span class="nav-soon">скоро</span>' : ''}
          </a>`
        ).join('')}
      </nav>
      <div class="nav-who">
        <span id="nav-email"></span>
        <button type="button" class="secondary" id="nav-logout">Выйти</button>
      </div>
    </div>
  `;

  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    window.location.href = '/index.html';
    return;
  }
  const me = await meRes.json();
  document.getElementById('nav-email').textContent = me.email;
  document.getElementById('nav-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/index.html';
  });

  return me;
}
