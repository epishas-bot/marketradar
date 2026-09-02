// Настройки — пока единственное, что тут есть: посмотреть/заменить API-токен
// Wildberries уже подключённого аккаунта. До этой страницы форма подключения токена
// (см. dashboard.html) показывалась только ОДИН раз, пока аккаунт не подключён, и
// пропадала насовсем после первого успешного подключения — обновить токен позже
// (например, после того как в кабинете WB добавили новую категорию доступа тому же
// токену) было просто негде. Бэкенд для этого менять не пришлось: POST /api/wb/token
// и раньше делал UPSERT (см. src/routes/wb.js) — не хватало только формы на странице.

const tokenStatusLine = document.getElementById('token-status-line');
const tokenInput = document.getElementById('wb-token');
const tokenError = document.getElementById('token-error');
const tokenSuccess = document.getElementById('token-success');
const saveTokenBtn = document.getElementById('save-token-btn');

function fmtDate(s) {
  return s ? new Date(s).toLocaleString('ru-RU') : '—';
}

async function loadStatus() {
  const res = await fetch('/api/wb/token/status');
  const status = await res.json();
  tokenStatusLine.textContent = status.connected
    ? `Токен подключён, последнее обновление: ${fmtDate(status.updatedAt)}.`
    : 'Токен ещё не подключён — вставьте его в поле ниже.';
}

async function init() {
  await renderNav('settings');
  await loadStatus();
}

saveTokenBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  tokenError.textContent = '';
  tokenSuccess.style.display = 'none';

  if (token.length < 10) {
    tokenError.textContent = 'Вставьте API-токен продавца Wildberries целиком';
    return;
  }

  saveTokenBtn.disabled = true;
  try {
    const res = await fetch('/api/wb/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok) {
      tokenError.textContent = data.error || 'Не удалось сохранить токен';
      return;
    }
    tokenInput.value = '';
    tokenSuccess.textContent = 'Токен сохранён. Новые данные подтянутся при следующей синхронизации.';
    tokenSuccess.style.display = 'block';
    await loadStatus();
  } catch (err) {
    tokenError.textContent = 'Не удалось связаться с сервером';
  } finally {
    saveTokenBtn.disabled = false;
  }
});

init();
