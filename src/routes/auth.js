const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { asyncHandler } = require('../asyncHandler');
const { sendPasswordResetEmail } = require('../mailer');

const router = express.Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 час

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Укажите корректный e-mail' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким e-mail уже зарегистрирован' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const inserted = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, plan',
      [email, passwordHash]
    );
    const user = inserted.rows[0];

    req.session.userId = user.id;
    res.json({ email: user.email, plan: user.plan });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Не удалось создать аккаунт' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Неверный e-mail или пароль' });
    }

    req.session.userId = user.id;
    res.json({ email: user.email, plan: user.plan });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Не удалось выполнить вход' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  // Отвечаем одинаково независимо от того, найден такой e-mail или нет — иначе по разнице
  // в ответе можно было бы проверять, зарегистрирован ли конкретный адрес в сервисе.
  const genericResponse = {
    ok: true,
    message:
      'Если аккаунт с таким e-mail существует, на него отправлено письмо со ссылкой для восстановления пароля.',
  };

  if (!isValidEmail(email)) {
    return res.json(genericResponse);
  }

  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await pool.query('UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3', [
        tokenHash,
        expires,
        user.id,
      ]);
      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
      await sendPasswordResetEmail({ to: email, resetUrl });
    }
  } catch (err) {
    // Ошибку не показываем клиенту (в т.ч. чтобы не палить существование e-mail через
    // разные ответы), но логируем — если Resend не настроен или упал, это нужно увидеть
    // в логах Render.
    console.error('forgot-password error:', err.message);
  }

  res.json(genericResponse);
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: 'Ссылка недействительна' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
    }

    const tokenHash = hashResetToken(token);
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > now()',
      [tokenHash]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(400).json({ error: 'Ссылка недействительна или истекла — запросите новую' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Не удалось сбросить пароль' });
  }
});

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    const result = await pool.query('SELECT email, plan, role, sku_limit FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Не авторизован' });
    res.json(user);
  })
);

module.exports = router;
