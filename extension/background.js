'use strict';

// Фоновый скрипт расширения «Выбираем вместе».
// По просьбе сайта открывает страницу товара в свёрнутом окне — с IP и cookies этого браузера, поэтому магазины
// её не блокируют, — читает её функцией readOpenProduct (та же, что у сайта и приложения) и закрывает окно.
// Окно разворачивается, только если магазин просит проверку или страницу не удалось прочитать за 15 секунд.

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
