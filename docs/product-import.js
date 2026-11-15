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
  const clean = (value, max) => (typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const textOf = (node) => (node ? node.innerText ?? node.textContent ?? '' : '');
  const rubles = (value, currency) => {
    const raw = String(value ?? '').trim();
    if (currency ? !/^RU[BR]$/i.test(currency.trim()) : !/₽$/.test(raw)) return null;
    const number = raw.replace(/[₽\s]/g, '').replace(',', '.');
    return /^\d+(?:\.\d{1,2})?$/.test(number) ? Number(number) : null;
  };
  // Состояние виджета Ozon, которое сервер кладёт в разметку: <div id="state-webPrice-…" data-state="{…}">
  const ozonState = (name) => {
    if (!ozon) return null;
    for (const node of document.querySelectorAll('[id^="state-' + name + '-"][data-state]')) {
      try { return JSON.parse(node.getAttribute('data-state')); } catch {}
    }
    return null;
  };

  // Цена — та, что покупатель видит главной вверху карточки, а не цена из ld+json/meta.
  // Ozon в ld+json отдаёт цену «с другими банками», а крупно (зелёным) показывает цену «с банками»
  // (бывшая «с Ozon Картой») — её и берём: на телефоне Ozon показывает только её. Маркет крупно показывает
  // цену с картой Яндекс Пэй (она же в ld+json). Поэтому в виджете цены берём сумму самым крупным шрифтом,
  // а зачёркнутую — как старую цену. Нет виджета — состояние виджета Ozon, затем ld+json и meta.
  const amountPattern = /^\d[\d\s]*(?:[.,]\d{1,2})?\s*₽$/;
  const struck = (node, box) => {
    for (let el = node; el && el !== box.parentElement; el = el.parentElement) {
      if (/^(?:S|DEL|STRIKE)$/.test(el.tagName) || /line-through/.test(getComputedStyle(el).textDecorationLine)) return true;
    }
    return false;
  };
  // Ozon рисует линию зачёркивания псевдоэлементом высотой 1px
  const strikeLine = (el) => ['::before', '::after'].some((pseudo) => {
    const line = getComputedStyle(el, pseudo);
    return line.content !== 'none' && line.content !== 'normal' && parseFloat(line.height) <= 3 &&
      (parseFloat(line.borderTopWidth) > 0 || !/^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(line.backgroundColor));
  });
  const shownAmounts = (box) => Array.from(box.querySelectorAll('*')).flatMap((el) => {
    const amount = textOf(el).trim();
    if (!amountPattern.test(amount) || Array.from(el.children).some((child) => amountPattern.test(textOf(child).trim()))) return [];
    const rect = el.getBoundingClientRect();
    const value = rubles(amount, '');
    if (!rect.width || !rect.height || value === null) return [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let digits = null;
    for (let node = walker.nextNode(); node && !digits; node = walker.nextNode()) if (/\d/.test(node.textContent)) digits = node.parentElement;
    digits = digits || el;
    let crossed = struck(digits, box);
    for (let inner = digits; !crossed && inner && inner !== el.parentElement; inner = inner.parentElement) crossed = strikeLine(inner);
    return [{ value, size: parseFloat(getComputedStyle(digits).fontSize) || 0, crossed }];
  });
  const priceBoxes = ozon
    ? '[data-widget="webPrice"], [data-widget="webMobPriceCompact"], [data-widget*="price" i]'
    : market ? '[data-apiary-widget-name="@card/PriceOffer"], [data-auto="mainPrice"]'
      : '[class*="price--current" i], [class*="Price_current" i], [class*="snow-price" i], [class*="product-price" i]';
  let shown = null;
  for (const box of document.querySelectorAll(priceBoxes)) {
    const amounts = shownAmounts(box);
    const current = amounts.filter((item) => !item.crossed).sort((a, b) => b.size - a.size)[0];
    if (!current) continue;
    const old = Math.max(0, ...amounts.filter((item) => item.crossed).map((item) => item.value));
    shown = { price: current.value, oldPrice: old > current.value ? old : null };
    break;
  }
  const webPrice = ozonState('webPrice');
  const mobilePrice = [].concat(ozonState('webMobPriceCompact')?.mainPrice?.price || []);
  const statePrice = webPrice ? {
    price: rubles(webPrice.cardPrice || webPrice.price, ''),
    oldPrice: webPrice.showOriginalPrice === false ? null : rubles(webPrice.originalPrice, ''),
  } : mobilePrice.length ? {
    price: rubles(mobilePrice.find((item) => item?.textStyle === 'PRICE')?.text, ''),
    oldPrice: rubles(mobilePrice.find((item) => item?.textStyle === 'ORIGINAL_PRICE')?.text, ''),
  } : null;
  const metaPrices = [
    ...[].concat(product?.offers || []).map((offer) => [offer?.price ?? offer?.lowPrice, offer?.priceCurrency]),
    [meta('product:price:amount', 'og:price:amount', 'price'), meta('product:price:currency', 'og:price:currency', 'priceCurrency')],
  ].map(([value, currency]) => rubles(value, typeof currency === 'string' ? currency : '')).filter(Number.isFinite);
  const chosen = shown || (statePrice?.price != null ? statePrice : { price: metaPrices[0] ?? null, oldPrice: null });
  const price = chosen.price;
  const oldPrice = price !== null && chosen.oldPrice > price ? chosen.oldPrice : null;
  // Цена Ozon без скидки банка («С другими банками») — для справки; на телефоне Ozon её не показывает
  const noCard = webPrice?.cardPrice ? rubles(webPrice.price, '') : null;
  const priceNoCard = price !== null && noCard > price && (oldPrice === null || noCard < oldPrice) ? noCard : null;

  // Рейтинг и число отзывов: ld+json, состояние виджета Ozon, затем текст «4.8 • 2 778 отзывов» / «4.8 (7.6K)»
  const ratingOf = (value) => {
    const raw = String(value ?? '').trim();
    const number = Number(raw.replace(',', '.'));
    return /^\d(?:[.,]\d+)?$/.test(raw) && number > 0 && number <= 5 ? Math.round(number * 10) / 10 : null;
  };
  const countOf = (value) => {
    const match = String(value ?? '').replace(/\s/g, '').match(/^(\d+(?:[.,]\d+)?)(тыс\.?|k|к|млн)?$/i);
    if (!match) return null;
    const number = Number(match[1].replace(',', '.')) * (!match[2] ? 1 : /млн/i.test(match[2]) ? 1e6 : 1e3);
    return Number.isFinite(number) && (match[2] || Number.isInteger(number)) ? Math.round(number) : null;
  };
  const aggregate = product?.aggregateRating || {};
  let rating = ratingOf(aggregate.ratingValue);
  let reviews = countOf(aggregate.reviewCount ?? aggregate.ratingCount);
  const score = ozonState('webReviewProductScore');
  if (rating === null) rating = ratingOf(score?.totalScore);
  if (reviews === null) reviews = countOf(score?.reviewsCount);
  const ratingBox = Array.from(document.querySelectorAll(ozon
    ? '[data-widget="webSingleProductScore"], [data-widget="ugcCounters"], [data-widget="webReviewProductScore"]'
    : market ? '[data-zone-name="rating"], [data-auto="product-rating"], [data-auto="rating-badge"]'
      : '[class*="rating" i], [class*="review" i]')).find((node) => /\d/.test(textOf(node)));
  const ratingText = textOf(ratingBox).replace(/\s+/g, ' ');
  if (rating === null) rating = ratingOf(ratingText.match(/(?:^|[\s(])([0-5][.,]\d)(?=$|[\s•·/)])/)?.[1]);
  if (reviews === null) {
    // Тысячи в отзывах пишут через пробел: «2 778». Число не должно начинаться внутри рейтинга:
    // в «4.9 756 отзывов» иначе получалось 9 756
    const count = '(?<![\\d.,])(\\d{1,3}(?:\\s\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(тыс\\.?|k|к|млн)?';
    const found = ratingText.match(new RegExp(count + '\\s*(?:отзыв|оцен)', 'i')) ||
      ratingText.match(new RegExp('\\(' + count + '\\)', 'i'));
    if (found) reviews = countOf(found[1] + (found[2] || ''));
  }
  // Тексты отзывов есть только в ld+json (у Маркета); на странице они подгружаются при прокрутке
  let reviewsTop = [].concat(product?.review || []).flatMap((review) => {
    const body = clean(review?.reviewBody ?? review?.description, 300);
    if (!body) return [];
    const item = { text: body };
    const stars = ratingOf(review?.reviewRating?.ratingValue);
    const author = clean(typeof review?.author === 'string' ? review.author : review?.author?.name, 60);
    if (stars !== null) item.rating = stars;
    if (author) item.author = author;
    return [item];
  }).slice(0, 3);

  // Описание: ld+json и meta (кроме рекламных «купить в интернет-магазине…»), затем блок описания на странице
  const advert = /(?:купить|покупайте)[^.]{0,120}(?:интернет-магазин|на ozon|маркете|aliexpress|по выгодн)/i;
  const descriptionBox = document.querySelector(ozon
    ? '[data-widget="webDescription"], [data-widget="webMobTextDescription"]'
    : market ? '[data-apiary-widget-name="@card/AboutDescriptionV2"], [data-zone-name="description"]'
      : '#product-description, [class*="ProductDescription" i], [class*="product-description" i]');
  const pageDescription = textOf(descriptionBox).split('\n').map((line) => line.trim())
    .filter((line, index) => line && !(index < 2 && /^описание$/i.test(line)) &&
      !/^(?:показать|читать|свернуть|развернуть)(?: полностью)?$/i.test(line))
    .join(' ');
  let description = [product?.description, meta('og:description', 'description'), pageDescription]
    .map((value) => clean(value, 2000)).find((value) => value.length >= 20 && !advert.test(value)) || '';

  // Характеристики: таблицы dl/dt/dd, строки «название — значение» в блоке характеристик, ld+json additionalProperty
  const specs = [];
  const addSpec = (name, value) => {
    name = clean(name, 120).replace(/\s*:$/, '');
    value = clean(value, 120);
    if (name && value && specs.length < 40 && !/^(?:перейти к|показать|все характеристики|читать)/i.test(value) &&
        !specs.some((spec) => spec.name.toLowerCase() === name.toLowerCase())) specs.push({ name, value });
  };
  const cells = (node) => Array.from(node.children)
    .filter((child) => !/^(?:SCRIPT|NOFRAMES|STYLE|BUTTON|INPUT|DL)$/.test(child.tagName) && textOf(child).trim());
  for (const box of document.querySelectorAll(ozon
    ? '[data-widget="webCharacteristics"], [data-widget="webShortCharacteristics"], [data-widget="webMobShortCharacteristics"]'
    : market ? '[data-apiary-widget-name="@card/AboutFullSpecsListV2"], [data-auto="specs-list-minimal"]'
      : '[class*="specification" i], [class*="characteristic" i]')) {
    for (const row of box.querySelectorAll('dl')) addSpec(textOf(row.querySelector('dt')), textOf(row.querySelector('dd')));
    const rows = Array.from(box.querySelectorAll('*')).filter((node) => node.tagName !== 'DL' && cells(node).length === 2);
    for (const row of rows) {
      if (rows.some((other) => other !== row && row.contains(other))) continue;
      const [name, value] = cells(row);
      addSpec(textOf(name), textOf(value));
    }
  }
  // Характеристики в состояниях Ozon: { name|title, values: [{ text }] } (компьютер) или { title, contentRS: [{ content }] } (телефон)
  const stateSpecs = (state) => {
    const found = [];
    const nodes = [state];
    for (let i = 0; nodes.length && i < 5000; i++) {
      const node = nodes.pop();
      if (!node || typeof node !== 'object') continue;
      const title = node.name ?? node.title;
      const values = Array.isArray(node.values) ? node.values.map((part) => part?.text)
        : Array.isArray(node.contentRS) ? node.contentRS.map((part) => part?.content) : null;
      if (values && title) {
        const name = typeof title === 'string' ? title : [].concat(title?.textRs || []).map((part) => part?.content || '').join('');
        found.push([name, values.filter((part) => typeof part === 'string' && part.trim()).join(', ')]);
      } else nodes.push(...Object.values(node).reverse());
    }
    return found;
  };
  for (const [name, value] of stateSpecs(ozonState('webCharacteristics'))) addSpec(name, value);
  for (const [name, value] of stateSpecs(ozonState('webShortCharacteristics'))) addSpec(name, value);
  for (const property of [].concat(product?.additionalProperty || [])) addSpec(property?.name, property?.value);

  // Варианты (цвет, размер…). Ссылку оставляем, только если она ведёт на товар того же магазина
  const productNumber = (href) => {
    try {
      const link = new URL(href, location.href);
      return link.hostname === url.hostname && productPath.test(link.pathname)
        ? link.pathname.match(/(\d{5,})(?:\.html)?\/?$/)?.[1] ?? null : null;
    } catch { return null; }
  };
  const currentNumber = productNumber(url.href);
  const variantUrl = (href) => {
    if (typeof href !== 'string' || !href || href.startsWith('#')) return null;
    try {
      const link = new URL(href, location.href);
      if (link.protocol !== 'https:' || !productNumber(link.href)) return null;
      link.search = '';
      link.hash = '';
      return link.href.length <= 800 ? link.href : null;
    } catch { return null; }
  };
  const kindName = (label) => {
    const name = clean(label, 60).replace(/:.*$/, '').replace(/^выберите\s+/i, '').trim().slice(0, 40);
    return name ? name[0].toUpperCase() + name.slice(1) : '';
  };
  const variants = [];
  const addGroup = (kind, values) => {
    const seen = new Set();
    const list = values.flatMap((value) => {
      const label = clean(value?.label, 120);
      if (!label || seen.has(label.toLowerCase())) return [];
      seen.add(label.toLowerCase());
      const item = { label };
      if (value.selected) item.selected = true;
      const link = variantUrl(value.url);
      if (link) item.url = link;
      return [item];
    }).slice(0, 30);
    if (list.length && variants.length < 6) variants.push({ kind: kindName(kind) || 'Вариант', values: list });
  };
  // Ozon на компьютере: все варианты есть в состоянии виджета webAspects
  for (const aspect of [].concat(ozonState('webAspects')?.aspects || [])) {
    addGroup(aspect?.aspectName || [].concat(aspect?.descriptionRs || []).map((part) => part?.content || '').join(''),
      [].concat(aspect?.variants || []).map((variant) => ({
        label: variant?.data?.searchableText || [].concat(variant?.data?.textRs || []).map((part) => part?.content || '').join(''),
        selected: variant?.active === true || (!!currentNumber && String(variant?.sku) === currentNumber),
        url: variant?.link,
      })));
  }
  // Маркет: группы фильтров/пикеров; подписи у групп нет — угадываем по характеристикам и виду значений
  if (!variants.length && market) {
    for (const group of document.querySelectorAll('[data-zone-name="filter"]')) {
      const values = Array.from(group.querySelectorAll('[data-zone-name="filterValue"], [data-auto="picker"]')).map((option) => {
        const link = option.matches('a[href]') ? option : option.querySelector('a[href]');
        return {
          label: option.getAttribute('value') || option.getAttribute('title') || link?.getAttribute('aria-label') || textOf(option),
          selected: option.getAttribute('aria-selected') === 'true' || !!option.querySelector('[aria-selected="true"]'),
          url: option.getAttribute('pagehref') || link?.getAttribute('href'),
          image: option.getAttribute('type') === 'image',
        };
      });
      const selected = clean(values.find((value) => value.selected)?.label, 120).toLowerCase();
      const spec = selected && specs.find((item) => item.value.toLowerCase() === selected);
      const kind = spec ? spec.name
        : values.length && values.every((value) => /^(?:\d{2,3}(?:[-–]\d{2,3})?|[2-6]?X{0,3}[SML]|XXS)(?:\s|$)/i.test(clean(value.label, 40))) ? 'Размер'
          : values.some((value) => value.image) ? 'Цвет' : 'Вариант';
      addGroup(kind, values);
    }
  }
  // Ozon на телефоне и AliExpress: варианты в разметке; подпись группы — её текст вне самих вариантов
  const aspectsBox = !variants.length && (ozon || ali) && document.querySelector(ozon
    ? '[data-widget="webAspects"], [data-widget="webMobAspects"]'
    : '[class*="sku-property" i], [class*="SkuProperty" i]');
  if (aspectsBox) {
    const optionSelector = 'a[href], [title]';
    const options = Array.from(aspectsBox.querySelectorAll(optionSelector)).filter((option) => {
      const outer = option.parentElement?.closest(optionSelector);
      return !option.closest('button') && !(outer && aspectsBox.contains(outer));
    });
    const ownText = (node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let own = '';
      for (let part = walker.nextNode(); part; part = walker.nextNode()) {
        const inside = part.parentElement?.closest(optionSelector + ', button');
        if (!inside || !node.contains(inside) || inside === node) own += part.textContent + '\n';
      }
      return own.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    };
    const groups = new Map();
    for (const option of options) {
      let box = option.parentElement;
      while (box && box !== aspectsBox && !ownText(box).length) box = box.parentElement;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push(option);
    }
    for (const [box, members] of groups) {
      const lines = ownText(box);
      // «Цвет: белый» бывает одной строкой, а бывает двумя («Цвет:» и «белый»)
      const current = lines[0]?.includes(':')
        ? clean(lines[0].split(':').slice(1).join(':'), 120) || clean(lines[1], 120) : '';
      const values = members.map((option) => {
        const href = option.getAttribute('href');
        const selected = !href || option.getAttribute('aria-selected') === 'true' ||
          (!!currentNumber && productNumber(href) === currentNumber);
        return {
          label: option.getAttribute('title') || option.getAttribute('aria-label') || textOf(option).trim() || (selected ? current : ''),
          selected,
          url: href,
        };
      });
      if (!values.some((value) => value.label) && current) values.push({ label: current, selected: true });
      addGroup(lines[0] || '', values);
    }
  }
  // ld+json: варианты товара (hasVariant) или цвет и размер самого товара
  if (!variants.length) {
    const offers = [].concat(product?.hasVariant || []);
    for (const key of ['color', 'size']) {
      const values = offers.map((item) => ({
        label: item?.[key], url: item?.url, selected: !!currentNumber && productNumber(item?.url) === currentNumber,
      }));
      if (!values.length && typeof product?.[key] === 'string') values.push({ label: product[key], selected: true });
      addGroup(key === 'color' ? 'Цвет' : 'Размер', values);
    }
  }

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

  // Полные описание, характеристики и отзывы магазины показывают только после прокрутки, а приложение
  // читает страницу в скрытом окне. Поэтому первый вызов запускает запросы к тому же сайту (с куками
  // покупателя) и кладёт результат в window.__vmesteExtra, а следующие опросы (каждые ~0,8 с) его забирают.
  // Пока запросы идут, complete = false, но не дольше 3 с: цену, название и фото это не задерживает надолго.
  const htmlText = (html) => (typeof html === 'string' && html
    ? new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/(?:p|div|li|h\d)>/gi, '\n'), 'text/html').body.textContent
      .replace(/ㅤ/g, ' ')
    : '');
  // Данные виджетов Маркета: <noframes data-apiary="patch">{"widgets":{"@card/…":{"<id>":{…}}}}</noframes>
  const patchData = (root) => Array.from(root?.querySelectorAll?.('noframes') || []).flatMap((node) => {
    try {
      return Object.entries(JSON.parse(node.textContent)?.widgets || {})
        .flatMap(([name, byId]) => Object.values(byId || {}).map((data) => ({ name, data })));
    } catch { return []; }
  });
  // Состояния виджетов Ozon из разметки (<div id="state-webCharacteristics-…" data-state="…">) — пары [имя, данные]
  const statesOf = (root) => Array.from(root?.querySelectorAll?.('[id^="state-"][data-state]') || []).flatMap((node) => {
    try { return [[node.id.match(/^state-([A-Za-z]+)/)?.[1] || '', JSON.parse(node.getAttribute('data-state'))]]; } catch { return []; }
  });
  const fetchText = async (path, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(path, { credentials: 'include', headers, signal: controller.signal });
      return response.ok ? await response.text() : '';
    } catch { return ''; } finally { clearTimeout(timer); }
  };
  const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');
  // Текст описания из состояния Ozon: пары «заголовок: текст» и строки text/content, без служебных полей
  const stateText = (node, parts = [], depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 14 || parts.length > 300) return parts;
    if (typeof node.title === 'string' && typeof node.content === 'string') {
      if (!/^маркировка$/i.test(node.title.trim())) parts.push(node.title + ': ' + htmlText(node.content));
      return parts;
    }
    for (const [key, value] of Object.entries(node)) {
      if (/^(?:trackingInfo|lexemes|params|img|imgLink|images?|video\w*|src\w*|link|action|common|testInfo)$/i.test(key)) continue;
      if (typeof value === 'string') {
        if (/^(?:text|content|title|richAnnotation|description)$/i.test(key)) parts.push(htmlText(value));
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        if (/^(?:text|content)$/i.test(key)) parts.push(...value.map(htmlText));
      } else stateText(value, parts, depth + 1);
    }
    return parts;
  };
  const ozonReview = (review) => {
    const body = review?.content || {};
    const mobile = [].concat(review?.reviewBody?.content || []);
    return {
      text: [body.comment, body.positive, body.negative, ...mobile.map((part) => part?.comment?.text ?? part?.text)]
        .find((value) => typeof value === 'string' && value.trim()),
      rating: body.score ?? review?.reviewHeader?.rating?.value,
      author: [review?.author?.firstName, review?.author?.lastName].filter(Boolean).join(' ') ||
        review?.reviewHeader?.author?.centerBlock?.title?.text || review?.reviewHeader?.title?.text,
    };
  };
  const loadOzon = async () => {
    const api = (path) => fetchText('/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(path), { Accept: 'application/json' })
      .then((body) => {
        try {
          return Object.entries(JSON.parse(body)?.widgetStates || {}).flatMap(([key, value]) => {
            try { return [[key.match(/^[A-Za-z]+/)?.[0] || '', JSON.parse(value)]]; } catch { return []; }
          });
        } catch { return []; }
      });
    // Вторая часть страницы (описание, все характеристики) — по ссылке из виджета paginator, обычной страницей:
    // запрос к API за ней Ozon отклоняет
    const next = ozonState('paginator')?.nextPage;
    const base = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
    const parts = await Promise.all([
      typeof next === 'string' && /^\/product\//.test(next) ? fetchText(next).then((html) => statesOf(parseHtml(html))) : [],
      /^\/product\//.test(base) ? api(base + 'features/') : [],
      /^\/product\//.test(base) ? api(base + 'reviews/') : [],
    ]);
    const states = parts.flat();
    return {
      description: states.filter(([name]) => /Description|RichContent|LongCharacteristics/.test(name))
        .flatMap(([, state]) => stateText(state)).join(' '),
      specs: states.filter(([name]) => /Characteristics/.test(name) && !/Long/.test(name)).flatMap(([, state]) => stateSpecs(state)),
      reviews: states.filter(([name]) => /ListReviews/.test(name)).flatMap(([, state]) => [].concat(state?.reviews || [])).map(ozonReview),
    };
  };
  const marketSpecs = (data) => data.filter((item) => item.name === '@card/SpecsList')
    .flatMap(({ data: list }) => [...[].concat(list?.specs || []), ...[].concat(list?.groups || []).flatMap((group) => [].concat(group?.items || []))])
    .map((item) => [item?.name, item?.value]);
  const loadMarket = async () => {
    // Страница «Характеристики» (/card/<slug>/<id>/spec) отдаёт все характеристики и описание сразу в разметке
    const data = patchData(parseHtml(await fetchText(url.pathname.replace(/\/$/, '') + '/spec' + location.search)));
    return {
      description: htmlText(data.find((item) => item.name === '@product-page-support/Description')?.data?.description),
      specs: marketSpecs(data),
      reviews: [],
    };
  };
  let extra = window.__vmesteExtra;
  if (!extra || extra.url !== url.href) {
    extra = window.__vmesteExtra = { url: url.href, started: Date.now(), done: !ozon && !market, data: null };
    if (!extra.done) {
      const own = extra;
      (ozon ? loadOzon() : loadMarket()).then((data) => { own.data = data; }, () => {}).finally(() => { own.done = true; });
    }
  }
  const extraWaiting = !extra.done && Date.now() - extra.started < 3000;

  // Маркет кладёт описание и часть характеристик в разметку заранее, но рисует их при прокрутке:
  // данные виджетов лежат и в самой странице, и в <template id="second-screen">
  if (market) {
    const roots = [document, ...Array.from(document.querySelectorAll('template')).map((template) => template.content)];
    const data = roots.flatMap(patchData);
    if (!description) {
      description = [htmlText(data.find((item) => item.name === '@card/AboutDescriptionV2')?.data?.shortDescription)]
        .map((value) => clean(value, 2000)).find((value) => value.length >= 20 && !advert.test(value)) || '';
    }
    for (const { name, data: spec } of data) if (name === '@card/AboutSpecV2') addSpec(spec?.name, spec?.value);
    for (const [name, value] of marketSpecs(data)) addSpec(name, value);
  }
  if (extra.data) {
    if (!description) {
      description = [extra.data.description].map((value) => clean(value, 2000))
        .find((value) => value.length >= 20 && !advert.test(value)) || '';
    }
    for (const [name, value] of extra.data.specs || []) addSpec(name, value);
  }
  // Отзывы Ozon: из запроса выше, иначе закреплённый отзыв со страницы
  if (ozon && !reviewsTop.length) {
    reviewsTop = [...(extra.data?.reviews || []), ozonReview(ozonState('pinnedReview'))].flatMap((review) => {
      const body = clean(review?.text, 300);
      if (!body) return [];
      const item = { text: body };
      const stars = ratingOf(review.rating);
      const author = clean(review.author, 60);
      if (stars !== null) item.rating = stars;
      if (author) item.author = author;
      return [item];
    }).filter((item, index, list) => list.findIndex((other) => other.text === item.text) === index).slice(0, 3);
  }

  const result = {
    status: 'ok',
    complete: !!title && price !== null && images.length > 0 && !extraWaiting,
    url: url.href,
    title,
    price,
    images,
  };
  // Необязательные поля добавляем, только когда они нашлись
  if (oldPrice !== null) result.oldPrice = oldPrice;
  if (priceNoCard !== null) result.priceNoCard = priceNoCard;
  if (rating !== null) result.rating = rating;
  if (reviews !== null) result.reviews = reviews;
  if (reviewsTop.length) result.reviewsTop = reviewsTop;
  if (description) result.description = description;
  if (specs.length) result.specs = specs;
  if (variants.length) result.variants = variants;
  return result;
}
