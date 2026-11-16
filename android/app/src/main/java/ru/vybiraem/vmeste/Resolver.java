package ru.vybiraem.vmeste;

import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;

/**
 * Адреса сайтов для обхода: DNS-over-HTTPS (несколько резолверов по IP — в ClientHello нет имени dns.google и т. п.,
 * сертификат проверяется по IP или имени резолвера) и системный резолвер. Как SmartResolver в kadr (net.rs):
 * ответ провайдера может быть подменён (заглушка вместо адреса), а DoH — нет; адреса из обоих источников идут
 * вперемешку, и перебор маршрутов в {@link BypassProxy} сам отбросит неработающие. Ответы кэшируются по TTL.
 */
final class Resolver {
    private Resolver() {
    }

    /**
     * Резолвер DoH: адрес и порт, имя в его сертификате, SNI (null — не отправлять: подключение по IP без имени
     * в ClientHello), формат: проводной RFC 8484 (POST application/dns-message) или JSON (GET application/dns-json).
     */
    static final class Endpoint {
        final String ip;
        final int port;
        final String name;
        final String sni;
        final boolean json;
        final String label;

        Endpoint(String ip, int port, String name, String sni, boolean json, String label) {
            this.ip = ip;
            this.port = port;
            this.name = name;
            this.sni = sni;
            this.json = json;
            this.label = label;
        }
    }

    // Quad9 на 443 отвечает только по HTTP/2 (а HttpsURLConnection в Android — HTTP/1.1), поэтому JSON на 5053, как в kadr.
    // Яндекс без SNI рвёт соединение — ему передаём своё имя (Яндекс в России не блокируют).
    static final List<Endpoint> ENDPOINTS = Collections.unmodifiableList(Arrays.asList(
            new Endpoint("1.1.1.1", 443, "cloudflare-dns.com", null, false, "Cloudflare 1.1.1.1"),
            new Endpoint("8.8.8.8", 443, "dns.google", null, false, "Google 8.8.8.8"),
            new Endpoint("9.9.9.9", 5053, "dns.quad9.net", null, true, "Quad9 9.9.9.9"),
            new Endpoint("77.88.8.8", 443, "common.dot.dns.yandex.net", "common.dot.dns.yandex.net", false, "Яндекс 77.88.8.8"),
            new Endpoint("1.0.0.1", 443, "cloudflare-dns.com", null, false, "Cloudflare 1.0.0.1"),
            new Endpoint("8.8.4.4", 443, "dns.google", null, false, "Google 8.8.4.4")));

    /** Итог DoH: адреса, TTL, кто ответил, ошибка (если никто). */
    static final class DohResult {
        final List<String> ips;
        final int ttl;
        final String by;
        final String error;
        /** Хоть один резолвер ответил (пусть и без адресов) — значит, DoH из этой сети работает. */
        final boolean answered;

        DohResult(List<String> ips, int ttl, String by, String error, boolean answered) {
            this.ips = ips;
            this.ttl = ttl;
            this.by = by;
            this.error = error;
            this.answered = answered;
        }
    }

    private static final class Entry {
        final List<InetAddress> addrs;
        final long until;

        Entry(List<InetAddress> addrs, long until) {
            this.addrs = addrs;
            this.until = until;
        }
    }

    private static final int DOH_TIMEOUT_MS = 2500;
    private static final int SYSTEM_TIMEOUT_MS = 2500;
    /** Сколько ещё ждём DoH, когда система уже ответила. */
    private static final long DOH_EXTRA_MS = 600;
    /** После того как DoH не ответил ни разу, какое-то время его не ждём (но адреса системы работают). */
    private static final long DOH_DOWN_MS = 3 * 60_000;
    private static final Pattern HOST = Pattern.compile("[a-z0-9]([a-z0-9-]{0,62})(\\.[a-z0-9]([a-z0-9-]{0,62}))*\\.?");

    private static final ExecutorService POOL = new ThreadPoolExecutor(0, 48, 30, TimeUnit.SECONDS,
            new SynchronousQueue<>(), r -> {
                Thread t = new Thread(r, "bypass-dns");
                t.setDaemon(true);
                return t;
            }, new ThreadPoolExecutor.CallerRunsPolicy());
    private static final Map<String, Entry> CACHE = new HashMap<>();
    private static volatile long dohDownUntil;

    static boolean validHost(String host) {
        return host != null && host.length() <= 253 && HOST.matcher(host).matches();
    }

    /** Адреса для подключения: из кэша, иначе DoH + система. Пустой список — сайт не найден. */
    static List<InetAddress> resolve(String host) {
        host = host.toLowerCase(Locale.ROOT);
        InetAddress literal = literal(host);
        if (literal != null) return Collections.singletonList(literal);
        long now = SystemClock.elapsedRealtime();
        synchronized (CACHE) {
            Entry e = CACHE.get(host);
            if (e != null && e.until > now) return e.addrs;
        }
        final String name = host;
        Future<List<InetAddress>> sysF = POOL.submit(() -> Arrays.asList(InetAddress.getAllByName(name)));
        boolean waitDoh = now >= dohDownUntil;
        Future<DohResult> dohF = POOL.submit(() -> doh(name, DOH_TIMEOUT_MS));
        List<InetAddress> sys = get(sysF, SYSTEM_TIMEOUT_MS);
        boolean sysGood = false;
        if (sys != null) for (InetAddress a : sys) sysGood |= usable(a) || isFakeIp(a);
        DohResult doh = null;
        if (waitDoh) {
            // Система уже дала адреса — DoH ждём совсем недолго, иначе каждое первое соединение к сайту стоит секунды
            long full = DOH_TIMEOUT_MS + 300 - (SystemClock.elapsedRealtime() - now);
            doh = get(dohF, Math.max(sysGood ? Math.min(full, DOH_EXTRA_MS) : full, 50));
            if (doh == null && !sysGood) dohDownUntil = SystemClock.elapsedRealtime() + DOH_DOWN_MS;
        } else if (dohF.isDone()) {
            doh = get(dohF, 1);
        }
        Object[] combined = combine(sys, doh);
        @SuppressWarnings("unchecked")
        List<InetAddress> result = (List<InetAddress>) combined[0];
        boolean late = doh == null && sysGood;
        // Пока DoH не ответил, адреса системы живут 30 с (провайдер мог подсунуть заглушку); ответ DoH дополнит их
        store(host, result, late ? 30 : (int) combined[1]);
        if (late) {
            final List<InetAddress> sysFinal = sys;
            try {
                POOL.execute(() -> {
                    DohResult d = get(dohF, DOH_TIMEOUT_MS + 300);
                    if (d == null || !d.answered) {
                        dohDownUntil = SystemClock.elapsedRealtime() + DOH_DOWN_MS;
                    } else if (!d.ips.isEmpty()) {
                        Object[] c = combine(sysFinal, d);
                        @SuppressWarnings("unchecked")
                        List<InetAddress> merged = (List<InetAddress>) c[0];
                        store(name, merged, (int) c[1]);
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException ignored) {
            }
        }
        return result;
    }

    /** Адреса DoH и системы вперемешку (сначала IPv4) и TTL кэша. */
    private static Object[] combine(List<InetAddress> sys, DohResult doh) {
        List<InetAddress> result = new ArrayList<>();
        int ttl = 120;
        boolean fake = false;
        if (sys != null) for (InetAddress a : sys) fake |= isFakeIp(a);
        if (fake) {
            // VPN с «поддельными» адресами (198.18.0.0/15): соединение всё равно уйдёт в туннель — берём его адреса
            for (InetAddress a : sys) if (isFakeIp(a)) result.add(a);
            return new Object[] { result, 60 };
        }
        List<InetAddress> fromDoh = new ArrayList<>();
        if (doh != null) {
            for (String ip : doh.ips) {
                InetAddress a = literal(ip);
                if (a != null && usable(a)) fromDoh.add(a);
            }
            if (!fromDoh.isEmpty()) ttl = Math.max(60, Math.min(doh.ttl, 1800));
        }
        List<InetAddress> fromSys = new ArrayList<>();
        if (sys != null) for (InetAddress a : sys) if (usable(a)) fromSys.add(a);
        // Вперемешку: DoH, система, DoH… — сначала IPv4 (IPv6 у мобильных операторов часто не ходит)
        List<InetAddress> mixed = new ArrayList<>();
        for (int i = 0; i < Math.max(fromDoh.size(), fromSys.size()); i++) {
            if (i < fromDoh.size() && !mixed.contains(fromDoh.get(i))) mixed.add(fromDoh.get(i));
            if (i < fromSys.size() && !mixed.contains(fromSys.get(i))) mixed.add(fromSys.get(i));
        }
        for (InetAddress a : mixed) if (a instanceof Inet4Address) result.add(a);
        for (InetAddress a : mixed) if (!(a instanceof Inet4Address)) result.add(a);
        return new Object[] { result, ttl };
    }

    private static void store(String host, List<InetAddress> addrs, int ttlSec) {
        if (addrs.isEmpty()) return;
        synchronized (CACHE) {
            if (CACHE.size() > 512) CACHE.clear();
            CACHE.put(host, new Entry(Collections.unmodifiableList(new ArrayList<>(addrs)), SystemClock.elapsedRealtime() + ttlSec * 1000L));
        }
    }

    /** Системный резолвер с ограничением по времени. */
    static List<InetAddress> system(String host, long timeoutMs) throws Exception {
        Future<List<InetAddress>> f = POOL.submit(() -> Arrays.asList(InetAddress.getAllByName(host)));
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable c = e.getCause();
            throw c instanceof Exception ? (Exception) c : e;
        } finally {
            f.cancel(true);
        }
    }

    /** Все резолверы DoH одновременно: первый непустой ответ. */
    static DohResult doh(String host, int timeoutMs) {
        CompletionService<Object[]> cs = new ExecutorCompletionService<>(POOL);
        List<Future<Object[]>> all = new ArrayList<>();
        for (Endpoint e : ENDPOINTS) {
            all.add(cs.submit(() -> new Object[] { e, query(e, host, timeoutMs) }));
        }
        long deadline = SystemClock.elapsedRealtime() + timeoutMs + 200;
        String error = null;
        boolean nxdomain = false;
        try {
            for (int i = 0; i < all.size(); i++) {
                long left = deadline - SystemClock.elapsedRealtime();
                if (left <= 0) break;
                Future<Object[]> f = cs.poll(left, TimeUnit.MILLISECONDS);
                if (f == null) break;
                try {
                    Object[] r = f.get();
                    DnsWire.Answer a = (DnsWire.Answer) r[1];
                    if (!a.ips.isEmpty()) return new DohResult(a.ips, a.ttl, ((Endpoint) r[0]).label, null, true);
                    nxdomain = true;
                } catch (java.util.concurrent.ExecutionException e) {
                    Throwable c = e.getCause();
                    if (error == null) error = c == null ? "ошибка" : c.getClass().getSimpleName() + (c.getMessage() != null ? ": " + c.getMessage() : "");
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            for (Future<Object[]> f : all) f.cancel(true);
        }
        if (nxdomain) return new DohResult(Collections.emptyList(), 0, null, "нет адресов", true);
        return new DohResult(Collections.emptyList(), 0, null, error != null ? error : "нет ответа", false);
    }

    /** Один запрос DoH к резолверу по его IP. */
    static DnsWire.Answer query(Endpoint e, String host, int timeoutMs) throws IOException {
        int txId = 1 + (int) (Math.random() * 0xfffe);
        byte[] q = DnsWire.query(host, txId);
        if (q == null) throw new IOException("bad host");
        String base = "https://" + e.ip + (e.port == 443 ? "" : ":" + e.port) + "/dns-query";
        URL url = new URL(e.json ? base + "?name=" + host + "&type=A" : base);
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection(Proxy.NO_PROXY);
        HostnameVerifier def = HttpsURLConnection.getDefaultHostnameVerifier();
        c.setHostnameVerifier((h, session) -> def.verify(e.ip, session) || def.verify(e.name, session));
        if (e.sni != null) c.setSSLSocketFactory(new SniFactory(HttpsURLConnection.getDefaultSSLSocketFactory(), e.sni));
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        c.setUseCaches(false);
        if (e.json) {
            c.setRequestProperty("Accept", "application/dns-json");
        } else {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/dns-message");
            c.setRequestProperty("Accept", "application/dns-message");
            c.setFixedLengthStreamingMode(q.length);
        }
        try {
            if (!e.json) {
                try (OutputStream out = c.getOutputStream()) {
                    out.write(q);
                }
            }
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            ByteArrayOutputStream body = new ByteArrayOutputStream(512);
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[2048];
                int n;
                while ((n = in.read(buf)) > 0 && body.size() < 65536) body.write(buf, 0, n);
            }
            byte[] b = body.toByteArray();
            return e.json ? parseJson(new String(b, java.nio.charset.StandardCharsets.UTF_8)) : DnsWire.parse(b, b.length, txId);
        } finally {
            c.disconnect();
        }
    }

    /** Ответ в JSON ({"Status":0,"Answer":[{"type":1,"TTL":300,"data":"1.2.3.4"}]}). */
    static DnsWire.Answer parseJson(String text) throws IOException {
        try {
            org.json.JSONObject o = new org.json.JSONObject(text);
            List<String> ips = new ArrayList<>();
            int ttl = Integer.MAX_VALUE;
            org.json.JSONArray answers = o.optInt("Status", -1) == 0 ? o.optJSONArray("Answer") : null;
            for (int i = 0; answers != null && i < answers.length(); i++) {
                org.json.JSONObject a = answers.optJSONObject(i);
                if (a == null || a.optInt("type") != 1) continue;
                String ip = a.optString("data").trim();
                if (literal(ip) == null || ips.contains(ip)) continue;
                ips.add(ip);
                ttl = Math.min(ttl, Math.max(0, a.optInt("TTL", 300)));
            }
            return new DnsWire.Answer(ips, ips.isEmpty() ? 0 : ttl);
        } catch (org.json.JSONException ex) {
            throw new IOException("bad json");
        }
    }

    /**
     * Фабрика TLS-сокетов, которая подставляет своё имя вместо IP: оно уходит в SNI. Сертификат проверяет
     * HostnameVerifier соединения (по IP или имени резолвера).
     */
    private static final class SniFactory extends javax.net.ssl.SSLSocketFactory {
        private final javax.net.ssl.SSLSocketFactory base;
        private final String sni;

        SniFactory(javax.net.ssl.SSLSocketFactory base, String sni) {
            this.base = base;
            this.sni = sni;
        }

        @Override
        public java.net.Socket createSocket(java.net.Socket s, String host, int port, boolean autoClose) throws IOException {
            return base.createSocket(s, sni, port, autoClose);
        }

        @Override
        public String[] getDefaultCipherSuites() {
            return base.getDefaultCipherSuites();
        }

        @Override
        public String[] getSupportedCipherSuites() {
            return base.getSupportedCipherSuites();
        }

        @Override
        public java.net.Socket createSocket(String host, int port) throws IOException {
            return base.createSocket(host, port);
        }

        @Override
        public java.net.Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
            return base.createSocket(host, port, local, localPort);
        }

        @Override
        public java.net.Socket createSocket(InetAddress host, int port) throws IOException {
            return base.createSocket(host, port);
        }

        @Override
        public java.net.Socket createSocket(InetAddress address, int port, InetAddress local, int localPort) throws IOException {
            return base.createSocket(address, port, local, localPort);
        }
    }

    /** IP-адрес, записанный цифрами (без обращения к DNS); иначе null. */
    static InetAddress literal(String host) {
        if (host == null || host.isEmpty()) return null;
        String h = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        boolean v4 = h.matches("\\d{1,3}(\\.\\d{1,3}){3}");
        boolean v6 = h.indexOf(':') >= 0 && h.matches("[0-9a-fA-F:.]+");
        if (!v4 && !v6) return null;
        try {
            return InetAddress.getByName(h); // для цифрового адреса DNS не нужен
        } catch (IOException e) {
            return null;
        }
    }

    /** 198.18.0.0/15 — «поддельные» адреса VPN-клиентов (fake-ip). */
    static boolean isFakeIp(InetAddress a) {
        byte[] b = a.getAddress();
        return b.length == 4 && (b[0] & 0xff) == 198 && ((b[1] & 0xff) == 18 || (b[1] & 0xff) == 19);
    }

    /** Публичный адрес: не локальный, не частный, не служебный. */
    static boolean usable(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress()
                || a.isMulticastAddress()) return false;
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) {
            int b0 = b[0] & 0xff, b1 = b[1] & 0xff;
            if (b0 == 0 || b0 >= 224) return false;
            if (b0 == 100 && b1 >= 64 && b1 < 128) return false; // CGNAT
            return !isFakeIp(a);
        }
        if (a instanceof Inet6Address) return (b[0] & 0xfe) != 0xfc; // ULA fc00::/7
        return false;
    }

    private static <T> T get(Future<T> f, long ms) {
        try {
            return f.get(ms, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            return null;
        }
    }
}
