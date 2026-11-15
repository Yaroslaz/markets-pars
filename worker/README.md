# Карточки Ozon и AliExpress

Worker раскрывает короткую ссылку, извлекает артикул и запрашивает данные о товаре через серверное API. Если API недоступен или товар отсутствует в каталоге, Worker пробует публичную страницу товара. При блокировке страницы сохраняется неполная карточка со ссылкой.

В Cloudflare откройте настройки Worker `markets-pars` и добавьте значения в **Variables and Secrets** с типом **Secret**. Для локальной проверки задайте эти же значения в `worker/.dev.vars` и храните файл локально.

| Переменная | Значение |
| --- | --- |
| `MPSTATS_API_TOKEN` | Токен MPSTATS с доступом к Analytics API для Ozon. Цены берутся из данных MPSTATS и могут отличаться от цены на сайте. |
| `ALIEXPRESS_APP_KEY` | App Key приложения с доступом к `aliexpress.affiliate.productdetail.get`. |
| `ALIEXPRESS_APP_SECRET` | App Secret того же приложения. |
| `ALIEXPRESS_TRACKING_ID` | Tracking ID программы AliExpress, если он нужен для вашего доступа. |

После публикации обновлённого Worker пришлите короткую или полную ссылку в `POST /api/parse` в поле `url`. Ответ содержит `product`. Для уже сохранённых карточек используйте кнопку обновления. При наличии данных у API Worker заполнит цену в рублях и фотографии. AliExpress Affiliate API охватывает товары своего партнёрского каталога.

[MPSTATS Analytics API для Ozon](https://mpstats.io/integrations/analytics-oz/) · [Получение токена MPSTATS](https://mpstats.io/integrations/docs/description/) · [AliExpress Affiliate API](https://developer.alibaba.com/docs/api.htm?apiId=48595) · [Секреты Cloudflare Workers](https://developers.cloudflare.com/workers/configuration/secrets/)
