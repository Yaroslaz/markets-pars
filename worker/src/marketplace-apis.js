const ALI_METHOD = 'aliexpress.affiliate.productdetail.get';

async function fetchCatalogJson(provider, url, options) {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      if (response.status !== 404) console.warn(`${provider} returned HTTP ${response.status}`);
      await response.body?.cancel();
      return null;
    }
    return await response.json();
  } catch {
    console.warn(`${provider}: could not load product data`);
    return null;
  }
}

export async function fetchOzonProduct(id, env) {
  if (!env.MPSTATS_API_TOKEN) return null;
  const item = await fetchCatalogJson('MPSTATS', `https://mpstats.io/api/analytics/v1/oz/items/${id}/full`, {
    headers: { 'X-Mpstats-TOKEN': env.MPSTATS_API_TOKEN, Accept: 'application/json' },
  });
  if (String(item?.id) !== id || typeof item.name !== 'string' || !item.name.trim()) return null;

  const photos = Array.isArray(item.photo?.list) ? item.photo.list : [];
  const images = imageUrls(photos.map((photo) => photo?.f));
  const thumbnails = new Map(photos.map((photo) => [photo?.f, imageUrls([photo?.m, photo?.t])[0]]));
  const current = positiveNumber(item.price?.final_price);
  const original = positiveNumber(item.price?.price);
  return {
    title: item.name.trim(),
    brand: item.brand || null,
    price: current == null ? null : current / 100,
    oldPrice: current != null && original > current ? original / 100 : null,
    priceNote: current == null ? null : 'по данным MPSTATS',
    rating: positiveNumber(item.rating),
    reviews: number(item.comments),
    images,
    thumbs: images.map((url) => thumbnails.get(url) || url),
    partial: !images.length || current == null,
  };
}

export async function fetchAliProduct(id, env) {
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET) return null;
  const params = new URLSearchParams({
    app_key: env.ALIEXPRESS_APP_KEY,
    method: ALI_METHOD,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
    product_ids: id,
    target_language: 'RU',
    target_currency: 'RUB',
    country: 'RU',
  });
  if (env.ALIEXPRESS_TRACKING_ID) params.set('tracking_id', env.ALIEXPRESS_TRACKING_ID);
  params.sort();
  const message = Array.from(params, ([key, value]) => key + value).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.ALIEXPRESS_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  params.set('sign', Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase());

  const data = await fetchCatalogJson('AliExpress Affiliate API', 'https://api-sg.aliexpress.com/sync', {
    method: 'POST',
    body: params,
  });
  if (data?.error_response) console.warn('AliExpress Affiliate API rejected the product request');
  const result = data?.aliexpress_affiliate_productdetail_get_response?.resp_result;
  const products = result?.result?.products?.product;
  if (Number(result?.resp_code) !== 200 || !Array.isArray(products)) return null;
  const item = products.find((product) => String(product?.product_id) === id);
  if (typeof item?.product_title !== 'string' || !item.product_title.trim()) return null;

  const images = imageUrls([item.product_main_image_url, ...[].concat(item.product_small_image_urls?.string || [])]);
  const price = rublePrice(item.target_sale_price, item.target_sale_price_currency)
    ?? rublePrice(item.sale_price, item.sale_price_currency);
  const original = rublePrice(item.target_original_price, item.target_original_price_currency)
    ?? rublePrice(item.original_price, item.original_price_currency);
  return {
    title: item.product_title.trim(),
    brand: null,
    price,
    oldPrice: price != null && original > price ? original : null,
    priceNote: price == null ? null : 'из партнёрского каталога AliExpress',
    rating: null,
    reviews: null,
    images,
    thumbs: images,
    partial: !images.length || price == null,
  };
}

function imageUrls(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.startsWith('https://')))].slice(0, 30);
}

function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positiveNumber(value) {
  const parsed = number(value);
  return parsed > 0 ? parsed : null;
}

function rublePrice(value, currency) {
  return currency === 'RUB' ? positiveNumber(value) : null;
}
