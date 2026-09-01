const form = document.getElementById('forgot-form');
const submitBtn = document.getElementById('submit-btn');
const errorEl = document.getElementById('error');
const successEl = document.getElementById('success');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();

  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Что-то пошло не так';
      submitBtn.disabled = false;
      return;
    }
    form.querySelector('.field').style.display = 'none';
    submitBtn.style.display = 'none';
    successEl.textContent = data.message;
    successEl.style.display = 'block';
  } catch (err) {
    errorEl.textContent = 'Не удалось связаться с сервером';
    submitBtn.disabled = false;
  }
});
