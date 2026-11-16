'use strict';

// Фоновый скрипт расширения «Выбираем вместе».
// По просьбе сайта читает страницу товара функцией readOpenProduct (та же, что у сайта и приложения) — с IP
// и cookies этого браузера, поэтому магазины её не блокируют.
// Обычно страница открывается в рамке невидимого документа расширения (offscreen.html, frame.js): ни окна,
// ни вкладки, ни значка на панели задач. Если в рамке магазин показывает проверку (слайдер AliExpress, проверка
// браузера Wildberries, когда её пропуск истёк) или страница не читается, она открывается в свёрнутом окне,
// как раньше. Окно разворачивается, только если магазин просит проверку или страницу не удалось прочитать
// за 15 секунд. В Firefox невидимых документов нет — там сразу свёрнутое окно.

// В Chrome это service worker, в Firefox product-import.js подключён в manifest.json
if (typeof readOpenProduct !== 'function') importScripts('product-import.js');

// Адрес сайта для кнопки расширения. Если у вас своя копия сайта — поменяйте здесь и в manifest.json (content_scripts).
const SITE_URL = 'https://yaroslaz.github.io/markets-pars/';

const MARKET_HOST = /(^|\.)(ozon\.(ru|by|kz)|market\.yandex\.(ru|by|kz|com)|wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru|aliexpress\.(ru|com|us)|aliclick\.shop|ali\.click)$|^(ya\.cc|ozon\.onelink\.me)$/;
const PRODUCT_HOST = /(^|\.)(ozon\.(ru|by|kz)|market\.yandex\.(ru|by|kz|com)|wildberries\.(ru|by|kz|am|kg|uz)|aliexpress\.(ru|com|us))$/;
const POLL_MS = 800;
const HIDDEN_LIMIT_MS = 15_000; // сколько ждём молча, прежде чем показать окно
const PARTIAL_GRACE_MS = 5_000; // сколько ждём недостающие цену или фото
const BLOCKED_GRACE_MS = 2_500; // автоматические проверки проходят сами за секунду-две
const CHECK_LIMIT_MS = 180_000; // сколько даём на прохождение проверки
const CACHE_MS = 120_000;
const FRAME_LIMIT_MS = 12_000; // сколько ждём страницу в невидимой рамке, прежде чем открыть окно
// Готовую карточку, где меньше 10 фото, принимаем не сразу: галерея Маркета дорисовывается через секунду-две
const FRAME_SETTLE_MS = 1_500;
// Проверку магазина в рамке не пройти: ни слайдер, ни проверку браузера Wildberries (ей нужны cookies, которые
// рамке не положены). Автоматическая проверка Ozon проходит и в рамке, но readOpenProduct не считает её «blocked»
const FRAME_BLOCKED_MS = 2_000;
const OFFSCREEN_IDLE_MS = 20_000; // невидимый документ закрываем, когда он столько не нужен
// Домены, у которых в невидимой рамке снимаются запреты на встраивание (X-Frame-Options, CSP frame-ancestors)
const FRAME_DOMAINS = ['ozon.ru', 'ozon.by', 'ozon.kz', 'ozon.onelink.me', 'market.yandex.ru', 'market.yandex.by',
  'market.yandex.kz', 'market.yandex.com', 'ya.cc', 'wildberries.ru', 'wildberries.by', 'wildberries.kz',
  'wildberries.am', 'wildberries.kg', 'wildberries.uz', 'aliexpress.ru', 'aliexpress.com', 'aliexpress.us',
  'aliclick.shop', 'ali.click'];

const BANNERS = {
  blocked: 'Выбираем вместе: магазин просит проверку. Пройдите её — товар добавится сам, а окно закроется. Чтобы отменить, закройте окно.',
  slow: 'Выбираем вместе: не получилось прочитать страницу автоматически. Если магазин показывает проверку — пройдите её. Чтобы отменить, закройте окно.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const queue = [];
let running = false;
// Товары, только что прочитанные кнопкой расширения: сайт попросит их сразу же, второй раз открывать не нужно
const cache = new Map();

function normalize(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(value);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'read') return;
  port.onMessage.addListener(({ url } = {}) => {
    let link = null;
    try {
      link = new URL(url);
      if (link.protocol === 'http:') link.protocol = 'https:';
    } catch {}
    if (!link || link.protocol !== 'https:' || link.username || link.password || !MARKET_HOST.test(link.hostname)) {
      port.postMessage({ ok: false, error: 'bad-request' });
      return;
    }
    const job = { url: link.href, port, cancelled: false };
    port.onDisconnect.addListener(() => (job.cancelled = true));
    queue.push(job);
    pump();
  });
});

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (job.cancelled) continue;
    let result;
    try {
      result = await readProduct(job);
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    if (!job.cancelled) {
      try {
        job.port.postMessage(result);
      } catch {}
    }
    // Пауза между страницами, чтобы магазин не принял нас за бота
    if (queue.length && !result.cached) await sleep(600 + Math.random() * 900);
  }
  running = false;
}

async function readProduct(job) {
  const hit = cache.get(normalize(job.url));
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, data: hit.data, cached: true };

  // Сначала — без окна. Окно нужно, только если магазин просит проверку, которую в рамке не пройти
  if (chrome.offscreen && chrome.declarativeNetRequest) {
    let result = null;
    try {
      result = await readInFrame(job);
    } catch {}
    if (result) return result;
    if (job.cancelled) return { ok: false, error: 'cancelled' };
  }
  return readInWindow(job);
}

// ---------- Чтение в невидимой рамке ----------

let offscreenReady = null;
let offscreenTimer = 0;
let frameJob = null;

// Результаты из рамки (frame.js). Принимаем только от рамки без вкладки — то есть из нашего невидимого документа —
// и только от текущей: её узнаём по имени, которое дал offscreen.js, а после первого сообщения — по номеру рамки
// (имя страница может и поменять)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'frame-read') return;
  const ours = frameJob && !sender.tab && sender.id === chrome.runtime.id &&
    (msg.frame === frameJob.name || (frameJob.frameId !== undefined && sender.frameId === frameJob.frameId));
  if (!ours) {
    sendResponse({ stop: true });
    return;
  }
  frameJob.frameId = sender.frameId;
  frameJob.report(String(msg.href || ''), msg.result);
  sendResponse({ stop: frameJob.finished });
});

async function prepareOffscreen() {
  clearTimeout(offscreenTimer);
  // Магазины запрещают встраивать свои страницы в чужие; снимаем запрет только для рамок вне вкладок —
  // то есть для невидимого документа расширения. Обычных вкладок покупателя правило не касается
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { resourceTypes: ['sub_frame'], tabIds: [chrome.tabs.TAB_ID_NONE], requestDomains: FRAME_DOMAINS },
    }],
  });
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['IFRAME_SCRIPTING'],
          justification: 'Открыть страницу товара во встроенной рамке и прочитать её без окна',
        });
      }
    })().catch((error) => {
      offscreenReady = null;
      throw error;
    });
  }
  await offscreenReady;
}

function releaseOffscreen() {
  clearTimeout(offscreenTimer);
  offscreenTimer = setTimeout(() => {
    if (frameJob || queue.length) return;
    offscreenReady = null;
    chrome.offscreen.closeDocument().catch(() => {});
  }, OFFSCREEN_IDLE_MS);
}

// Открывает страницу в рамке и ждёт от frame.js готовую карточку.
// Возвращает результат для сайта или null — тогда страницу нужно открыть в окне.
async function readInFrame(job) {
  await prepareOffscreen();
  const started = Date.now();
  let partial = null;
  let partialAt = 0;
  let completeAt = 0;
  let blockedAt = 0;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const state = {
    name: 'vmeste-' + Date.now().toString(36) + Math.random().toString(36).slice(2),
    finished: false,
    report(href, result) {
      if (state.finished || !/^https:\/\//.test(href)) return;
      const now = Date.now();
      const status = result?.status || 'wait';
      // Товара больше нет — открывать окно бессмысленно
      if (status === 'gone') return end({ ok: false, error: 'gone', url: href });
      if (status === 'ok' && result.complete) {
        if (!completeAt) completeAt = now;
        partial = result;
        if (result.images?.length >= 10 || now - completeAt >= FRAME_SETTLE_MS) return end({ ok: true, data: result });
      } else if (status === 'ok' && !completeAt) {
        if (!partial) partialAt = now;
        partial = result;
        if (now - partialAt >= PARTIAL_GRACE_MS) return end({ ok: true, data: partial });
      }
      if (status !== 'blocked') blockedAt = 0;
      else if (!blockedAt) blockedAt = now;
      else if (now - blockedAt >= FRAME_BLOCKED_MS) return end(null);
    },
  };
  const end = (value) => {
    if (state.finished) return;
    state.finished = true;
    finish(value);
  };
  frameJob = state;
  // Отмена и общий срок проверяем и без сообщений из рамки: страница могла вовсе не загрузиться
  const timer = setInterval(() => {
    const now = Date.now();
    if (job.cancelled) end(null);
    else if (now - started >= FRAME_LIMIT_MS || (completeAt && now - completeAt >= FRAME_SETTLE_MS + 1000)) {
      end(partial ? { ok: true, data: partial } : null);
    }
  }, 250);
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'open', url: job.url, name: state.name });
    return await done;
  } finally {
    clearInterval(timer);
    state.finished = true;
    if (frameJob === state) frameJob = null;
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'close' }).catch(() => {});
    releaseOffscreen();
  }
}

// ---------- Чтение в свёрнутом окне (если в рамке не получилось, и в Firefox) ----------

async function readInWindow(job) {
  const win = await chrome.windows.create({ url: job.url, state: 'minimized', focused: false });
  const winId = win.id;
  const tabId = win.tabs[0].id;
  let closed = false;
  const onRemoved = (id) => {
    if (id === winId) closed = true;
  };
  chrome.windows.onRemoved.addListener(onRemoved);

  const started = Date.now();
  let lastUrl = job.url;
  let shownAt = 0;
  let shownKind = '';
  let partial = null;
  let partialAt = 0;
  let blockedAt = 0;
  const fail = (error) => ({ ok: false, error, ...(lastUrl.startsWith('https://') ? { url: lastUrl } : {}) });

  try {
    for (;;) {
      await sleep(POLL_MS);
      if (closed || job.cancelled) return fail('cancelled');
      const now = Date.now();
      let result = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) lastUrl = tab.url;
        const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: readOpenProduct });
        result = frame?.result ?? null;
      } catch {
        // страница ещё грузится или идёт редирект через чужой домен
      }
      const status = result?.status || 'wait';
      if (status === 'gone') return fail('gone');

      if (status === 'ok') {
        if (result.complete) return { ok: true, data: result };
        if (!partial) partialAt = now;
        partial = result;
        if (now - partialAt >= PARTIAL_GRACE_MS) return { ok: true, data: partial };
      }
      if (status !== 'blocked') blockedAt = 0;
      else if (!blockedAt) blockedAt = now;
      else if (!shownAt && now - blockedAt >= BLOCKED_GRACE_MS) {
        shownAt = now;
        shownKind = 'blocked';
        await showWindow(winId);
      }

      if (!shownAt && now - started >= HIDDEN_LIMIT_MS) {
        if (partial) return { ok: true, data: partial };
        shownAt = now;
        shownKind = 'slow';
        await showWindow(winId);
      } else if (shownAt && now - shownAt >= CHECK_LIMIT_MS) {
        return partial ? { ok: true, data: partial } : fail('timeout');
      }
      // После каждого перехода страницы плашку нужно вернуть
      if (shownAt) await showBanner(tabId, BANNERS[shownKind]);
    }
  } finally {
    chrome.windows.onRemoved.removeListener(onRemoved);
    if (!closed) chrome.windows.remove(winId).catch(() => {});
  }
}

async function showWindow(winId) {
  try {
    await chrome.windows.update(winId, { state: 'normal', focused: true, width: 1100, height: 860 });
  } catch {}
}

async function showBanner(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [text],
      func: (message) => {
        if (document.getElementById('vmeste-banner')) return;
        const bar = document.createElement('div');
        bar.id = 'vmeste-banner';
        bar.textContent = message;
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:10px 16px;' +
          'background:#fff4d6;color:#16161a;font:14px/1.4 system-ui,sans-serif;text-align:center;' +
          'box-shadow:0 2px 12px rgba(0,0,0,.15);pointer-events:none';
        document.documentElement.append(bar);
      },
    });
  } catch {}
}

// Кнопка расширения: на странице товара — сразу читает его и открывает сайт с этой ссылкой;
// на любой другой странице — просто открывает сайт.
chrome.action.onClicked.addListener(async (tab) => {
  let target = SITE_URL;
  try {
    const page = new URL(tab.url);
    if (PRODUCT_HOST.test(page.hostname)) {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readOpenProduct });
      const result = frame?.result;
      if (result?.status === 'ok') {
        const entry = { at: Date.now(), data: result };
        cache.set(normalize(result.url), entry);
        cache.set(normalize(tab.url), entry);
        target = SITE_URL + '?text=' + encodeURIComponent(result.url);
      } else {
        target = SITE_URL + '?text=' + encodeURIComponent(tab.url);
      }
    }
  } catch {}
  chrome.tabs.create({ url: target, index: tab.index + 1 });
});
