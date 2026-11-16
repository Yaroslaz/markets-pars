'use strict';

// Невидимый документ расширения (chrome.offscreen). По просьбе background.js открывает страницу товара
// во встроенной рамке: это обычная загрузка страницы с IP этого браузера, но без окна и без вкладки.
// Для магазина рамка — «чужой сайт»: он получает только cookies, разрешённые для встраивания (SameSite=None),
// поэтому вход в аккаунт там обычно не виден, а цена — как для гостя.
// Читает страницу frame.js — он встраивается в рамку как скрипт расширения и сам шлёт результаты в background.js.

let frame = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'open') {
    frame?.remove();
    frame = document.createElement('iframe');
    // Размер как у окна компьютера: магазин показывает полную версию страницы
    frame.style.cssText = 'width:1280px;height:900px;border:0';
    // По имени рамки background.js отличает её сообщения от сообщений прошлой, уже закрытой рамки
    frame.name = String(msg.name || '');
    frame.src = msg.url;
    document.body.append(frame);
    // Невидимый документ сам ничего не раскладывает, и без этого у страницы в рамке ширина окна — 0
    frame.getBoundingClientRect();
  } else if (msg.type === 'close') {
    frame?.remove();
    frame = null;
  }
});
