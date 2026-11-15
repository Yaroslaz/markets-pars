'use strict';

/* ============================== Константы ============================== */

const CFG = window.MP_CONFIG || {};
const SOURCES = {
  ozon: { name: 'Ozon', pkg: 'ru.ozon.app.android' },
  wb: { name: 'Wildberries', pkg: 'com.wildberries.ru' },
  ym: { name: 'Яндекс Маркет', pkg: 'ru.beru.android' },
  ali: { name: 'AliExpress', pkg: 'com.alibaba.aliexpresshd' },
};
const fav = (k, cls = 'fav') => `<img class="${cls}" src="img/${k}.png" alt="" width="16" height="16">`;
const SORTS = [
  ['new', 'Сначала новые', 'новые'],
  ['votes', 'Больше лайков', 'по лайкам'],
  ['cheap', 'Сначала дешевле', 'дешевле'],
  ['expensive', 'Сначала дороже', 'дороже'],
  ['rating', 'По рейтингу', 'по рейтингу'],
];
const UA = navigator.userAgent;
const IS_ANDROID = /Android/i.test(UA);
const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_ANDROID || IS_IOS;
const POLL_MS = 20000;

// Лёгкая отдача вибрацией; до первого касания страницы браузер её запрещает — тогда молчим
const buzz = (pattern) => navigator.userActivation?.hasBeenActive !== false && navigator.vibrate?.(pattern);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ============================== Хранилище ============================== */

const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem('mp_' + k);
      return v == null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v == null || v === '') localStorage.removeItem('mp_' + k);
      else localStorage.setItem('mp_' + k, v);
    } catch {}
  },
};

const state = {
  api: '',
  accessToken: '',
  unlocked: false,
  board: 'main',
  boards: [],
  role: '', // m — парень, f — девушка
  cards: [],
  filter: 'all', // all | both
  source: '',
  sort: store.get('sort', 'new'),
  loading: true,
  error: '',
  openId: null,
  selecting: false, // режим выбора карточек (долгое нажатие)
  selected: new Set(),
  booting: !store.get('booted'), // самый первый запуск: показываем сердце над заготовками
};

function initState() {
  const qs = new URLSearchParams(location.search);
  const apiQ = qs.get('api');
  const boardQ = qs.get('b');
  const defaultApi = normalizeApi(CFG.apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (apiQ && (!defaultApi || local)) store.set('api_override', normalizeApi(apiQ));
  if (boardQ && /^[\w-]{1,40}$/.test(boardQ)) store.set('board', boardQ);
  state.api = normalizeApi(store.get('api_override') || (defaultApi ? '' : store.get('api')) || defaultApi);
  state.accessToken = store.get('access:' + state.api, '');
  state.board = store.get('board') || 'main';
  state.role = ['m', 'f'].includes(store.get('role')) ? store.get('role') : '';

  // Убираем служебные параметры из адресной строки, оставляя остальное (share target и т.п.)
  if (apiQ || boardQ) {
    qs.delete('api');
    qs.delete('b');
    const rest = qs.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
}

function normalizeApi(u) {
  u = String(u || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (u && !/^https?:\/\//.test(u)) u = 'https://' + u;
  return u;
}

/* ========================= Извлечение ссылок =========================== */

// Достаёт ссылки маркетплейсов из любого текста: отбрасывает слова, эмодзи, кавычки, знаки препинания,
// разлепляет склеенные ссылки, понимает ссылки без https:// и дубли.
function extractLinks(text) {
  const src = String(text || '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/(https?:\/\/)/gi, ' $1'); // «…/detail.aspxhttps://…» → две ссылки
  const re = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*)?/gi;
  const found = [];
  const seen = new Set();
  let ignored = 0;
  for (let m of src.match(re) || []) {
    m = trimTail(m);
    if (!/^https?:\/\//i.test(m)) m = 'https://' + m;
    let url;
    try {
      url = new URL(m);
    } catch {
      continue;
    }
    const source = detectSource(url.hostname);
    if (!source) {
      if (url.pathname.length > 1 || /^https?:\/\//i.test(m)) ignored++;
      continue;
    }
    const key = productKey(source, url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push({ url: url.toString(), source, key });
  }
  return { links: found, ignored };
}

function trimTail(s) {
  // Хвостовая пунктуация и непарные скобки — не часть ссылки
  for (;;) {
    const last = s[s.length - 1];
    if (/[.,;:!?'"*\]}>]/.test(last)) s = s.slice(0, -1);
    else if (last === ')' && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
    else return s;
  }
}

function detectSource(host) {
  host = String(host).toLowerCase();
  if (/(^|\.)ozon\.(ru|by|kz)$/.test(host) || host === 'ozon.onelink.me') return 'ozon';
  if (/(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru)$/.test(host)) return 'wb';
  if (/(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(host) || host === 'ya.cc') return 'ym';
  if (/(^|\.)(aliexpress\.(ru|com|us)|aliclick\.shop)$/.test(host)) return 'ali';
  return null;
}

function productKey(source, url) {
  const p = url.pathname;
  let id = null;
  if (source === 'ozon') id = p.match(/\/(?:product\/(?:[^/]+-)?|context\/detail\/id\/)(\d{5,})(?:\/|$)/)?.[1];
  if (source === 'wb') id = p.match(/\/catalog\/(\d+)/)?.[1];
  if (source === 'ym') id = p.match(/\/(?:card|product)[^/]*\/(?:[^/]+\/)?(\d{5,})/)?.[1];
  if (source === 'ali') id = p.match(/\/item\/(?:[^/]*\/)?(\d{6,})/)?.[1];
  if (id) return source + ':' + id;
  // короткая ссылка — ключ по самой ссылке; голый домен без пути — не товар
  if (p.length <= 1) return null;
  return source + ':' + url.host.replace(/^www\./, '') + p.replace(/\/$/, '');
}

/* ================================ API ================================= */

async function api(path, opts = {}) {
  const base = state.api;
  if (!base) throw new Error('Сервер не настроен');
  const token = opts.public ? '' : state.accessToken;
  const headers = new Headers();
  if (opts.body) headers.set('Content-Type', 'application/json');
  if (opts.file) headers.set('Content-Type', opts.file.type);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.file ? await opts.file.arrayBuffer() : opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'error',
  });
  if (base !== state.api || (!opts.public && token !== state.accessToken)) {
    throw new Error('Подключение изменилось');
  }
  if (res.ok && opts.image) return res.blob();
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (base !== state.api || (!opts.public && token !== state.accessToken)) throw new Error('Подключение изменилось');
  if (res.status === 401 && !opts.public) lockApp();
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

/* ======================= Приложение для Android ======================= */

// Приложение (папка android/) открывает этот сайт и встраивает в него объект MarketsNative.
// По просьбе сайта оно незаметно загружает страницу товара в скрытом браузере телефона —
// с IP и cookies телефона, поэтому магазины не блокируют, — и выполняет там readOpenProduct.
// Браузер показывается, только если магазин просит пройти проверку.
const nativeSources = new Set(['ozon', 'ym', 'ali']);
const nativeApp = (() => {
  const port = window.MarketsNative;
  if (!port || typeof port.postMessage !== 'function' || typeof readOpenProduct !== 'function') return null;
  const pending = new Map();
  let seq = 0;
  port.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const done = pending.get(msg?.id);
    if (!done) return;
    pending.delete(msg.id);
    done(msg);
  };
  return {
    read(url) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        port.postMessage(JSON.stringify({ type: 'read', id, url, script: '(' + readOpenProduct + ')()' }));
      });
    },
  };
})();

// Добавляет или обновляет карточку по данным, прочитанным телефоном. null — если приложение не помогло.
// cardId — карточка, которую перечитываем: если у товара другой номер (заготовка по короткой ссылке Ozon),
// сервер перенесёт её на настоящий товар.
async function importViaApp(board, url, source, cardId) {
  if (!nativeApp || !nativeSources.has(source)) return null;
  try {
    const r = await nativeApp.read(url);
    const data = r?.ok ? r.data : null;
    if (!data?.url || (!data.title && data.price == null && !data.images?.length)) {
      // Страницу прочитать не дали, но телефон уже раскрыл короткую ссылку до адреса товара —
      // отдадим серверу полную ссылку: у карточки сразу будет настоящий номер и название из адреса
      try {
        const page = new URL(r?.url);
        if (page.protocol === 'https:' && detectSource(page.hostname) === source &&
            /:\d+$/.test(productKey(source, page) || '')) return { resolved: page.href };
      } catch {}
      return null;
    }
    const browserData = { title: data.title, price: data.price, images: data.images };
    const res = await api('/api/cards/import', { method: 'POST', body: { board, url: data.url, browserData, cardId } });
    if (res.removed && state.board === board) state.cards = state.cards.filter((c) => c.id !== res.removed);
    return res;
  } catch {
    return null;
  }
}

const accessDialog = $('#accessDialog');
const accessForm = $('#accessForm');

function setAccessToken(token) {
  state.accessToken = token;
  store.set('access:' + state.api, token);
}

function lockApp() {
  setAccessToken('');
  clearPrivatePhotos();
  state.unlocked = false;
  state.cards = [];
  state.boards = [];
  state.openId = null;
  state.error = '';
  state.loading = false;
  exitSelection();
  for (const dialog of $$('dialog[open]')) {
    if (dialog !== accessDialog) dialog.close();
  }
  render();
  if (!accessDialog.open) {
    $('#accessStatus').textContent = '';
    const pass = accessForm.elements.password;
    if (pass.type !== 'password') togglePassword($('.pass-toggle', accessForm));
    openDialog(accessDialog);
  }
}

async function signIn(event) {
  event.preventDefault();
  const button = $('button[type=submit]', accessForm);
  const password = accessForm.elements.password;
  const status = $('#accessStatus');
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('loading');
  status.textContent = '';
  password.removeAttribute('aria-invalid');
  try {
    const origin = new URL(state.api);
    if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
      throw new Error('Для входа нужен адрес сервера с HTTPS');
    }
    const { token } = await api('/api/auth/login', { method: 'POST', body: { password: password.value }, public: true });
    if (typeof token !== 'string' || !token) throw new Error('Сервер не выдал доступ');
    setAccessToken(token);
    accessForm.reset();
    await enterApp(true);
  } catch (error) {
    status.textContent = error instanceof TypeError ? 'Не удалось подключиться. Проверьте интернет и повторите вход.' : error.message;
    password.setAttribute('aria-invalid', 'true');
    password.focus();
    password.select();
    // Неверный пароль — окно «встряхивается»
    const box = $('.gate-inner', accessDialog) || accessForm;
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    buzz([12, 40, 12]);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
}

function togglePassword(btn) {
  const input = accessForm.elements.password;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  $('use', btn).setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  input.focus({ preventScroll: true });
}

async function loadCards({ silent = false } = {}) {
  if (!state.api) {
    state.loading = false;
    render();
    return;
  }
  if (!silent) {
    state.loading = !state.cards.length;
    render();
  }
  try {
    const data = await api(`/api/cards?board=${encodeURIComponent(state.board)}`);
    // не перетираем голос, который пользователь только что нажал
    const pending = new Map(state.cards.filter((c) => c._pending).map((c) => [c.id, c]));
    state.cards = data.cards.map((c) => pending.get(c.id) || withUploadedPhoto(c));
    state.error = '';
    if (state.booting) (state.booting = false), store.set('booted', '1');
  } catch (e) {
    if (!silent) state.error = e.message;
  }
  state.loading = false;
  render();
  if (state.openId) refreshViewer();
}

/* ============================== Форматы =============================== */

const rub = (n) =>
  n == null ? '' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: n % 1 ? 2 : 0 }).format(n) + ' ₽';
const plural = (n, a, b, c) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
const reviewsText = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ${plural(n, 'отзыв', 'отзыва', 'отзывов')}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
}

/* ============================== Рендер ================================ */

function visibleCards() {
  let list = state.cards.slice();
  if (state.filter === 'both') list = list.filter((c) => c.likes.m && c.likes.f);
  if (state.source) list = list.filter((c) => c.source === state.source);
  const price = (c) => (c.price == null ? null : c.price);
  const by = {
    new: (a, b) => b.createdAt - a.createdAt,
    votes: (a, b) => b.likes.m + b.likes.f - (a.likes.m + a.likes.f) || b.createdAt - a.createdAt,
    cheap: (a, b) => (price(a) ?? Infinity) - (price(b) ?? Infinity),
    expensive: (a, b) => (price(b) ?? -Infinity) - (price(a) ?? -Infinity),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviews ?? 0) - (a.reviews ?? 0),
  }[state.sort];
  return list.sort(by);
}

function priceHtml(c) {
  if (c.price == null) return `<div class="price"><span class="none">Цена не найдена</span></div>`;
  return `<div class="price"><b>${rub(c.price)}</b>${c.oldPrice ? `<s>${rub(c.oldPrice)}</s>` : ''}${
    c.priceNote && !c.edited.includes('price') ? `<span class="approx" title="Цена ${esc(c.priceNote)}"><svg><use href="#i-history"/></svg></span>` : ''
  }</div>`;
}

function metaHtml(c, withSource = true) {
  const rating =
    c.rating != null
      ? `<span class="rate"><svg><use href="#i-star"/></svg>${String(c.rating).replace('.', ',')}</span>${
          c.reviews != null ? `<span>${reviewsText(c.reviews)}</span>` : ''
        }`
      : c.reviews != null
        ? `<span>${reviewsText(c.reviews)}</span>`
        : '';
  const src = withSource ? `<span class="src">${fav(c.source)}${SOURCES[c.source].name}</span>` : '';
  return rating || src ? `<div class="meta">${rating}${src}</div>` : '';
}

// Своё сердце можно нажать, сердце второго человека только показывает его выбор
function votesHtml(c) {
  const heart = (k, who) => {
    const own = state.role === k;
    const on = c.likes[k];
    const label = `${who}${on ? ': нравится' : ''}`;
    return own
      ? `<button class="vote ${k} own ${on ? 'on' : ''}" data-vote="${k}" aria-pressed="${on}" aria-label="${label}" title="${label}"><svg><use href="#i-heart"/></svg></button>`
      : `<span class="vote ${k} other ${on ? 'on' : ''}" role="img" aria-label="${label}" title="${label}"><svg><use href="#i-heart"/></svg></span>`;
  };
  return `<div class="votes">${heart('m', 'Парень')}${heart('f', 'Девушка')}</div>`;
}

function placeholderHtml(c, withHint = true) {
  return `<div class="placeholder"><div><span class="mark">${fav(c.source, 'mark-ic')}</span>${
    withHint ? '<small>Нет фото</small>' : ''
  }</div></div>`;
}

const privatePhoto = /^\/api\/cards\/[a-f0-9]{16}\/photo\?v=[a-f0-9-]{36}$/;
const privatePhotos = new Map();

function photoSource(value) {
  return privatePhoto.test(value) ? `data-private-photo="${esc(value)}"` : `src="${esc(value)}"`;
}

function loadPrivatePhotos(root) {
  for (const img of $$('img[data-private-photo]:not([src])', root)) {
    const path = img.dataset.privatePhoto;
    let photo = privatePhotos.get(path);
    if (!photo) {
      photo = api(path, { image: true }).then((blob) => URL.createObjectURL(blob));
      privatePhotos.set(path, photo);
      photo.catch(() => { if (privatePhotos.get(path) === photo) privatePhotos.delete(path); });
    }
    photo.then((url) => {
      if (img.isConnected && privatePhotos.get(path) === photo) img.src = url;
    }).catch(() => {});
  }
}

function clearPrivatePhotos() {
  for (const photo of privatePhotos.values()) photo.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  privatePhotos.clear();
}

function cardHtml(c) {
  const img = (c.thumbs && c.thumbs[0]) || (c.images && c.images[0]);
  const n = (c.images || []).length;
  return `<article class="card" data-id="${c.id}" tabindex="0">
    <div class="photo">${
      img ? `<img ${photoSource(img)} alt="" loading="lazy" decoding="async" draggable="false" referrerpolicy="no-referrer">` : placeholderHtml(c)
    }<span class="mk" title="${SOURCES[c.source].name}">${fav(c.source)}</span>${n > 1 ? `<span class="n">${n} фото</span>` : ''}<span class="sel-ck" aria-hidden="true"><svg><use href="#i-check"/></svg></span></div>
    <div class="body">
      ${priceHtml(c)}
      <h3 class="title">${esc(c.title)}</h3>
      ${metaHtml(c, false)}
      ${votesHtml(c)}
    </div>
  </article>`;
}

const cardSig = new Map();

function render() {
  pruneSelection();
  renderGrid();
  syncSelection();
}

function renderGrid() {
  const grid = $('#grid');
  const empty = $('#empty');
  updateSum();
  $('#toolbar').hidden = !state.api;
  renderBoardName();

  if (!state.api) {
    grid.innerHTML = '';
    cardSig.clear();
    empty.hidden = false;
    empty.innerHTML = `<div class="logo"><svg><use href="#i-heart"/></svg></div>
      <h2>Подключите сервер</h2>
      <p>Карточки и голоса хранятся на вашем бесплатном Cloudflare Worker.</p>
      <div class="row"><a class="btn primary" href="${deployUrl()}" target="_blank" rel="noopener">Создать сервер</a>
      <button class="btn" data-action="settings">Ввести адрес</button></div>`;
    return;
  }
  // Заготовки — только когда показать действительно нечего (кэш пуст, подборка ещё грузится)
  if (state.loading && !state.cards.length) {
    empty.hidden = true;
    if (grid.querySelector('.skeleton')) return;
    const n = innerWidth >= 900 ? 10 : innerWidth >= 600 ? 9 : 6;
    // При самом первом запуске над заготовками бьётся сердце-логотип
    const boot = state.booting ? '<div class="boot" aria-hidden="true"><div class="logo"><svg><use href="#i-heart"/></svg></div>Загружаем подборку…</div>' : '';
    grid.innerHTML = boot + Array.from({ length: n }, (_, i) =>
      `<div class="skeleton" style="--i:${i}" aria-hidden="true"><div class="photo"></div><div class="body"><div class="l p"></div><div class="l"></div><div class="l s"></div><div class="vs"><div class="v"></div><div class="v"></div></div></div></div>`).join('');
    grid.setAttribute('aria-busy', 'true');
    cardSig.clear();
    return;
  }
  grid.removeAttribute('aria-busy');
  if (grid.querySelector('.boot')) grid.innerHTML = '';
  const list = visibleCards();
  if (!list.length) {
    grid.innerHTML = '';
    cardSig.clear();
    empty.hidden = false;
    if (state.error) {
      empty.innerHTML = `<h2>Сервер не отвечает</h2><p>${esc(state.error)}</p>
        <div class="row"><button class="btn primary" data-action="reload">Повторить</button><button class="btn" data-action="settings">Настройки</button></div>`;
    } else if (!state.cards.length) {
      empty.innerHTML = `<div class="logo"><svg><use href="#i-heart"/></svg></div><h2>Пока пусто</h2>
        <p>Вставьте ссылки с Ozon, Wildberries, Маркета или AliExpress.</p>
        <div class="row"><button class="btn primary" data-action="paste-add"><svg><use href="#i-paste"/></svg><span>Вставить из буфера обмена</span></button>
        <button class="btn" data-action="add">Ввести вручную</button></div>`;
    } else if (state.filter === 'both') {
      empty.innerHTML = `<h2>Совпадений пока нет</h2><p>Здесь появятся товары, которые лайкнули оба.</p>`;
    } else {
      empty.innerHTML = `<h2>Ничего не найдено</h2><p>Попробуйте другой магазин.</p>`;
    }
    return;
  }
  empty.hidden = true;

  // Ключевое обновление: перерисовываем только изменившиеся карточки, не дёргая картинки
  if (grid.querySelector('.skeleton')) grid.innerHTML = '';
  const existing = new Map($$('.card', grid).map((el) => [el.dataset.id, el]));
  const ids = new Set(list.map((c) => c.id));
  for (const [id, el] of existing) if (!ids.has(id)) (el.remove(), cardSig.delete(id));
  let prev = null;
  for (const c of list) {
    const sig = JSON.stringify([c.title, c.price, c.oldPrice, c.priceNote, c.rating, c.reviews, c.thumbs?.[0], c.images?.length, c.likes, state.role, c.edited]);
    let el = existing.get(c.id);
    if (!el || cardSig.get(c.id) !== sig) {
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHtml(c);
      const fresh = tmp.firstElementChild;
      if (el) {
        fresh.style.animation = 'none';
        el.replaceWith(fresh);
      }
      el = fresh;
      cardSig.set(c.id, sig);
    }
    const want = prev ? prev.nextElementSibling : grid.firstElementChild;
    if (want !== el) grid.insertBefore(el, want);
    prev = el;
  }
  loadPrivatePhotos(grid);
}

// Островок над таб-баром: сколько товаров на экране и на какую сумму
function updateSum() {
  const bar = $('#sumbar');
  // В режиме выбора островок считает только выбранные товары
  const shown = state.api && !(state.loading && !state.cards.length) ? visibleCards() : [];
  const list = state.selecting ? shown.filter((c) => state.selected.has(c.id)) : shown;
  if (!list.length) {
    bar.hidden = true;
    return;
  }
  const priced = list.filter((c) => c.price != null);
  const total = priced.reduce((a, c) => a + c.price, 0);
  const n = list.length;
  const what = `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;
  const incomplete = list.filter(isIncomplete).length;
  const bulk = state.bulkRefresh;
  const refresh = state.selecting ? '' : bulk
    ? `<button type="button" class="sum-refresh busy" data-action="stop-refresh" title="Остановить обновление"><svg><use href="#i-refresh"/></svg><span>${bulk.done} из ${bulk.total}</span></button>`
    : incomplete
      ? `<button type="button" class="sum-refresh" data-action="refresh-incomplete" title="Обновить цену и фото у товаров без данных"><svg><use href="#i-refresh"/></svg><span>Обновить ${incomplete}</span></button>`
      : '';
  bar.innerHTML = `${state.filter === 'both' ? '<svg class="duo"><use href="#i-duo"/></svg>' : '<svg><use href="#i-bag"/></svg>'}<span class="cnt">${what}</span>${priced.length ? `<i class="sep"></i><b>${rub(total)}</b>` : ''}${refresh}`;
  bar.hidden = false;
}

// Товар без цены или без фото — его стоит перечитать
const isIncomplete = (c) => c.price == null || !c.images?.length;

// «Обновить N»: по очереди перечитывает все товары на экране, у которых нет цены или фото.
// В приложении для Android Ozon, Маркет и AliExpress читаются с телефона, остальное — сервером.
async function refreshIncomplete() {
  if (state.bulkRefresh) return;
  const board = state.board;
  const ids = visibleCards().filter(isIncomplete).map((c) => c.id);
  if (!ids.length) return;
  const run = (state.bulkRefresh = { done: 0, total: ids.length, stop: false });
  let fixed = 0;
  updateSum();
  for (const id of ids) {
    if (run.stop || state.board !== board || !state.unlocked) break;
    const c = state.cards.find((x) => x.id === id);
    if (c) {
      const viaApp = !!nativeApp && nativeSources.has(c.source);
      try {
        const viaPhone = await importViaApp(board, c.url, c.source, id);
        const r = viaPhone?.card ? viaPhone : await api(`/api/cards/${id}/refresh`, { method: 'POST', body: {} });
        if (state.board === board) {
          upsertCard(r.card);
          if (!isIncomplete(withUploadedPhoto(r.card))) fixed++;
        }
      } catch {}
      // Пауза между страницами магазина, чтобы он не принял нас за бота
      if (viaApp) await new Promise((r) => setTimeout(r, 800 + Math.random() * 1500));
    }
    run.done++;
    render();
  }
  state.bulkRefresh = null;
  render();
  toast(fixed ? `Дополнено ${fixed} из ${run.done}` : 'Новых данных не нашлось');
}

function setFilter(f) {
  state.filter = f;
  $$('.tab[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === f));
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ========================= Кастомный дропдаун ========================= */

function filterMenu(root) {
  const opt = (k, v, label, icon) =>
    `<button type="button" class="dd-opt" role="menuitemradio" data-k="${k}" data-v="${esc(v)}">${icon}<span class="lbl">${esc(label)}</span><svg class="ck"><use href="#i-check"/></svg></button>`;
  root.innerHTML = `<button type="button" class="dd-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Фильтр и сортировка"></button>
    <div class="dd-menu" role="menu">
      <div class="dd-group">Магазин</div>
      ${opt('source', '', 'Все магазины', '<span class="ic"><svg><use href="#i-bag"/></svg></span>')}
      ${Object.entries(SOURCES).map(([k, s]) => opt('source', k, s.name, fav(k))).join('')}
      <div class="dd-sep"></div>
      <div class="dd-group">Сортировка</div>
      ${SORTS.map(([v, label]) => opt('sort', v, label, '')).join('')}
    </div>`;
  const btn = $('.dd-btn', root);
  const sync = () => {
    const changed = state.source || state.sort !== 'new';
    btn.innerHTML = `${state.source ? fav(state.source) : '<svg><use href="#i-filter"/></svg>'}${changed ? '<i class="badge"></i>' : ''}`;
    btn.title = `${state.source ? SOURCES[state.source].name : 'Все магазины'}, ${(SORTS.find((x) => x[0] === state.sort) || SORTS[0])[1].toLowerCase()}`;
    $$('.dd-opt', root).forEach((o) => o.setAttribute('aria-checked', o.dataset.v === state[o.dataset.k]));
  };
  const close = () => setDd(root, false);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setDd(root, !root.classList.contains('open'));
  });
  root.addEventListener('click', (e) => {
    const o = e.target.closest('.dd-opt');
    if (!o) return;
    e.stopPropagation();
    state[o.dataset.k] = o.dataset.v;
    if (o.dataset.k === 'sort') store.set('sort', o.dataset.v);
    sync();
    close();
    render();
  });
  root.addEventListener('keydown', (e) => {
    const opts = $$('.dd-opt', root);
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') (close(), btn.focus());
    else if (e.key === 'ArrowDown' && root.classList.contains('open')) (e.preventDefault(), opts[Math.min(i + 1, opts.length - 1)].focus());
    else if (e.key === 'ArrowUp' && root.classList.contains('open')) (e.preventDefault(), opts[Math.max(i - 1, 0)].focus());
  });
  sync();
}
// Касание или прокрутка вне открытого меню только закрывает его: элемент под пальцем не срабатывает
// (клик внутри меню закрывает уже само действие)
let ddSwallowClick = false;
function closeDdOutside(target) {
  const open = $$('.dd.open').filter((d) => !d.contains(target));
  open.forEach((d) => setDd(d, false));
  return open.length > 0;
}
document.addEventListener('pointerdown', (e) => {
  ddSwallowClick = closeDdOutside(e.target);
}, true);
document.addEventListener('click', (e) => {
  if (!ddSwallowClick) return;
  ddSwallowClick = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
document.addEventListener('scroll', (e) => closeDdOutside(e.target === document ? document.body : e.target), { capture: true, passive: true });
document.addEventListener('wheel', (e) => closeDdOutside(e.target), { capture: true, passive: true });

/* ============================== Голоса ================================ */

async function toggleVote(id, kind, btn) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  if (kind !== state.role) return;
  const prev = { ...c.likes };
  const on = !c.likes[kind];
  c.likes = { ...c.likes, [kind]: on };
  c._pending = true;
  buzz(8);
  render();
  refreshViewer();
  bump(id, kind);
  try {
    const r = await api(`/api/cards/${id}/vote`, { method: 'POST', body: { kind, value: on } });
    c.likes = r.likes;
  } catch (e) {
    c.likes = prev;
    toast('Голос не сохранился: ' + e.message);
  }
  delete c._pending;
  render();
  refreshViewer();
}

function bump(id, kind) {
  $$(`[data-id="${id}"] .vote.${kind}, #viewer[open] .vote.${kind}`).forEach((b) => {
    b.classList.add('bump');
    setTimeout(() => b.classList.remove('bump'), 220);
  });
}

/* ========================= Добавление ссылок ========================== */

const addDialog = $('#addDialog');
const addText = $('#addForm textarea');
const verificationSources = new Set(Object.keys(SOURCES));

function openAdd(prefill) {
  if (!state.api) return openSettings();
  if (prefill != null) addText.value = prefill;
  $('#progress').hidden = true;
  $('#progress').innerHTML = '';
  updateParseInfo();
  openDialog(addDialog);
  if (!IS_MOBILE && prefill == null) setTimeout(() => addText.focus(), 50);
}

// Авто-высота текстовых полей (без ручного растягивания, предел — max-height в CSS)
function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px';
}
document.addEventListener('input', (e) => e.target.tagName === 'TEXTAREA' && autosize(e.target));

function updateParseInfo() {
  autosize(addText);
  const { links, ignored } = extractLinks(addText.value);
  const info = $('#parseInfo');
  if (!addText.value.trim()) info.textContent = '';
  else if (!links.length) info.textContent = 'Ссылок на товары не нашёл';
  else
    info.innerHTML = `Найдено <b>${links.length}</b>${ignored ? ` · пропущу ${ignored} ${plural(ignored, 'чужую ссылку', 'чужие ссылки', 'чужих ссылок')}` : ''}`;
  $('#addForm [type=submit] span').textContent = links.length > 1 ? `Добавить ${links.length}` : 'Добавить';
}

async function readClipboard() {
  try {
    if (!navigator.clipboard?.readText) throw 0;
    return await navigator.clipboard.readText();
  } catch {
    toast('Нет доступа к буферу — вставьте вручную');
    return null;
  }
}

async function addLinks(text) {
  const submit = $('#addForm [type=submit]');
  if (submit.disabled) return;
  const { links } = extractLinks(text);
  if (!links.length) {
    toast('Не нашёл ссылок на Ozon, WB, Маркет или AliExpress');
    return;
  }
  const shareText = links.length === 1 && links[0].source === 'ali' && text.length <= 3000 &&
    /^(?:Смотри, что есть на AliExpress!|I just found this on AliExpress:)/i.test(text.trim()) ? text : undefined;
  const list = $('#progress');
  list.hidden = false;
  list.innerHTML = links
    .map((l, i) => `<li data-i="${i}">${fav(l.source)}<span class="u">${esc(l.url.replace(/^https?:\/\/(www\.)?/, ''))}</span><span class="spinner"></span></li>`)
    .join('');
  submit.disabled = true;
  const rows = [...list.children];
  const board = state.board;
  let added = 0, dups = 0, failed = 0;

  // 3 запроса параллельно — сервер парсит по одной ссылке за раз
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const i = next++;
      const li = rows[i];
      const { url, source } = links[i];
      try {
        const viaApp = await importViaApp(board, url, source);
        const r = viaApp?.card ? viaApp
          : await api('/api/cards', { method: 'POST', body: { board, url: viaApp?.resolved || url, shareText } });
        if (state.board === board) upsertCard(r.card);
        if (r.duplicate) dups++;
        else added++;
        li.className = r.duplicate ? 'dup' : 'ok';
        li.querySelector('.spinner').outerHTML = `<span class="st">${r.duplicate ? 'уже есть' : 'добавлено'}</span>`;
        li.querySelector('.u').textContent = r.card.title;
      } catch (e) {
        failed++;
        li.className = 'err';
        li.querySelector('.spinner').outerHTML = `<span class="st" title="${esc(e.message)}">ошибка</span>`;
        li.querySelector('.u').textContent = e.message;
      }
      render();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  submit.disabled = false;

  const parts = [];
  if (added) parts.push(`добавлено ${added}`);
  if (dups) parts.push(`уже были ${dups}`);
  if (failed) parts.push(`ошибок ${failed}`);
  toast(parts.join(', ').replace(/^./, (s) => s.toUpperCase()));
  if (failed && addDialog.open && addText.value === text) {
    $('#parseInfo').textContent = 'Не все ссылки добавились — причина в списке ниже.';
  } else if (!failed && addText.value === text) {
    addText.value = '';
    setTimeout(() => addDialog.open && !addText.value && addDialog.close(), 700);
  }
}

function upsertCard(card) {
  card = withUploadedPhoto(card);
  const i = state.cards.findIndex((c) => c.id === card.id);
  if (i >= 0) state.cards[i] = card;
  else state.cards.unshift(card);
}

function withUploadedPhoto(card) {
  if (!privatePhoto.test(card.uploadedPhoto)) return card;
  const images = card.images || [];
  const thumbs = card.thumbs?.length === images.length ? card.thumbs : images;
  return { ...card, images: [card.uploadedPhoto, ...images], thumbs: [card.uploadedPhoto, ...thumbs], partial: card.price == null };
}

const verificationDialog = $('#verificationDialog');
const photoInput = $('#cardPhotoInput');

function openProductCheck(value, cardId) {
  if (!value) return;
  const url = new URL(value);
  const source = detectSource(url.hostname);
  if (!verificationSources.has(source) || url.username || url.password) return;
  url.protocol = 'https:';
  const frame = $('#verificationFrame');
  const framed = /(^|\.)(ozon\.(ru|by|kz)|market\.yandex\.(ru|by|kz|com)|wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru|aliexpress\.(ru|com|us))$/.test(url.hostname)
    || ['ozon.onelink.me', 'ya.cc'].includes(url.hostname);
  frame.hidden = !framed;
  $('#verificationStatus').hidden = !framed;
  $('#verificationTitle').textContent = SOURCES[source].name;
  const external = $('#verificationExternal');
  const chrome = IS_ANDROID && /Chrome\//.test(UA) && !/(?:EdgA|SamsungBrowser|YaBrowser|OPR)\//.test(UA);
  external.href = chrome ? androidIntent(url, 'com.android.chrome') : url.href;
  external.textContent = chrome ? 'Открыть в Chrome' : 'Открыть в браузере';
  external.target = chrome ? '_self' : '_blank';
  $('#verificationAddress').value = url.href;
  $('#verificationAddressField').hidden = true;
  $('#verificationCopyStatus').hidden = true;
  const photo = $('#verificationPhoto');
  photo.hidden = !cardId;
  photo.dataset.cardId = cardId || '';
  openDialog(verificationDialog);
  if (framed) frame.src = url.href;
}

async function copyVerificationUrl() {
  const field = $('#verificationAddress');
  const status = $('#verificationCopyStatus');
  try {
    await navigator.clipboard.writeText(field.value);
    status.textContent = 'Вставьте ссылку в адресную строку браузера.';
  } catch {
    $('#verificationAddressField').hidden = false;
    field.focus();
    field.select();
    status.textContent = 'Скопируйте выделенный адрес и вставьте его в строку браузера.';
  }
  status.hidden = false;
}

function selectPhoto(id) {
  if (!id || !state.cards.some((card) => card.id === id)) return;
  photoInput.dataset.cardId = id;
  photoInput.value = '';
  photoInput.click();
}

async function preparePhoto(file) {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = source;
    });
    const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.68, 0.48]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 512 * 1024) return blob;
    }
  } catch {
    throw new Error('Не удалось открыть фото. Выберите изображение JPEG или PNG.');
  } finally {
    URL.revokeObjectURL(source);
  }
  throw new Error('Фото слишком большое. Выберите другое изображение.');
}

async function uploadPhoto() {
  const [file] = photoInput.files;
  if (!file) return;
  const id = photoInput.dataset.cardId;
  const board = state.board;
  try {
    const result = await api(`/api/cards/${id}/photo`, { method: 'POST', file: await preparePhoto(file) });
    if (board !== state.board) return;
    upsertCard(result.card);
    render();
    if (verificationDialog.open && $('#verificationPhoto').dataset.cardId === id) verificationDialog.close();
    if (state.openId === id) refreshViewer(true);
    toast('Фото добавлено');
  } catch (error) {
    toast(error.message);
  } finally {
    photoInput.value = '';
  }
}

/* ===================== Карточка, галерея, лайтбокс ==================== */

const viewer = $('#viewer');

function openViewer(id) {
  state.openId = id;
  refreshViewer(true);
  openDialog(viewer);
  history.replaceState(null, '', '#card=' + id);
}

function closeViewer() {
  state.openId = null;
  if (viewer.open) viewer.close();
  if (location.hash.startsWith('#card=')) history.replaceState(null, '', location.pathname + location.search);
}

function androidIntent(url, packageName) {
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${packageName};S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

function appHref(c) {
  if (IS_ANDROID) return androidIntent(new URL(c.url), SOURCES[c.source].pkg);
  // iOS: универсальная ссылка откроет приложение, если оно установлено
  return c.url;
}

function refreshViewer(full = false) {
  const c = state.cards.find((x) => x.id === state.openId);
  const body = $('#viewerBody');
  if (!c) {
    if (viewer.open) closeViewer();
    return;
  }
  const sig = JSON.stringify([c.images, c.title, c.price, c.oldPrice, c.rating, c.reviews, c.updatedAt, c.edited]);
  if (!full && body.dataset.sig === sig && body.dataset.id === c.id) {
    // меняются только голоса — не трогаем галерею
    $('.votes', body).outerHTML = votesHtml(c);
    return;
  }
  const keepIndex = body.dataset.id === c.id ? currentSlide() : 0;
  body.dataset.sig = sig;
  body.dataset.id = c.id;
  const imgs = c.images || [];
  const missing = [!imgs.length && 'фото', c.price == null && 'цены'].filter(Boolean).join(' и ');
  const src = SOURCES[c.source];
  // Кнопки «⋯» и «✕» живут вне прокручиваемого содержимого и всегда остаются на месте
  const top = $('#viewerTop');
  $$('.dd.open', top).forEach((d) => setDd(d, false));
  top.innerHTML = `
        <div class="dd more">
          <button type="button" class="icon-btn float-btn" data-action="toggle-more" aria-haspopup="menu" aria-expanded="false" aria-label="Ещё" title="Ещё"><svg><use href="#i-more"/></svg></button>
          <div class="dd-menu" role="menu">
            <button type="button" class="dd-opt" role="menuitem" data-action="copy-card"><span class="ic"><svg><use href="#i-copy"/></svg></span><span class="lbl">Скопировать ссылку</span></button>
            <button type="button" class="dd-opt" role="menuitem" data-action="refresh-card"><span class="ic"><svg><use href="#i-refresh"/></svg></span><span class="lbl">Обновить цену и фото</span></button>
            <button type="button" class="dd-opt" role="menuitem" data-action="edit-card"><span class="ic"><svg><use href="#i-edit"/></svg></span><span class="lbl">Изменить</span></button>
            ${imgs.length ? `<button type="button" class="dd-opt" role="menuitem" data-action="upload-photo">${c.uploadedPhoto ? 'Заменить своё фото' : 'Добавить своё фото'}</button>` : ''}
            <div class="dd-sep"></div>
            <button type="button" class="dd-opt danger" role="menuitem" data-action="delete-card"><span class="ic"><svg><use href="#i-trash"/></svg></span><span class="lbl">Удалить из подборки</span></button>
          </div>
        </div>
        <button type="button" class="icon-btn float-btn" data-action="close-viewer" aria-label="Закрыть" title="Закрыть"><svg><use href="#i-close"/></svg></button>`;
  body.innerHTML = `
    <div class="gallery">
      <div class="stage">
      <div class="track" id="track">${
        imgs.length
          ? imgs.map((u, i) => `<div class="slide"><img ${photoSource(u)} alt="Фото ${i + 1}" ${i ? 'loading="lazy"' : ''} referrerpolicy="no-referrer" data-zoom="${i}"></div>`).join('')
          : `<div class="slide">${placeholderHtml(c, false)}</div>`
      }</div>
      ${imgs.length > 1 ? `<button class="icon-btn nav prev" data-action="prev" aria-label="Предыдущее фото"><svg><use href="#i-left"/></svg></button>
      <button class="icon-btn nav next" data-action="next" aria-label="Следующее фото"><svg><use href="#i-right"/></svg></button>
      <span class="counter" id="counter">1 / ${imgs.length}</span>` : ''}
      </div>
      ${imgs.length > 1 ? `<div class="thumbs" id="thumbs">${(c.thumbs?.length === imgs.length ? c.thumbs : imgs)
        .map((u, i) => `<button data-thumb="${i}" class="${i ? '' : 'active'}" aria-label="Фото ${i + 1}"><img ${photoSource(u)} alt="" loading="lazy" referrerpolicy="no-referrer"></button>`)
        .join('')}</div>` : ''}
    </div>
    <div class="info">
      ${priceHtml(c)}
      <h2>${esc(c.title)}</h2>
      ${metaHtml(c)}
      ${votesHtml(c)}
      ${c.partial && missing ? `<div class="partial-note"><span class="msg">Нет ${missing}</span><button type="button" class="btn" data-action="edit-card" aria-label="Дополнить вручную" title="Дополнить вручную"><svg><use href="#i-edit"/></svg><span class="lbl">Дополнить</span></button></div>` : ''}
      ${!imgs.length ? '<div class="row"><button type="button" class="btn" data-action="upload-photo">Добавить фото</button></div>' : ''}
      <div class="open-row">
        ${!imgs.length && nativeApp && nativeSources.has(c.source)
          ? '<button type="button" class="btn primary" data-action="refresh-card"><svg><use href="#i-refresh"/></svg><span>Обновить цену и фото</span></button>'
          : !imgs.length && verificationSources.has(c.source)
          ? '<button type="button" class="btn primary" data-action="check-product"><svg><use href="#i-open"/></svg><span>Открыть проверку</span></button>'
          : `<a class="btn primary" href="${esc(appHref(c))}" ${IS_ANDROID ? '' : 'target="_blank"'} rel="noopener"><svg><use href="#i-open"/></svg><span><span class="verb">Открыть в </span>${src.name}</span></a>`}
        <button type="button" class="icon-btn share" data-action="share-card" aria-label="Поделиться" title="Поделиться"><svg><use href="#i-share"/></svg></button>
      </div>
      <div class="updated">${c.priceNote ? `Цена ${esc(c.priceNote)} · ` : ''}обновлено ${ago(c.updatedAt)}</div>
    </div>`;
  loadPrivatePhotos(body);
  const track = $('#track');
  track.addEventListener('scroll', onTrackScroll, { passive: true });
  if (keepIndex) requestAnimationFrame(() => goSlide(keepIndex, false));
}

function currentSlide() {
  const t = $('#track');
  return t ? Math.round(t.scrollLeft / t.clientWidth) : 0;
}
function goSlide(i, smooth = true) {
  const t = $('#track');
  if (!t) return;
  const n = t.children.length;
  i = (i + n) % n;
  t.scrollTo({ left: i * t.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
}
function onTrackScroll() {
  const i = currentSlide();
  const n = $('#track').children.length;
  const counter = $('#counter');
  if (counter) counter.textContent = `${i + 1} / ${n}`;
  $$('#thumbs button').forEach((b, k) => b.classList.toggle('active', k === i));
  // прокручиваем только ленту миниатюр (scrollIntoView дёрнул бы всю карточку)
  const strip = $('#thumbs');
  const th = $(`#thumbs [data-thumb="${i}"]`);
  if (strip && th) {
    const left = th.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + th.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollTo({ left: left - strip.clientWidth / 2 + th.offsetWidth / 2, behavior: 'smooth' });
  }
}

// Лайтбокс (полноэкранные фото) — жесты и зум ниже, в разделе «Лайтбокс: жесты и зум»
const lightbox = $('#lightbox');

/* ============================== Действия ============================== */

async function refreshCard(id) {
  toast('Обновляю…');
  try {
    const c = state.cards.find((x) => x.id === id);
    const viaPhone = c && (await importViaApp(state.board, c.url, c.source, id));
    const r = viaPhone?.card ? viaPhone : await api(`/api/cards/${id}/refresh`, { method: 'POST', body: {} });
    upsertCard(r.card);
    render();
    refreshViewer(true);
    toast('Данные обновлены');
  } catch (e) {
    toast(e.message);
  }
}

async function deleteCard(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  const ok = await confirmDialog({
    title: 'Удалить товар?',
    text: `«${c.title.slice(0, 80)}» и лайки к нему удалятся из подборки.`,
    ok: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/cards/${id}`, { method: 'DELETE' });
    state.cards = state.cards.filter((x) => x.id !== id);
    closeViewer();
    render();
    toast('Удалено');
  } catch (e) {
    toast(e.message);
  }
}

const editDialog = $('#editDialog');
function openEdit(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  const f = $('#editForm');
  f.dataset.id = id;
  f.title.value = c.title || '';
  f.price.value = c.price ?? '';
  f.oldPrice.value = c.oldPrice ?? '';
  f.rating.value = c.rating ?? '';
  f.reviews.value = c.reviews ?? '';
  f.images.value = editedPhotoLinks(c);
  openDialog(editDialog);
  autosize(f.images);
}

function editedPhotoLinks(card) {
  return card.edited.includes('images') ? card.images.filter((url) => !privatePhoto.test(url)).join('\n') : '';
}

async function saveEdit() {
  const f = $('#editForm');
  const id = f.dataset.id;
  const c = state.cards.find((x) => x.id === id);
  const val = (k) => f[k].value.trim();
  const overrides = {};
  // Отправляем только то, что реально поменяли
  for (const k of ['title', 'price', 'oldPrice', 'rating', 'reviews']) {
    const was = c[k] == null ? '' : String(c[k]);
    if (val(k) !== was) overrides[k] = val(k);
  }
  const imgs = val('images');
  if (imgs !== editedPhotoLinks(c)) overrides.images = imgs;
  if (!Object.keys(overrides).length) return;
  try {
    const r = await api(`/api/cards/${id}`, { method: 'PATCH', body: { overrides } });
    upsertCard(r.card);
    render();
    refreshViewer(true);
    toast('Сохранено');
  } catch (e) {
    toast(e.message);
  }
}

/* ============================== Поделиться ============================ */

function boardUrl() {
  const u = new URL(location.pathname, location.origin);
  if (state.api && normalizeApi(CFG.apiUrl) !== state.api) u.searchParams.set('api', state.api);
  if (state.board !== 'main') u.searchParams.set('b', state.board);
  return u.toString();
}

async function share({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const full = text ? `${text}\n${url}` : url;
  $('#shareUrl').value = url;
  $('#shareTargets').innerHTML = [
    ['Telegram', '<img src="img/tg.png" alt="">', `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text || title || '')}`],
    ['WhatsApp', '<span class="glyph" style="background:#25d366"><svg><use href="#i-wa"/></svg></span>', `https://wa.me/?text=${encodeURIComponent(full)}`],
    ['ВКонтакте', '<img src="img/vk.png" alt="">', `https://vk.com/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title || '')}`],
    ['Почта', '<span class="glyph" style="background:#8e8e93"><svg><use href="#i-mail"/></svg></span>', `mailto:?subject=${encodeURIComponent(title || '')}&body=${encodeURIComponent(full)}`],
  ]
    .map(([n, ic, href]) => `<a href="${href}" target="_blank" rel="noopener"><span class="ic">${ic}</span>${n}</a>`)
    .join('');
  openDialog($('#shareDialog'));
}

function shareCard(c) {
  const price = c.price != null ? ` — ${rub(c.price)}` : '';
  share({ title: c.title, text: `${c.title}${price}`, url: c.url });
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована');
  } catch {
    toast('Не удалось скопировать');
  }
}

/* ============================== Настройки ============================= */

const settingsDialog = $('#settingsDialog');
function deployUrl() {
  return `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent((CFG.repo || '') + '/tree/main/worker')}`;
}
function setRole(role) {
  state.role = role;
  store.set('role', role);
  $$('#roleSwitch [data-role]').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
  cardSig.clear();
  render();
  if (state.openId) refreshViewer();
}

const roleDialog = $('#roleDialog');
function askRole() {
  openDialog(roleDialog);
}

function openSettings() {
  const f = $('#settingsForm');
  $$('#roleSwitch [data-role]').forEach((b) => b.classList.toggle('active', b.dataset.role === state.role));
  markTheme();
  markFont();
  previewFonts();
  f.apiUrl.value = state.api;
  $('#deployLink').href = deployUrl();
  setSetupOpen(!state.api);
  $('#apiStatus').textContent = '';
  $('#apiStatus').className = 'api-status';
  openDialog(settingsDialog);
}

function setAccordionOpen(box, open) {
  box.classList.toggle('open', open);
  $('.acc-head', box).setAttribute('aria-expanded', open);
}
const setSetupOpen = (open) => setAccordionOpen($('#setupBox'), open);

async function testApi(url) {
  const s = $('#apiStatus');
  s.className = 'api-status';
  s.textContent = 'Проверяю…';
  try {
    const r = await fetch(normalizeApi(url) + '/api/health').then((r) => r.json());
    if (!r.ok) throw 0;
    s.className = 'api-status ok';
    s.textContent = r.db ? 'Работает' : 'Работает, но нет базы';
    return true;
  } catch {
    s.className = 'api-status err';
    s.textContent = 'Не отвечает';
    return false;
  }
}

function saveSettings() {
  const f = $('#settingsForm');
  const api = normalizeApi(f.apiUrl.value);
  const changed = api !== state.api;
  state.api = api;
  store.set('api_override', api === normalizeApi(CFG.apiUrl) ? '' : api);
  if (changed) {
    clearPrivatePhotos();
    state.accessToken = store.get('access:' + state.api, '');
    state.unlocked = false;
    state.cards = [];
    state.boards = [];
    cardSig.clear();
    setTimeout(() => enterApp(), 0);
  }
}

/* ============================== Подборки ============================== */

const boardsDialog = $('#boardsDialog');
const currentBoard = () => state.boards.find((b) => b.id === state.board);

function renderBoardName() {
  const b = currentBoard();
  $('#boardName').textContent = b ? b.name : state.board === 'main' ? 'Основная' : state.board;
}

async function loadBoards() {
  if (!state.api) return;
  try {
    const r = await api('/api/boards');
    state.boards = r.boards;
    // Подборки из ссылки ещё нет в списке (например, её удалили) — переходим на первую
    if (!currentBoard() && state.boards.length && !state.cards.length) switchBoard(state.boards[0].id, false);
  } catch {}
  renderBoardName();
  if (boardsDialog.open) renderBoards();
  if (moveDialog.open) renderMoveList();
}

function boardMeta(b) {
  // для текущей подборки берём живые данные с экрана
  const live = b.id === state.board && !state.loading;
  const count = live ? state.cards.length : b.count;
  const total = live ? state.cards.reduce((a, c) => a + (c.price || 0), 0) : b.total;
  return count ? `${count} ${plural(count, 'товар', 'товара', 'товаров')}${total ? ' · ' + rub(total) : ''}` : 'пусто';
}

function renderBoards() {
  const list = $('#boardsList');
  const many = state.boards.length > 1;
  list.innerHTML = state.boards
    .map((b) => {
      return `<li class="board-row ${b.id === state.board ? 'current' : ''}" data-board="${esc(b.id)}">
        <button type="button" class="board-pick" data-action="pick-board"><span class="txt"><span class="bn">${esc(b.name)}</span><span class="bm">${boardMeta(b)}</span></span><svg class="ck"><use href="#i-check"/></svg></button>
        <button type="button" class="icon-btn ghost" data-action="rename-board" aria-label="Переименовать" title="Переименовать"><svg><use href="#i-edit"/></svg></button>
        ${many ? `<button type="button" class="icon-btn ghost danger" data-action="delete-board" aria-label="Удалить" title="Удалить"><svg><use href="#i-trash"/></svg></button>` : ''}
      </li>`;
    })
    .join('');
}

function openBoards() {
  if (!state.api) return openSettings();
  renderBoards();
  $('#boardsForm').boardName.value = '';
  openDialog(boardsDialog);
  loadBoards();
}

function switchBoard(id, notify = true) {
  if (id === state.board) return;
  exitSelection();
  state.board = id;
  store.set('board', id === 'main' ? '' : id);
  state.cards = [];
  state.source = '';
  cardSig.clear();
  setFilter('all');
  renderBoardName();
  loadCards();
  if (notify) toast(`Подборка «${currentBoard()?.name || id}»`);
}

function pickBoard(id) {
  switchBoard(id);
  boardsDialog.close();
}

async function createBoard() {
  const input = $('#boardsForm').boardName;
  const name = input.value.trim();
  if (!name) return input.focus();
  try {
    const r = await api('/api/boards', { method: 'POST', body: { name } });
    state.boards.push(r.board);
    input.value = '';
    pickBoard(r.board.id);
  } catch (e) {
    toast(e.message);
  }
}

function startRename(row) {
  const b = state.boards.find((x) => x.id === row.dataset.board);
  row.innerHTML = `<input class="rename" value="${esc(b.name)}" maxlength="60" aria-label="Новое название">
    <button type="button" class="icon-btn ghost" data-action="save-board" aria-label="Сохранить" title="Сохранить"><svg><use href="#i-check"/></svg></button>`;
  const input = $('.rename', row);
  input.focus();
  input.select();
}

async function saveRename(row) {
  const id = row.dataset.board;
  const name = $('.rename', row)?.value.trim();
  const b = state.boards.find((x) => x.id === id);
  if (!name || name === b.name) return renderBoards();
  try {
    await api(`/api/boards/${id}`, { method: 'PATCH', body: { name } });
    b.name = name;
    renderBoards();
    renderBoardName();
  } catch (e) {
    toast(e.message);
  }
}

async function removeBoard(id) {
  const b = state.boards.find((x) => x.id === id);
  if (!b) return;
  const count = b.id === state.board && !state.loading ? state.cards.length : b.count;
  const ok = await confirmDialog({
    title: `Удалить подборку «${b.name}»?`,
    text: `${count ? `Вместе с ней удалятся ${count} ${plural(count, 'товар', 'товара', 'товаров')} и все лайки. ` : ''}Это нельзя отменить.`,
    ok: 'Удалить',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/boards/${id}`, { method: 'DELETE' });
    state.boards = state.boards.filter((x) => x.id !== id);
    if (state.board === id) switchBoard(state.boards[0].id, false);
    renderBoards();
    toast('Подборка удалена');
  } catch (e) {
    toast(e.message);
  }
}

/* ================================ Тема ================================ */

function setTheme(key) {
  store.set('theme', window.MP_applyTheme(key) === 'system' ? '' : key);
  markTheme();
}
function markTheme() {
  const cur = document.documentElement.dataset.theme || 'system';
  $$('#themeSwitch [data-theme-key]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeKey === cur);
    b.setAttribute('aria-checked', String(b.dataset.themeKey === cur));
  });
}

/* =============================== Шрифты =============================== */

function setFont(key) {
  key = window.MP_applyFont(key);
  store.set('font', key);
  markFont();
}
function markFont() {
  const cur = document.documentElement.dataset.font;
  $$('#fontSwitch [data-font]').forEach((b) => b.classList.toggle('active', b.dataset.font === cur));
}
// Чтобы на кнопках выбора было видно оба шрифта, подгружаем их заголовочные начертания
function previewFonts() {
  if ($('#fontPreview')) return;
  const l = document.createElement('link');
  l.id = 'fontPreview';
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Montserrat+Alternates:wght@700&family=Geologica:wght@700&display=swap&text=' + encodeURIComponent('ИгривоСвежо');
  document.head.appendChild(l);
}

/* ============================ Кнопка «Назад» ============================ */

// Единый стек слоёв: открытая карточка, лайтбокс, окна, режим выбора, выпадающие меню.
// Каждый слой при открытии добавляет запись в историю, поэтому «Назад» (жест Android, кнопка браузера)
// закрывает только верхний слой. Если слой закрылся своим интерфейсом (✕, Escape, тап мимо, смахивание),
// лишние записи отматываются одним history.go(-n). Адрес страницы при этом не меняется.
const layers = []; // [{ key, close }]
let unwind = 0; // записей истории, которые осталось отмотать (их слои уже закрыты)
let owed = 0; // записей, которые надо добавить, когда закончится наша перемотка
let traversing = 0; // наши history.go() в пути: их popstate слои не закрывает
let unwindTimer = 0;
let traverseGuard = 0;

function pushLayer(key, close) {
  if (layers.some((l) => l.key === key)) return;
  layers.push({ key, close });
  if (unwind) {
    // Запись закрытого слоя ещё не отмотана — используем её для нового слоя
    unwind--;
    history.replaceState({ ...(history.state || {}), layer: layers.length }, '');
  } else if (traversing) owed++;
  else history.pushState({ ...(history.state || {}), layer: layers.length }, '');
}

// Слой закрылся сам: убираем его (и всё, что открыто поверх него) и отматываем историю
function popLayer(key) {
  const i = layers.findIndex((l) => l.key === key);
  if (i < 0) return;
  const gone = layers.splice(i);
  for (const l of gone.slice(1).reverse()) l.close();
  for (let k = 0; k < gone.length; k++) owed ? owed-- : unwind++;
  if (unwind && !unwindTimer) unwindTimer = setTimeout(flushUnwind, 0);
}

function flushUnwind() {
  unwindTimer = 0;
  if (!unwind || traversing) return;
  const n = unwind;
  unwind = 0;
  traversing++;
  history.go(-n);
  // Если браузер не смог перейти (записи пропали), не зависаем в ожидании popstate
  clearTimeout(traverseGuard);
  traverseGuard = setTimeout(() => traversing && settleTraverse(), 800);
}

function settleTraverse() {
  traversing = 0;
  clearTimeout(traverseGuard);
  for (; owed > 0; owed--) history.pushState({ ...(history.state || {}), layer: layers.length - owed + 1 }, '');
  if (unwind) flushUnwind();
}

window.addEventListener('popstate', () => {
  if (traversing) {
    traversing--;
    if (!traversing) settleTraverse();
    return;
  }
  // «Назад» съел запись уже закрытого слоя — больше ничего не закрываем
  if (unwind) return void unwind--;
  layers.pop()?.close();
});

// Для приложения Android: true — закрыли верхний слой, false — закрывать нечего (можно выходить)
window.mpHandleBack = () => {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.close();
  return true;
};

// Окно входа и выбор роли «Назад» не закрывает: без них пользоваться сайтом нельзя
const pinnedDialogs = () => [accessDialog, roleDialog];
function openDialog(d) {
  if (d.open) return;
  d.showModal();
  if (!pinnedDialogs().includes(d)) pushLayer(d, () => d.open && d.close());
}

// Выпадающее меню — тоже слой: «Назад» сначала закрывает его
function setDd(dd, open) {
  if (!dd || dd.classList.contains('open') === open) return;
  dd.classList.toggle('open', open);
  $(':scope > .dd-btn, :scope > [data-action="toggle-more"]', dd)?.setAttribute('aria-expanded', String(open));
  if (open) pushLayer(dd, () => setDd(dd, false));
  else popLayer(dd);
}

/* ============================ Подтверждение ============================ */

// Своё окно вместо системного confirm(): в тон сайту, со светлой и тёмной темой.
// Возвращает промис: true — подтвердили, false — отменили (кнопкой, Escape или тапом мимо окна).
const confirmBox = $('#confirmDialog');
let confirmDone = null;
let confirmReturnFocus = null;

function confirmDialog({ title, text = '', ok = 'OK', cancel = 'Отмена', danger = false }) {
  confirmDone?.(false);
  $('#confirmTitle').textContent = title;
  const p = $('#confirmText');
  p.textContent = text;
  p.hidden = !text;
  const okBtn = $('#confirmOk');
  const cancelBtn = $('button[value=cancel]', confirmBox);
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
  cancelBtn.textContent = cancel;
  confirmBox.returnValue = '';
  confirmReturnFocus = document.activeElement;
  return new Promise((resolve) => {
    confirmDone = (value) => {
      confirmDone = null;
      resolve(value);
    };
    openDialog(confirmBox);
    // Для опасного действия фокус на «Отмена», чтобы случайный Enter ничего не удалил
    (danger ? cancelBtn : okBtn).focus();
  });
}

function onConfirmClose() {
  confirmDone?.(confirmBox.returnValue === 'ok');
  const back = confirmReturnFocus;
  confirmReturnFocus = null;
  if (back?.isConnected && (document.activeElement === document.body || !document.activeElement)) back.focus?.({ preventScroll: true });
}

/* ============================ Режим выбора ============================ */

// Долгое нажатие на карточку включает выбор: касания отмечают карточки, снизу — «Перенести» и «Удалить».
const LONG_PRESS_MS = 450;
const selbar = $('#selbar');
const selactions = $('#selactions');
const moveDialog = $('#moveDialog');

function enterSelection(id) {
  if (!state.unlocked || state.loading || !state.api) return;
  $$('.dd.open').forEach((d) => setDd(d, false));
  if (!state.selecting) {
    state.selecting = true;
    state.selected = new Set();
    // «Назад» (Android, браузер, Escape) выходит из режима выбора, а не со страницы
    pushLayer('select', exitSelection);
  }
  if (id) state.selected.add(id);
  syncSelection();
}

function exitSelection() {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  syncSelection();
  popLayer('select');
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelection();
}

function selectAll() {
  const ids = visibleCards().map((c) => c.id);
  const all = ids.length && ids.every((id) => state.selected.has(id));
  state.selected = new Set(all ? [] : ids);
  syncSelection();
}

// Выбранными остаются только карточки, которые сейчас на экране (фильтр, удаление другим человеком)
function pruneSelection() {
  if (!state.selecting || state.loading) return;
  const ids = new Set(visibleCards().map((c) => c.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}

function syncSelection() {
  const on = state.selecting;
  document.body.classList.toggle('selecting', on);
  selbar.hidden = !on;
  selactions.hidden = !on;
  for (const el of $$('#grid .card')) {
    const picked = on && state.selected.has(el.dataset.id);
    el.classList.toggle('selected', picked);
    if (on) el.setAttribute('aria-selected', String(picked));
    else el.removeAttribute('aria-selected');
  }
  updateSum();
  if (!on) return;
  const n = state.selected.size;
  $('#selCount').textContent = n ? `Выбрано ${n}` : 'Выберите товары';
  const total = visibleCards().length;
  const all = total > 0 && n === total;
  $('.sel-all span', selbar).textContent = all ? 'Снять все' : 'Выбрать все';
  $$('button', selactions).forEach((b) => (b.disabled = !n));
}

// Карточки плавно исчезают, прежде чем пропасть из сетки
function animateOut(ids) {
  const els = ids.map((id) => $(`#grid .card[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  if (!els.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  els.forEach((el) => el.classList.add('leaving'));
  return new Promise((r) => setTimeout(r, 200));
}

async function dropCards(ids) {
  await animateOut(ids);
  const gone = new Set(ids);
  state.cards = state.cards.filter((c) => !gone.has(c.id));
  render();
}

const goodsText = (n) => `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const n = ids.length;
  const ok = await confirmDialog({
    title: n === 1 ? 'Удалить товар?' : `Удалить ${goodsText(n)}?`,
    text: `${n === 1 ? 'Товар и лайки к нему удалятся' : 'Товары и лайки к ним удалятся'} из подборки. Это нельзя отменить.`,
    ok: 'Удалить',
    danger: true,
  });
  if (!ok || !state.selecting) return;
  const board = state.board;
  try {
    await api('/api/cards/delete', { method: 'POST', body: { ids } });
    if (state.board !== board) return;
    exitSelection();
    await dropCards(ids);
    toast(`Удалено: ${goodsText(n)}`);
    loadBoards();
  } catch (e) {
    toast(e.message);
  }
}

function openMove() {
  const n = state.selected.size;
  if (!n) return;
  $('#moveTitle').textContent = `Перенести ${goodsText(n)}`;
  const form = $('#moveForm');
  form.boardName.value = '';
  renderMoveList();
  showMoveNew(!state.boards.some((b) => b.id !== state.board));
  openDialog(moveDialog);
  loadBoards();
}

function renderMoveList() {
  const others = state.boards.filter((b) => b.id !== state.board);
  $('#moveList').innerHTML =
    others
      .map((b) => `<li class="board-row" data-board="${esc(b.id)}">
        <button type="button" class="board-pick" data-action="move-to"><span class="txt"><span class="bn">${esc(b.name)}</span><span class="bm">${boardMeta(b)}</span></span><svg class="go"><use href="#i-right"/></svg></button>
      </li>`)
      .join('') +
    `<li class="board-row new-row" ${$('#moveNew').hidden ? '' : 'hidden'}>
      <button type="button" class="board-pick" data-action="move-new"><span class="plus"><svg><use href="#i-plus"/></svg></span><span class="txt"><span class="bn">Новая подборка…</span></span></button>
    </li>`;
}

function showMoveNew(show) {
  $('#moveNew').hidden = !show;
  const row = $('#moveList .new-row');
  if (row) row.hidden = show;
  if (show && moveDialog.open) $('#moveForm').boardName.focus();
}

let moving = false;
async function moveSelected(target, name) {
  const ids = [...state.selected];
  const from = state.board;
  if (moving || !ids.length || target === from) return;
  moving = true;
  try {
    const r = await api('/api/cards/move', { method: 'POST', body: { ids, board: target } });
    if (moveDialog.open) moveDialog.close();
    if (state.board !== from) return;
    exitSelection();
    await dropCards(ids);
    const merged = r.merged?.length || 0;
    toast(`Перенесено в «${name}»: ${goodsText(ids.length)}${merged ? ` (${merged} уже ${merged === 1 ? 'был' : 'были'} там — лайки объединены)` : ''}`);
    loadBoards();
  } catch (e) {
    toast(e.message);
  } finally {
    moving = false;
  }
}

async function moveToNewBoard() {
  const input = $('#moveForm').boardName;
  const name = input.value.trim();
  if (!name) return input.focus();
  if (moving) return;
  try {
    const r = await api('/api/boards', { method: 'POST', body: { name } });
    state.boards.push(r.board);
    await moveSelected(r.board.id, r.board.name);
  } catch (e) {
    toast(e.message);
  }
}

// Долгое нажатие: карточка медленно «вдавливается», через 450 мс включается выбор.
// Сдвиг пальца больше чем на 10 px (прокрутка) отменяет нажатие.
let press = null;
let pressFired = false;
let lastPointerType = 'mouse';

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  clearTimeout(press.holdTimer);
  press.card.classList.remove('holding');
  press = null;
}

function firePress() {
  const { card, id } = press;
  cancelPress();
  pressFired = true;
  buzz(10);
  if (state.selecting) toggleSelected(id);
  else enterSelection(id);
  card.classList.add('picked');
  setTimeout(() => card.classList.remove('picked'), 320);
}

function bindLongPress(grid) {
  grid.addEventListener('pointerdown', (e) => {
    cancelPress();
    if (e.button !== 0 || !e.isPrimary) return;
    const card = !ddSwallowClick && e.target.closest('.card');
    // Сердце всегда голосует, даже если его подержать подольше
    if (!card || (!state.selecting && e.target.closest('[data-vote]'))) return;
    press = { card, id: card.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    press.holdTimer = setTimeout(() => card.classList.add('holding'), 90);
    press.timer = setTimeout(firePress, LONG_PRESS_MS);
  });
  grid.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, cancelPress, { passive: true });
  window.addEventListener('scroll', cancelPress, { passive: true });
  // Без системного меню и перетаскивания картинок на карточках
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    // Правая кнопка мыши на компьютере — то же, что долгое нажатие
    if (lastPointerType === 'mouse' && !press && !pressFired) {
      if (state.selecting) toggleSelected(card.dataset.id);
      else enterSelection(card.dataset.id);
    }
  });
  grid.addEventListener('dragstart', (e) => e.target.closest('.card') && e.preventDefault());
  // Отпускание после долгого нажатия не должно открывать карточку
  window.addEventListener('click', (e) => {
    if (!pressFired) return;
    pressFired = false;
    if (e.target.closest?.('#grid')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

/* ========================== Отклик на нажатия ========================== */

// Всё нажимаемое чуть «проседает» под пальцем (класс .pressed, стили — в CSS).
// На касание реагируем с задержкой 50 мс, чтобы прокрутка ленты не дёргала карточки,
// а быстрый тап всё равно получает заметный отклик не короче 110 мс.
const PRESSABLE = 'button, a.btn, .share-targets a, .card, [role="button"]';

function bindPressFeedback() {
  let el = null;
  let since = 0;
  let timer = 0;
  let x = 0;
  let y = 0;
  const on = () => {
    clearTimeout(timer);
    timer = 0;
    if (el && !el.classList.contains('pressed')) {
      el.classList.add('pressed');
      since = performance.now();
    }
  };
  const off = (flash) => {
    if (!el) return;
    const t = el;
    if (flash && timer) on();
    el = null;
    clearTimeout(timer);
    timer = 0;
    const left = 110 - (performance.now() - since);
    if (left > 0 && t.classList.contains('pressed')) setTimeout(() => t.classList.remove('pressed'), left);
    else t.classList.remove('pressed');
  };
  document.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    pressFired = false;
    off(false);
    if (e.button !== 0) return;
    const t = !ddSwallowClick && e.target.closest(PRESSABLE);
    if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    el = t;
    x = e.clientX;
    y = e.clientY;
    if (e.pointerType === 'mouse') on();
    else timer = setTimeout(on, 50);
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (el && Math.hypot(e.clientX - x, e.clientY - y) > 10) off(false);
  }, { passive: true });
  // Палец подняли раньше задержки — всё равно коротко показываем нажатие
  document.addEventListener('pointerup', () => off(true), { passive: true });
  document.addEventListener('pointercancel', () => off(false), { passive: true });
  // iOS Safari включает :active только при наличии обработчика touchstart
  document.addEventListener('touchstart', () => {}, { passive: true });
}

/* =================== Смахивание карточки вниз — закрыть =================== */

// Тянем открытую карточку вниз: она едет за пальцем, фон светлеет. Отпустили дальше 120 px
// или резко смахнули — карточка уезжает и закрывается, иначе пружинит обратно.
// Жест начинается, только если содержимое прокручено к началу и движение — вниз, а не вбок.
function bindViewerSwipe() {
  let g = null;
  const scrolled = (el) => {
    for (; el && el !== viewer; el = el.parentElement) if (el.scrollTop > 0) return true;
    return false;
  };
  const reset = () => {
    viewer.classList.remove('dragging');
    viewer.style.removeProperty('transition');
    viewer.style.removeProperty('translate');
    viewer.style.removeProperty('opacity');
    viewer.style.removeProperty('--drag');
  };
  viewer.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || lightbox.open || viewer.classList.contains('closing')) return;
    if (e.target.closest('.viewer-top, .dd-menu') || scrolled(e.target)) return;
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, mode: '', y: 0, v: 0, ly: t.clientY, lt: e.timeStamp };
  }, { passive: true });
  viewer.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.mode) {
      if (e.touches.length !== 1) return (g = null);
      if (Math.hypot(dx, dy) < 6) return;
      g.mode = dy > 0 && dy > Math.abs(dx) * 1.2 && e.cancelable ? 'drag' : 'skip';
      if (g.mode === 'drag') {
        $$('.dd.open', viewer).forEach((d) => setDd(d, false));
        viewer.classList.add('dragging');
        viewer.style.transition = 'none';
      }
    }
    if (g.mode !== 'drag') return;
    e.preventDefault();
    g.v = (t.clientY - g.ly) / Math.max(1, e.timeStamp - g.lt);
    g.ly = t.clientY;
    g.lt = e.timeStamp;
    // Лёгкое сопротивление: карточка отстаёт от пальца тем сильнее, чем дальше её тянут
    const h = viewer.clientHeight || innerHeight;
    g.y = Math.max(0, dy) * (1 - Math.min(0.35, Math.max(0, dy) / (h * 2)));
    viewer.style.translate = `0 ${g.y}px`;
    viewer.style.setProperty('--drag', Math.min(1, g.y / (h * 0.6)).toFixed(3));
  }, { passive: false });
  const end = () => {
    if (g?.mode !== 'drag') return (g = null);
    const { y, v } = g;
    g = null;
    if (y > 120 || (v > 0.5 && y > 24)) {
      viewer.classList.add('closing');
      viewer.style.transition = 'translate .22s cubic-bezier(.4, 0, 1, 1), opacity .22s ease-in, --drag .22s linear';
      viewer.style.translate = '0 100%';
      viewer.style.opacity = '0.6';
      viewer.style.setProperty('--drag', '1');
      setTimeout(() => {
        closeViewer();
        viewer.classList.remove('closing');
        reset();
      }, 230);
    } else {
      viewer.style.transition = 'translate .32s cubic-bezier(.25, 1, .5, 1), --drag .32s ease';
      viewer.style.translate = '0 0';
      viewer.style.setProperty('--drag', '0');
      setTimeout(() => !g && reset(), 340);
    }
  };
  viewer.addEventListener('touchend', end);
  viewer.addEventListener('touchcancel', end);
}

/* ========================= Лайтбокс: жесты и зум ========================= */

// Фото листаются трансформами, а не прокруткой: так щипок, двойной тап и перетаскивание
// увеличенного фото не путаются с перелистыванием и не масштабируют саму страницу.
const lb = { index: 0, n: 0, s: 1, tx: 0, ty: 0, dx: 0, dy: 0 };
const LB_MAX = 4;
const lbTrack = $('#lbTrack');
const lbImg = (i = lb.index) => lbTrack.children[i]?.querySelector('img');

function lbRender(animate) {
  const w = lightbox.clientWidth || innerWidth;
  const h = lightbox.clientHeight || innerHeight;
  const ease = animate ? '.32s cubic-bezier(.2, .8, .2, 1)' : '0s';
  lbTrack.style.transition = `transform ${ease}`;
  lbTrack.style.transform = `translate3d(${-lb.index * w + lb.dx}px, ${lb.dy}px, 0)`;
  const img = lbImg();
  if (img) {
    img.style.transition = `transform ${ease}`;
    img.style.transform = `translate3d(${lb.tx}px, ${lb.ty}px, 0) scale(${lb.s})`;
  }
  lightbox.style.transition = animate ? '--drag .32s ease' : '';
  lightbox.style.setProperty('--drag', Math.min(1, Math.max(0, lb.dy) / (h * 0.6)).toFixed(3));
  lightbox.classList.toggle('zoomed', lb.s > 1.01);
  $('#lbCounter').textContent = lb.n > 1 ? `${lb.index + 1} / ${lb.n}` : '';
}

// Допустимые сдвиги увеличенного фото: меньше экрана — по центру, больше — без пустых полей
function lbBounds(s) {
  const W = lightbox.clientWidth || innerWidth;
  const H = lightbox.clientHeight || innerHeight;
  const img = lbImg();
  const iw = img?.offsetWidth || W;
  const ih = img?.offsetHeight || H;
  const bx = (W - iw) / 2;
  const by = (H - ih) / 2;
  const range = (size, b, view) => (size * s <= view ? [(size - size * s) / 2, (size - size * s) / 2] : [view - b - size * s, -b]);
  return { x: range(iw, bx, W), y: range(ih, by, H), bx, by };
}
const clampTo = (v, [a, b]) => Math.min(b, Math.max(a, v));
const rubber = (v, [a, b]) => (v < a ? a - (a - v) * 0.35 : v > b ? b + (v - b) * 0.35 : v);

// Масштаб s вокруг точки экрана (fx, fy): точка фото под пальцами остаётся на месте
function lbZoomAt(s, fx, fy) {
  const { bx, by } = lbBounds(lb.s);
  const k = s / lb.s;
  lb.tx = fx - bx - k * (fx - bx - lb.tx);
  lb.ty = fy - by - k * (fy - by - lb.ty);
  lb.s = s;
}

function lbSettle(fx, fy) {
  const W = lightbox.clientWidth || innerWidth;
  const H = lightbox.clientHeight || innerHeight;
  if (lb.s <= 1.01) Object.assign(lb, { s: 1, tx: 0, ty: 0 });
  else if (lb.s > LB_MAX) lbZoomAt(LB_MAX, fx ?? W / 2, fy ?? H / 2);
  const b = lbBounds(lb.s);
  lb.tx = clampTo(lb.tx, b.x);
  lb.ty = clampTo(lb.ty, b.y);
  lbRender(true);
}

function lbGo(i) {
  const old = lbImg();
  lb.index = Math.max(0, Math.min(lb.n - 1, i));
  if (old && old !== lbImg()) {
    old.style.transition = 'transform .32s ease';
    old.style.transform = '';
  }
  Object.assign(lb, { s: 1, tx: 0, ty: 0, dx: 0, dy: 0 });
  lbRender(true);
}

function openLightbox(i) {
  const c = state.cards.find((x) => x.id === state.openId);
  if (!c?.images?.length) return;
  lbTrack.innerHTML = c.images
    .map((u) => `<div class="slide"><img ${photoSource(u)} alt="" draggable="false" referrerpolicy="no-referrer"></div>`)
    .join('');
  loadPrivatePhotos(lbTrack);
  Object.assign(lb, { index: Math.max(0, Math.min(i, c.images.length - 1)), n: c.images.length, s: 1, tx: 0, ty: 0, dx: 0, dy: 0 });
  lightbox.classList.remove('closing');
  openDialog(lightbox);
  nativeBars(true);
  lbRender(false);
}

// Приложение для Android рисует сайт под системными панелями: на чёрном лайтбоксе значки панелей
// должны быть светлыми (dark: true), после закрытия — снова по теме (dark: null)
function nativeBars(dark) {
  try {
    window.MarketsNative?.postMessage(JSON.stringify({ type: 'bars', dark }));
  } catch {}
}

function closeLightboxAnimated() {
  const h = lightbox.clientHeight || innerHeight;
  lightbox.classList.add('closing');
  lb.dy = h;
  lbRender(true);
  setTimeout(() => lightbox.open && lightbox.close(), 240);
}

function bindLightbox() {
  const ptrs = new Map();
  let g = null;
  let moved = false;
  let tap = null;
  const pts = () => [...ptrs.values()];
  const begin = () => {
    const p = pts();
    if (p.length >= 2) {
      const [a, b] = p;
      g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: lb.s, tx0: lb.tx, ty0: lb.ty, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      moved = true;
    } else if (p.length === 1) {
      const [a] = p;
      g = { type: lb.s > 1.01 ? 'pan' : 'pending', x0: a.x, y0: a.y, tx0: lb.tx, ty0: lb.ty, t0: performance.now(), vx: 0, vy: 0, lx: a.x, ly: a.y, lt: performance.now() };
    } else g = null;
  };
  lightbox.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.lb-close') || lightbox.classList.contains('closing')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!ptrs.size) moved = false;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  });
  lightbox.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || !g) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (g.type === 'pinch') {
      const [a, b] = pts();
      if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let s = (g.s0 * d) / g.d0;
      s = s < 1 ? Math.max(0.6, 1 - (1 - s) * 0.5) : s > LB_MAX ? LB_MAX + (s - LB_MAX) * 0.3 : s;
      const { bx, by } = lbBounds(lb.s);
      lb.tx = m.x - bx - (s / g.s0) * (g.m0.x - bx - g.tx0);
      lb.ty = m.y - by - (s / g.s0) * (g.m0.y - by - g.ty0);
      lb.s = s;
      g.mid = m;
      return lbRender(false);
    }
    const dx = p.x - g.x0;
    const dy = p.y - g.y0;
    const now = performance.now();
    g.vx = (p.x - g.lx) / Math.max(1, now - g.lt);
    g.vy = (p.y - g.ly) / Math.max(1, now - g.lt);
    g.lx = p.x;
    g.ly = p.y;
    g.lt = now;
    if (Math.hypot(dx, dy) > 8) moved = true;
    if (g.type === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      g.type = Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'down' : 'none';
    }
    if (g.type === 'pan') {
      const b = lbBounds(lb.s);
      lb.tx = rubber(g.tx0 + dx, b.x);
      lb.ty = rubber(g.ty0 + dy, b.y);
    } else if (g.type === 'swipe') {
      const edge = (lb.index === 0 && dx > 0) || (lb.index === lb.n - 1 && dx < 0);
      lb.dx = edge ? dx / 3 : dx;
    } else if (g.type === 'down') {
      lb.dy = Math.max(0, dy);
    } else return;
    lbRender(false);
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    const ended = g;
    if (ended?.type === 'pinch') {
      // Отпустили один палец из двух — продолжаем как перетаскивание, но сначала вписываем масштаб
      if (lb.s < 1 || lb.s > LB_MAX) lbSettle(ended.mid?.x, ended.mid?.y);
      if (!ptrs.size) lbSettle(ended.mid?.x, ended.mid?.y);
      return begin();
    }
    if (ptrs.size) return begin();
    g = null;
    if (!ended) return;
    const W = lightbox.clientWidth || innerWidth;
    if (ended.type === 'swipe') {
      let i = lb.index;
      if (lb.dx < -W * 0.18 || ended.vx < -0.4) i++;
      else if (lb.dx > W * 0.18 || ended.vx > 0.4) i--;
      lb.dx = 0;
      return lbGo(i);
    }
    if (ended.type === 'down') {
      if (lb.dy > 120 || (ended.vy > 0.5 && lb.dy > 24)) return closeLightboxAnimated();
      lb.dy = 0;
      return lbRender(true);
    }
    if (ended.type === 'pan') lbSettle();
    // Двойной тап: увеличить в точке касания в 2,5 раза или вернуть как было
    if (!moved && e.type === 'pointerup' && performance.now() - ended.t0 < 300) {
      const now = performance.now();
      if (tap && now - tap.t < 320 && Math.hypot(p.x - tap.x, p.y - tap.y) < 30) {
        tap = null;
        moved = true; // второй тап не должен закрыть лайтбокс кликом по фону
        if (lb.s > 1.01) Object.assign(lb, { s: 1, tx: 0, ty: 0 });
        else lbZoomAt(2.5, p.x, p.y);
        return lbSettle(p.x, p.y);
      }
      tap = { x: p.x, y: p.y, t: now };
    }
  };
  lightbox.addEventListener('pointerup', up);
  lightbox.addEventListener('pointercancel', up);
  // Колесо мыши и щипок на тачпаде (ctrl + колесо) — зум вокруг курсора
  lightbox.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = Math.min(LB_MAX, Math.max(1, lb.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))));
    lbZoomAt(s, e.clientX, e.clientY);
    if (s <= 1) Object.assign(lb, { tx: 0, ty: 0 });
    const b = lbBounds(lb.s);
    lb.tx = clampTo(lb.tx, b.x);
    lb.ty = clampTo(lb.ty, b.y);
    lbRender(false);
  }, { passive: false });
  // Тап по чёрному полю закрывает, если это был именно тап, а не жест
  lightbox.addEventListener('click', (e) => {
    if (moved) return (moved = false);
    if (e.target === lightbox || e.target.classList.contains('slide')) lightbox.close();
  });
  lightbox.addEventListener('close', () => {
    nativeBars(null);
    ptrs.clear();
    g = null;
    lightbox.classList.remove('closing', 'zoomed');
    lightbox.style.removeProperty('--drag');
  });
  window.addEventListener('resize', () => {
    if (!lightbox.open) return;
    Object.assign(lb, { s: 1, tx: 0, ty: 0, dx: 0, dy: 0 });
    lbRender(false);
  });
}

/* ============================== Подсказки ============================== */

// Свои подсказки вместо системных title: на компьютере — при наведении (через 400 мс) и фокусе
// с клавиатуры, на телефоне — при долгом нажатии на кнопку-иконку (кроме карточек: там выбор).
// title переносим в data-tip, чтобы не было двух подсказок сразу; aria-label остаётся для чтения с экрана.
const tipEl = Object.assign(document.createElement('div'), { className: 'tip', id: 'tip' });
tipEl.setAttribute('role', 'tooltip');
const tipPopover = typeof tipEl.showPopover === 'function';
if (tipPopover) tipEl.popover = 'manual';
const TIP_TARGET = '[data-tip], .icon-btn[aria-label], .tab[aria-label], .fab[aria-label]';
let tipFor = null;
let tipTimer = 0;
let tipHideTimer = 0;
let tipWarmUntil = 0;
let tipFired = false;

const tipText = (el) => el.dataset.tip || el.getAttribute('aria-label') || '';

function adoptTitles(root) {
  if (root.nodeType !== 1) return;
  const list = root.hasAttribute('title') ? [root] : [];
  for (const el of [...list, ...root.querySelectorAll('[title]')]) {
    if (el.tagName === 'IFRAME' || el instanceof SVGElement) continue;
    el.dataset.tip = el.getAttribute('title');
    el.removeAttribute('title');
  }
}

function tipTarget(node, touch) {
  const el = node?.closest?.(TIP_TARGET);
  if (!el || !tipText(el) || el.disabled) return null;
  // На телефоне долгое нажатие на карточке — это режим выбора; подсказки только у сердец
  if (touch && el.closest('.card') && !el.matches('.vote')) return null;
  return el;
}

function placeTip(el) {
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const below = r.top - h - 10 < 8;
  const left = Math.min(vw - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${below ? r.bottom + 10 : r.top - h - 10}px`;
  tipEl.classList.toggle('below', below);
  tipEl.style.setProperty('--arrow-x', `${Math.min(w - 12, Math.max(12, r.left + r.width / 2 - left))}px`);
}

function showTip(el) {
  clearTimeout(tipTimer);
  if (!el.isConnected) return;
  tipFor = el;
  tipEl.textContent = tipText(el);
  if (tipPopover) {
    if (!tipEl.isConnected) document.body.append(tipEl);
    // Каждый показ поднимает подсказку наверх — над окнами, открытыми позже
    try {
      if (tipEl.matches(':popover-open')) tipEl.hidePopover();
      tipEl.showPopover();
    } catch {}
  } else (el.closest('dialog') || document.body).append(tipEl);
  placeTip(el);
  requestAnimationFrame(() => tipFor === el && tipEl.classList.add('show'));
}

function hideTip() {
  clearTimeout(tipTimer);
  clearTimeout(tipHideTimer);
  if (tipFor) tipWarmUntil = performance.now() + 300;
  tipFor = null;
  tipEl.classList.remove('show');
}

function bindTooltips() {
  adoptTitles(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') m.target.hasAttribute('title') && adoptTitles(m.target);
      else m.addedNodes.forEach(adoptTitles);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  let start = null;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = tipTarget(e.target);
    if (el === tipFor) return;
    hideTip();
    if (!el) return;
    // Если подсказка только что была у соседней кнопки — показываем сразу
    if (performance.now() < tipWarmUntil) showTip(el);
    else tipTimer = setTimeout(() => showTip(el), 400);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse' || !tipFor) return;
    if (!tipFor.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e.target);
    if (el && el === e.target && el.matches(':focus-visible')) showTip(el);
  });
  document.addEventListener('focusout', () => tipFor && hideTip());
  document.addEventListener('pointerdown', (e) => {
    tipFired = false;
    hideTip();
    if (e.pointerType === 'mouse') return;
    const el = tipTarget(e.target, true);
    if (!el) return;
    start = { x: e.clientX, y: e.clientY };
    tipTimer = setTimeout(() => {
      tipFired = true;
      buzz(8);
      showTip(el);
      tipHideTimer = setTimeout(hideTip, 1500);
    }, 500);
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) (clearTimeout(tipTimer), (start = null));
  }, { passive: true });
  const release = () => {
    start = null;
    clearTimeout(tipTimer);
    if (tipFired && tipFor) {
      clearTimeout(tipHideTimer);
      tipHideTimer = setTimeout(hideTip, 700);
    }
  };
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  // Долгое нажатие ради подсказки не нажимает саму кнопку и не вызывает системное меню
  document.addEventListener('click', (e) => {
    if (!tipFired) return;
    tipFired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (lastPointerType !== 'mouse' && tipTarget(e.target, true)) e.preventDefault();
  });
  document.addEventListener('scroll', hideTip, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && tipFor && hideTip());
  window.addEventListener('resize', hideTip);
}

/* ================================ Тост ================================ */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  // Поверх открытых окон (верхний слой браузера), иначе тост в карточке не виден
  if (typeof t.showPopover === 'function') {
    try {
      if (!t.popover) t.popover = 'manual';
      if (t.matches(':popover-open')) t.hidePopover();
      t.showPopover();
      void t.offsetWidth; // чтобы появление анимировалось и при самом первом показе
    } catch {}
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============================== События =============================== */

function bind() {
  document.addEventListener('click', async (e) => {
    // В режиме выбора касание карточки (и её сердец) только отмечает её
    const picked = state.selecting && e.target.closest('#grid .card');
    if (picked) return toggleSelected(picked.dataset.id);
    const vote = e.target.closest('[data-vote]');
    if (vote) {
      e.stopPropagation();
      const id = vote.closest('[data-id]')?.dataset.id || state.openId;
      return toggleVote(id, vote.dataset.vote, vote);
    }
    const themeBtn = e.target.closest('.theme-switch [data-theme-key]');
    if (themeBtn) return setTheme(themeBtn.dataset.themeKey);
    const fontBtn = e.target.closest('.font-switch [data-font]');
    if (fontBtn) return setFont(fontBtn.dataset.font);
    const role = e.target.closest('[data-role]');
    if (role) {
      setRole(role.dataset.role);
      if (roleDialog.open) roleDialog.close();
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) return openLightbox(Number(zoom.dataset.zoom));
    const thumb = e.target.closest('[data-thumb]');
    if (thumb) return goSlide(Number(thumb.dataset.thumb));
    const tab = e.target.closest('.tab[data-tab]');
    if (tab) return setFilter(tab.dataset.tab);

    const actEl = e.target.closest('[data-action]');
    const card = e.target.closest('.card');
    if (!actEl && card) return openViewer(card.dataset.id);
    if (!actEl) return;
    const c = state.cards.find((x) => x.id === state.openId);
    if (actEl.dataset.action !== 'toggle-more') setDd(actEl.closest('.dd.more'), false);
    switch (actEl.dataset.action) {
      case 'add':
        return openAdd();
      case 'check-product':
        return actEl.dataset.url
          ? openProductCheck(actEl.dataset.url, actEl.dataset.cardId)
          : openProductCheck(c?.url, c?.id);
      case 'copy-verification-url':
        return copyVerificationUrl();
      case 'upload-photo':
        return selectPhoto(actEl.dataset.cardId || c?.id);
      case 'paste': {
        const t = await readClipboard();
        if (t == null) return;
        addText.value = (addText.value.trim() ? addText.value.trim() + '\n' : '') + t;
        return updateParseInfo();
      }
      case 'paste-add': {
        const t = await readClipboard();
        if (t == null) return openAdd();
        openAdd(t);
        if (extractLinks(t).links.length) addLinks(t);
        return;
      }
      case 'settings':
        return openSettings();
      case 'close-dialog':
        return actEl.closest('dialog')?.close();
      case 'boards':
        return openBoards();
      case 'pick-board':
        return pickBoard(actEl.closest('[data-board]').dataset.board);
      case 'rename-board':
        return startRename(actEl.closest('[data-board]'));
      case 'save-board':
        return saveRename(actEl.closest('[data-board]'));
      case 'delete-board':
        return removeBoard(actEl.closest('[data-board]').dataset.board);
      case 'share-board':
        if (!state.api) return openSettings();
        return share({ title: 'Выбираем вместе', text: 'Голосуй за товары в нашей подборке', url: boardUrl() });
      case 'reload':
        return state.unlocked ? loadCards() : enterApp();
      case 'toggle-more':
        return setDd(actEl.closest('.dd'), !actEl.closest('.dd').classList.contains('open'));
      case 'close-viewer':
        return closeViewer();
      case 'prev':
        return goSlide(currentSlide() - 1);
      case 'next':
        return goSlide(currentSlide() + 1);
      case 'share-card':
        return c && shareCard(c);
      case 'copy-card':
        return c && copy(c.url);
      case 'refresh-card':
        return c && refreshCard(c.id);
      case 'refresh-incomplete':
        return refreshIncomplete();
      case 'stop-refresh':
        if (state.bulkRefresh) state.bulkRefresh.stop = true;
        return toast('Останавливаю после текущего товара');
      case 'edit-card':
        return c && openEdit(c.id);
      case 'delete-card':
        return c && deleteCard(c.id);
      case 'lb-close':
        return lightbox.close();
      case 'toggle-setup':
        return setSetupOpen(!$('#setupBox').classList.contains('open'));
      case 'test-api':
        return testApi($('#settingsForm').apiUrl.value);
      case 'copy-share':
        return copy($('#shareUrl').value);
      case 'toggle-password':
        return togglePassword(actEl);
      case 'select-cancel':
        return exitSelection();
      case 'select-all':
        return selectAll();
      case 'select-move':
        return openMove();
      case 'select-delete':
        return deleteSelected();
      case 'move-to': {
        const id = actEl.closest('[data-board]').dataset.board;
        return moveSelected(id, state.boards.find((b) => b.id === id)?.name || id);
      }
      case 'move-new':
        return showMoveNew(true);
    }
  });

  document.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.card');
    if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      if (state.selecting) toggleSelected(card.dataset.id);
      else openViewer(card.dataset.id);
    }
    // Escape вне окон: сначала закрывает меню, потом выходит из режима выбора
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && layers.length) {
      e.preventDefault();
      mpHandleBack();
    }
    if (lightbox.open && !lightbox.classList.contains('closing')) {
      if (e.key === 'ArrowLeft') lbGo(lb.index - 1);
      if (e.key === 'ArrowRight') lbGo(lb.index + 1);
    }
    if (viewer.open && !lightbox.open) {
      if (e.key === 'ArrowLeft') goSlide(currentSlide() - 1);
      if (e.key === 'ArrowRight') goSlide(currentSlide() + 1);
    }
  });

  // Битые картинки → заглушка
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG' || img.dataset.failed) return;
      img.dataset.failed = '1';
      const holder = img.closest('.photo, .slide');
      if (holder && holder.classList.contains('photo')) {
        const c = state.cards.find((x) => x.id === img.closest('[data-id]')?.dataset.id);
        if (c) img.outerHTML = placeholderHtml(c);
      } else img.style.visibility = 'hidden';
    },
    true
  );

  // Без выбора роли закрыть окно нельзя
  roleDialog.addEventListener('cancel', (e) => !state.role && e.preventDefault());
  // Браузер может закрыть окно и без нашего согласия (Escape или жест «Назад» до первого касания) —
  // окно входа и выбор роли тогда сразу открываются снова
  roleDialog.addEventListener('close', () => !state.role && setTimeout(() => !state.role && !accessDialog.open && askRole(), 0));
  accessDialog.addEventListener('keydown', (e) => e.key === 'Escape' && e.preventDefault());
  roleDialog.addEventListener('keydown', (e) => e.key === 'Escape' && !state.role && e.preventDefault());
  accessDialog.addEventListener('close', () => setTimeout(() => {
    if (!state.unlocked && state.api && !accessDialog.open) openDialog(accessDialog);
  }, 0));

  viewer.addEventListener('close', () => {
    state.openId = null;
    if (location.hash.startsWith('#card=')) history.replaceState(null, '', location.pathname + location.search);
  });
  viewer.addEventListener('click', (e) => e.target === viewer && closeViewer());
  for (const d of [addDialog, editDialog, settingsDialog, $('#shareDialog'), $('#boardsDialog'), moveDialog, confirmBox])
    d.addEventListener('click', (e) => e.target === d && d.close());
  // Окно закрылось чем угодно (✕, Escape, тап мимо, отправка формы) — убираем его слой из истории «Назад»
  for (const d of $$('dialog')) d.addEventListener('close', () => popLayer(d));
  confirmBox.addEventListener('close', onConfirmClose);
  moveDialog.addEventListener('close', () => showMoveNew(false));
  $('#moveForm').addEventListener('submit', (e) => {
    e.preventDefault();
    moveToNewBoard();
  });

  addText.addEventListener('input', updateParseInfo);
  photoInput.addEventListener('change', uploadPhoto);
  verificationDialog.addEventListener('close', () => $('#verificationFrame').removeAttribute('src'));
  accessDialog.addEventListener('cancel', (e) => e.preventDefault());
  accessForm.addEventListener('submit', signIn);
  $('#addForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'submit') return;
    e.preventDefault();
    addLinks(addText.value);
  });
  // Ctrl+V / Cmd+V где угодно на странице — сразу добавить ссылки
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea') || document.querySelector('dialog[open]') || !state.api) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!extractLinks(text).links.length) return;
    e.preventDefault();
    openAdd(text);
    addLinks(text);
  });
  $('#boardsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    createBoard();
  });
  $('#boardsList').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('rename')) return;
    if (e.key === 'Enter') (e.preventDefault(), saveRename(e.target.closest('[data-board]')));
    if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), renderBoards());
  });
  $('#editForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveEdit();
  });
  $('#settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveSettings();
  });

  filterMenu($('#filterDd'));
  bindPressFeedback();
  bindLongPress($('#grid'));
  bindViewerSwipe();
  bindLightbox();
  bindTooltips();

  // Фоновое обновление голосов от других людей
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.unlocked && state.api && !addDialog.open && !editDialog.open) loadCards({ silent: true });
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && state.unlocked && state.api && loadCards({ silent: true }));
}

/* ============================== Старт ================================= */

async function enterApp(verified = false) {
  if (state.api && !verified) {
    try {
      const health = await api('/api/health', { public: true });
      if (health.authRequired) {
        if (!state.accessToken) return lockApp();
        await api('/api/auth/session');
      }
    } catch (error) {
      if (!accessDialog.open) {
        state.error = error.message;
        state.loading = false;
        render();
      }
      return;
    }
  }
  state.unlocked = true;
  if (accessDialog.open) accessDialog.close();
  if (!state.role) askRole();
  loadBoards();
  await loadCards();

  // Web Share Target (PWA на Android): «Поделиться» из приложения маркетплейса → сюда
  const qs = new URLSearchParams(location.search);
  const shared = [qs.get('title'), qs.get('text'), qs.get('url')].filter(Boolean).join(' ');
  if (shared && state.api) {
    history.replaceState(null, '', location.pathname);
    openAdd(shared);
    if (extractLinks(shared).links.length) addLinks(shared);
  }
  const m = location.hash.match(/^#card=([\w-]+)/);
  if (m && state.cards.some((c) => c.id === m[1])) openViewer(m[1]);
}

function start() {
  initState();
  bind();
  render();
  return enterApp();
}

start();
