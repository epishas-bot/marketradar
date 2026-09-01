const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const form = document.getElementById('auth-form');
const submitBtn = document.getElementById('submit-btn');
const errorEl = document.getElementById('error');
const forgotLink = document.getElementById('forgot-link');
const resetSuccessEl = document.getElementById('reset-success');

let mode = 'login';

function setMode(next) {
  mode = next;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  submitBtn.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  forgotLink.style.display = mode === 'login' ? 'block' : 'none';
  errorEl.textContent = '';
}

tabLogin.addEventListener('click', () => setMode('login'));
tabRegister.addEventListener('click', () => setMode('register'));

if (new URLSearchParams(window.location.search).get('reset') === 'ok') {
  resetSuccessEl.style.display = 'block';
}

// Если уже залогинены — сразу в дашборд.
fetch('/api/auth/me').then((r) => {
  if (r.ok) window.location.href = '/dashboard.html';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Что-то пошло не так';
      submitBtn.disabled = false;
      return;
    }
    window.location.href = '/dashboard.html';
  } catch (err) {
    errorEl.textContent = 'Не удалось связаться с сервером';
    submitBtn.disabled = false;
  }
});
