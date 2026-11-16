package ru.vybiraem.vmeste;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.ColorStateList;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.regex.Pattern;

/**
 * Скрытый браузер, который по очереди открывает страницы товаров и читает их скриптом от сайта.
 * Он лежит под сайтом и выходит наверх, только если магазин показывает проверку («я не робот»)
 * или страницу не удалось прочитать сразу. Как только данные прочитаны — снова прячется.
 */
final class ProductReader {
    private static final long FIRST_POLL_MS = 1200;
    private static final long POLL_MS = 700;
    /** Сколько ждём молча, прежде чем показать страницу пользователю. */
    private static final long HIDDEN_LIMIT_MS = 25_000;
    /** Мобильная версия Wildberries во встроенном браузере не загружает карточку товара — открываем компьютерную. */
    private static final Pattern DESKTOP_HOST = Pattern.compile("(^|\\.)(wildberries\\.(ru|by|kz|am|kg|uz)|wb\\.ru)$");
    /** Сколько ждём недостающие цену или фото, когда название уже есть. */
    private static final long PARTIAL_GRACE_MS = 5_000;
    /** Многие проверки (например, Яндекса) проходят сами за секунду-две — столько ждём, прежде чем показать. */
    private static final long BLOCKED_GRACE_MS = 2_500;
    /** Сколько даём на прохождение проверки. */
    private static final long CHECK_LIMIT_MS = 180_000;

    private static final Pattern MARKET_HOST = Pattern.compile(
            "(^|\\.)(ozon\\.(ru|by|kz)|market\\.yandex\\.(ru|by|kz|com)|wildberries\\.(ru|by|kz|am|kg|uz)|wb\\.ru"
                    + "|aliexpress\\.(ru|com|us)|aliclick\\.shop|ali\\.click)$|^(ya\\.cc|ozon\\.onelink\\.me)$");

    private static final class Job {
        final int id;
        final String url;
        final String script;
        final JavaScriptReplyProxy reply;
        long started;
        long shownAt;
        long partialAt;
        long blockedAt;
        /** Браузер уже начал грузить страницу этого задания — до этого в нём ещё прошлый товар. */
        boolean navigated;
        JSONObject partial;

        Job(int id, String url, String script, JavaScriptReplyProxy reply) {
            this.id = id;
            this.url = url;
            this.script = script;
            this.reply = reply;
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<Job> queue = new ArrayDeque<>();
    private final LinearLayout layer;
    private final WebView browser;
    private final TextView hint;
    private View cover;
    private Job current;
    private boolean showing;
    private final String mobileUserAgent;
    private final String desktopUserAgent;

    @SuppressLint("SetJavaScriptEnabled")
    ProductReader(Activity activity, FrameLayout root) {
        layer = new LinearLayout(activity);
        layer.setOrientation(LinearLayout.VERTICAL);
        layer.setBackgroundColor(activity.getColor(R.color.page));

        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(activity.getColor(R.color.bar));
        int pad = dp(activity, 12);
        bar.setPadding(pad, pad, pad / 2, pad);
        hint = new TextView(activity);
        hint.setTextColor(activity.getColor(R.color.page_text));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        bar.addView(hint, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button cancel = new Button(activity, null, android.R.attr.borderlessButtonStyle);
        cancel.setText(R.string.check_cancel);
        cancel.setTextColor(ColorStateList.valueOf(activity.getColor(R.color.page_text)));
        cancel.setOnClickListener(v -> cancelAll());
        bar.addView(cancel, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        layer.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        browser = new WebView(activity);
        layer.addView(browser, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(layer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = browser.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // Для магазина это обычный мобильный Chrome, а не встроенный браузер приложения
        mobileUserAgent = s.getUserAgentString().replace("; wv)", ")").replace("Version/4.0 ", "");
        java.util.regex.Matcher chrome = Pattern.compile("Chrome/(\\d+)").matcher(mobileUserAgent);
        desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + (chrome.find() ? chrome.group(1) : "130") + ".0.0.0 Safari/537.36";
        s.setUserAgentString(mobileUserAgent);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, Collections.emptySet());
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, true);

        browser.setWebChromeClient(new WebChromeClient());
        browser.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Не даём странице магазина переключиться в его приложение (intent://, ozon://, market://)
                String scheme = request.getUrl().getScheme();
                return !"https".equals(scheme) && !"http".equals(scheme);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (current != null && url != null && url.startsWith("http")) current.navigated = true;
            }

            // Сайт магазина не открылся (нет связи, домен недоступен у провайдера) — сдаёмся сразу,
            // а не ждём 15 секунд, чтобы потом показать пустую страницу ошибки
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError err) {
                if (current == null || !request.isForMainFrame()) return;
                int code = err.getErrorCode();
                if (code == ERROR_UNSUPPORTED_SCHEME) return;
                Job job = current;
                handler.post(() -> {
                    if (job == current) finish(job, error(job.id, "network"));
                });
            }
        });
    }

    /** Окно рисуется под системными панелями — плашку и страницу магазина отодвигаем от них. */
    void setInsets(int top, int bottom) {
        layer.setPadding(0, top, 0, bottom);
    }

    /** Вид, который лежит поверх скрытого браузера (сайт). */
    void setCover(View cover) {
        this.cover = cover;
    }

    boolean isShowing() {
        return showing;
    }

    /** Запрос от сайта: {"type":"read","id":1,"url":"https://…","script":"(function…)()"} */
    void handle(String message, JavaScriptReplyProxy reply) {
        int id = 0;
        try {
            JSONObject msg = new JSONObject(message);
            id = msg.optInt("id");
            Uri url = Uri.parse(msg.optString("url"));
            String script = msg.optString("script");
            if (!"read".equals(msg.optString("type")) || script.isEmpty() || script.length() > 200_000) {
                throw new IllegalArgumentException("bad request");
            }
            if ("http".equals(url.getScheme())) url = url.buildUpon().scheme("https").build();
            if (!"https".equals(url.getScheme()) || url.getHost() == null || url.getUserInfo() != null
                    || !MARKET_HOST.matcher(url.getHost().toLowerCase()).find()) {
                throw new IllegalArgumentException("not a marketplace link");
            }
            queue.add(new Job(id, url.toString(), script, reply));
            if (current == null) next();
        } catch (JSONException | IllegalArgumentException e) {
            reply.postMessage(error(id, "bad-request").toString());
        }
    }

    void cancelCurrent() {
        if (current != null) finish(current, error(current.id, "cancelled"));
        else hide();
    }

    /** «Отмена» и «Назад» отменяют всю очередь: каждому заданию отвечаем, чтобы сайт не ждал. */
    void cancelAll() {
        Job job;
        while ((job = queue.poll()) != null) {
            try {
                job.reply.postMessage(error(job.id, "cancelled").toString());
            } catch (RuntimeException ignored) {
            }
        }
        cancelCurrent();
    }

    void destroy() {
        handler.removeCallbacksAndMessages(null);
        browser.destroy();
    }

    private void next() {
        current = queue.poll();
        handler.removeCallbacks(poll);
        browser.stopLoading();
        if (current == null) {
            browser.loadUrl("about:blank");
            return;
        }
        current.started = SystemClock.uptimeMillis();
        String host = Uri.parse(current.url).getHost();
        boolean desktop = host != null && DESKTOP_HOST.matcher(host.toLowerCase()).find();
        browser.getSettings().setUserAgentString(desktop ? desktopUserAgent : mobileUserAgent);
        browser.loadUrl(current.url);
        handler.postDelayed(poll, FIRST_POLL_MS);
    }

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            Job job = current;
            if (job == null) return;
            browser.evaluateJavascript(job.script, value -> onResult(job, value));
        }
    };

    private void onResult(Job job, String value) {
        if (job != current) return;
        long now = SystemClock.uptimeMillis();
        JSONObject result = null;
        try {
            if (job.navigated && value != null && value.startsWith("{")) result = new JSONObject(value);
        } catch (JSONException ignored) {
        }
        String status = result == null ? "wait" : result.optString("status", "wait");
        // Товара больше нет (удалён, снят с продажи) — ждать нечего
        if ("gone".equals(status)) {
            finish(job, error(job.id, "gone"));
            return;
        }

        if ("ok".equals(status)) {
            if (result.optBoolean("complete")) {
                finish(job, ok(job.id, result));
                return;
            }
            if (job.partial == null) job.partialAt = now;
            job.partial = result;
            if (now - job.partialAt >= PARTIAL_GRACE_MS) {
                finish(job, ok(job.id, result));
                return;
            }
        }
        if (!"blocked".equals(status)) {
            job.blockedAt = 0;
        } else if (job.blockedAt == 0) {
            job.blockedAt = now;
        } else if (!showing && now - job.blockedAt >= BLOCKED_GRACE_MS) {
            show(job, R.string.check_blocked);
        }

        if (!showing && now - job.started >= HIDDEN_LIMIT_MS) {
            if (job.partial != null) {
                finish(job, ok(job.id, job.partial));
                return;
            }
            show(job, R.string.check_slow);
        } else if (showing && now - job.shownAt >= CHECK_LIMIT_MS) {
            finish(job, job.partial != null ? ok(job.id, job.partial) : error(job.id, "timeout"));
            return;
        }
        handler.postDelayed(poll, POLL_MS);
    }

    private void show(Job job, int text) {
        hint.setText(text);
        job.shownAt = SystemClock.uptimeMillis();
        showing = true;
        layer.bringToFront();
        ((View) layer.getParent()).invalidate();
    }

    private void hide() {
        if (!showing) return;
        showing = false;
        if (cover != null) {
            cover.bringToFront();
            ((View) cover.getParent()).invalidate();
        }
    }

    private void finish(Job job, JSONObject reply) {
        handler.removeCallbacks(poll);
        // Даже если страницу прочитать не дали, адрес после редиректов (раскрытая короткая ссылка) пригодится сайту
        String page = browser.getUrl();
        if (!reply.optBoolean("ok") && page != null && page.startsWith("https://")) {
            try {
                reply.put("url", page);
            } catch (JSONException ignored) {
            }
        }
        try {
            job.reply.postMessage(reply.toString());
        } catch (RuntimeException ignored) {
            // Страница сайта уже перезагружена — ответ некому отдавать
        }
        hide();
        next();
    }

    private static JSONObject ok(int id, JSONObject data) {
        try {
            return new JSONObject().put("id", id).put("ok", true).put("data", data);
        } catch (JSONException e) {
            return error(id, "json");
        }
    }

    private static JSONObject error(int id, String code) {
        try {
            return new JSONObject().put("id", id).put("ok", false).put("error", code);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
