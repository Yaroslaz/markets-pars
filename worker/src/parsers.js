// Парсеры маркетплейсов. Каждый возвращает нормализованный объект товара:
// { source, productId, url, title, brand, price, oldPrice, priceNote, rating, reviews, images[], thumbs[], partial }
// и, если нашлись: priceNoCard (цена Ozon без скидки банка), description, specs [{ name, value }],
// variants [{ kind, values: [{ label, selected?, url? }] }], reviewsTop [{ text, rating?, author? }]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' };

export const SOURCES = {
  ozon: { name: 'Ozon' },
  wb: { name: 'Wildberries' },
  ym: { name: 'Яндекс Маркет' },
  ali: { name: 'AliExpress' },
};

/** Достаёт все http(s)-ссылки из произвольного текста (в т.ч. из «Поделиться» приложений). */
export function extractUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'«»]+/gi) || [];
  const out = [];
  for (let u of found) {
    u = u.replace(/[),.;!?]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

export function detectSource(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(^|\.)ozon\.(ru|by|kz)$/.test(host) || host === 'ozon.onelink.me') return 'ozon';
  if (/(^|\.)(wildberries\.(ru|by|kz|am|kg|uz)|wb\.ru|wbbasket\.ru)$/.test(host)) return 'wb';
  if (/(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(host) || host === 'ya.cc') return 'ym';
  if (/(^|\.)(aliexpress\.(ru|com|us)|alibaba\.com|aliclick\.shop|ali\.click)$/.test(host) || /^s\.click\.aliexpress\.com$/.test(host))
    return 'ali';
  return null;
}

/** Ручное раскрытие редиректов (короткие ссылки ozon.ru/t, market.yandex.ru/cc, a.aliexpress.com/_, ali.click). */
async function resolveRedirects(url, source, maxHops = 8) {
  let current = url;
  // AliExpress (ali.click → aliexpress.ru/aff/redirect) сначала ставит cookie через login.aliexpress.ru
  // и возвращает на тот же адрес — без cookie это бесконечный круг. Храним их между переходами.
  const jar = new Map();
  for (let i = 0; i < maxHops; i++) {
    // Ozon отдаёт редирект только «голому» запросу, Яндекс — только запросу с браузерными заголовками
    let res = null;
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    for (const base of source === 'ozon' ? [undefined, HEADERS] : [HEADERS, undefined]) {
      const headers = cookie ? { ...(base || {}), Cookie: cookie } : base;
      try {
        res = await fetch(current, { method: 'GET', redirect: 'manual', headers });
      } catch {
        res = null;
      }
      if (res && (res.headers.get('location') || res.ok)) break;
    }
    if (res) {
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
      for (const line of setCookies) {
        const pair = line.split(';')[0].trim();
        const eq = pair.indexOf('=');
        if (eq > 0 && jar.size < 40) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    if (!res) return current;
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current).toString();
      // Ozon антибот уводит на ?__rr=1 того же адреса — дальше идти смысла нет
      if (stripQuery(next) === stripQuery(current) && !jar.size) return current;
      if (detectSource(next) === source && !needsResolve(next, source)) {
        return next;
      }
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

const stripQuery = (u) => u.split(/[?#]/)[0];

function needsResolve(url, source) {
  if (source === 'ozon') return !ozonId(url);
  if (source === 'ym') return !ymIdFromUrl(url);
  if (source === 'wb') return !/\/catalog\/\d+/.test(new URL(url).pathname);
  if (source === 'ali') return !aliId(url);
  return false;
}

/**
 * Раскрывает короткую ссылку (ali.click, ozon.ru/t, market.yandex.ru/cc…) до адреса товара — только редиректы,
 * без загрузки страницы. Приложению на телефоне некоторые короткие домены недоступны (ali.click), поэтому
 * сайт сначала просит раскрыть ссылку сервер. Если не вышло, возвращает исходную ссылку.
 */
export async function resolveLink(inputUrl) {
  const source = detectSource(inputUrl);
  if (!source || !needsResolve(inputUrl, source)) return inputUrl;
  const url = await resolveRedirects(inputUrl, source);
  const resolved = detectSource(url);
  return resolved && !needsResolve(url, resolved) ? url : inputUrl;
}

export async function parseProduct(inputUrl, shareText) {
  let source = detectSource(inputUrl);
  if (!source) throw new HttpError(400, 'Ссылка не похожа на Ozon, Wildberries, Яндекс Маркет или AliExpress');
  let url = inputUrl;
  if (needsResolve(url, source)) {
    url = await resolveRedirects(url, source);
    source = detectSource(url) || source;
  }
  if (needsResolve(url, source)) return placeholderProduct(inputUrl, source, shareText);
  const parser = { wb: parseWb, ym: parseYm, ozon: parseOzon, ali: parseAli }[source];
  const share = source === 'ali' ? aliShareData(inputUrl, shareText) : null;
  const product = await parser(url, share);
  if (!product?.productId) throw new HttpError(422, 'Не удалось определить товар по ссылке');
  return product;
}

// Магазины часто не раскрывают короткие ссылки серверам Cloudflare (Ozon — всегда). Карточку всё равно создаём,
// чтобы ссылка, добавленная с любого устройства, не терялась: приложение для Android или расширение браузера
// потом раскроет её у себя и перенесёт заготовку на настоящий товар (moveCard в index.js).
function placeholderProduct(inputUrl, source, shareText) {
  const link = new URL(inputUrl);
  link.hash = '';
  const ozonCode = source === 'ozon' ? ozonShortCode(inputUrl) : null;
  const key = ozonCode ? 't-' + ozonCode
    : 'link-' + (link.hostname.replace(/^www\./, '') + link.pathname).replace(/[^\w-]+/g, '_').replace(/_+$/, '').slice(-80);
  const product = {
    ...partialFromSlug(source, key, ozonCode ? `https://ozon.ru/t/${ozonCode}` : link.href, ''),
    title: `Товар ${SOURCES[source].name}`,
    placeholder: true,
  };
  const share = source === 'ali' ? aliShareData(inputUrl, shareText) : null;
  if (share?.title) Object.assign(product, { title: share.title, titleFromShare: true });
  if (share?.price != null) Object.assign(product, { price: share.price, priceNote: 'из текста «Поделиться»' });
  return product;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ----------------------------- Wildberries ----------------------------- */

// Диапазоны vol → номер basket-хоста CDN (публичные данные, могут устаревать — тогда перебор).
const WB_BASKETS = [
  [143, 1], [287, 2], [431, 3], [719, 4], [1007, 5], [1061, 6], [1115, 7], [1169, 8], [1313, 9], [1601, 10],
  [1655, 11], [1919, 12], [2045, 13], [2189, 14], [2405, 15], [2621, 16], [2837, 17], [3053, 18], [3269, 19],
  [3485, 20], [3701, 21], [3917, 22], [4133, 23], [4349, 24], [4565, 25], [4877, 26], [5189, 27], [5501, 28],
  [5813, 29], [6125, 30], [6437, 31], [6749, 32], [7061, 33], [7373, 34], [7685, 35], [7997, 36], [8309, 37],
];

function wbBasketGuess(vol) {
  for (const [max, n] of WB_BASKETS) if (vol <= max) return n;
  return WB_BASKETS[WB_BASKETS.length - 1][1] + Math.ceil((vol - WB_BASKETS[WB_BASKETS.length - 1][0]) / 312);
}

const wbHost = (n) => `https://basket-${String(n).padStart(2, '0')}.wbbasket.ru`;

async function wbFindBase(nm) {
  const vol = Math.floor(nm / 1e5);
  const part = Math.floor(nm / 1e3);
  const path = `/vol${vol}/part${part}/${nm}`;
  const guess = wbBasketGuess(vol);
  const tryHost = async (n) => {
    if (n < 1 || n > 99) return null;
    const res = await fetch(`${wbHost(n)}${path}/info/ru/card.json`, { headers: HEADERS });
    if (!res.ok) return null;
    return { base: `${wbHost(n)}${path}`, card: await res.json() };
  };
  const first = await tryHost(guess).catch(() => null);
  if (first) return first;
  // Перебор соседних хостов пачками
  const order = [];
  for (let d = 1; d <= 30; d++) order.push(guess + d, guess - d);
  for (let i = 0; i < order.length; i += 8) {
    const batch = await Promise.all(order.slice(i, i + 8).map((n) => tryHost(n).catch(() => null)));
    const hit = batch.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

async function parseWb(url) {
  const m = url.match(/\/catalog\/(\d+)/) || url.match(/[?&]nm=(\d+)/);
  if (!m) throw new HttpError(400, 'Не нашёл артикул Wildberries в ссылке');
  const nm = Number(m[1]);
  const canonical = `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
  const found = await wbFindBase(nm);
  if (!found) return partialFromSlug('wb', String(nm), canonical, '');
  const { base, card } = found;

  const count = Math.min(card?.media?.photo_count ?? 1, 30);
  const images = [];
  const thumbs = [];
  for (let i = 1; i <= count; i++) {
    images.push(`${base}/images/big/${i}.webp`);
    thumbs.push(`${base}/images/c516x688/${i}.webp`);
  }

  const result = {
    source: 'wb',
    productId: String(nm),
    url: canonical,
    title: card.imt_name || card.subj_name || `Товар ${nm}`,
    brand: card?.selling?.brand_name || null,
    price: null,
    oldPrice: null,
    priceNote: null,
    rating: null,
    reviews: null,
    images,
    thumbs,
    partial: !images.length,
  };

  const description = cleanText(card.description, 2000);
  if (description) result.description = description;
  const specs = cleanSpecs(card.options);
  if (specs) result.specs = specs;

  const [detail, feedbacks, history, colors] = await Promise.all([
    wbDetail(nm).catch(() => null),
    wbFeedbacks(card.imt_id).catch(() => null),
    fetch(`${base}/info/price-history.json`, { headers: HEADERS })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    wbColors(nm, card).catch(() => null),
  ]);
  const variants = cleanVariants([colors, wbSizes(card)].filter(Boolean),
    (link) => (/^https:\/\/www\.wildberries\.ru\/catalog\/\d+\/detail\.aspx$/.test(link) ? link : null));
  if (variants) result.variants = variants;

  if (detail) {
    Object.assign(result, detail);
  } else if (Array.isArray(history) && history.length) {
    // История цен обновляется редко (точки раз в неделю, а то и реже) и бывает совсем мимо:
    // у товара за 615 ₽ последняя точка была 18 ₽ двухмесячной давности. Берём только свежую точку,
    // иначе оставляем цену пустой — при обновлении карточки сохранится прежняя.
    const last = history[history.length - 1];
    const ageDays = (Date.now() / 1000 - Number(last?.dt)) / 86400;
    const price = Math.round((last?.price?.RUB || 0) / 100) || null;
    if (price && ageDays >= 0 && ageDays <= 10) {
      result.price = price;
      result.priceNote = 'по истории цен';
    }
  }
  result.partial = result.price == null || !images.length;
  if (feedbacks) {
    if (result.rating == null) result.rating = feedbacks.rating;
    if (result.reviews == null) result.reviews = feedbacks.reviews;
  }
  return result;
}

// Актуальная цена из API карточки (может отдавать 403 из-за защиты — тогда берём историю цен).
// sizes[].price.product — обычная цена на сайте (чёрная, «без кошелька»), basic — зачёркнутая.
// Крупная красная цена «с WB Кошельком» (≈ −3%) считается на сайте и зависит от покупателя — её не угадываем.
async function wbDetail(nm) {
  const res = await fetch(
    `https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nm}`,
    { headers: { ...HEADERS, Accept: 'application/json' } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const p = (json?.products || json?.data?.products || [])[0];
  if (!p) return null;
  const size = (p.sizes || []).find((s) => s?.price) || {};
  const price = size.price?.product ?? p.salePriceU;
  const basic = size.price?.basic ?? p.priceU;
  return {
    price: price ? Math.round(price / 100) : null,
    oldPrice: basic && basic !== price ? Math.round(basic / 100) : null,
    rating: p.reviewRating ?? p.rating ?? null,
    reviews: p.feedbacks ?? null,
  };
}

// Цвета: текущий цвет из nm_colors_names, остальные — из card.json соседних артикулов (не больше 8 запросов,
// только по угаданному хосту CDN, чтобы не тратить лимит подзапросов воркера).
async function wbColors(nm, card) {
  const current = cleanText(card?.nm_colors_names, 120);
  const others = [...new Set([].concat(card?.colors || []).map(Number))]
    .filter((other) => Number.isSafeInteger(other) && other > 0 && other !== nm).slice(0, 8);
  const names = await Promise.all(others.map(async (other) => {
    const vol = Math.floor(other / 1e5);
    const res = await fetch(`${wbHost(wbBasketGuess(vol))}/vol${vol}/part${Math.floor(other / 1e3)}/${other}/info/ru/card.json`,
      { headers: HEADERS, signal: AbortSignal.timeout(4000) }).catch(() => null);
    const json = res?.ok ? await res.json().catch(() => null) : null;
    return { label: json?.nm_colors_names, url: `https://www.wildberries.ru/catalog/${other}/detail.aspx` };
  }));
  const values = [
    ...(current ? [{ label: current, selected: true, url: `https://www.wildberries.ru/catalog/${nm}/detail.aspx` }] : []),
    ...names,
  ];
  return values.length ? { kind: 'Цвет', values } : null;
}

// Размеры из таблицы размеров card.json: «48 (M)» — российский размер и размер продавца
function wbSizes(card) {
  const table = card?.sizes_table;
  const ruColumn = [].concat(table?.details_props || []).findIndex((name) => name === 'RU');
  const values = [].concat(table?.values || []).flatMap((row) => {
    const tech = cleanText(row?.tech_size, 40);
    const ru = ruColumn >= 0 ? cleanText([].concat(row?.details || [])[ruColumn], 40) : '';
    const label = ru && tech && ru !== tech ? `${ru} (${tech})` : ru || tech;
    return label && label !== '0' ? [{ label }] : [];
  });
  return values.length > 1 ? { kind: 'Размер', values } : null;
}

// Ответ большой (все отзывы) — не парсим JSON целиком, а вытаскиваем два поля регэкспом.
async function wbFeedbacks(imtId) {
  if (!imtId) return null;
  for (const host of ['feedbacks1', 'feedbacks2']) {
    const res = await fetch(`https://${host}.wb.ru/feedbacks/v1/${imtId}`, { headers: HEADERS });
    if (!res.ok) continue;
    const text = await res.text();
    const val = text.match(/"valuation"\s*:\s*"?([\d.]+)/);
    const cnt = text.match(/"feedbackCount"\s*:\s*(\d+)/);
    if (val || cnt) return { rating: val ? Number(val[1]) : null, reviews: cnt ? Number(cnt[1]) : null };
  }
  return null;
}

/* ---------------------------- Яндекс Маркет ---------------------------- */

function ymIdFromUrl(url) {
  const path = new URL(url).pathname;
  return path.match(/^\/(?:card|product(?:--[^/]+)?)\/(?:[^/]+\/)?(\d{5,})(?:\/|$)/)?.[1] ?? null;
}

function ymCanonical(url) {
  const u = new URL(url);
  const keep = new URLSearchParams();
  for (const k of ['sku', 'do-waremd5', 'offerid']) if (u.searchParams.get(k)) keep.set(k, u.searchParams.get(k));
  const q = keep.toString();
  return `https://market.yandex.ru${u.pathname}${q ? '?' + q : ''}`;
}

async function parseYm(url) {
  const id = ymIdFromUrl(url);
  const canonical = ymCanonical(url);
  const slug = new URL(canonical).pathname.split('/')[2];
  const fallback = partialFromSlug('ym', id, canonical, slug);
  const page = await readProductPage(canonical, 'ym', id, ymIdFromUrl);
  if (!page) return fallback;
  const { html, gallery, metadata, heading, pageUrl, matchesId } = page;
  const product = findLdProduct(html, (item) => matchesId(item.url ?? item.mainEntityOfPage?.['@id'] ?? item['@id']) !== false);
  const meta = pageMeta(html);
  const sameProduct = matchesId(meta.get('og:url') ?? metadata.canonical);
  if (sameProduct === false) return fallback;
  const photos = imageLinks([...ymGallery(html), ...gallery, ...[].concat(product?.image || []), ...metadata.images], pageUrl, 'ym');

  if (!product && (!photos.length || (!sameProduct && !gallery.length && meta.get('og:type') !== 'product'))) return fallback;
  const offer = [].concat(product?.offers || [])[0] || {};
  const rating = product?.aggregateRating || {};
  const oldPrice = matchNum(html, /"oldPrice"\s*:\s*\{[^}]*?"value"\s*:\s*"?(\d+)/) || null;
  // Цена из ld+json совпадает с крупной ценой на странице (с картой Яндекс Пэй)
  const price = num(offer.price ?? offer.lowPrice) ?? rubleAmount(meta.get('product:price:amount'), meta.get('product:price:currency'));
  return {
    ...fallback,
    title: product?.name || meta.get('og:title') || heading || fallback.title,
    brand: typeof product?.brand === 'object' ? product.brand?.name : product?.brand || null,
    price,
    oldPrice: oldPrice && price && oldPrice > price ? oldPrice : null,
    priceNote: null,
    rating: num(rating.ratingValue),
    reviews: num(rating.reviewCount ?? rating.ratingCount),
    images: photos,
    thumbs: photos,
    partial: price == null || !photos.length,
    ...ldExtras(product, ymDescription(html)),
  };
}

// Описание Маркета лежит в данных виджета: "@card/AboutDescriptionV2":{"…":{"shortDescription":"…"}}
// (description в ld+json у Маркета рекламный: «купить в интернет-магазине…»)
function ymDescription(html) {
  const raw = html.match(/"@card\/AboutDescriptionV2":\{"[^"]+":\{[^{}]*?"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!raw) return '';
  try {
    return decodeHtml(JSON.parse(`"${raw}"`).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''));
  } catch { return ''; }
}

// Галерея: "gallery":{"<id>":{"mediaItems":["mi_..",...]}} + "mediaItem":{"mi_..":{"origUrl":"..."}}
function ymGallery(html) {
  const g = html.match(/"gallery"\s*:\s*\{\s*"\d+"\s*:\s*\{\s*"mediaItems"\s*:\s*\[([^\]]*)\]/);
  if (!g) return [];
  const ids = g[1].match(/mi_\d+/g) || [];
  const out = [];
  for (const id of ids.slice(0, 30)) {
    const m = html.match(new RegExp(`"${id}"\\s*:\\s*\\{[^{}]*?"origUrl"\\s*:\\s*"([^"]+)"`));
    if (m) out.push(m[1].replace(/\\\//g, '/'));
  }
  return out;
}

/* -------------------------------- Ozon -------------------------------- */

function ozonId(url) {
  const path = new URL(url).pathname;
  const slug = path.match(/\/product\/([^/]+)/)?.[1];
  return slug?.match(/(?:^|-)(\d{5,})$/)?.[1] ?? path.match(/^\/context\/detail\/id\/(\d{5,})\/?$/)?.[1];
}

// Код короткой ссылки «Поделиться» из приложения Ozon: https://ozon.ru/t/39Y1ISL
function ozonShortCode(url) {
  try {
    const u = new URL(url);
    if (!/^(?:www\.)?ozon\.(?:ru|by|kz)$/.test(u.hostname)) return null;
    return u.pathname.match(/^\/t\/([A-Za-z0-9_-]{4,20})\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function parseOzon(url) {
  const id = ozonId(url);
  if (!id) throw new HttpError(400, 'Не нашёл товар Ozon в ссылке');
  const slug = new URL(url).pathname.match(/\/product\/([^/]+)/)?.[1] || '';
  const canonical = `https://www.ozon.ru/product/${slug || id}/`;

  const fromPage = await tryPlainHtml(canonical, 'ozon', id);
  if (fromPage) return { ...fromPage, source: 'ozon', productId: id, url: canonical };
  return partialFromSlug('ozon', id, canonical, slug);
}

/* ----------------------------- AliExpress ----------------------------- */

function aliId(url) {
  const u = new URL(url);
  const productId = u.searchParams.get('productId');
  return u.pathname.match(/\/item\/(?:[^/]+\/)?(\d{6,})(?:\.html)?(?:\/|$)/)?.[1]
    ?? productId?.match(/^\d+$/)?.[0];
}

export function productFromBrowser(link, details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new HttpError(400, 'Нужны данные товара из браузера');
  }
  const source = detectSource(link);
  const url = source && new URL(link);
  const ozon = source === 'ozon';
  const ali = source === 'ali' && /(^|\.)aliexpress\.(ru|com|us)$/.test(url.hostname);
  const market = source === 'ym' && /(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(url.hostname);
  const wb = source === 'wb' && STORE_HOSTS.wb.test(url.hostname);
  const path = ozon ? BROWSER_PATHS.ozon : market ? BROWSER_PATHS.ym : wb ? BROWSER_PATHS.wb : BROWSER_PATHS.ali;
  if ((!ozon && !ali && !market && !wb) || url.protocol !== 'https:' || url.username || url.password ||
      !path.test(url.pathname) || url.pathname.length > 1000) {
    throw new HttpError(400, 'Нужна полная ссылка на товар Ozon, Яндекс Маркета, Wildberries или AliExpress');
  }
  const id = ozon ? ozonId(link) : market ? ymIdFromUrl(link) : wb ? url.pathname.match(/\/catalog\/(\d+)/)?.[1] : aliId(link);
  if (!id) throw new HttpError(400, 'Не удалось определить товар по ссылке');
  url.search = '';
  url.hash = '';
  const slug = ozon || market ? url.pathname.split('/')[2] || '' : '';
  const product = partialFromSlug(source, id, url.href, slug);
  const patch = {};
  const title = typeof details.title === 'string' && details.title.trim().slice(0, 300);
  if (title) Object.assign(patch, { title, titleFromBrowser: true, titleFromShare: false });
  const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (money(details.price)) {
    Object.assign(patch, { price: details.price, priceNote: 'при импорте из браузера' });
    // Старая (зачёркнутая) цена и цена без скидки банка Ozon или WB Кошелька — только вместе с ценой и только больше неё
    if (money(details.oldPrice) && details.oldPrice > details.price) patch.oldPrice = details.oldPrice;
    if (money(details.priceNoCard) && details.priceNoCard > details.price &&
        (patch.oldPrice == null || details.priceNoCard < patch.oldPrice)) patch.priceNoCard = details.priceNoCard;
  }
  if (typeof details.rating === 'number' && details.rating > 0 && details.rating <= 5) {
    patch.rating = Math.round(details.rating * 10) / 10;
  }
  if (Number.isSafeInteger(details.reviews) && details.reviews >= 0) patch.reviews = details.reviews;
  const description = cleanText(details.description, 2000);
  if (description) patch.description = description;
  const specs = cleanSpecs(details.specs);
  if (specs) patch.specs = specs;
  const variants = cleanVariants(details.variants, (value) => storeProductUrl(value, source, url.href));
  if (variants) patch.variants = variants;
  const reviewsTop = cleanReviews(details.reviewsTop);
  if (reviewsTop) patch.reviewsTop = reviewsTop;
  const images = Array.isArray(details.images) ? uniq(details.images.slice(0, 10).flatMap((value) => {
    if (typeof value !== 'string' || value.length > 800) return [];
    try {
      const image = new URL(value);
      if (image.protocol !== 'https:' || !marketplacePhoto(image, source) || image.username || image.password) return [];
      image.search = '';
      image.hash = '';
      return [image.href];
    } catch { return []; }
  })) : [];
  if (images.length) Object.assign(patch, { images, thumbs: images });
  if (!patch.title && patch.price == null && !patch.images) throw new HttpError(400, 'В данных из браузера нет названия, цены или фото');
  return { product: mergeBrowserProduct(product, patch), patch };
}

function marketplacePhoto(image, source) {
  if (source === 'ozon') return /(^|\.)ozone\.ru$/.test(image.hostname);
  // Фото Wildberries: basket-12.wbbasket.ru (или региональный …geobasket.ru)/vol…/part…/<артикул>/images/big/1.webp
  if (source === 'wb') {
    return /(^|\.)(wbbasket\.ru|geobasket\.ru)$/.test(image.hostname) && /^\/vol\d+\/part\d+\/\d+\/images\//.test(image.pathname);
  }
  if (source === 'ali') return /(^|\.)(alicdn\.com|aliexpress-media\.com)$/.test(image.hostname);
  return /\.marketpic\.ru$/.test(image.hostname) ||
    (/^(?:avatars\.mds\.yandex\.(?:net|ru)|avatars\.yandex\.net)$/.test(image.hostname) &&
     /\/get-(?:mpic|marketpic|marketpicturereading|marketpicplus)\//.test(image.pathname));
}

function imageLinks(values, pageUrl, source) {
  return uniq(values.flatMap((image) => {
    const value = image?.contentUrl ?? image?.url ?? image;
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
      const link = new URL(value, pageUrl);
      return link.protocol === 'https:' && !link.username && !link.password &&
        (!source || marketplacePhoto(link, source)) ? [link.href] : [];
    } catch { return []; }
  })).slice(0, 30);
}

// Поля, которых нет в patch (рейтинг, описание, характеристики, варианты…), остаются от прежней карточки
export function mergeBrowserProduct(product, patch) {
  const result = { ...product, ...patch };
  // Цена сменилась, а старой цены и цены без карты страница не показала — прежние уже не про эту цену
  if (patch.price != null && patch.price !== product.price) {
    if (patch.oldPrice === undefined) result.oldPrice = null;
    if (patch.priceNoCard === undefined) delete result.priceNoCard;
  }
  result.partial = result.price == null || !result.images?.length;
  return result;
}

async function parseAli(url, share) {
  const id = aliId(url);
  if (!id) throw new HttpError(400, 'Не нашёл товар AliExpress в ссылке');
  const canonical = `https://aliexpress.ru/item/${id}.html`;
  const data = await tryPlainHtml(canonical, 'ali', id);
  const product = data ? { ...data, source: 'ali', productId: id, url: canonical } : partialFromSlug('ali', id, canonical, '');
  if (!product.partial || !share) return product;

  const priceFromShare = product.price == null && share.price != null;
  const price = priceFromShare ? share.price : product.price;
  return {
    ...product,
    title: data ? product.title : share.title,
    titleFromShare: !data,
    price,
    priceNote: priceFromShare ? 'из текста «Поделиться»' : product.priceNote,
    partial: price == null || !product.images.length,
  };
}

function aliShareData(inputUrl, text) {
  if (typeof text !== 'string' || text.length > 3000) return null;
  const links = extractUrls(text);
  if (links.length !== 1 || links[0] !== inputUrl) return null;
  const snippet = text.slice(0, text.indexOf(inputUrl)).trim().replace(/\s+/g, ' ');
  const russian = snippet.match(/^Смотри, что есть на AliExpress!\s+(.+?)\s+за\s+([\d ]+(?:[.,]\d{1,2})?\s*(?:₽|руб\.?))(?:\s*[-–—]\s*уже со скидкой\s*-?\s*\d{1,3}\s*%)?$/i);
  if (russian) return { title: russian[1].trim().slice(0, 300), price: rubleAmount(russian[2]) };

  const english = snippet.match(/^I just found this on AliExpress:\s*([^|]*\d[^|]*)\|\s*(.+)$/i);
  if (!english) return null;
  const amount = english[1].trim();
  const rublePrefix = /^(?:RUB\s+|₽\s*)/i;
  const price = rublePrefix.test(amount) ? rubleAmount(amount.replace(rublePrefix, ''), 'RUB') : rubleAmount(amount);
  return { title: english[2].trim().slice(0, 300), price };
}

/* ------------------------------- Общее ------------------------------- */

async function readProductPage(url, source, id, productId) {
  const matchesId = (value) => {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      const page = new URL(value, url).href;
      const candidate = detectSource(page) === source ? productId(page) : null;
      return candidate ? candidate === id : undefined;
    } catch { return undefined; }
  };
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(6500) });
    const pageUrl = res.url || url;
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html') || matchesId(pageUrl) !== true || !res.body) {
      await res.body?.cancel();
      return null;
    }
    const metadata = { canonical: '', images: [] };
    const gallery = [];
    let heading = '';
    const rewriter = new HTMLRewriter()
      .on('meta', { element(el) {
        const key = (el.getAttribute('property') || el.getAttribute('name') || el.getAttribute('itemprop') || '').toLowerCase();
        if (/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?|image)$/.test(key)) {
          const content = el.getAttribute('content');
          if (content && metadata.images.length < 20) metadata.images.push(content);
        }
      } })
      .on('link', { element(el) {
        const rel = el.getAttribute('rel');
        if (rel === 'canonical') metadata.canonical = el.getAttribute('href');
        if (rel === 'image_src' && metadata.images.length < 20) metadata.images.push(el.getAttribute('href'));
      } })
      .on('h1', { text(chunk) {
        if (heading.length < 400) heading += chunk.text;
      } });
    const containers = source === 'ozon'
      ? ['[data-widget="webGallery"]', '[data-widget="webProductGallery"]']
      : source === 'ym' ? ['[data-auto="gallery"]', '[data-auto="product-gallery"]', '[data-zone-name="productGallery"]'] : [];
    for (const container of containers) {
      rewriter.on(container + ' img', { element(el) {
        if (gallery.length >= 50) return;
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
        const largest = srcset.split(',').at(-1)?.trim().split(/\s+/)[0];
        gallery.push(el.getAttribute('data-original'), largest, el.getAttribute('data-src'), el.getAttribute('src'));
      } });
    }
    if (source === 'ozon') {
      rewriter.on('[id^="state-webGallery"][data-state]', { element(el) {
        const state = el.getAttribute('data-state');
        if (state && state.length < 220000) gallery.push(...galleryStateImages(state));
      } });
    }
    const reader = rewriter.transform(res).body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytes = 0;
    const maxBytes = 4 * 1024 * 1024;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value.subarray(0, maxBytes - bytes), { stream: true });
      bytes += value.length;
      if (bytes >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
    html += decoder.decode();
    return { html, gallery: imageLinks(gallery, pageUrl, source), metadata, heading: decodeHtml(heading).trim(), pageUrl, matchesId };
  } catch {
    return null;
  }
}

function galleryStateImages(raw) {
  let state;
  for (const candidate of [raw, decodeHtml(raw)]) {
    try {
      state = JSON.parse(candidate);
      break;
    } catch {}
  }
  const nodes = [state];
  const photos = [];
  for (let i = 0; nodes.length && i < 1800 && photos.length < 30; i++) {
    const value = nodes.pop();
    if (typeof value === 'string' && /^(?:https:)?\/\/[^ ]+\.(?:avif|jpe?g|png|webp)(?:[?#].*)?$/i.test(value)) {
      photos.push(value);
    } else if (value && typeof value === 'object') {
      nodes.push(...Object.values(value).reverse().slice(0, 1800));
    }
  }
  return photos;
}

async function tryPlainHtml(url, source, id) {
  const page = await readProductPage(url, source, id, source === 'ozon' ? ozonId : aliId);
  if (!page) return null;
  const { html, gallery, metadata, heading, pageUrl, matchesId } = page;
  const meta = pageMeta(html);
  const sameProduct = matchesId(meta.get('og:url') ?? metadata.canonical);
  if (sameProduct === false) return null;
  let otherProduct = false;
  const product = findLdProduct(html, (item) => {
    const match = matchesId(item.url ?? item.mainEntityOfPage?.['@id'] ?? item.mainEntityOfPage ?? item['@id']);
    if (match !== false) return true;
    otherProduct = true;
    return false;
  });
  const name = product?.name || meta.get('og:title') || heading;
  const images = imageLinks([...gallery, ...[].concat(product?.image || []), ...metadata.images], pageUrl, source);
  const verifiedPhoto = images.length && (sameProduct || gallery.length);
  if (typeof name !== 'string' || !name.trim() || (!product && (otherProduct || (!verifiedPhoto && meta.get('og:type') !== 'product')))) return null;
  const offerPrices = [].concat(product?.offers || []).map((offer) => rubleAmount(offer?.price ?? offer?.lowPrice, offer?.priceCurrency));
  // У Ozon в ld+json цена «с другими банками»; крупная зелёная цена «с банками» — в состоянии виджета webPrice
  const states = source === 'ozon' ? ozonStates(html) : {};
  const shown = ozonStatePrice(states);
  const price = shown?.price ?? offerPrices.find((value) => value != null)
    ?? rubleAmount(meta.get('product:price:amount'), meta.get('product:price:currency'))
    ?? rubleAmount(meta.get('og:price:amount'), meta.get('og:price:currency'))
    ?? rubleAmount(meta.get('price'), meta.get('pricecurrency'));
  const oldPrice = shown && shown.price === price && shown.oldPrice > price ? shown.oldPrice : null;
  const priceNoCard = shown && shown.price === price && shown.noCard > price && (!oldPrice || shown.noCard < oldPrice)
    ? shown.noCard : null;
  const rating = pageNumber(product?.aggregateRating?.ratingValue ?? states.webReviewProductScore?.totalScore);
  const reviews = pageNumber(product?.aggregateRating?.reviewCount ?? product?.aggregateRating?.ratingCount ??
    states.webReviewProductScore?.reviewsCount);
  const extras = ldExtras(product, '');
  const specs = cleanSpecs([
    ...(extras.specs || []),
    ...ozonStateSpecs(states.webCharacteristics),
    ...ozonStateSpecs(states.webShortCharacteristics),
  ]);
  const variants = cleanVariants([].concat(states.webAspects?.aspects || []).map((aspect) => ({
    kind: aspect?.aspectName,
    values: [].concat(aspect?.variants || []).map((variant) => ({
      label: variant?.data?.searchableText || [].concat(variant?.data?.textRs || []).map((part) => part?.content || '').join(''),
      selected: variant?.active === true || String(variant?.sku) === id,
      url: variant?.link,
    })),
  })), (link) => storeProductUrl(link, source, pageUrl));
  return {
    title: name.trim(),
    brand: typeof product?.brand === 'object' ? product.brand?.name : product?.brand || null,
    price,
    oldPrice,
    priceNote: null,
    rating: rating > 0 && rating <= 5 ? rating : null,
    reviews: Number.isSafeInteger(reviews) ? reviews : null,
    images,
    thumbs: images,
    partial: price == null || !images.length,
    ...extras,
    ...(priceNoCard ? { priceNoCard } : {}),
    ...(specs ? { specs } : {}),
    ...(variants ? { variants } : {}),
  };
}

// Состояния виджетов Ozon из разметки: <div id="state-webPrice-…" data-state='{…}'>
function ozonStates(html) {
  const states = {};
  const names = /\bid="state-(webPrice|webMobPriceCompact|webAspects|webShortCharacteristics|webCharacteristics|webReviewProductScore)-/g;
  for (const match of html.matchAll(names)) {
    if (states[match[1]]) continue;
    const start = html.lastIndexOf('<', match.index);
    const tag = html.slice(start, start + 300000).match(/^<\w+(?:[^"'<>]|"[^"]*"|'[^']*')*>/)?.[0] || '';
    const value = tag.match(/\sdata-state=(?:'([^']*)'|"([^"]*)")/);
    if (!value) continue;
    try { states[match[1]] = JSON.parse(decodeHtml(value[1] ?? value[2])); } catch {}
  }
  return states;
}

function ozonStatePrice(states) {
  const web = states.webPrice;
  if (web && (web.cardPrice || web.price)) {
    return {
      price: rubleAmount(web.cardPrice || web.price),
      oldPrice: web.showOriginalPrice === false ? null : rubleAmount(web.originalPrice),
      noCard: web.cardPrice ? rubleAmount(web.price) : null,
    };
  }
  const mobile = [].concat(states.webMobPriceCompact?.mainPrice?.price || []);
  const price = rubleAmount(mobile.find((item) => item?.textStyle === 'PRICE')?.text);
  return price == null ? null
    : { price, oldPrice: rubleAmount(mobile.find((item) => item?.textStyle === 'ORIGINAL_PRICE')?.text), noCard: null };
}

// Характеристики из состояния Ozon: [{ title: { textRs: [{ content }] }, values: [{ text }] }] на любой глубине
function ozonStateSpecs(state) {
  const found = [];
  const nodes = [state];
  for (let i = 0; nodes.length && i < 3000; i++) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node.values) && node.title) {
      const name = typeof node.title === 'string' ? node.title
        : [].concat(node.title?.textRs || []).map((part) => part?.content || '').join('');
      found.push({ name, value: node.values.map((part) => part?.text || '').filter(Boolean).join(', ') });
    } else nodes.push(...Object.values(node).reverse());
  }
  return found;
}

// Описание (кроме рекламных «купить в интернет-магазине…»), характеристики и отзывы из ld+json
function ldExtras(product, pageDescription) {
  const advert = /(?:купить|покупайте)[^.]{0,120}(?:интернет-магазин|на ozon|маркете|aliexpress|по выгодн)/i;
  const description = [product?.description, pageDescription]
    .map((value) => cleanText(typeof value === 'string' ? decodeHtml(value) : '', 2000))
    .find((value) => value.length >= 20 && !advert.test(value));
  const specs = cleanSpecs([].concat(product?.additionalProperty || []));
  const reviewsTop = cleanReviews([].concat(product?.review || []).map((review) => ({
    text: review?.reviewBody ?? review?.description,
    rating: pageNumber(review?.reviewRating?.ratingValue),
    author: typeof review?.author === 'string' ? review.author : review?.author?.name,
  })));
  return {
    ...(description ? { description } : {}),
    ...(specs ? { specs } : {}),
    ...(reviewsTop ? { reviewsTop } : {}),
  };
}

/* ---------- Описание, характеристики, варианты, отзывы: очистка и ограничения ---------- */

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanSpecs(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const specs = list.slice(0, 200).flatMap((item) => {
    const name = cleanText(item?.name, 120).replace(/\s*:$/, '');
    const value = cleanText(typeof item?.value === 'number' ? String(item.value) : item?.value, 120);
    if (!name || !value || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    return [{ name, value }];
  }).slice(0, 40);
  return specs.length ? specs : null;
}

// toUrl(value) возвращает безопасную ссылку на товар того же магазина или null
function cleanVariants(list, toUrl) {
  if (!Array.isArray(list)) return null;
  const groups = list.slice(0, 20).flatMap((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.values)) return [];
    const seen = new Set();
    const values = group.values.slice(0, 100).flatMap((value) => {
      const label = cleanText(value?.label, 120);
      if (!label || seen.has(label.toLowerCase())) return [];
      seen.add(label.toLowerCase());
      const item = { label };
      if (value.selected === true) item.selected = true;
      const link = typeof value.url === 'string' ? toUrl(value.url) : null;
      if (link) item.url = link;
      return [item];
    }).slice(0, 30);
    return values.length ? [{ kind: cleanText(group.kind, 40).replace(/\s*:$/, '') || 'Вариант', values }] : [];
  }).slice(0, 6);
  return groups.length ? groups : null;
}

function cleanReviews(list) {
  if (!Array.isArray(list)) return null;
  const reviews = list.slice(0, 10).flatMap((review) => {
    const text = cleanText(review?.text, 300);
    if (!text) return [];
    const item = { text };
    if (typeof review.rating === 'number' && review.rating > 0 && review.rating <= 5) item.rating = Math.round(review.rating * 10) / 10;
    const author = cleanText(review.author, 60);
    if (author) item.author = author;
    return [item];
  }).slice(0, 3);
  return reviews.length ? reviews : null;
}

const BROWSER_PATHS = {
  ozon: /^\/(?:product\/(?:[^/]+-)?\d{5,}|context\/detail\/id\/\d{5,})\/?$/,
  ym: /^\/(?:card|product(?:--[^/]+)?)\/(?:[^/]+\/)?\d{5,}\/?$/,
  wb: /^\/catalog\/\d{5,}\/detail\.aspx\/?$/,
  ali: /^\/item\/(?:[^/]+\/)?\d{6,}(?:\.html)?\/?$/,
};
const STORE_HOSTS = {
  ozon: /(^|\.)ozon\.(ru|by|kz)$/,
  ym: /(^|\.)market\.yandex\.(ru|by|kz|com)$/,
  wb: /(^|\.)wildberries\.(ru|by|kz|am|kg|uz)$/,
  ali: /(^|\.)aliexpress\.(ru|com|us)$/,
};

// https-ссылка на страницу товара того же магазина, без параметров; иначе null
function storeProductUrl(value, source, base) {
  if (typeof value !== 'string' || !value || value.length > 2000 || !BROWSER_PATHS[source]) return null;
  try {
    const link = new URL(value, base);
    if (link.protocol !== 'https:' || link.username || link.password || !STORE_HOSTS[source].test(link.hostname) ||
        !BROWSER_PATHS[source].test(link.pathname)) return null;
    link.search = '';
    link.hash = '';
    return link.href.length <= 800 ? link.href : null;
  } catch { return null; }
}

function pageMeta(html) {
  const values = new Map();
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  for (const tag of head.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = Object.fromEntries(Array.from(
      tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g),
      ([, key, quoted, singleQuoted, unquoted]) => [key.toLowerCase(), quoted ?? singleQuoted ?? unquoted],
    ));
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase();
    if (key && attrs.content && !values.has(key)) values.set(key, decodeHtml(attrs.content).trim());
  }
  return values;
}

function pageNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().replace(/\s+/g, '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function rubleAmount(value, currency) {
  const suffix = /\s*(?:₽|руб\.?)$/i;
  const text = String(value ?? '').trim();
  if (currency != null ? !/^RU[BR]$/i.test(String(currency).trim()) : !suffix.test(text)) return null;
  return pageNumber(text.replace(suffix, ''));
}

function findLdProduct(html, accept = () => true) {
  const re = /<script\b[^>]*\stype\s*=\s*(['"]?)application\/ld\+json\1(?=\s|>)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[2]);
      const list = Array.isArray(data) ? data : [data, ...[].concat(data?.['@graph'] || [])];
      const p = list.find((x) => [].concat(x?.['@type'] || [])
        .some((type) => typeof type === 'string' && /^(?:https?:\/\/schema\.org\/)?Product$/.test(type)) && accept(x));
      if (p) return p;
    } catch {}
  }
  return null;
}

function partialFromSlug(source, id, url, slug) {
  return {
    source,
    productId: id,
    url,
    title: slugToTitle(slug, id) || `Товар ${SOURCES[source].name}${id ? ' №' + id : ''}`,
    brand: null,
    price: null,
    oldPrice: null,
    priceNote: null,
    rating: null,
    reviews: null,
    images: [],
    thumbs: [],
    partial: true,
  };
}

// Обратная транслитерация slug из URL: "ochistitel-vozduha-kp500-6101004944" → "Очиститель воздуха кп500"
const TR = [
  ['shch', 'щ'], ['sch', 'щ'], ['yo', 'ё'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'],
  ['yu', 'ю'], ['ya', 'я'], ['iy', 'ий'], ['yy', 'ый'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'],
  ['e', 'е'], ['z', 'з'], ['i', 'и'], ['y', 'ы'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'],
  ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['j', 'й'],
  ['w', 'в'], ['x', 'кс'], ['q', 'к'],
];

export function slugToTitle(slug, id) {
  if (!slug) return '';
  let decoded = slug;
  try { decoded = decodeURIComponent(slug); } catch {}
  const words = decoded.toLowerCase().split('-').filter(Boolean);
  if (id && words[words.length - 1] === String(id)) words.pop();
  const titleWords = words.map((w) => {
    if (/^\d+h\d+$/.test(w)) return w.replace('h', '×');
    let out = '';
    for (let i = 0; i < w.length; ) {
      if (/\d/.test(w[i])) {
        out += w[i++];
        continue;
      }
      const hit = TR.find(([lat]) => w.startsWith(lat, i));
      if (hit) {
        // «y» перед гласной в начале слова — это «й»
        if (hit[0] === 'y' && (i === 0 || /[aeiou]/.test(w[i - 1])) && /[aeiou]/.test(w[i + 1] || '')) out += 'й';
        else if (hit[0] === 'y' && i > 0 && /[aeiou]/.test(w[i - 1])) out += 'й';
        else out += hit[1];
        i += hit[0].length;
      } else out += w[i++];
    }
    return out;
  });
  const s = titleWords.join(' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const matchNum = (s, re) => num(s.match(re)?.[1]);
const uniq = (a) => [...new Set(a)];
const decodeHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
