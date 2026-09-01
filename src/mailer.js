/**
 * Отправка писем через Resend (https://resend.com) — сейчас используется только для
 * восстановления пароля. Как и с прокси для цены на сайте (см. priceScraper.js), это
 * целиком операторская настройка: продавцу-клиенту ничего заводить не нужно, ключ и
 * адрес отправителя задаются через переменные окружения на сервере (см. README →
 * «Восстановление пароля» и .env.example).
 *
 * Пока не подключён свой домен в Resend, можно отправлять с onboarding@resend.dev —
 * это ограничение только Resend: без подтверждённого домена так можно слать письма на
 * любой адрес (не только на свой), но с их доменного адреса в теме иногда попадает в
 * спам. Для реальных клиентов стоит подтвердить в Resend свой домен и указать его в
 * MAIL_FROM.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendPasswordResetEmail({ to, resetUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'MarketRadar <onboarding@resend.dev>';

  if (!apiKey) {
    throw new Error(
      'RESEND_API_KEY не задан — отправка почты не настроена (см. README → «Восстановление пароля»).'
    );
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject: 'Восстановление пароля — MarketRadar',
      html: `
        <p>Кто-то (надеемся, что вы) запросил восстановление пароля в MarketRadar.</p>
        <p><a href="${resetUrl}">Придумать новый пароль</a></p>
        <p style="color:#8a8f9c;font-size:13px">Ссылка действует 1 час. Если это были не вы — просто проигнорируйте это письмо, пароль не изменится.</p>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend вернул ошибку ${res.status}: ${body}`);
  }
}

module.exports = { sendPasswordResetEmail };
