package ru.vybiraem.vmeste;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.SystemClock;

import androidx.webkit.WebViewCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * «Проверка связи»: для каждого адреса — DNS (система и DoH), TCP, TLS и HTTP напрямую и через прокси обхода,
 * со временем каждого шага или ошибкой. Итог — простой текст для чата и короткая сводка для окна «Сеть».
 * Личных данных не собирает: только версии Android/WebView/приложения, режим обхода, есть ли VPN и адреса серверов.
 */
final class NetCheck {
    private static final int TCP_MS = 5_000;
    private static final int TLS_MS = 8_000;
    private static final int HTTP_MS = 8_000;
    private static final int BODY_LIMIT = 64 * 1024;
    private static final String UA = "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE
            + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    private static final String DEFAULT_API = "https://markets-pars.joroslav121.workers.dev";

    private static volatile boolean running;

    private NetCheck() {
    }

    private static final class Target {
        final String name;
        final String url;
        final String host;
        final String path;

        Target(String name, String url) {
            this.name = name;
            this.url = url;
            URI u = URI.create(url);
            this.host = u.getHost();
            String p = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            this.path = u.getRawQuery() == null ? p : p + "?" + u.getRawQuery();
        }
    }

    /** Один путь до сервера: напрямую или через прокси обхода. */
    private static final class Path {
        String ip;
        long proxyMs = -1;
        long tcpMs = -1;
        long tlsMs = -1;
        long httpMs = -1;
        int status;
        long bytes;
        boolean bodyDone;
        String error;
        String stage;
        String route;

        boolean ok() {
            return status > 0 && error == null;
        }
    }

    private static final class Result {
        Target target;
        List<InetAddress> sys;
        long sysMs;
        String sysError;
        Resolver.DohResult doh;
        long dohMs;
        Path direct;
        Path bypass;
        boolean added;
    }

    /** Запускает проверку в фоне; done вызывается в главном потоке с {report, items}. */
    static void run(Context c, String api, Consumer<JSONObject> done) {
        if (running) {
            NetBypass.post(() -> done.accept(error("Проверка уже идёт")));
            return;
        }
        running = true;
        Thread t = new Thread(() -> {
            JSONObject out;
            try {
                out = check(c, api);
            } catch (Exception e) {
                out = error("Проверка не удалась: " + e);
            } finally {
                running = false;
            }
            JSONObject result = out;
            NetBypass.post(() -> done.accept(result));
        }, "net-check");
        t.setDaemon(true);
        t.start();
    }

    private static JSONObject error(String text) {
        try {
            return new JSONObject().put("report", text).put("items", new JSONArray());
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static List<Target> targets(String api) {
        String server = DEFAULT_API;
        if (api != null && api.startsWith("https://") && api.length() < 200) {
            try {
                URI u = URI.create(api);
                if (u.getHost() != null && Resolver.validHost(u.getHost().toLowerCase(Locale.ROOT))) server = "https://" + u.getHost();
            } catch (IllegalArgumentException ignored) {
            }
        }
        List<Target> list = new ArrayList<>();
        list.add(new Target("ali.click", "https://ali.click/"));
        list.add(new Target("AliExpress", "https://aliexpress.ru/"));
        list.add(new Target("Фото AliExpress (alicdn)", "https://ae01.alicdn.com/images/eng/wholesale/icon/aliexpress.ico"));
        list.add(new Target("Фото AliExpress (aliexpress-media)", "https://ae-pic-a1.aliexpress-media.com/favicon.ico"));
        list.add(new Target("Ozon", "https://www.ozon.ru/"));
        list.add(new Target("Яндекс Маркет", "https://market.yandex.ru/"));
        list.add(new Target("Wildberries", "https://www.wildberries.ru/"));
        list.add(new Target("Сервер подборок", server + "/api/health"));
        return list;
    }

    private static JSONObject check(Context c, String api) throws Exception {
        long started = SystemClock.elapsedRealtime();
        BypassProxy proxy = BypassProxy.get(c);
        List<Target> targets = targets(api);
        ExecutorService pool = Executors.newFixedThreadPool(32, r -> {
            Thread t = new Thread(r, "net-check");
            t.setDaemon(true);
            return t;
        });
        List<Result> results = new ArrayList<>();
        try {
            List<Future<Result>> futures = new ArrayList<>();
            for (Target target : targets) futures.add(pool.submit(() -> checkOne(pool, target, proxy)));
            for (int i = 0; i < futures.size(); i++) {
                Result r;
                try {
                    r = futures.get(i).get(90, TimeUnit.SECONDS);
                } catch (Exception e) {
                    r = new Result();
                    r.target = targets.get(i);
                    r.sysError = "проверка не уложилась во время";
                }
                results.add(r);
            }
        } finally {
            pool.shutdownNow();
        }

        // Адрес не открывается напрямую, а через обход открывается — добавляем его в список обхода
        boolean changed = false;
        List<String> rules = NetBypass.hosts(c);
        for (Result r : results) {
            if (r.direct != null && r.bypass != null && !r.direct.ok() && r.bypass.ok()
                    && !NetBypass.covered(rules, r.target.host)) {
                NetBypass.addHost(c, r.target.host);
                r.added = true;
                changed = true;
            }
        }
        if (changed && NetBypass.AUTO.equals(NetBypass.mode(c))) NetBypass.post(() -> NetBypass.apply(c, null));

        StringBuilder sb = new StringBuilder();
        sb.append("Проверка связи — «Выбираем вместе» для Android\n");
        sb.append(new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT).format(new Date()))
                .append(", заняла ").append((SystemClock.elapsedRealtime() - started + 500) / 1000).append(" с\n");
        sb.append("Приложение: ").append(appVersion(c)).append("; Android ").append(Build.VERSION.RELEASE)
                .append(" (API ").append(Build.VERSION.SDK_INT).append(")");
        android.content.pm.PackageInfo wv = WebViewCompat.getCurrentWebViewPackage(c);
        if (wv != null) sb.append("; WebView ").append(wv.versionName);
        sb.append('\n');
        sb.append("Обход: ").append(NetBypass.describe(c));
        if (proxy == null) sb.append("; прокси не запустился");
        sb.append('\n');
        sb.append("Сеть: ").append(network(c)).append('\n');
        JSONArray items = new JSONArray();
        for (Result r : results) {
            sb.append('\n');
            describe(sb, r);
            items.put(new JSONObject()
                    .put("name", r.target.name)
                    .put("host", r.target.host)
                    .put("direct", r.direct != null && r.direct.ok())
                    .put("bypass", r.bypass != null && r.bypass.ok())
                    .put("added", r.added));
        }
        return new JSONObject().put("report", sb.toString()).put("items", items);
    }

    private static Result checkOne(ExecutorService pool, Target t, BypassProxy proxy) throws Exception {
        Result r = new Result();
        r.target = t;
        Future<Resolver.DohResult> dohF = pool.submit(() -> Resolver.doh(t.host, 3000));
        long t0 = SystemClock.elapsedRealtime();
        try {
            r.sys = Resolver.system(t.host, 5000);
        } catch (Exception e) {
            r.sysError = errorText(e);
        }
        r.sysMs = SystemClock.elapsedRealtime() - t0;
        // Через прокси — параллельно с прямым путём: прокси сам ищет адреса и способ
        Future<Path> bypassF = proxy == null ? null : pool.submit(() -> viaProxy(t, proxy));
        try {
            r.doh = dohF.get(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            r.doh = null;
        }
        r.dohMs = SystemClock.elapsedRealtime() - t0;
        InetAddress ip = pickIp(r);
        r.direct = ip == null ? failed("DNS", "адрес не найден") : direct(t, ip);
        if (bypassF != null) {
            try {
                r.bypass = bypassF.get(60, TimeUnit.SECONDS);
            } catch (Exception e) {
                r.bypass = failed("прокси", "нет ответа");
            }
        }
        return r;
    }

    private static InetAddress pickIp(Result r) {
        if (r.sys != null) {
            for (InetAddress a : r.sys) if (a instanceof Inet4Address) return a;
            if (!r.sys.isEmpty()) return r.sys.get(0);
        }
        if (r.doh != null && !r.doh.ips.isEmpty()) return Resolver.literal(r.doh.ips.get(0));
        return null;
    }

    private static Path failed(String stage, String error) {
        Path p = new Path();
        p.stage = stage;
        p.error = error;
        return p;
    }

    /** Напрямую: TCP к адресу из системного DNS, TLS с именем сайта, HTTP-запрос. */
    private static Path direct(Target t, InetAddress ip) {
        Path p = new Path();
        p.ip = ip.getHostAddress();
        Socket s = new Socket();
        try {
            p.stage = "TCP";
            long t0 = SystemClock.elapsedRealtime();
            s.setTcpNoDelay(true);
            s.connect(new InetSocketAddress(ip, 443), TCP_MS);
            p.tcpMs = SystemClock.elapsedRealtime() - t0;
            tlsAndHttp(p, s, t);
        } catch (Exception e) {
            p.error = errorText(e);
        } finally {
            BypassProxy.close(s);
        }
        return p;
    }

    /** Через прокси обхода: CONNECT, потом TLS и HTTP так же, как браузер. */
    private static Path viaProxy(Target t, BypassProxy proxy) {
        Path p = new Path();
        Socket s = new Socket();
        try {
            p.stage = "прокси";
            long t0 = SystemClock.elapsedRealtime();
            s.setTcpNoDelay(true);
            s.connect(new InetSocketAddress(InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 }), proxy.port()), 2000);
            s.setSoTimeout(20_000);
            OutputStream out = s.getOutputStream();
            out.write(("CONNECT " + t.host + ":443 HTTP/1.1\r\nHost: " + t.host + ":443\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            String head = readHead(s.getInputStream());
            if (head == null) throw new IOException("прокси закрыл соединение");
            String line = head.split("\r\n", 2)[0];
            if (!line.matches("HTTP/1\\.[01] 200.*")) throw new IOException("прокси ответил: " + line);
            p.proxyMs = SystemClock.elapsedRealtime() - t0;
            p.stage = "TCP";
            tlsAndHttp(p, s, t);
        } catch (Exception e) {
            p.error = errorText(e);
        } finally {
            BypassProxy.close(s);
            p.route = proxy.routeOf(t.host);
        }
        return p;
    }

    private static void tlsAndHttp(Path p, Socket s, Target t) throws IOException {
        p.stage = "TLS";
        long t0 = SystemClock.elapsedRealtime();
        s.setSoTimeout(TLS_MS);
        SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, t.host, 443, true);
        ssl.startHandshake();
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(t.host, ssl.getSession())) {
            throw new IOException("сертификат выдан не этому сайту (подмена?)");
        }
        p.tlsMs = SystemClock.elapsedRealtime() - t0;

        p.stage = "HTTP";
        t0 = SystemClock.elapsedRealtime();
        ssl.setSoTimeout(HTTP_MS);
        OutputStream out = ssl.getOutputStream();
        out.write(("GET " + t.path + " HTTP/1.1\r\nHost: " + t.host + "\r\nUser-Agent: " + UA
                + "\r\nAccept: */*\r\nAccept-Language: ru-RU,ru;q=0.9\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        InputStream in = ssl.getInputStream();
        String head = readHead(in);
        if (head == null) throw new IOException("сервер закрыл соединение без ответа");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^HTTP/\\d(?:\\.\\d)?\\s+(\\d{3})").matcher(head);
        if (!m.find()) throw new IOException("непонятный ответ");
        p.status = Integer.parseInt(m.group(1));
        p.httpMs = SystemClock.elapsedRealtime() - t0;

        // Немного тела ответа: ТСПУ иногда пропускает начало и «замораживает» поток на 16–20 КБ
        p.stage = "тело ответа";
        byte[] buf = new byte[8192];
        long deadline = SystemClock.elapsedRealtime() + HTTP_MS;
        try {
            while (p.bytes < BODY_LIMIT && SystemClock.elapsedRealtime() < deadline) {
                int n = in.read(buf);
                if (n < 0) {
                    p.bodyDone = true;
                    break;
                }
                p.bytes += n;
            }
            if (p.bytes >= BODY_LIMIT) p.bodyDone = true;
        } catch (SocketTimeoutException e) {
            p.error = "поток ответа остановился после " + kb(p.bytes);
        } catch (IOException e) {
            if (p.bytes == 0) throw e;
            p.error = "поток ответа оборвался после " + kb(p.bytes) + ": " + errorText(e);
        }
    }

    /** Заголовок HTTP-ответа (до пустой строки) по одному байту — чтобы не съесть начало тела. */
    private static String readHead(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (sb.length() < 16384) {
            int b = in.read();
            if (b < 0) return sb.length() == 0 ? null : sb.toString();
            sb.append((char) b);
            int n = sb.length();
            if (n >= 4 && sb.charAt(n - 4) == '\r' && sb.charAt(n - 3) == '\n' && sb.charAt(n - 2) == '\r' && sb.charAt(n - 1) == '\n') {
                return sb.toString();
            }
        }
        return sb.toString();
    }

    private static void describe(StringBuilder sb, Result r) {
        sb.append(r.target.name).append(" — ").append(r.target.url).append('\n');
        sb.append("  DNS система: ");
        if (r.sys != null) sb.append(ips(r.sys)).append(" — ").append(r.sysMs).append(" мс");
        else sb.append("ошибка: ").append(r.sysError != null ? r.sysError : "нет ответа");
        sb.append('\n');
        sb.append("  DNS DoH: ");
        if (r.doh == null) sb.append("нет ответа");
        else if (!r.doh.ips.isEmpty()) sb.append(String.join(", ", r.doh.ips)).append(" — ").append(r.dohMs).append(" мс (").append(r.doh.by).append(')');
        else sb.append("ошибка: ").append(r.doh.error);
        sb.append('\n');
        if (r.direct != null) sb.append("  Напрямую: ").append(path(r.direct)).append('\n');
        if (r.bypass != null) sb.append("  Через обход: ").append(path(r.bypass)).append('\n');
        if (r.added) sb.append("  → напрямую не открывается, через обход открывается: добавлен в список обхода\n");
    }

    private static String path(Path p) {
        List<String> parts = new ArrayList<>();
        if (p.proxyMs >= 0) parts.add("прокси " + p.proxyMs + " мс");
        if (p.tcpMs >= 0) parts.add("TCP " + p.ip + " " + p.tcpMs + " мс");
        if (p.tlsMs >= 0) parts.add("TLS " + p.tlsMs + " мс");
        if (p.status > 0) parts.add("HTTP " + p.status + " за " + p.httpMs + " мс, " + kb(p.bytes) + (p.bodyDone ? "" : "+"));
        if (p.error != null) parts.add(("тело ответа".equals(p.stage) ? "" : p.stage + " — ") + "ошибка: " + p.error);
        if (p.route != null) parts.add("маршрут: " + p.route);
        return parts.isEmpty() ? "нет данных" : String.join("; ", parts);
    }

    private static String ips(List<InetAddress> list) {
        if (list.isEmpty()) return "нет адресов";
        List<String> out = new ArrayList<>();
        for (InetAddress a : list) {
            if (out.size() == 4) {
                out.add("…");
                break;
            }
            out.add(a.getHostAddress() + (Resolver.usable(a) || Resolver.isFakeIp(a) ? "" : " (не публичный)"));
        }
        return String.join(", ", out);
    }

    private static String kb(long bytes) {
        return bytes < 1024 ? bytes + " Б" : String.format(Locale.ROOT, "%.1f КБ", bytes / 1024.0);
    }

    private static String errorText(Throwable e) {
        String name = e.getClass().getSimpleName();
        String msg = e.getMessage();
        if (e instanceof SocketTimeoutException) return "нет ответа (таймаут)";
        if (e instanceof java.net.UnknownHostException) return "адрес не найден";
        if (e instanceof java.net.ConnectException) return "соединение отклонено" + (msg != null ? " (" + msg + ")" : "");
        if (e instanceof javax.net.ssl.SSLHandshakeException) return "TLS не прошёл: " + msg;
        if (e instanceof java.net.SocketException && msg != null && msg.toLowerCase(Locale.ROOT).contains("reset")) {
            return "соединение сброшено (RST)";
        }
        if (e instanceof java.io.EOFException) return "соединение закрыто";
        return msg != null ? (msg.matches(".*[а-яА-Я].*") ? msg : name + ": " + msg) : name;
    }

    private static String network(Context c) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return "неизвестно";
        Network n = cm.getActiveNetwork();
        NetworkCapabilities caps = n != null ? cm.getNetworkCapabilities(n) : null;
        if (caps == null) return "нет активной сети";
        List<String> parts = new ArrayList<>();
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) parts.add("Wi-Fi");
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) parts.add("мобильная");
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) parts.add("Ethernet");
        boolean vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        parts.add(vpn ? "VPN включён (для приложения)" : "VPN нет");
        try {
            String dns = android.provider.Settings.Global.getString(c.getContentResolver(), "private_dns_mode");
            if (dns != null) parts.add("частный DNS: " + ("off".equals(dns) ? "выключен" : "opportunistic".equals(dns) ? "авто" : "свой сервер"));
        } catch (RuntimeException ignored) {
        }
        return String.join(", ", parts);
    }

    @SuppressWarnings("deprecation")
    private static String appVersion(Context c) {
        try {
            android.content.pm.PackageInfo info = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return info.versionName + " (" + (Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode) + ")";
        } catch (Exception e) {
            return "?";
        }
    }
}
