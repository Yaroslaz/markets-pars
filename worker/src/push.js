// Web Push без сторонних сервисов и библиотек: шифрование содержимого по RFC 8291 (aes128gcm)
// и подпись VAPID по RFC 8292 (JWT ES256) — всё на WebCrypto внутри Worker.
// Ключи VAPID сервер создаёт сам при первом обращении и хранит в D1 (таблица config),
// поэтому настраивать ничего не нужно. Свои ключи можно задать секретами VAPID_PUBLIC_KEY и
// VAPID_PRIVATE_KEY (формат как у `npx web-push generate-vapid-keys`: base64url).

const enc = new TextEncoder();

export const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromB64url(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, i), (i += p.length);
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/* ------------------------------ Ключи VAPID ------------------------------ */

let cached = null;

export async function vapidKeys(env) {
  if (cached) return cached;
  let jwk;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    const pub = fromB64url(env.VAPID_PUBLIC_KEY);
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY };
  } else {
    const row = await env.DB.prepare(`SELECT value FROM config WHERE key = 'vapid'`).first();
    if (row) jwk = JSON.parse(row.value);
    else {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const fresh = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const value = JSON.stringify({ kty: 'EC', crv: 'P-256', x: fresh.x, y: fresh.y, d: fresh.d });
      // Два запроса могли создать ключи одновременно — остаётся тот, что записан первым
      await env.DB.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES ('vapid', ?)`).bind(value).run();
      jwk = JSON.parse((await env.DB.prepare(`SELECT value FROM config WHERE key = 'vapid'`).first()).value);
    }
  }
  const privateKey = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
  cached = { privateKey, publicKey, publicKeyText: b64url(publicKey) };
  return cached;
}

async function vapidHeader(endpoint, keys, subject) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const unsigned = header + '.' + claims;
  // WebCrypto отдаёт подпись ECDSA сразу в виде r‖s — именно так её ждёт JWS
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKeyText}`;
}

/* --------------------------- Шифрование (RFC 8291) --------------------------- */

export async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length < 16) throw new Error('bad subscription keys');

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" ‖ 0 ‖ ua_public ‖ as_public, 32)
  const prkKey = await hmac(auth, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  // Одна запись: данные и разделитель 0x02 (последняя запись), без дополнительного заполнения
  const record = concat(plaintext, new Uint8Array([2]));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, record));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([rs >>> 24, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, cipher);
}

/* ------------------------------ Отправка ------------------------------ */

// Адреса push-сервисов браузеров. Другие адреса не принимаем: сервер не должен ходить куда попало.
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.apple\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/i;

export function checkEndpoint(endpoint, env) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (String(endpoint).length > 1024 || u.username || u.password) return false;
  // Для локальной проверки (wrangler dev --var PUSH_DEV:1) разрешаем приёмник на этом компьютере
  if (env.PUSH_DEV === '1' && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
}

/** Возвращает статус ответа push-сервиса (0 — сеть недоступна). */
export async function sendPush(env, sub, data, subject) {
  const keys = await vapidKeys(env);
  const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(data)));
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 60 * 60),
        Urgency: 'normal',
      },
      body,
      redirect: 'manual',
    });
    if (res.status >= 400) console.warn('push', res.status, (await res.text()).slice(0, 200));
    return res.status;
  } catch (e) {
    console.warn('push failed', e?.message);
    return 0;
  }
}
