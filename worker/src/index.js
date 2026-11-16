import { parseProduct, productFromBrowser, mergeBrowserProduct, extractUrls, HttpError } from './parsers.js';
import { accessConfig, requireSession, signIn } from './access.js';

const VERSION = '1.5.0';
const STALE_MS = 6 * 60 * 60 * 1000; // через сколько обновлять цену/рейтинг в фоне
const MAX_PHOTO_BYTES = 512 * 1024;
// Лайки берём тем же запросом, что и карточки, — один поход в базу вместо нескольких
const CARD_SELECT = 'SELECT c.*, (SELECT version FROM card_photos WHERE card_id = c.id) AS photo_version, ' +
  '(SELECT group_concat(DISTINCT kind) FROM votes WHERE card_id = c.id) AS liked FROM cards c';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    board TEXT NOT NULL,
    source TEXT NOT NULL,
    product_id TEXT NOT NULL,
    url TEXT NOT NULL,
    data TEXT NOT NULL,
    overrides TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (board, source, product_id)
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    card_id TEXT NOT NULL,
    voter TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (card_id, voter, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS card_photos (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    bytes BLOB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cards_board ON cards (board, created_at)`,
  `CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO boards (id, name, created_at) VALUES ('main', 'Основная', 0)`,
  // Подборки, у которых есть карточки, но нет записи (созданы до появления списка), — регистрируем.
  // Раньше это делалось при каждом открытии списка подборок — лишняя запись в базу на каждый запрос.
  `INSERT OR IGNORE INTO boards (id, name, created_at) SELECT board, board, MIN(created_at) FROM cards GROUP BY board`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });

// Ответ с ETag: если у клиента та же версия, отдаём пустой 304 — опрос раз в 20 секунд почти ничего не весит.
// Это важно без VPN: большие ответы Cloudflare в России тормозят сильнее мелких.
// Версия считается только по карточкам — у /api/bootstrap и /api/cards она общая, и сайт может
// переиспользовать её при смене подборки. Список подборок сайт обновляет отдельно, когда его открывают.
async function jsonTagged(request, data) {
  const text = JSON.stringify(data);
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(data.cards)));
  const etag = '"' + [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('') + '"';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: etag, ...CORS };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(text, { headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      return await route(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: e.message || 'Ошибка сервера' }, status);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '' || path === '/api' || path === '/api/health') {
    return json({ ok: true, service: 'markets-pars', version: VERSION, db: !!env.DB, authRequired: true });
  }
  const access = accessConfig(env);
  if (path === '/api/auth/login' && method === 'POST') return json(await signIn(request, env, access));
  await requireSession(request, access);
  if (path === '/api/auth/session' && method === 'GET') return json({ ok: true });
  if (!env.DB) throw new HttpError(500, 'База D1 не подключена (binding DB)');
  await ensureSchema(env.DB);

  // Всё, что нужно сайту при запуске, одним запросом: сессия проверена выше, тут подборки и карточки
  if (path === '/api/bootstrap' && method === 'GET') {
    const [boards, cards] = await Promise.all([boardsData(env), cardsData(env, ctx, url)]);
    return jsonTagged(request, { boards, ...cards });
  }
  if (path === '/api/cards' && method === 'GET') return jsonTagged(request, await cardsData(env, ctx, url));
  if (path === '/api/cards' && method === 'POST') return addCard(env, await body(request));
  if (path === '/api/cards/import' && method === 'POST') return addCard(env, await body(request), true);
  if (path === '/api/cards/move' && method === 'POST') return moveCards(env, await body(request));
  if (path === '/api/cards/delete' && method === 'POST') return deleteCards(env, await body(request));
  if (path === '/api/parse' && method === 'POST') {
    const { url: link, shareText } = await body(request);
    return json({ product: await parseProduct(firstUrl(link), shareText ?? link) });
  }

  if (path === '/api/boards' && method === 'GET') return json({ boards: await boardsData(env) });
  if (path === '/api/boards' && method === 'POST') return createBoard(env, await body(request));
  const mb = path.match(/^\/api\/boards\/([\w-]+)$/);
  if (mb && method === 'PATCH') return renameBoard(env, mb[1], await body(request));
  if (mb && method === 'DELETE') return deleteBoard(env, mb[1]);

  const m = path.match(/^\/api\/cards\/([\w-]+)(\/(vote|refresh|photo))?$/);
  if (m) {
    const id = m[1];
    const action = m[3];
    if (action === 'photo' && method === 'GET') return getPhoto(env, id, url.searchParams.get('v'));
    if (action === 'photo' && method === 'POST') return savePhoto(env, id, request);
    if (action === 'vote' && method === 'POST') return vote(env, id, await body(request));
    if (action === 'refresh' && method === 'POST') return json({ card: await refreshCard(env, id) });
    if (!action && method === 'PATCH') return editCard(env, id, await body(request));
    if (!action && method === 'DELETE') return deleteCard(env, id);
    if (!action && method === 'GET') return json({ card: await getCard(env, id) });
  }
  throw new HttpError(404, 'Не найдено');
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Ожидался JSON');
  }
}

const board = (b) => (String(b || 'main').match(/^[\w-]{1,40}$/) ? String(b || 'main') : 'main');

function firstUrl(text) {
  const u = extractUrls(text)[0];
  if (!u) throw new HttpError(400, 'В тексте нет ссылки');
  return u;
}

/* ------------------------------ Подборки ------------------------------ */

const boardName = (n) => {
  const name = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'Нужно название подборки');
  return name;
};

async function boardsData(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name, b.created_at AS createdAt,
            COUNT(c.id) AS count,
            COALESCE(SUM(COALESCE(json_extract(c.overrides, '$.price'), json_extract(c.data, '$.price'))), 0) AS total
     FROM boards b LEFT JOIN cards c ON c.board = b.id
     GROUP BY b.id ORDER BY b.created_at, b.name`
  ).all();
  return results;
}

async function createBoard(env, input) {
  const name = boardName(input.name);
  // Сайт сам придумывает адрес новой подборки, чтобы сразу на неё переключиться, не дожидаясь ответа
  const wanted = typeof input.id === 'string' && /^[\w-]{6,40}$/.test(input.id) && input.id !== 'main' ? input.id : null;
  const id = wanted || crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO boards (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, Date.now()).run();
  if (!r.meta?.changes) throw new HttpError(409, 'Такая подборка уже есть');
  return json({ board: { id, name, count: 0, total: 0 } }, 201);
}

async function renameBoard(env, id, input) {
  const name = boardName(input.name);
  const r = await env.DB.prepare('UPDATE boards SET name = ? WHERE id = ?').bind(name, id).run();
  if (!r.meta?.changes) throw new HttpError(404, 'Подборка не найдена');
  return json({ ok: true });
}

async function deleteBoard(env, id) {
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM boards WHERE id != ?').bind(id).first();
  if (!left?.n) throw new HttpError(400, 'Нельзя удалить единственную подборку');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM votes WHERE card_id IN (SELECT id FROM cards WHERE board = ?)').bind(id),
    env.DB.prepare('DELETE FROM cards WHERE board = ?').bind(id),
    env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

/* ------------------------------ Карточки ------------------------------ */

async function cardsData(env, ctx, url) {
  const b = board(url.searchParams.get('board'));
  const { results: rows } = await env.DB.prepare(CARD_SELECT + ' WHERE c.board = ? ORDER BY c.created_at DESC LIMIT 500')
    .bind(b)
    .all();
  const likes = {};
  const now = Date.now();

  // Фоново освежаем самые старые карточки (цены меняются)
  const stale = rows.filter((r) => now - r.updated_at > STALE_MS).sort((a, b) => a.updated_at - b.updated_at).slice(0, 2);
  if (stale.length) ctx.waitUntil(Promise.allSettled(stale.map((r) => refreshCard(env, r.id))));

  return { board: b, cards: rows.map((r) => present(r, likes)) };
}

async function getCard(env, id) {
  const row = await env.DB.prepare(CARD_SELECT + ' WHERE c.id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Карточка не найдена');
  return present(row, {});
}

async function savePhoto(env, id, request) {
  if (request.headers.get('Content-Type') !== 'image/jpeg' || !request.body) {
    throw new HttpError(415, 'Поддерживаются фотографии в формате JPEG');
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_PHOTO_BYTES);
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (length + value.length > bytes.length) {
      await reader.cancel();
      throw new HttpError(413, 'Фото слишком большое');
    }
    bytes.set(value, length);
    length += value.length;
  }
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      bytes[length - 2] !== 0xff || bytes[length - 1] !== 0xd9) {
    throw new HttpError(415, 'Файл не является фотографией JPEG');
  }
  const result = await env.DB.prepare(
    `INSERT INTO card_photos (card_id, version, bytes)
     SELECT id, ?, ? FROM cards WHERE id = ?
     ON CONFLICT(card_id) DO UPDATE SET version = excluded.version, bytes = excluded.bytes`
  ).bind(crypto.randomUUID(), bytes.buffer.slice(0, length), id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Карточка не найдена');
  return json({ card: await getCard(env, id) });
}

async function getPhoto(env, id, version) {
  const row = await env.DB.prepare('SELECT bytes FROM card_photos WHERE card_id = ? AND version = ?')
    .bind(id, version).first();
  if (!row) throw new HttpError(404, 'Фото не найдено');
  return new Response(new Uint8Array(row.bytes), { headers: {
    ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

async function addCard(env, input, fromBrowser = false) {
  const b = board(input.board);
  const link = firstUrl(input.url);
  const imported = (fromBrowser || input.browserData != null) ? productFromBrowser(link, input.browserData) : null;
  const product = imported ? imported.product : await parseProduct(link, input.shareText ?? input.url);
  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  // Приложение перечитало существующую карточку (например, заготовку по короткой ссылке Ozon),
  // и у товара оказался другой номер — переносим карточку вместе с лайками на настоящий товар.
  let removed = null;
  if (imported && typeof input.cardId === 'string') {
    const moved = await moveCard(env, b, input.cardId, imported, now);
    if (moved instanceof Response) return moved;
    removed = moved?.removed ?? null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await env.DB.prepare('SELECT id, data FROM cards WHERE board = ? AND source = ? AND product_id = ?')
      .bind(b, product.source, product.productId)
      .first();
    if (existing) {
      const previous = JSON.parse(existing.data);
      const merged = imported ? mergeBrowserProduct(previous, imported.patch) : keepCompleteProduct(product, previous);
      const result = await updateProduct(env, existing, merged, now);
      if (result.meta.changes) {
        return json({
          duplicate: true, ...(imported ? { updated: true } : {}), ...(removed ? { removed } : {}),
          card: await getCard(env, existing.id),
        });
      }
      continue;
    }
    const result = await env.DB.prepare(
      'INSERT INTO cards (id, board, source, product_id, url, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (board, source, product_id) DO NOTHING'
    ).bind(id, b, product.source, product.productId, product.url, JSON.stringify(product), now, now).run();
    if (result.meta.changes) return json({ card: await getCard(env, id) }, 201);
  }
  throw new HttpError(409, 'Карточка обновляется. Повторите добавление.');
}

async function moveCard(env, b, cardId, imported, now) {
  const { product, patch } = imported;
  const row = await env.DB.prepare('SELECT id, product_id, data FROM cards WHERE id = ? AND board = ? AND source = ?')
    .bind(cardId, b, product.source).first();
  if (!row || row.product_id === product.productId) return null;
  const other = await env.DB.prepare('SELECT id FROM cards WHERE board = ? AND source = ? AND product_id = ?')
    .bind(b, product.source, product.productId).first();
  if (other) {
    // Такой товар уже есть отдельной карточкой — пустую заготовку убираем, данные получит существующая
    if (!JSON.parse(row.data).placeholder) return null;
    await deleteCard(env, row.id);
    return { removed: row.id };
  }
  const merged = mergeBrowserProduct({ ...JSON.parse(row.data), placeholder: undefined }, patch);
  Object.assign(merged, { productId: product.productId, url: product.url });
  if (!patch.title) merged.title = product.title;
  const result = await env.DB.prepare(
    'UPDATE cards SET product_id = ?, url = ?, data = ?, updated_at = ? WHERE id = ? AND product_id = ?'
  ).bind(product.productId, product.url, JSON.stringify(merged), now, row.id, row.product_id).run();
  if (!result.meta.changes) return null;
  return json({ duplicate: true, updated: true, card: await getCard(env, row.id) });
}

function updateProduct(env, row, product, now) {
  return env.DB.prepare('UPDATE cards SET data = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND data = ?')
    .bind(JSON.stringify(product), now, row.id, row.data)
    .run();
}

async function refreshCard(env, id) {
  const row = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Карточка не найдена');
  const now = Date.now();
  try {
    const fresh = await parseProduct(row.url);
    const merged = keepCompleteProduct(fresh, JSON.parse(row.data));
    await updateProduct(env, row, merged, now);
  } catch (e) {
    await env.DB.prepare('UPDATE cards SET updated_at = MAX(updated_at, ?) WHERE id = ?').bind(now, id).run();
    if (!(e instanceof HttpError)) console.error('refresh failed', id, e);
  }
  return getCard(env, id);
}

function keepCompleteProduct(fresh, old) {
  if (fresh.partial && fresh.images?.length && !old.images?.length) {
    return keepRichFields(mergeBrowserProduct(old, { images: fresh.images, thumbs: fresh.thumbs }), old);
  }
  const lostPrice = fresh.price == null && old.price != null;
  const lostPhotos = !fresh.images?.length && old.images?.length;
  const lostImportedTitle = (old.titleFromBrowser || old.titleFromShare) && !fresh.titleFromShare &&
    fresh.price == null && !fresh.images?.length;
  return fresh.partial && (!old.partial || lostPrice || lostPhotos || lostImportedTitle) ? old : keepRichFields(fresh, old);
}

// Описание, характеристики, варианты и отзывы часто приходят только из приложения или расширения.
// Фоновое обновление сервером их не отдаёт — тогда оставляем прежние, а не стираем.
const RICH_FIELDS = ['description', 'specs', 'variants', 'reviewsTop', 'priceNoCard', 'rating', 'reviews'];
function keepRichFields(product, old) {
  const result = { ...product };
  // Сервер видит только цену без скидки (WB Кошелька, Ozon Банка). Если она та же, что прочитали на устройстве
  // рядом с ценой со скидкой, — та цена всё ещё верна, оставляем её. Иначе прежняя «цена без скидки» уже не про эту цену.
  if (result.price != null && result.price === old.priceNoCard && old.price != null && old.price < result.price) {
    Object.assign(result, { price: old.price, priceNote: old.priceNote ?? null });
    if (!(result.oldPrice > result.price)) result.oldPrice = old.oldPrice ?? null;
  }
  for (const key of RICH_FIELDS) {
    if (key === 'priceNoCard' && result.price !== old.price) continue;
    const missing = result[key] == null || (Array.isArray(result[key]) && !result[key].length);
    if (missing && old[key] != null) result[key] = old[key];
  }
  return result;
}

const EDITABLE = ['title', 'price', 'oldPrice', 'rating', 'reviews', 'images'];

async function editCard(env, id, input) {
  const row = await env.DB.prepare('SELECT overrides FROM cards WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Карточка не найдена');
  const overrides = JSON.parse(row.overrides || '{}');
  for (const k of EDITABLE) {
    if (!(k in (input.overrides || {}))) continue;
    let v = input.overrides[k];
    if (v === null || v === '') {
      delete overrides[k];
      continue;
    }
    if (k === 'title') v = String(v).slice(0, 300);
    else if (k === 'images')
      v = (Array.isArray(v) ? v : String(v).split(/\s+/))
        .map((s) => String(s).trim())
        .filter((s) => /^https:\/\//.test(s))
        .slice(0, 20);
    else v = Number(String(v).replace(',', '.').replace(/[^\d.]/g, '')) || null;
    if (v == null || (Array.isArray(v) && !v.length)) delete overrides[k];
    else overrides[k] = v;
  }
  await env.DB.prepare('UPDATE cards SET overrides = ? WHERE id = ?').bind(JSON.stringify(overrides), id).run();
  return json({ card: await getCard(env, id) });
}

async function deleteCard(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM votes WHERE card_id = ?').bind(id),
    env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

/* -------------------------- Несколько карточек -------------------------- */
// Список карточек передаём в SQL одной JSON-строкой через json_each — так не упираемся
// в ограничение D1 на число параметров и укладываемся в один пакетный запрос.

const MAX_BULK = 200;

function cardIds(value) {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, 'Нужен список карточек');
  if (value.length > MAX_BULK) throw new HttpError(400, `За раз можно выбрать не больше ${MAX_BULK} карточек`);
  const ids = [...new Set(value)];
  if (!ids.every((id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id))) {
    throw new HttpError(400, 'Неверный номер карточки');
  }
  return JSON.stringify(ids);
}

// Карточки из списка, у которых в целевой подборке уже есть такой же товар
const TWINS = `SELECT c.id AS id, t.id AS target FROM cards c
  JOIN cards t ON t.board = ?2 AND t.source = c.source AND t.product_id = c.product_id
  WHERE c.id IN (SELECT value FROM json_each(?1)) AND c.board != ?2`;

async function moveCards(env, input) {
  const ids = cardIds(input.ids);
  const target = String(input.board ?? '');
  if (!/^[\w-]{1,40}$/.test(target)) throw new HttpError(400, 'Неверная подборка');
  const exists = await env.DB.prepare('SELECT 1 FROM boards WHERE id = ?').bind(target).first();
  if (!exists) throw new HttpError(404, 'Подборка не найдена');

  // Всё одним пакетом (транзакцией). Если такой товар в подборке уже есть, оставляем ту карточку:
  // переносим на неё лайки и своё фото (если у неё фото нет), а дубль удаляем.
  const q = (sql) => env.DB.prepare(sql).bind(ids, target);
  const [twins, , , , , , moved] = await env.DB.batch([
    q(TWINS),
    q(`INSERT OR IGNORE INTO votes (card_id, voter, kind, created_at)
       SELECT tw.target, v.voter, v.kind, v.created_at FROM votes v JOIN (${TWINS}) tw ON tw.id = v.card_id`),
    q(`INSERT OR IGNORE INTO card_photos (card_id, version, bytes)
       SELECT tw.target, p.version, p.bytes FROM card_photos p JOIN (${TWINS}) tw ON tw.id = p.card_id`),
    q(`DELETE FROM votes WHERE card_id IN (SELECT id FROM (${TWINS}))`),
    q(`DELETE FROM card_photos WHERE card_id IN (SELECT id FROM (${TWINS}))`),
    q(`DELETE FROM cards WHERE id IN (SELECT id FROM (${TWINS}))`),
    // OR IGNORE: если в списке оказались одинаковые товары из разных подборок, лишний останется на месте
    q(`UPDATE OR IGNORE cards SET board = ?2 WHERE id IN (SELECT value FROM json_each(?1)) AND board != ?2`),
  ]);
  return json({ ok: true, moved: moved.meta?.changes ?? 0, merged: twins.results });
}

async function deleteCards(env, input) {
  const ids = cardIds(input.ids);
  const inList = 'IN (SELECT value FROM json_each(?))';
  const [, , cards] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM votes WHERE card_id ${inList}`).bind(ids),
    env.DB.prepare(`DELETE FROM card_photos WHERE card_id ${inList}`).bind(ids),
    env.DB.prepare(`DELETE FROM cards WHERE id ${inList}`).bind(ids),
  ]);
  return json({ ok: true, deleted: cards.meta?.changes ?? 0 });
}

/* ------------------------------- Лайки ------------------------------- */
// Пользователей двое: парень (m) и девушка (f). Каждый ставит/снимает своё сердце.

async function vote(env, id, input) {
  const kind = input.kind === 'f' ? 'f' : input.kind === 'm' ? 'm' : null;
  if (!kind) throw new HttpError(400, 'Нужно указать, кто голосует: m или f');
  const exists = await env.DB.prepare('SELECT 1 FROM cards WHERE id = ?').bind(id).first();
  if (!exists) throw new HttpError(404, 'Карточка не найдена');

  const had = await env.DB.prepare('SELECT 1 FROM votes WHERE card_id = ? AND kind = ?').bind(id, kind).first();
  const want = typeof input.value === 'boolean' ? input.value : !had;
  if (want && !had)
    await env.DB.prepare('INSERT OR IGNORE INTO votes (card_id, voter, kind, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, kind, kind, Date.now())
      .run();
  if (!want && had) await env.DB.prepare('DELETE FROM votes WHERE card_id = ? AND kind = ?').bind(id, kind).run();

  return json({ likes: (await likesFor(env, [id]))[id] || { m: false, f: false } });
}

async function likesFor(env, ids) {
  const likes = {};
  // D1 ограничивает число параметров — бьём на пачки
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT card_id, kind FROM votes WHERE card_id IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(...chunk)
      .all();
    for (const r of results) (likes[r.card_id] ||= { m: false, f: false })[r.kind] = true;
  }
  return likes;
}

function present(row, likes) {
  const data = JSON.parse(row.data);
  const overrides = JSON.parse(row.overrides || '{}');
  const card = { ...data, ...overrides };
  if (overrides.images) card.thumbs = overrides.images;
  if (row.photo_version) {
    card.uploadedPhoto = `/api/cards/${row.id}/photo?v=${row.photo_version}`;
  }
  return {
    id: row.id,
    ...card,
    edited: Object.keys(overrides),
    likes: typeof row.liked === 'string' || row.liked === null
      ? { m: /(^|,)m(,|$)/.test(row.liked || ''), f: /(^|,)f(,|$)/.test(row.liked || '') }
      : likes[row.id] || { m: false, f: false },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
