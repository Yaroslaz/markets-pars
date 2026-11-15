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

    private WebView site;
    private ProductReader reader;
    private Uri siteUri;
    private ValueCallback<Uri[]> fileCallback;
    /** Размеры системных панелей в CSS-пикселях: сверху, снизу, слева, справа. */
    private float[] safeArea;
    private boolean themeDark;
    /** Тёмный слой на сайте (галерея) переопределяет цвет значков панелей; null — как у темы. */
    private Boolean barsDark;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        siteUri = Uri.parse(getString(R.string.site_url));

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
                        else reader.handle(data, reply);
                    });
        }

        // Android 13+ (и обязательно с targetSdk 36) не вызывает onBackPressed — регистрируем обработчик «Назад» явно
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        String shared = sharedText(getIntent());
        if (savedInstanceState == null || shared != null) site.loadUrl(siteUrl(shared));
        else site.restoreState(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String shared = sharedText(intent);
        if (shared != null) {
            reader.cancelAll();
            site.loadUrl(siteUrl(shared));
        }
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
            reader.cancelCurrent();
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
                "(function(s){s.setProperty('--native-safe-t','%.1fpx');s.setProperty('--native-safe-b','%.1fpx');"
                        + "s.setProperty('--native-safe-l','%.1fpx');s.setProperty('--native-safe-r','%.1fpx')})"
                        + "(document.documentElement.style)",
                safeArea[0], safeArea[1], safeArea[2], safeArea[3]);
        site.evaluateJavascript(js, null);
    }
}
