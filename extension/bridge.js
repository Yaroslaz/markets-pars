// Выполняется в контексте страницы сайта «Выбираем вместе» до его скриптов.
// Даёт сайту тот же объект MarketsNative, что и приложение для Android, — сайт не отличает одно от другого.
// Сообщения уходят в relay.js (контекст расширения) через window.postMessage.
(() => {
  if (window.MarketsNative) return;
  const listeners = new Set();
  const port = {
    onmessage: null,
    postMessage(data) {
      window.postMessage({ __vmesteExt: 'to-ext', data: String(data) }, location.origin);
    },
    addEventListener(type, fn) {
      if (type === 'message' && typeof fn === 'function') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.delete(fn);
    },
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.__vmesteExt !== 'from-ext') return;
    const event = { data: e.data.data };
    try { port.onmessage?.(event); } catch (err) { console.error(err); }
    for (const fn of listeners) {
      try { fn(event); } catch (err) { console.error(err); }
    }
  });
  Object.defineProperty(window, 'MarketsNative', { value: port, configurable: false, writable: false });
})();
