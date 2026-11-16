'use strict';

// Встраивается во все рамки страниц магазинов, но работает только в одной — в той, что background.js
// открыл в невидимом документе расширения (offscreen.html). Там каждые 0,8 с читает страницу функцией
// readOpenProduct (product-import.js) и отправляет результат в background.js, пока тот не ответит «хватит».
// В обычных вкладках покупателя и в рамках на чужих страницах сразу выходит.
(() => {
  if (window.top === window) return;
  // Рамка должна лежать прямо в странице этого расширения (в Firefox ancestorOrigins нет — там рамка не используется)
  const origins = location.ancestorOrigins;
  if (!origins || origins.length !== 1 || origins[0] + '/' !== chrome.runtime.getURL('')) return;
  // Имя рамки, которое дал offscreen.js, запоминаем до скриптов страницы: они могут его поменять
  const name = window.name;

  let parsed = document.readyState !== 'loading';
  const tick = async () => {
    let result;
    try {
      // Пока разметка не разобрана, страницу не читаем (иначе догрузка описания начнётся раньше времени),
      // но о странице проверки по её адресу сообщаем сразу: она может грузиться долго
      result = parsed ? readOpenProduct()
        : { status: /showcaptcha|\/captcha|\/punish|_____tmd_____/i.test(location.pathname + location.search) ? 'blocked' : 'wait' };
    } catch {
      result = { status: 'wait' };
    }
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'frame-read', frame: name, href: location.href, result });
    } catch {
      return; // расширение перезагрузили
    }
    if (!reply?.stop) setTimeout(tick, 800);
  };
  if (!parsed) document.addEventListener('DOMContentLoaded', () => (parsed = true), { once: true });
  setTimeout(tick, 300);
})();
