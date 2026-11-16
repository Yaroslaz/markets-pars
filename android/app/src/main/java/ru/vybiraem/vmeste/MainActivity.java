package ru.vybiraem.vmeste;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;

/**
 * Показывает сайт «Выбираем вместе» и даёт ему объект MarketsNative.
 * Через него сайт просит прочитать страницу товара: {@link ProductReader} грузит её в скрытом
 * браузере телефона (IP и cookies телефона), поэтому магазины не отсекают запрос как серверный.
 */
public class MainActivity extends Activity {
    private static final int FILE_REQUEST = 1;
    private static final int NOTIFY_REQUEST = 2;
    /** Приложение на экране: фоновая проверка тогда не показывает уведомления — сайт и так всё показывает. */
    static volatile boolean visible;

    private WebView site;
    private ProductReader reader;
    private Uri siteUri;
    private ValueCallback<Uri[]> fileCallback;
    /** Размеры системных панелей в CSS-пикселях: сверху, снизу, слева, справа. */
    private float[] safeArea;
    private boolean themeDark;
    /** Тёмный слой на сайте (галерея) переопределяет цвет значков панелей; null — как у темы. */
    private Boolean barsDark;
    /** Ответ сайту на просьбу разрешить уведомления: придёт после системного диалога. */
    private JavaScriptReplyProxy permissionReply;
    private int permissionId;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        siteUri = Uri.parse(getString(R.string.site_url));
        // Обход блокировок (прокси для AliExpress и сервера) — до того, как WebView начнут грузить страницы
        NetBypass.apply(this, null);

        FrameLayout root = new FrameLayout(this);
        // Скрытый браузер лежит под сайтом: он «видим» для системы и нормально выполняет JS страницы,
        // но пользователь его не замечает, пока не понадобится пройти проверку магазина.
        reader = new ProductReader(this, root);
        site = new WebView(this);
        root.addView(site, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        reader.setCover(site);
        applyInsets(root);
        setContentView(root);

        CookieManager.getInstance().setAcceptCookie(true);
        WebSettings s = site.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        site.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri url = request.getUrl();
                if (isSite(url)) return false;
                openOutside(url);
                return true;
            }

            // У новой страницы своих CSS-переменных ещё нет — передаём размеры панелей заново
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                barsDark = null;
                pushSafeArea();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pushSafeArea();
            }
        });
        site.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Объект появляется только на страницах нашего сайта и только в главном фрейме
            String origin = siteUri.getScheme() + "://" + siteUri.getAuthority();
            WebViewCompat.addWebMessageListener(site, "MarketsNative", Collections.singleton(origin),
                    (view, message, sourceOrigin, isMainFrame, reply) -> {
                        String data = message.getData();
                        if (!isMainFrame || data == null) return;
                        if (data.startsWith("{\"type\":\"theme\"") || data.startsWith("{\"type\":\"bars\"")) onLookMessage(data);
                        else if (data.startsWith("{\"type\":\"clipboard\"")) reply.postMessage(clipboardReply(data));
                        else if (data.startsWith("{\"type\":\"notify-")) onNotifyMessage(data, reply);
                        else if (data.startsWith("{\"type\":\"bypass")) NetBypass.handle(this, data, reply);
                        else reader.handle(data, reply);
                    });
        }

        // Android 13+ (и обязательно с targetSdk 36) не вызывает onBackPressed — регистрируем обработчик «Назад» явно
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        String shared = sharedText(getIntent());
        String card = cardUrl(getIntent());
        if (card != null) site.loadUrl(card);
        else if (savedInstanceState == null || shared != null) site.loadUrl(siteUrl(shared));
        else site.restoreState(savedInstanceState);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        // Пока приложение открыто, новое видно на сайте: проверка только отмечает события как увиденные
        Notifier.schedule(this);
        Notifier.checkSoon(this, true);
    }

    @Override
    protected void onStop() {
        visible = false;
        // Ушли в фон: всё, что было до этого момента, человек уже видел; дальше — уведомления
        Notifier.checkSoon(this, true);
        super.onStop();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String shared = sharedText(intent);
        if (shared != null) {
            reader.cancelAll();
            site.loadUrl(siteUrl(shared));
            return;
        }
        String card = cardUrl(intent);
        if (card != null) {
            // Нажали уведомление: открытый сайт сам переключит подборку и откроет карточку, иначе — загрузка по адресу
            String board = intent.getStringExtra(Notifier.EXTRA_BOARD);
            String id = intent.getStringExtra(Notifier.EXTRA_CARD);
            String js = "(function(){try{return !!(window.mpOpenCard&&window.mpOpenCard(" + org.json.JSONObject.quote(board == null ? "" : board)
                    + "," + org.json.JSONObject.quote(id == null ? "" : id) + "))}catch(e){return false}})()";
            reader.cancelCurrent();
            site.evaluateJavascript(js, opened -> {
                if (!"true".equals(opened)) site.loadUrl(card);
            });
        }
    }

    /** Адрес сайта для нажатого уведомления: ?b=<подборка>#card=<карточка>. */
    private String cardUrl(Intent intent) {
        if (intent == null || !Notifier.ACTION_OPEN.equals(intent.getAction())) return null;
        String board = intent.getStringExtra(Notifier.EXTRA_BOARD);
        String card = intent.getStringExtra(Notifier.EXTRA_CARD);
        Uri.Builder b = siteUri.buildUpon();
        if (board != null && board.matches("[\\w-]{1,40}")) b.appendQueryParameter("b", board);
        if (card != null && card.matches("[\\w-]{1,40}")) b.encodedFragment("card=" + card);
        return b.build().toString();
    }

    /**
     * Уведомления: сайт сообщает настройки и просит разрешение.
     * notify-hello — есть ли уведомления в приложении; notify-config — сервер, вход, роль, настройки;
     * notify-permission — запросить разрешение (Android 13+); notify-settings — открыть настройки уведомлений.
     */
    private void onNotifyMessage(String data, JavaScriptReplyProxy reply) {
        org.json.JSONObject msg;
        try {
            msg = new org.json.JSONObject(data);
        } catch (org.json.JSONException e) {
            return;
        }
        int id = msg.optInt("id");
        switch (msg.optString("type")) {
            case "notify-config":
                Notifier.saveConfig(this, msg);
                Notifier.ensureChannels(this);
                Notifier.checkSoon(this, true);
                reply.postMessage(notifyReply(id));
                break;
            case "notify-permission":
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    if (permissionReply != null) permissionReply.postMessage(notifyReply(permissionId));
                    permissionReply = reply;
                    permissionId = id;
                    requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, NOTIFY_REQUEST);
                } else {
                    reply.postMessage(notifyReply(id));
                }
                break;
            case "notify-settings":
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                } catch (ActivityNotFoundException ignored) {
                }
                reply.postMessage(notifyReply(id));
                break;
            default: // notify-hello
                reply.postMessage(notifyReply(id));
        }
    }

    private String notifyReply(int id) {
        android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class);
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            out.put("id", id).put("ok", true).put("granted", nm != null && nm.areNotificationsEnabled());
        } catch (org.json.JSONException ignored) {
        }
        return out.toString();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFY_REQUEST || permissionReply == null) return;
        permissionReply.postMessage(notifyReply(permissionId));
        permissionReply = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        site.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        reader.destroy();
        site.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    /**
     * «Назад» отменяет последний шаг: закрывает проверку магазина, затем то, что открыто на сайте
     * (карточку, галерею, окно, режим выбора — сайт отвечает через window.mpHandleBack).
     * Только когда закрывать нечего, приложение уходит в фон, сохраняя состояние.
     */
    private void handleBack() {
        if (reader.isShowing()) {
            reader.cancelAll();
            return;
        }
        site.evaluateJavascript(
                "(function(){try{return !!(window.mpHandleBack&&window.mpHandleBack())}catch(e){return false}})()",
                handled -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST || fileCallback == null) return;
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
    }

    /** Текст из «Поделиться»: сайт сам найдёт в нём ссылки (так же, как PWA share target). */
    private static String sharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        String joined = ((subject != null ? subject + " " : "") + (text != null ? text : "")).trim();
        return joined.isEmpty() ? null : joined;
    }

    private String siteUrl(String shared) {
        if (shared == null) return siteUri.toString();
        return siteUri.buildUpon().clearQuery().appendQueryParameter("text", shared).build().toString();
    }

    private boolean isSite(Uri url) {
        String path = url.getPath() == null ? "/" : url.getPath();
        String base = siteUri.getPath() == null ? "/" : siteUri.getPath();
        return siteUri.getScheme().equals(url.getScheme()) && siteUri.getAuthority().equals(url.getAuthority())
                && path.startsWith(base);
    }

    /** Ссылки на товары, Telegram и т. п. открываются в приложениях телефона, а не внутри сайта. */
    private void openOutside(Uri url) {
        String scheme = url.getScheme();
        if (scheme == null) return;
        try {
            Intent intent = "intent".equals(scheme)
                    ? Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME)
                    : new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Текст из буфера обмена для кнопки «Вставить» на сайте: WebView не даёт странице читать буфер,
     * а приложению на экране Android это разрешает.
     */
    private String clipboardReply(String message) {
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            out.put("id", new org.json.JSONObject(message).optInt("id"));
            android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            android.content.ClipData clip = cm != null ? cm.getPrimaryClip() : null;
            CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(this) : null;
            out.put("ok", text != null);
            if (text != null) out.put("text", text.toString().substring(0, Math.min(text.length(), 20000)));
        } catch (Exception e) {
            try {
                out.put("ok", false);
            } catch (org.json.JSONException ignored) {
            }
        }
        return out.toString();
    }

    /** Сообщения сайта о внешнем виде: {"type":"theme","dark":…} — тема, {"type":"bars","dark":true|null} — тёмный слой (галерея). */
    private void onLookMessage(String data) {
        boolean dark = data.contains("\"dark\":true");
        if (data.startsWith("{\"type\":\"theme\"")) {
            themeDark = dark;
            View root = (View) site.getParent();
            root.setBackgroundColor(dark ? 0xFF0F0F12 : 0xFFF3F3F6);
            getWindow().getDecorView().setBackgroundColor(dark ? 0xFF0F0F12 : 0xFFF3F3F6);
        } else {
            barsDark = data.contains("\"dark\":null") ? null : dark;
        }
        applyBarIcons(barsDark != null ? barsDark : themeDark);
    }

    /** Светлые значки статус-бара и навигации на тёмном фоне, тёмные — на светлом. */
    @SuppressWarnings("deprecation")
    private void applyBarIcons(boolean dark) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            View decor = getWindow().getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int ui = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(dark ? ui & ~flags : ui | flags);
        }
    }

    /**
     * Сайт рисуется во весь экран, под статус-баром и панелью навигации (иначе над тёмной галереей видны
     * светлые полосы). Размеры панелей передаём странице CSS-переменными --native-safe-*, а сайт сам
     * отодвигает от них шапку и нижнюю панель. Отступ от клавиатуры по-прежнему делаем здесь.
     */
    private void applyInsets(View root) {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right, keyboard;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top;
                bottom = bars.bottom;
                left = bars.left;
                right = bars.right;
                keyboard = ime.bottom;
            } else {
                @SuppressWarnings("deprecation")
                int t = insets.getSystemWindowInsetTop(), b = insets.getSystemWindowInsetBottom(),
                        l = insets.getSystemWindowInsetLeft(), r = insets.getSystemWindowInsetRight();
                top = t;
                left = l;
                right = r;
                // до Android 11 клавиатуру и панель навигации не различить: большая нижняя вставка — это клавиатура
                boolean ime = b > 200 * getResources().getDisplayMetrics().density;
                bottom = ime ? 0 : b;
                keyboard = ime ? b : 0;
            }
            // С открытой клавиатурой сайт сжимается над ней, а нижний отступ странице уже не нужен
            v.setPadding(0, 0, 0, keyboard);
            float density = getResources().getDisplayMetrics().density;
            safeArea = new float[] { top / density, keyboard > 0 ? 0 : bottom / density, left / density, right / density };
            pushSafeArea();
            reader.setInsets(top, keyboard > 0 ? keyboard : bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private void pushSafeArea() {
        if (safeArea == null) return;
        String js = String.format(java.util.Locale.ROOT,
                // В самом начале загрузки документа ещё нет — тогда переменные выставит onPageFinished
                "(function(e){if(!e)return;var s=e.style;s.setProperty('--native-safe-t','%.1fpx');s.setProperty('--native-safe-b','%.1fpx');"
                        + "s.setProperty('--native-safe-l','%.1fpx');s.setProperty('--native-safe-r','%.1fpx')})"
                        + "(document.documentElement)",
                safeArea[0], safeArea[1], safeArea[2], safeArea[3]);
        site.evaluateJavascript(js, null);
    }
}
