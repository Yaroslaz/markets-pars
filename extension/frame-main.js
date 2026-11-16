'use strict';

// Выполняется в контексте самой страницы магазина, но только в невидимой рамке расширения (offscreen.html).
// Невидимый документ не рисуется, поэтому браузер не вызывает requestAnimationFrame, а скрипты магазинов
// откладывают на него отрисовку: без замены часть страниц в рамке так и не дочитывалась.
// Заменяем его обычным таймером ~60 раз в секунду.
(() => {
  if (window.top === window) return;
  const origins = location.ancestorOrigins;
  if (!origins || origins.length !== 1 || !/^chrome-extension:\/\//.test(origins[0])) return;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
})();
