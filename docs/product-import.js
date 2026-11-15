'use strict';

const PRODUCT_IMPORT_PREFIX = 'MP-PRODUCT/1 ';

// Функция целиком попадает в закладку и запускается пользователем на странице магазина.
function copyOpenProduct(prefix) {
  const url = new URL(location.href);
  const ozon = /(^|\.)ozon\.(ru|by|kz)$/.test(url.hostname);
  const ali = /(^|\.)aliexpress\.(ru|com|us)$/.test(url.hostname);
  const market = /(^|\.)market\.yandex\.(ru|by|kz|com)$/.test(url.hostname);
  const productPath = ozon
    ? /^\/(?:product\/(?:[^/]+-)?\d{5,}|context\/detail\/id\/\d{5,})\/?$/
    : market ? /^\/(?:card|product(?:--[^/]+)?)\/(?:[^/]+\/)?\d{5,}\/?$/
      : /^\/item\/(?:[^/]+\/)?\d{6,}(?:\.html)?\/?$/;
  if (url.protocol !== 'https:' || url.username || url.password || (!ozon && !ali && !market) || !productPath.test(url.pathname)) {
    alert('Откройте страницу товара Ozon, Яндекс Маркета или AliExpress и запустите закладку снова.');
    return;
  }
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
    : '[data-auto*="gallery" i], [data-zone-name*="gallery" i], [data-testid*="gallery" i]');
  const priceWidget = document.querySelector(ozon ? '[data-widget="webPrice"]' : '[data-auto="mainPrice"]');
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
  const productMeta = meta('og:type') === 'product' || (heading && cleanPhoto(ogImage));
  const labelledPhotos = heading ? Array.from(document.querySelectorAll('main img[alt]'))
    .filter((image) => image.alt.trim().toLowerCase() === heading.trim().toLowerCase()) : [];
  const productImages = [...Array.from(gallery?.querySelectorAll('img') || []), ...labelledPhotos]
    .flatMap((image) => [image.dataset.src, image.dataset.original, image.currentSrc || image.src])
    .map(cleanPhoto).filter(Boolean);
  if (!product && !productMeta && !gallery && !priceWidget && !productImages.length) {
    alert('Данные товара пока не видны. Дождитесь загрузки карточки и пройдите проверку, если её показывает магазин.');
    return;
  }

  const title = String(heading || product?.name || meta('og:title'))
    .trim().replace(/\s+/g, ' ').slice(0, 300);
  const prices = [
    ...[].concat(product?.offers || []).map((offer) => [offer?.price ?? offer?.lowPrice, offer?.priceCurrency]),
    [meta('product:price:amount', 'og:price:amount', 'price'), meta('product:price:currency', 'og:price:currency', 'priceCurrency')],
  ];
  const rubles = (value, currency) => {
    const text = String(value ?? '').trim();
    if (currency ? !/^RU[BR]$/i.test(currency.trim()) : !/₽$/.test(text)) return null;
    const number = text.replace(/[₽\s]/g, '').replace(',', '.');
    return /^\d+(?:\.\d{1,2})?$/.test(number) ? Number(number) : null;
  };
  const visiblePrices = [...new Set((priceWidget?.innerText?.match(/\d[\d \u00a0\u202f]*(?:[.,]\d{1,2})?\s*₽/g) || [])
    .map((text) => rubles(text, '')).filter(Number.isFinite))];
  const price = (visiblePrices.length === 1 ? visiblePrices[0] : null)
    ?? prices.map(([value, currency]) => rubles(value, typeof currency === 'string' ? currency : ''))
      .find(Number.isFinite) ?? null;
  const pictures = [
    ...[].concat(product?.image || []).map((image) => image?.contentUrl || image?.url || image),
    ogImage,
  ];
  const images = [...new Set([...pictures.map(cleanPhoto).filter(Boolean), ...productImages])].slice(0, 10);

  if (!title && price === null && !images.length) {
    alert('На этой странице не удалось прочитать данные товара.');
    return;
  }

  // Кнопка даёт Clipboard API собственное нажатие, в том числе в Safari.
  const existing = document.getElementById('mp-product-copy');
  if (existing?.open) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'mp-product-copy';
  dialog.setAttribute('aria-label', 'Скопировать карточку товара');
  const form = document.createElement('form');
  form.method = 'dialog';
  const name = document.createElement('p');
  name.textContent = title || 'Карточка товара';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = [price === null ? '' : price + ' ₽', images.length ? images.length + ' фото' : ''].filter(Boolean).join(' · ');
  const field = document.createElement('textarea');
  field.setAttribute('aria-label', 'Данные товара');
  field.readOnly = true;
  field.hidden = true;
  field.value = prefix + JSON.stringify({ url: url.href, title, price, images });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Скопировать данные';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = 'Скопировано. Вставьте данные в «Выбираем вместе».';
    } catch {
      field.hidden = false;
      field.focus();
      field.select();
      status.textContent = 'Скопируйте выделенный текст и вставьте его в «Выбираем вместе».';
    }
  });
  const close = document.createElement('button');
  close.textContent = 'Закрыть';
  form.append(name, status, field, copy, close);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function productBookmarklet() {
  return 'javascript:' + encodeURIComponent('void (' + copyOpenProduct.toString() + ')(' + JSON.stringify(PRODUCT_IMPORT_PREFIX) + ')');
}
