package ru.vybiraem.vmeste;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;

/**
 * Настройка «Обход блокировок» и связь встроенных браузеров (WebView) с прокси обхода ({@link BypassProxy}).
 * <ul>
 *   <li>«Авто» (по умолчанию) — через прокси идут только адреса из списка ({@link #BASE_HOSTS} + добавленные
 *       проверкой связи), остальное — напрямую. Это «обратный» список обхода WebView (ProxyConfig reverse bypass).
 *       Если WebView телефона его не умеет, через прокси идёт всё, кроме других магазинов и нашего сайта
 *       ({@link #DIRECT_HOSTS}) — разрыв ClientHello там, где он не нужен, ничему не мешает;</li>
 *   <li>«Всегда» — через прокси идёт всё, что открывают WebView приложения;</li>
 *   <li>«Выключен» — WebView ходит напрямую, как раньше.</li>
 * </ul>
 * Если WebView совсем не умеет подменять прокси (PROXY_OVERRIDE), обход недоступен — сайт покажет это в «Сети».
 * Применяется при запуске, до загрузки страниц, и при смене режима с сайта.
 */
final class NetBypass {
    static final String AUTO = "auto";
    static final String ALWAYS = "always";
    static final String OFF = "off";

    /** Где у пользователя страница товара не грузилась без VPN: короткие ссылки и сам AliExpress, его CDN и наш сервер. */
    static final List<String> BASE_HOSTS = Collections.unmodifiableList(Arrays.asList(
            "ali.click", "aliclick.shop", "*.aliexpress.ru", "*.aliexpress.com", "*.alicdn.com",
            "*.aliexpress-media.com", "*.workers.dev"));
    /** Без обратного списка: эти адреса идут напрямую, всё остальное — через прокси. */
    static final List<String> DIRECT_HOSTS = Collections.unmodifiableList(Arrays.asList(
            "*.ozon.ru", "*.ozone.ru", "*.ozonusercontent.com", "*.yandex.ru", "*.yandex.net", "*.yastatic.net",
            "*.yandex.com", "ya.cc", "*.wildberries.ru", "*.wb.ru", "*.wbbasket.ru", "*.wbcontent.net",
            "*.github.io", "*.googleapis.com", "*.gstatic.com", "*.ok.ru", "*.vk.com", "*.userapi.com"));

    private static final List<String> LAN = Arrays.asList("<local>", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16");

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Executor ON_MAIN = MAIN::post;
    /** Что сейчас применено к WebView: off / hosts / all / unsupported / error. */
    private static volatile String scope = OFF;

    private NetBypass() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("bypass", Context.MODE_PRIVATE);
    }

    static String mode(Context c) {
        String m = prefs(c).getString("mode", AUTO);
        return ALWAYS.equals(m) || OFF.equals(m) ? m : AUTO;
    }

    /** Адреса, добавленные сверх основного списка (проверкой связи или сайтом). */
    static List<String> extraHosts(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("hosts", "[]"));
            for (int i = 0; i < a.length(); i++) {
                String h = normalizeRule(a.optString(i));
                if (h != null && !out.contains(h)) out.add(h);
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    static List<String> hosts(Context c) {
        Set<String> all = new LinkedHashSet<>(BASE_HOSTS);
        all.addAll(extraHosts(c));
        return new ArrayList<>(all);
    }

    /** «host» или «*.host» в нижнем регистре; null — не похоже на адрес сайта. */
    static String normalizeRule(String rule) {
        if (rule == null) return null;
        String r = rule.trim().toLowerCase(Locale.ROOT);
        String host = r.startsWith("*.") ? r.substring(2) : r;
        if (!Resolver.validHost(host) || host.indexOf('.') < 0 || Resolver.literal(host) != null) return null;
        return r;
    }

    /** Подходит ли сайт под список («*.d» — сам d и все его поддомены). */
    static boolean covered(List<String> rules, String host) {
        host = host.toLowerCase(Locale.ROOT);
        for (String r : rules) {
            String d = r.startsWith("*.") ? r.substring(2) : r;
            if (host.equals(d) || (r.startsWith("*.") && host.endsWith("." + d))) return true;
        }
        return false;
    }

    static void addHost(Context c, String host) {
        List<String> extra = extraHosts(c);
        String rule = normalizeRule(host);
        if (rule == null || extra.contains(rule) || extra.size() >= 64) return;
        extra.add(rule);
        prefs(c).edit().putString("hosts", new JSONArray(extra).toString()).apply();
    }

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
    }

    static boolean reverseSupported() {
        return supported() && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS);
    }

    /** Применяет режим к WebView приложения. done вызывается в главном потоке, когда WebView принял настройку. */
    static void apply(Context context, Runnable done) {
        Context c = context.getApplicationContext();
        String mode = mode(c);
        Runnable finish = () -> {
            if (done != null) done.run();
        };
        if (!supported()) {
            scope = OFF.equals(mode) ? OFF : "unsupported";
            MAIN.post(finish);
            return;
        }
        ProxyController controller = ProxyController.getInstance();
        if (OFF.equals(mode)) {
            scope = OFF;
            controller.clearProxyOverride(ON_MAIN, finish);
            return;
        }
        BypassProxy proxy = BypassProxy.get(c);
        if (proxy == null) {
            scope = "error";
            controller.clearProxyOverride(ON_MAIN, finish);
            return;
        }
        ProxyConfig.Builder b = new ProxyConfig.Builder().addProxyRule("127.0.0.1:" + proxy.port());
        if (ALWAYS.equals(mode)) {
            // Локальная сеть (сайт с компьютера разработчика и т. п.) — напрямую: прокси такие адреса не пропускает
            for (String lan : LAN) b.addBypassRule(lan);
            scope = "all";
        } else if (reverseSupported()) {
            // Обратный список: через прокси — только эти адреса
            for (String rule : hosts(c)) addRule(b, rule);
            b.setReverseBypassEnabled(true);
            scope = "hosts";
        } else {
            // WebView без обратного списка: напрямую — другие магазины и сайт, остальное через прокси
            for (String rule : DIRECT_HOSTS) addRule(b, rule);
            for (String lan : LAN) b.addBypassRule(lan);
            String site = android.net.Uri.parse(c.getString(R.string.site_url)).getHost();
            if (site != null) b.addBypassRule(site);
            scope = "all-but-shops";
        }
        try {
            controller.setProxyOverride(b.build(), ON_MAIN, finish);
        } catch (IllegalArgumentException e) {
            scope = "error";
            controller.clearProxyOverride(ON_MAIN, finish);
        }
    }

    private static void addRule(ProxyConfig.Builder b, String rule) {
        b.addBypassRule(rule);
        // «*.d» в правилах Chromium не всегда включает сам d — добавляем его отдельно
        if (rule.startsWith("*.")) b.addBypassRule(rule.substring(2));
    }

    /**
     * Сообщения сайта: {"type":"bypass","id":1[,"mode":"auto|always|off"]} — состояние (и смена режима);
     * {"type":"bypass-check","id":2[,"api":"https://…"]} — «Проверка связи», ответ придёт через 10–40 секунд;
     * {"type":"bypass-copy","id":3,"text":"…"} — положить отчёт в буфер обмена.
     */
    static void handle(Context context, String data, JavaScriptReplyProxy reply) {
        JSONObject msg;
        try {
            msg = new JSONObject(data);
        } catch (JSONException e) {
            return;
        }
        int id = msg.optInt("id");
        Context c = context.getApplicationContext();
        if ("bypass-copy".equals(msg.optString("type"))) {
            // Отчёт проверки в буфер обмена (если WebView не дал сайту записать его сам)
            boolean ok = false;
            android.content.ClipboardManager cm = (android.content.ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            String text = msg.optString("text");
            if (cm != null && !text.isEmpty() && text.length() <= 100_000) {
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Проверка связи", text));
                ok = true;
            }
            try {
                reply.postMessage(new JSONObject().put("id", id).put("ok", ok).toString());
            } catch (JSONException | RuntimeException ignored) {
            }
            return;
        }
        if ("bypass-check".equals(msg.optString("type"))) {
            NetCheck.run(c, msg.optString("api"), report -> {
                try {
                    report.put("id", id).put("ok", true);
                    reply.postMessage(report.toString());
                } catch (JSONException | RuntimeException ignored) {
                    // Страница сайта уже перезагружена — ответ некому отдавать
                }
            });
            return;
        }
        String mode = msg.optString("mode");
        if (AUTO.equals(mode) || ALWAYS.equals(mode) || OFF.equals(mode)) {
            if (!mode.equals(mode(c))) {
                prefs(c).edit().putString("mode", mode).apply();
                apply(c, () -> postStatus(c, id, reply));
                return;
            }
        }
        postStatus(c, id, reply);
    }

    private static void postStatus(Context c, int id, JavaScriptReplyProxy reply) {
        try {
            reply.postMessage(status(c).put("id", id).put("ok", true).toString());
        } catch (JSONException | RuntimeException ignored) {
        }
    }

    static JSONObject status(Context c) throws JSONException {
        return new JSONObject()
                .put("mode", mode(c))
                .put("supported", supported())
                .put("reverse", reverseSupported())
                .put("scope", scope)
                .put("hosts", new JSONArray(hosts(c)));
    }

    /** Строка о режиме для отчёта. */
    static String describe(Context c) {
        String mode = mode(c);
        String m = AUTO.equals(mode) ? "Авто" : ALWAYS.equals(mode) ? "Всегда" : "Выключен";
        String s;
        switch (scope) {
            case "hosts":
                s = "через обход — только адреса из списка";
                break;
            case "all":
                s = "через обход — всё";
                break;
            case "all-but-shops":
                s = "через обход — всё, кроме магазинов (WebView без обратного списка)";
                break;
            case "unsupported":
                s = "WebView не умеет подменять прокси — обход недоступен";
                break;
            case "error":
                s = "не удалось запустить прокси";
                break;
            default:
                s = "WebView ходит напрямую";
        }
        return m + ", " + s;
    }

    static void post(Runnable r) {
        MAIN.post(r);
    }
}
