# Выбираем вместе

Совместные подборки товаров с Ozon, Wildberries, Яндекс Маркета и AliExpress. Вставьте ссылки на товары — появятся карточки с фото, ценой, оценкой, описанием и характеристиками. Двое участников отмечают понравившееся сердечком, вкладка «Обоим» показывает совпадения.

Сайт: https://yaroslaz.github.io/markets-pars/

## Из чего состоит

| Папка | Что это |
| --- | --- |
| `docs/` | Сайт для GitHub Pages: HTML, CSS и JS без сборки |
| `worker/` | Сервер на Cloudflare Workers с базой D1: подборки, карточки, лайки |
| `android/` | Приложение для Android: открывает сайт и добавляет товары через «Поделиться» |
| `extension/` | Расширение для Chrome, Яндекс Браузера и Edge |

## Возможности

- Ссылки можно вставлять пачкой и вперемешку с текстом: лишние слова и чужие ссылки отбрасываются, дубли схлопываются.
- Несколько подборок; карточки можно выделить долгим нажатием, перенести в другую подборку или удалить.
- Цена, старая цена, оценка, отзывы, описание, характеристики и варианты товара (цвет, размер), если магазин их показывает.
- Обновление цен и фото — в карточке или сразу для всех товаров без данных.
- Светлая и тёмная тема, работа как приложение на телефоне (PWA).
- Доступ к подборкам по паролю.

Приложение для Android и расширение браузера читают страницы товаров на устройстве пользователя — так карточки получаются полнее и точнее. Без них ссылка всё равно добавляется, а недостающие данные можно дополнить позже.

## Развернуть свой сервер

1. Нажмите кнопку и следуйте шагам Cloudflare (база создастся сама):

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Yaroslaz/markets-pars/tree/main/worker)

2. Задайте пароль через [секрет APP_ACCESS](worker/README.md#вход-в-приложение).
3. Укажите адрес сервера (`https://<имя>.<аккаунт>.workers.dev`) на сайте в «Настройки → Адрес сервера» или в `docs/config.js`.

Вручную:

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

## Приложение для Android

Сборка (нужны JDK 17 и Android SDK, путь к SDK — в `android/local.properties`):

```bash
cd android
./gradlew assembleDebug
```

Готовый файл: `android/app/build/outputs/apk/debug/app-debug.apk`. Скопируйте его на телефон и установите.

## Расширение для браузера

Проще всего — установщиком: [extension/install](extension/install/README.md). Вручную:

1. Скачайте папку `extension`.
2. Откройте `chrome://extensions` (Яндекс Браузер — `browser://extensions`, Edge — `edge://extensions`) и включите «Режим разработчика».
3. Нажмите «Загрузить распакованное расширение» и выберите папку `extension`.

Расширение работает на сайте `https://yaroslaz.github.io/markets-pars/` и на `localhost`. Для другого адреса поменяйте его в `extension/manifest.json` и `extension/background.js`.

## Локальная разработка

```bash
cd worker && npx wrangler dev --port 8787
```

```bash
python -m http.server 5500 --directory docs
```

Откройте `http://localhost:5500/?api=http://127.0.0.1:8787`.

`extension/product-import.js` — копия `docs/product-import.js`; после изменения одного файла скопируйте его во второй.
