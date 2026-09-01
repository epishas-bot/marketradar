const form = document.getElementById('reset-form');
const submitBtn = document.getElementById('submit-btn');
const errorEl = document.getElementById('error');

const token = new URLSearchParams(window.location.search).get('token');
if (!token) {
  errorEl.textContent = 'Ссылка недействительна — запросите новую на странице входа.';
  submitBtn.disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;

  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Что-то пошло не так';
      submitBtn.disabled = false;
      return;
    }
    window.location.href = '/index.html?reset=ok';
  } catch (err) {
    errorEl.textContent = 'Не удалось связаться с сервером';
    submitBtn.disabled = false;
  }
});
