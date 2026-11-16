'use strict';
// Service worker «Выбираем вместе»: только уведомления Web Push. Запросы сайта он не перехватывает,
// поэтому кэш браузера и обновление файлов по ?v= работают как раньше.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const WHO = { m: 'Парень', f: 'Девушка' };
const plural = (n, a, b, c) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
const goods = (n) => (n === 1 ? 'товар' : `${n} ${plural(n, 'товар', 'товара', 'товаров')}`);
const verb = (actor, m, f) => (actor === 'f' ? f : m);

// Заголовок уведомления по типу события и числу событий в нём (несколько событий собираются в одно)
function heading(kind, actor, n) {
  const who = WHO[actor];
  if (kind === 'like') return `${who || 'Кто-то'} ${verb(actor, 'лайкнул', 'лайкнула')} ${goods(n)}`;
  if (kind === 'match') return n === 1 ? 'Совпадение! Нравится обоим' : `${n} ${plural(n, 'совпадение', 'совпадения', 'совпадений')} — нравится обоим`;
  if (kind === 'add') return who ? `${who} ${verb(actor, 'добавил', 'добавила')} ${goods(n)}` : n === 1 ? 'Новый товар в подборке' : `Новые товары: ${n}`;
  if (kind === 'board') {
    if (n > 1) return who ? `${who} ${verb(actor, 'создал', 'создала')} ${n} ${plural(n, 'подборку', 'подборки', 'подборок')}` : `Новые подборки: ${n}`;
    return who ? `${who} ${verb(actor, 'создал', 'создала')} подборку` : 'Новая подборка';
  }
  return 'Выбираем вместе';
}

function bodyText(items) {
  const lines = items.slice(0, 4).map((e) => (e.kind === 'board' ? `«${e.title || e.boardName || 'Подборка'}»` : e.title || 'Товар'));
  if (items.length > 4) lines.push(`и ещё ${items.length - 4}`);
  const boards = new Set(items.map((e) => e.board));
  const one = items[0];
  // Подборку называем, если все события из одной и это не основная
  if (one.kind !== 'board' && boards.size === 1 && one.board !== 'main' && one.boardName) lines.push(`Подборка «${one.boardName}»`);
  return lines.join('\n');
}

const minutes = (hhmm) => {
  const m = /^(\d\d):(\d\d)$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Тихие часы задаются на устройстве: уведомление всё равно показывается (так требуют браузеры), но без звука
async function quietNow() {
  try {
    const cache = await caches.open('mp-notify');
    const res = await cache.match(new URL('notify-settings', self.registration.scope).href);
    const s = res ? await res.json() : null;
    if (!s?.quiet) return false;
    const from = minutes(s.from), to = minutes(s.to);
    if (from == null || to == null || from === to) return false;
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    return from < to ? now >= from && now < to : now >= from || now < to;
  } catch {
    return false;
  }
}

async function onPush(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {}
  const events = Array.isArray(data?.events) ? data.events.filter((e) => e && typeof e.kind === 'string') : [];
  const silent = await quietNow();
  const icon = new URL('icon-192.png', self.registration.scope).href;
  if (!events.length) {
    return self.registration.showNotification('Выбираем вместе', { body: 'В подборке есть новости', tag: 'misc', icon, silent });
  }
  // Группы «тип + автор»: новое событие добавляется к уже показанному уведомлению той же группы
  const groups = new Map();
  for (const e of events) {
    const tag = `${e.kind}:${e.actor || ''}`;
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(e);
  }
  for (const [tag, fresh] of groups) {
    let before = [];
    try {
      const [shown] = await self.registration.getNotifications({ tag });
      before = Array.isArray(shown?.data?.items) ? shown.data.items : [];
    } catch {}
    const seen = new Set(fresh.map((e) => e.id));
    const items = [...fresh, ...before.filter((e) => !seen.has(e.id))].slice(0, 30);
    const top = items[0];
    await self.registration.showNotification(heading(top.kind, top.actor, items.length), {
      body: bodyText(items),
      tag,
      renotify: !silent,
      silent,
      icon,
      timestamp: top.createdAt || Date.now(),
      lang: 'ru',
      data: { items, board: top.board, card: top.cardId || null },
    });
  }
}

self.addEventListener('push', (event) => event.waitUntil(onPush(event)));

// Нажатие: открытая вкладка сайта показывает карточку сама, иначе открываем сайт сразу на ней
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { board, card } = event.notification.data || {};
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    const url = new URL('./', scope);
    if (board) url.searchParams.set('b', board);
    if (card) url.hash = 'card=' + card;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).pathname.startsWith(scope.pathname));
    if (open) {
      try {
        await open.focus();
      } catch {}
      open.postMessage({ type: 'open-card', board, card });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
