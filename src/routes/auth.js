const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { asyncHandler } = require('../asyncHandler');

const router = express.Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
