'use strict';

// Читает открытую страницу товара Ozon, Яндекс Маркета или AliExpress.
// Функция самодостаточна: приложение для Android получает её текст от сайта и выполняет
// внутри скрытого браузера на странице магазина, поэтому снаружи ей ничего не доступно.
// Возвращает { status: 'ok' | 'wait' | 'blocked', ... }.
function readOpenProduct() {
  const url = new URL(location.href);
  const text = (document.body?.innerText || '').slice(0, 4000);
  const blocked =
    /showcaptcha|\/captcha|\/punish|_____tmd_____|\/abt\//i.test(url.pathname + url.search) ||
    !!document.querySelector(
      'iframe[src*="captcha" i], .nc_wrapper, #nc_1_n1z, .baxia-dialog, [class*="smart-captcha" i], form[action*="checkcaptcha" i]'
    ) ||
    // Последняя пара — страница Ozon при блокировке по IP («Похоже, нет соединения… Инцидент: …»)
    /доступ ограничен|подтвердите, что вы не робот|вы не робот|are you a robot|verify you are human|slide to verify/i.test(text) ||
    (/выключите vpn/i.test(text) && /инцидент:/i.test(text));
  if (blocked) return { status: 'blocked' };

  const ozon = /(^|\.)ozon\.(ru|by|kz)$/.test(url.hostname);
  const ali = /(^|\.)aliexpress\.(ru|com|us)$/.test(url.hostname);
  const market = /(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(url.hostname);
  const productPath = ozon
    ? /^\/(?:product\/(?:[^/]+-)?\d{5,}|context\/detail\/id\/\d{5,})\/?$/
    : market ? /^\/(?:card|product(?:--[^/]+)?)\/(?:[^/]+\/)?\d{5,}\/?$/
      : /^\/item\/(?:[^/]+\/)?\d{6,}(?:\.html)?\/?$/;
  // Пока идут редиректы короткой ссылки или проверка браузера — ждём
  if (url.protocol !== 'https:' || (!ozon && !ali && !market) || !productPath.test(url.pathname)) return { status: 'wait' };
  url.search = '';
  url.hash = '';

  const meta = (...keys) => {
    for (const key of keys) {
      const node = document.querySelector('meta[property="' + key + '"],meta[name="' + key + '"],meta[itemprop="' + key + '"]');
      if (node?.content) return node.content;
    }
    return '';
  };
  let product;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const ld = JSON.parse(script.textContent);
      const items = Array.isArray(ld) ? ld : [ld, ...[].concat(ld?.['@graph'] || [])];
      product = items.find((item) => [].concat(item?.['@type']).some(
        (type) => /^(?:https?:\/\/schema\.org\/)?Product$/.test(type)
      ));
      if (product) break;
    } catch {}
  }

  const gallery = document.querySelector(ozon
    ? '[data-widget*="gallery" i]'
    : '[data-auto*="gallery" i], [data-zone-name*="gallery" i], [data-testid*="gallery" i], [class*="gallery" i]');
  const priceWidget = document.querySelector(ozon
    ? '[data-widget="webPrice"], [data-widget*="price" i]'
    : market ? '[data-auto="mainPrice"], [data-auto*="price" i]' : '[class*="price--current" i], [class*="Price_current" i], [class*="snow-price" i]');
  const heading = document.querySelector('h1')?.innerText;
  const ogImage = meta('og:image', 'og:image:secure_url');
  const imageHosts = ozon ? /(^|\.)ozone\.ru$/ : market
    ? /^(?:avatars\.mds\.yandex\.(?:net|ru)|avatars\.yandex\.net|[^.]+\.marketpic\.ru)$/
    : /(^|\.)(alicdn\.com|aliexpress-media\.com)$/;
  const cleanPhoto = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
      const image = new URL(value, url);
      if (image.protocol !== 'https:' || !imageHosts.test(image.hostname) || image.username || image.password) return null;
      if (market && !/\/get-(?:mpic|marketpic|marketpicturereading|marketpicplus)\//.test(image.pathname) &&
          !/\.marketpic\.ru$/.test(image.hostname)) return null;
      image.search = '';
      image.hash = '';
      return image.href.length <= 800 ? image.href : null;
    } catch { return null; }
  };
  const labelledPhotos = heading ? Array.from(document.querySelectorAll('img[alt]'))
    .filter((image) => image.alt.trim().toLowerCase() === heading.trim().toLowerCase()) : [];
  const productImages = [...Array.from(gallery?.querySelectorAll('img') || []), ...labelledPhotos]
    .flatMap((image) => [image.dataset.src, image.dataset.original, image.currentSrc || image.src])
    .map(cleanPhoto).filter(Boolean);

  const title = String(heading || product?.name || meta('og:title') || '')
    .trim().replace(/\s+/g, ' ').slice(0, 300);
  const rubles = (value, currency) => {
    const raw = String(value ?? '').trim();
    if (currency ? !/^RU[BR]$/i.test(currency.trim()) : !/₽$/.test(raw)) return null;
    const number = raw.replace(/[₽\s  ]/g, '').replace(',', '.');
    return /^\d+(?:\.\d{1,2})?$/.test(number) ? Number(number) : null;
  };
  // В виджете цены бывает несколько сумм (с картой, без карты, старая) — первая обычно актуальная
  const visiblePrices = (priceWidget?.innerText?.match(/\d[\d   ]*(?:[.,]\d{1,2})?\s*₽/g) || [])
    .map((value) => rubles(value, '')).filter(Number.isFinite);
  const metaPrices = [
    ...[].concat(product?.offers || []).map((offer) => [offer?.price ?? offer?.lowPrice, offer?.priceCurrency]),
    [meta('product:price:amount', 'og:price:amount', 'price'), meta('product:price:currency', 'og:price:currency', 'priceCurrency')],
  ].map(([value, currency]) => rubles(value, typeof currency === 'string' ? currency : '')).filter(Number.isFinite);
  const price = metaPrices[0] ?? visiblePrices[0] ?? null;
  const pictures = [
    ...[].concat(product?.image || []).map((image) => image?.contentUrl || image?.url || image),
    ogImage,
  ];
  // Одно фото Маркета приходит в разных размерах (…/orig, …/600x800) — оставляем первый вариант
  const photoKey = (href) => market ? href.replace(/\/[^/]*$/, '') : href;
  const seen = new Set();
  const images = [...pictures.map(cleanPhoto).filter(Boolean), ...productImages]
    .filter((href) => !seen.has(photoKey(href)) && seen.add(photoKey(href))).slice(0, 10);

  // Одного заголовка мало: так выглядят и «товар удалён», и недогруженная карточка
  if (price === null && !images.length) return { status: 'wait' };
  return {
    status: 'ok',
    complete: !!title && price !== null && images.length > 0,
    url: url.href,
    title,
    price,
    images,
  };
}
