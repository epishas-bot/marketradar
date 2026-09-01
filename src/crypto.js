// Шифрование сохранённого API-токена продавца (AES-256-GCM), чтобы токен
// не лежал в базе открытым текстом. Ключ выводится из APP_SECRET через scrypt.

const crypto = require('crypto');

const SECRET = process.env.APP_SECRET;
if (!SECRET || SECRET.length < 16) {
  throw new Error(
    'APP_SECRET не задан или слишком короткий. Задайте длинную случайную строку в .env (см. .env.example).'
  );
}

const SALT = 'wb-spp-tracker-static-salt-v1'; // фиксированная соль для детерминированного вывода ключа из APP_SECRET
const key = crypto.scryptSync(SECRET, SALT, 32);

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Повреждённые зашифрованные данные');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
