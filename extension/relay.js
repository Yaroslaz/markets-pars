// Контекст расширения на странице сайта: передаёт просьбы «прочитай товар» из bridge.js в background.js и ответы обратно.
// Для каждой просьбы — отдельный порт: пока он открыт, браузер не усыпляет фоновый скрипт (проверка магазина может идти минуты).
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.__vmesteExt !== 'to-ext') return;
  let msg;
  try {
    msg = JSON.parse(e.data.data);
  } catch {
    return;
  }
  if (msg?.type !== 'read' || typeof msg.url !== 'string') return; // сообщения о теме и т. п. расширению не нужны
  const reply = (body) => window.postMessage({ __vmesteExt: 'from-ext', data: JSON.stringify({ id: msg.id, ...body }) }, location.origin);
  let answered = false;
  let port;
  try {
    port = chrome.runtime.connect({ name: 'read' });
  } catch {
    reply({ ok: false, error: 'extension-reloaded' });
    return;
  }
  port.onMessage.addListener((result) => {
    answered = true;
    reply(result);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {
    if (!answered) reply({ ok: false, error: 'disconnected' });
  });
  port.postMessage({ url: msg.url });
});
