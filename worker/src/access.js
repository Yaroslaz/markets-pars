import { HttpError } from './parsers.js';

const encoder = new TextEncoder();
const SESSION_SECONDS = 365 * 24 * 60 * 60;

export function accessConfig(env) {
  try {
    const { password, signingKey } = JSON.parse(env.APP_ACCESS);
    if (typeof password === 'string' && password && /^[a-f0-9]{64}$/.test(signingKey)) {
      return { password, signingKey };
    }
  } catch {}
  throw new HttpError(503, 'Пароль приложения ещё не настроен на сервере');
}

async function sessionKey(access) {
  // Смена пароля завершает уже выданные сессии.
  const raw = encoder.encode(JSON.stringify([access.signingKey, access.password]));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signIn(request, env, access) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
  if (!success) throw new HttpError(429, 'Слишком много попыток. Попробуйте через минуту.');
  const password = await readPassword(request);
  const [given, expected] = await Promise.all([password, access.password].map(
    (value) => crypto.subtle.digest('SHA-256', encoder.encode(value))
  ));
  if (!crypto.subtle.timingSafeEqual(given, expected)) throw new HttpError(401, 'Неверный пароль');

  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = expires + '.' + crypto.randomUUID();
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(access), encoder.encode(payload));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token: payload + '.' + encoded };
}

async function readPassword(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Введите пароль');
  const input = new Uint8Array(2048);
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (offset + value.length > input.length) {
      await reader.cancel();
      throw new HttpError(413, 'Пароль слишком длинный');
    }
    input.set(value, offset);
    offset += value.length;
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(input.subarray(0, offset)));
  } catch {
    throw new HttpError(400, 'Ожидался JSON');
  }
  if (typeof data?.password !== 'string' || !data.password) throw new HttpError(400, 'Введите пароль');
  return data.password;
}

export async function requireSession(request, access) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer ((\d{10})\.[a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (match && Number(match[2]) > Math.floor(Date.now() / 1000)) {
    const signature = Uint8Array.from(atob(match[3].replace(/-/g, '+').replace(/_/g, '/') + '='), (char) => char.charCodeAt(0));
    if (await crypto.subtle.verify('HMAC', await sessionKey(access), signature, encoder.encode(match[1]))) return;
  }
  throw new HttpError(401, 'Введите пароль приложения');
}
