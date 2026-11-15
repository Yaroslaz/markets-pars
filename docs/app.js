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
};

function initState() {
  const qs = new URLSearchParams(location.search);
  const apiQ = qs.get('api');
  const boardQ = qs.get('b');
  if (apiQ) store.set('api', normalizeApi(apiQ));
  if (boardQ && /^[\w-]{1,40}$/.test(boardQ)) store.set('board', boardQ);
  state.api = normalizeApi(store.get('api') || CFG.apiUrl || '');
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
  if (/(^|\.)ozon\.(ru|by|kz)$/.test(host)) return 'ozon';
  if (/(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru)$/.test(host)) return 'wb';
  if (/(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(host)) return 'ym';
  if (/(^|\.)aliexpress\.(ru|com|us)$/.test(host)) return 'ali';
  return null;
}

function productKey(source, url) {
  const p = url.pathname;
  let id = null;
  if (source === 'ozon') id = p.match(/\/product\/(?:[^/]*?-)?(\d{5,})/)?.[1];
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
  if (!state.api) throw new Error('Сервер не настроен');
  const res = await fetch(state.api + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
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
    state.cards = data.cards.map((c) => (pending.has(c.id) ? pending.get(c.id) : c));
    state.error = '';
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

function cardHtml(c) {
  const img = (c.thumbs && c.thumbs[0]) || (c.images && c.images[0]);
  const n = (c.images || []).length;
  return `<article class="card" data-id="${c.id}" tabindex="0">
    <div class="photo">${
      img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : placeholderHtml(c)
    }<span class="mk" title="${SOURCES[c.source].name}">${fav(c.source)}</span>${n > 1 ? `<span class="n">${n} фото</span>` : ''}</div>
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
  if (state.loading) {
    empty.hidden = true;
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"><div class="photo"></div><div class="l"></div><div class="l s"></div></div>').join('');
    cardSig.clear();
    return;
  }
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
}

// Островок над таб-баром: сколько товаров на экране и на какую сумму
function updateSum() {
  const bar = $('#sumbar');
  const list = state.api && !state.loading ? visibleCards() : [];
  if (!list.length) {
    bar.hidden = true;
    return;
  }
  const priced = list.filter((c) => c.price != null);
  const total = priced.reduce((a, c) => a + c.price, 0);
  const n = list.length;
  const what = `${n} ${plural(n, 'товар', 'товара', 'товаров')}`;
  const noPrice = n - priced.length;
  bar.innerHTML = `${state.filter === 'both' ? '<svg class="duo"><use href="#i-duo"/></svg>' : '<svg><use href="#i-bag"/></svg>'}<span class="cnt">${what}${
    noPrice && priced.length ? `, без цены ${noPrice}` : ''
  }</span>${priced.length ? `<i class="sep"></i><b>${rub(total)}</b>` : ''}`;
  bar.hidden = false;
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
  const close = () => {
    root.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !root.classList.contains('open');
    root.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
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
// Клик вне открытого меню закрывает его (клик внутри меню закрывает уже само действие)
document.addEventListener('click', (e) => $$('.dd.open').forEach((d) => !d.contains(e.target) && d.classList.remove('open')));

/* ============================== Голоса ================================ */

async function toggleVote(id, kind, btn) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return;
  if (kind !== state.role) return;
  const prev = { ...c.likes };
  const on = !c.likes[kind];
  c.likes = { ...c.likes, [kind]: on };
  c._pending = true;
  if (navigator.vibrate) navigator.vibrate(8);
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

function openAdd(prefill) {
  if (!state.api) return openSettings();
  if (prefill != null) addText.value = prefill;
  $('#progress').hidden = true;
  $('#progress').innerHTML = '';
  updateParseInfo();
  addDialog.showModal();
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
    info.innerHTML = `Найдено: <b>${links.length}</b>${ignored ? ` · пропущу ${ignored} ${plural(ignored, 'чужую ссылку', 'чужие ссылки', 'чужих ссылок')}` : ''}`;
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
  const { links } = extractLinks(text);
  if (!links.length) {
    toast('Не нашёл ссылок на Ozon, WB, Маркет или AliExpress');
    return;
  }
  const list = $('#progress');
  list.hidden = false;
  list.innerHTML = links
    .map((l, i) => `<li data-i="${i}">${fav(l.source)}<span class="u">${esc(l.url.replace(/^https?:\/\/(www\.)?/, ''))}</span><span class="spinner"></span></li>`)
    .join('');
  const submit = $('#addForm [type=submit]');
  submit.disabled = true;
  let added = 0, dups = 0, failed = 0;

  // 3 запроса параллельно — сервер парсит по одной ссылке за раз
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const i = next++;
      const li = $(`li[data-i="${i}"]`, list);
      try {
        const r = await api('/api/cards', { method: 'POST', body: { board: state.board, url: links[i].url } });
        upsertCard(r.card);
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
  if (!failed) {
    addText.value = '';
    setTimeout(() => addDialog.open && addDialog.close(), 700);
  }
}

function upsertCard(card) {
  const i = state.cards.findIndex((c) => c.id === card.id);
  if (i >= 0) state.cards[i] = card;
  else state.cards.unshift(card);
}

/* ===================== Карточка, галерея, лайтбокс ==================== */

const viewer = $('#viewer');

function openViewer(id) {
  state.openId = id;
  refreshViewer(true);
  if (!viewer.open) viewer.showModal();
  history.replaceState(null, '', '#card=' + id);
}

function closeViewer() {
  state.openId = null;
  if (viewer.open) viewer.close();
  if (location.hash.startsWith('#card=')) history.replaceState(null, '', location.pathname + location.search);
}

function appHref(c) {
  if (IS_ANDROID) {
    const u = new URL(c.url);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=${SOURCES[c.source].pkg};S.browser_fallback_url=${encodeURIComponent(c.url)};end`;
  }
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
  const src = SOURCES[c.source];
  body.innerHTML = `
    <div class="gallery">
      <div class="stage">
      <div class="viewer-top">
        <div class="dd more">
          <button type="button" class="icon-btn" data-action="toggle-more" aria-haspopup="menu" aria-label="Ещё" title="Ещё"><svg><use href="#i-more"/></svg></button>
          <div class="dd-menu" role="menu">
            <button type="button" class="dd-opt" role="menuitem" data-action="copy-card"><span class="ic"><svg><use href="#i-copy"/></svg></span><span class="lbl">Скопировать ссылку</span></button>
            <button type="button" class="dd-opt" role="menuitem" data-action="refresh-card"><span class="ic"><svg><use href="#i-refresh"/></svg></span><span class="lbl">Обновить цену и фото</span></button>
            <button type="button" class="dd-opt" role="menuitem" data-action="edit-card"><span class="ic"><svg><use href="#i-edit"/></svg></span><span class="lbl">Изменить</span></button>
            <div class="dd-sep"></div>
            <button type="button" class="dd-opt danger" role="menuitem" data-action="delete-card"><span class="ic"><svg><use href="#i-trash"/></svg></span><span class="lbl">Удалить из подборки</span></button>
          </div>
        </div>
        <button type="button" class="icon-btn" data-action="close-viewer" aria-label="Закрыть" title="Закрыть"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="track" id="track">${
        imgs.length
          ? imgs.map((u, i) => `<div class="slide"><img src="${esc(u)}" alt="Фото ${i + 1}" ${i ? 'loading="lazy"' : ''} referrerpolicy="no-referrer" data-zoom="${i}"></div>`).join('')
          : `<div class="slide">${placeholderHtml(c, false)}</div>`
      }</div>
      ${imgs.length > 1 ? `<button class="icon-btn nav prev" data-action="prev" aria-label="Предыдущее фото"><svg><use href="#i-left"/></svg></button>
      <button class="icon-btn nav next" data-action="next" aria-label="Следующее фото"><svg><use href="#i-right"/></svg></button>
      <span class="counter" id="counter">1 / ${imgs.length}</span>` : ''}
      </div>
      ${imgs.length > 1 ? `<div class="thumbs" id="thumbs">${(c.thumbs?.length === imgs.length ? c.thumbs : imgs)
        .map((u, i) => `<button data-thumb="${i}" class="${i ? '' : 'active'}" aria-label="Фото ${i + 1}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`)
        .join('')}</div>` : ''}
    </div>
    <div class="info">
      ${priceHtml(c)}
      <h2>${esc(c.title)}</h2>
      ${metaHtml(c)}
      ${votesHtml(c)}
      ${c.partial && !c.edited.length ? `<div class="partial-note"><span class="msg">${src.name} не отдал фото и цену</span><button type="button" class="btn" data-action="edit-card" aria-label="Дополнить вручную" title="Дополнить вручную"><svg><use href="#i-edit"/></svg><span class="lbl">Дополнить</span></button></div>` : ''}
      <div class="open-row">
        <a class="btn primary" href="${esc(appHref(c))}" ${IS_ANDROID ? '' : 'target="_blank"'} rel="noopener"><svg><use href="#i-open"/></svg><span>${IS_MOBILE ? 'Открыть в приложении' : `Открыть на ${src.name}`}</span></a>
        <button type="button" class="icon-btn share" data-action="share-card" aria-label="Поделиться" title="Поделиться"><svg><use href="#i-share"/></svg></button>
      </div>
      <div class="updated">${c.priceNote ? `Цена ${esc(c.priceNote)} · ` : ''}обновлено ${ago(c.updatedAt)}</div>
    </div>`;
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

const lightbox = $('#lightbox');
function openLightbox(i) {
  const c = state.cards.find((x) => x.id === state.openId);
  if (!c?.images?.length) return;
  const t = $('#lbTrack');
  t.innerHTML = c.images.map((u) => `<div class="slide"><img src="${esc(u)}" alt="" referrerpolicy="no-referrer"></div>`).join('');
  lightbox.showModal();
  requestAnimationFrame(() => (t.scrollLeft = i * t.clientWidth));
  const upd = () => ($('#lbCounter').textContent = `${Math.round(t.scrollLeft / t.clientWidth) + 1} / ${c.images.length}`);
  t.onscroll = upd;
  upd();
}

/* ============================== Действия ============================== */

async function refreshCard(id) {
  toast('Обновляю…');
  try {
    const r = await api(`/api/cards/${id}/refresh`, { method: 'POST', body: {} });
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
  if (!c || !confirm(`Удалить «${c.title.slice(0, 60)}» из подборки?`)) return;
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
  f.images.value = c.edited.includes('images') ? c.images.join('\n') : '';
  editDialog.showModal();
  autosize(f.images);
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
  if (imgs !== (c.edited.includes('images') ? c.images.join('\n') : '')) overrides.images = imgs;
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
  $('#shareDialog').showModal();
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
  if (!roleDialog.open) roleDialog.showModal();
}

function openSettings() {
  const f = $('#settingsForm');
  $$('#roleSwitch [data-role]').forEach((b) => b.classList.toggle('active', b.dataset.role === state.role));
  markFont();
  previewFonts();
  f.apiUrl.value = state.api;
  $('#deployLink').href = deployUrl();
  setSetupOpen(!state.api);
  $('#apiStatus').textContent = '';
  $('#apiStatus').className = 'api-status';
  settingsDialog.showModal();
}

function setSetupOpen(open) {
  const box = $('#setupBox');
  box.classList.toggle('open', open);
  $('.acc-head', box).setAttribute('aria-expanded', open);
}

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
  store.set('api', api === normalizeApi(CFG.apiUrl) ? '' : api);
  if (changed) {
    state.cards = [];
    state.boards = [];
    cardSig.clear();
    loadCards();
    loadBoards();
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
}

function renderBoards() {
  const list = $('#boardsList');
  const many = state.boards.length > 1;
  list.innerHTML = state.boards
    .map((b) => {
      // для текущей подборки берём живые данные с экрана
      const live = b.id === state.board && !state.loading;
      const count = live ? state.cards.length : b.count;
      const total = live ? state.cards.reduce((a, c) => a + (c.price || 0), 0) : b.total;
      const meta = count ? `${count} ${plural(count, 'товар', 'товара', 'товаров')}${total ? ' · ' + rub(total) : ''}` : 'пусто';
      return `<li class="board-row ${b.id === state.board ? 'current' : ''}" data-board="${esc(b.id)}">
        <button type="button" class="board-pick" data-action="pick-board"><span class="txt"><span class="bn">${esc(b.name)}</span><span class="bm">${meta}</span></span><svg class="ck"><use href="#i-check"/></svg></button>
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
  boardsDialog.showModal();
  loadBoards();
}

function switchBoard(id, notify = true) {
  if (id === state.board) return;
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
  if (!b || !confirm(`Удалить подборку «${b.name}» вместе со всеми товарами и лайками?`)) return;
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

/* ================================ Тост ================================ */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============================== События =============================== */

function bind() {
  document.addEventListener('click', async (e) => {
    const vote = e.target.closest('[data-vote]');
    if (vote) {
      e.stopPropagation();
      const id = vote.closest('[data-id]')?.dataset.id || state.openId;
      return toggleVote(id, vote.dataset.vote, vote);
    }
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
    if (actEl.dataset.action !== 'toggle-more') actEl.closest('.dd.more')?.classList.remove('open');
    switch (actEl.dataset.action) {
      case 'add':
        return openAdd();
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
        return loadCards();
      case 'toggle-more':
        return actEl.closest('.dd').classList.toggle('open');
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
    }
  });

  document.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.card');
    if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      openViewer(card.dataset.id);
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

  viewer.addEventListener('close', () => {
    state.openId = null;
    if (location.hash.startsWith('#card=')) history.replaceState(null, '', location.pathname + location.search);
  });
  viewer.addEventListener('click', (e) => e.target === viewer && closeViewer());
  lightbox.addEventListener('click', (e) => (e.target === lightbox || e.target.classList.contains('slide')) && lightbox.close());
  for (const d of [addDialog, editDialog, settingsDialog, $('#shareDialog'), $('#boardsDialog')])
    d.addEventListener('click', (e) => e.target === d && d.close());

  addText.addEventListener('input', updateParseInfo);
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

  // Фоновое обновление голосов от других людей
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.api && !addDialog.open && !editDialog.open) loadCards({ silent: true });
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && state.api && loadCards({ silent: true }));
}

/* ============================== Старт ================================= */

async function start() {
  initState();
  bind();
  render();
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

start();
