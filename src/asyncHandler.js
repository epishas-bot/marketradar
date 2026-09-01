// Express 4 не перехватывает отклонённые промисы из async-обработчиков сам —
// без этой обёртки ошибка в БД просто повиснет запросом без ответа.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
