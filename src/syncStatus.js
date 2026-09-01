// Статус фоновой синхронизации по каждому пользователю — в памяти процесса.
//
// Зачем это отдельным модулем: получение цены на сайте идёт через настоящий браузер и
// может занимать много минут (см. priceScraper.js). Раньше POST /api/wb/sync держал
// HTTP-запрос открытым всё это время и ждал ответа — из-за этого синхронизация
// обрывалась, стоило продавцу переключиться на другую вкладку сайта (это отдельная
// HTML-страница — переход на неё останавливает JS текущей страницы и её fetch),
// закрыть ноутбук или просто попасть на таймаут прокси/браузера по дороге. Сам процесс
// на сервере при этом мог продолжать работать в фоне, но клиент об этом уже не узнавал.
//
// Теперь POST /sync только запускает синхронизацию и сразу отвечает — сам процесс
// живёт здесь, независимо от того, какая страница открыта у продавца и открыта ли она
// вообще. Любая страница кабинета может в любой момент спросить GET /sync/status и
// узнать, идёт ли сейчас синхронизация, на каком она шаге и чем закончилась прошлая.
//
// Хранится в памяти процесса, а не в базе — сознательное упрощение: сервис сейчас
// всегда работает в одном экземпляре (WEB_CONCURRENCY=1, см. server.js), поэтому нет
// проблемы "у какого инстанса спросить статус". Если в будущем появится несколько
// инстансов или очередь задач — этот модуль нужно будет заменить на что-то в Postgres.

const statuses = new Map(); // userId -> status

function getStatus(userId) {
  return statuses.get(userId) || { running: false };
}

function startSync(userId, { total }) {
  statuses.set(userId, {
    running: true,
    startedAt: new Date().toISOString(),
    progress: { done: 0, total },
    result: null,
    error: null,
  });
}

function updateProgress(userId, done, total) {
  const status = statuses.get(userId);
  if (!status || !status.running) return;
  status.progress = { done, total };
}

function finishSync(userId, result) {
  const status = statuses.get(userId) || {};
  statuses.set(userId, {
    ...status,
    running: false,
    finishedAt: new Date().toISOString(),
    result,
    error: null,
  });
}

function failSync(userId, message) {
  const status = statuses.get(userId) || {};
  statuses.set(userId, {
    ...status,
    running: false,
    finishedAt: new Date().toISOString(),
    result: null,
    error: message,
  });
}

module.exports = { getStatus, startSync, updateProgress, finishSync, failSync };
