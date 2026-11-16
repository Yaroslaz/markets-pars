package ru.vybiraem.vmeste;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Локальный HTTP-прокси обхода блокировок (127.0.0.1, случайный порт) — на Java то же, что dpi-прокси kadr (net.rs):
 * <ol>
 *   <li>CONNECT host:443 → адреса сайта через DoH и систему ({@link Resolver});</li>
 *   <li>ClientHello от WebView читаем целиком и отправляем серверу «с разрывом» ({@link Desync}): tcp-seg, chunk16,
 *       tls-sni-rfc, в конце — как есть;</li>
 *   <li>маршруты (адрес × способ) перебираются наперегонки: следующий стартует, если прошлый не ответил за 400 мс,
 *       не больше трёх сразу; побеждает первый ServerHello, остальные закрываются. Рабочий маршрут запоминается
 *       ({@link Routes}) и в следующий раз идёт первым;</li>
 *   <li>дальше байты просто копируются в обе стороны. Если соединение зависло, не успев «доказать» маршрут
 *       (ТСПУ пропустил ServerHello, но режет поток), маршрут отдыхает, а соединение закрывается.</li>
 * </ol>
 * Обычный HTTP (GET http://…) пересылается как есть, с разрывом заголовка Host. Принимаем только с loopback.
 */
final class BypassProxy {
    private static final int RACE_WIDTH = 3;
    private static final long RACE_STAGGER_MS = 400;
    private static final long RACE_BUDGET_MS = 15_000;
    private static final int CONNECT_MS = 4_000;
    private static final int HELLO_MS = 4_000;
    /** WebView может открыть туннель заранее и прислать ClientHello позже. */
    private static final int FIRST_BYTES_MS = 20_000;
    private static final int MAX_IPS = 4;
    private static final long VERIFY_BYTES = 24 * 1024;
    private static final long STALL_MS = 6_000;
    private static final long IDLE_MS = 5 * 60_000;
    private static final int REQUEST_MIN_BYTES = 96;

    private static BypassProxy instance;

    private final ServerSocket server;
    private final ThreadPoolExecutor pool;
    private final Routes routes;
    /** Как в последний раз прошло соединение к сайту — для отчёта «Проверка связи». */
    private final Map<String, String> lastRoute = new ConcurrentHashMap<>();
    private final boolean debug;

    /** Прокси приложения (запускается при первом обращении); null — не удалось открыть порт. */
    static synchronized BypassProxy get(Context context) {
        if (instance != null && !instance.server.isClosed()) return instance;
        try {
            instance = new BypassProxy(context.getApplicationContext());
        } catch (IOException e) {
            instance = null;
        }
        return instance;
    }

    private BypassProxy(Context context) throws IOException {
        server = new ServerSocket(0, 64, InetAddress.getByAddress("localhost", new byte[] { 127, 0, 0, 1 }));
        pool = new ThreadPoolExecutor(0, 256, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
            Thread t = new Thread(r, "bypass");
            t.setDaemon(true);
            return t;
        });
        debug = (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        SharedPreferences prefs = context.getSharedPreferences("bypass", Context.MODE_PRIVATE);
        routes = new Routes(new Routes.Store() {
            @Override
            public String load() {
                return prefs.getString("routes", null);
            }

            @Override
            public void save(String text) {
                prefs.edit().putString("routes", text).apply();
            }
        }, System.currentTimeMillis());
        Thread accept = new Thread(this::acceptLoop, "bypass-accept");
        accept.setDaemon(true);
        accept.start();
    }

    int port() {
        return server.getLocalPort();
    }

    String routeOf(String host) {
        return lastRoute.get(host.toLowerCase(Locale.ROOT));
    }

    /** Запоминает, как прошло соединение; в отладочной сборке — ещё и в logcat (тег Bypass). */
    private void note(String host, String route) {
        lastRoute.put(host, route);
        if (debug) android.util.Log.i("Bypass", host + ": " + route);
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            Socket client;
            try {
                client = server.accept();
            } catch (IOException e) {
                if (server.isClosed()) return;
                continue;
            }
            if (!client.getInetAddress().isLoopbackAddress()) {
                close(client);
                continue;
            }
            try {
                pool.execute(() -> handle(client));
            } catch (RejectedExecutionException e) {
                close(client);
            }
        }
    }

    // ---------------------------------------------------------------- запрос

    private void handle(Socket client) {
        try {
            client.setTcpNoDelay(true);
            client.setSoTimeout(10_000);
            InputStream in = client.getInputStream();
            byte[] head = new byte[8192];
            int filled = 0;
            int headerEnd = -1;
            while (headerEnd < 0) {
                if (filled == head.length) return;
                int n = in.read(head, filled, head.length - filled);
                if (n <= 0) return;
                filled += n;
                headerEnd = indexOf(head, filled, new byte[] { '\r', '\n', '\r', '\n' });
            }
            headerEnd += 4;
            String headText = new String(head, 0, headerEnd, StandardCharsets.ISO_8859_1);
            int eol = headText.indexOf("\r\n");
            String[] first = headText.substring(0, eol).split(" ");
            if (first.length < 3) {
                reply(client, "400 Bad Request");
                return;
            }
            String method = first[0];
            String target = first[1];
            byte[] rest = Arrays.copyOfRange(head, headerEnd, filled);
            if ("CONNECT".equalsIgnoreCase(method)) {
                connect(client, target, rest);
            } else if (target.regionMatches(true, 0, "http://", 0, 7)) {
                forwardHttp(client, method, target, first[2], headText.substring(eol + 2), rest);
            } else {
                reply(client, "400 Bad Request");
            }
        } catch (IOException ignored) {
        } finally {
            close(client);
        }
    }

    /** host:port из CONNECT; null — адрес не годится (только 443 и 80, только публичные сайты). */
    private static String[] hostPort(String target, int defaultPort) {
        String host = target;
        int port = defaultPort;
        int colon = target.lastIndexOf(':');
        if (colon > 0 && target.indexOf(']') < colon) {
            host = target.substring(0, colon);
            try {
                port = Integer.parseInt(target.substring(colon + 1));
            } catch (NumberFormatException e) {
                return null;
            }
        }
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        host = host.toLowerCase(Locale.ROOT);
        if (port != 443 && port != 80) return null;
        InetAddress literal = Resolver.literal(host);
        if (literal != null ? !Resolver.usable(literal) : !Resolver.validHost(host) || host.equals("localhost") || host.endsWith(".localhost")) {
            return null;
        }
        return new String[] { host, String.valueOf(port) };
    }

    /** Адреса, к которым можно подключаться: публичные или «поддельные» адреса VPN. */
    private static List<InetAddress> targets(String host) {
        List<InetAddress> out = new ArrayList<>();
        for (InetAddress a : Resolver.resolve(host)) if (Resolver.usable(a) || Resolver.isFakeIp(a)) out.add(a);
        return out;
    }

    private void connect(Socket client, String target, byte[] rest) throws IOException {
        String[] hp = hostPort(target, 443);
        if (hp == null) {
            reply(client, "403 Forbidden");
            return;
        }
        String host = hp[0];
        int port = Integer.parseInt(hp[1]);
        List<InetAddress> ips = targets(host);
        if (ips.isEmpty()) {
            reply(client, "502 Bad Gateway");
            return;
        }
        OutputStream out = client.getOutputStream();
        out.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        // ClientHello целиком: WebView (с постквантовым обменом ключами) шлёт ~1,8–2,2 КБ, бывает — несколькими кусками
        ByteArrayOutputStream pkt = new ByteArrayOutputStream(4096);
        pkt.write(rest, 0, rest.length);
        InputStream in = client.getInputStream();
        byte[] buf = new byte[16384];
        try {
            client.setSoTimeout(FIRST_BYTES_MS);
            while (pkt.size() < 5) {
                int n = in.read(buf);
                if (n <= 0) break;
                pkt.write(buf, 0, n);
            }
            byte[] sofar = pkt.toByteArray();
            if (sofar.length >= 5 && (sofar[0] & 0xff) == 0x16 && (sofar[1] & 0xff) == 0x03) {
                int need = Desync.recordEnd(sofar, sofar.length);
                client.setSoTimeout(3_000);
                while (pkt.size() < need && need <= 5 + 16384) {
                    int n = in.read(buf);
                    if (n <= 0) break;
                    pkt.write(buf, 0, n);
                }
            }
        } catch (SocketTimeoutException ignored) {
        }
        byte[] hello = pkt.toByteArray();
        if (hello.length == 0) return;
        client.setSoTimeout(0);

        boolean tls = port == 443 && Desync.isTlsHandshake(hello, hello.length)
                && Desync.recordEnd(hello, hello.length) <= hello.length;
        if (tls) {
            Hit hit = race(host, port, ips, hello);
            if (hit == null) {
                note(host, "не удалось: ни один способ не дал ответа сервера");
                return;
            }
            note(host, hit.strategy + " " + hit.ip.getHostAddress());
            try {
                out.write(hit.reply);
                out.flush();
                relay(client, hit.socket, host, hit.ip, hit.strategy, hit.reply.length);
            } finally {
                close(hit.socket);
            }
            return;
        }
        Socket up = connectAny(ips, port);
        if (up == null) return;
        note(host, "напрямую " + up.getInetAddress().getHostAddress());
        try {
            up.getOutputStream().write(hello);
            up.getOutputStream().flush();
            relay(client, up, host, null, null, 0);
        } finally {
            close(up);
        }
    }

    /** GET http://host/path → тот же запрос серверу, с «Connection: close» и разрывом заголовка Host. */
    private void forwardHttp(Socket client, String method, String target, String version, String headers, byte[] rest) throws IOException {
        int pathAt = target.indexOf('/', 7);
        String authority = pathAt < 0 ? target.substring(7) : target.substring(7, pathAt);
        String path = pathAt < 0 ? "/" : target.substring(pathAt);
        String[] hp = hostPort(authority, 80);
        if (hp == null || method.indexOf('\r') >= 0) {
            reply(client, "403 Forbidden");
            return;
        }
        List<InetAddress> ips = targets(hp[0]);
        Socket up = ips.isEmpty() ? null : connectAny(ips, Integer.parseInt(hp[1]));
        if (up == null) {
            reply(client, "502 Bad Gateway");
            return;
        }
        note(hp[0], "http напрямую " + up.getInetAddress().getHostAddress());
        try {
            StringBuilder sb = new StringBuilder(method).append(' ').append(path).append(' ').append(version).append("\r\n");
            for (String line : headers.split("\r\n")) {
                if (line.isEmpty()) continue;
                String lower = line.toLowerCase(Locale.ROOT);
                if (lower.startsWith("proxy-connection:") || lower.startsWith("proxy-authorization:")
                        || lower.startsWith("connection:") || lower.startsWith("keep-alive:")) continue;
                sb.append(line).append("\r\n");
            }
            sb.append("Connection: close\r\n\r\n");
            byte[] req = sb.toString().getBytes(StandardCharsets.ISO_8859_1);
            OutputStream o = up.getOutputStream();
            int host = indexOfIgnoreCase(req, "\r\nhost:");
            if (host > 0) {
                // Заголовок Host — в двух TCP-сегментах: «\r\nHo» и «st: …»
                o.write(req, 0, host + 4);
                o.flush();
                sleep(2);
                o.write(req, host + 4, req.length - host - 4);
            } else {
                o.write(req);
            }
            o.write(rest);
            o.flush();
            relay(client, up, hp[0], null, null, 0);
        } finally {
            close(up);
        }
    }

    // ---------------------------------------------------------------- гонка маршрутов

    private static final class Hit {
        final Socket socket;
        final byte[] reply;
        final InetAddress ip;
        final String strategy;

        Hit(Socket socket, byte[] reply, InetAddress ip, String strategy) {
            this.socket = socket;
            this.reply = reply;
            this.ip = ip;
            this.strategy = strategy;
        }
    }

    private static final class Step {
        final InetAddress ip;
        final String strategy;

        Step(InetAddress ip, String strategy) {
            this.ip = ip;
            this.strategy = strategy;
        }
    }

    /** Итог одного маршрута: hit, «адрес недоступен» (остальные способы на нём не пробуем) или «нет ServerHello». */
    private static final class Outcome {
        final Step step;
        final Hit hit;
        final boolean unreachable;
        /** Почему не вышло — для журнала отладочной сборки. */
        final String why;

        Outcome(Step step, Hit hit, boolean unreachable) {
            this(step, hit, unreachable, null);
        }

        Outcome(Step step, Hit hit, boolean unreachable, String why) {
            this.step = step;
            this.hit = hit;
            this.unreachable = unreachable;
            this.why = why;
        }
    }

    /** Общее состояние гонки: после её конца проигравшие закрывают свои сокеты сами. */
    private static final class Race {
        boolean done;
        final List<Socket> sockets = new ArrayList<>();
        final LinkedBlockingQueue<Outcome> results = new LinkedBlockingQueue<>();
    }

    private Hit race(String host, int port, List<InetAddress> ips, byte[] hello) {
        long now = System.currentTimeMillis();
        List<InetAddress> candidates = new ArrayList<>(ips);
        String preferred = null;
        Routes.Route working = routes.working(host, now);
        if (working != null) {
            InetAddress a = Resolver.literal(working.ip);
            if (a != null && (Resolver.usable(a) || Resolver.isFakeIp(a))) {
                candidates.remove(a);
                candidates.add(0, a);
                preferred = working.strategy;
            }
        }
        if (candidates.size() > MAX_IPS) candidates = new ArrayList<>(candidates.subList(0, MAX_IPS));
        List<String> order = new ArrayList<>(Desync.STRATEGIES);
        if (preferred != null) {
            order.remove(preferred);
            order.add(0, preferred);
        }
        // Сначала способы с разрывом по всем адресам, затем «как есть», затем отдыхающие после неудачи
        List<Step> steps = new ArrayList<>();
        List<Step> plain = new ArrayList<>();
        List<Step> resting = new ArrayList<>();
        for (InetAddress ip : candidates) {
            for (String s : order) {
                if (Desync.plan(hello, host, s) == null) continue;
                Step step = new Step(ip, s);
                if (routes.isResting(Routes.key(host, ip.getHostAddress(), s), now)) resting.add(step);
                else if (Desync.PLAIN.equals(s) && !s.equals(preferred)) plain.add(step);
                else steps.add(step);
            }
        }
        steps.addAll(plain);
        steps.addAll(resting);

        Race race = new Race();
        Set<InetAddress> dead = new HashSet<>();
        Hit winner = null;
        int running = 0;
        int next = 0;
        long deadline = System.currentTimeMillis() + RACE_BUDGET_MS;
        try {
            while (true) {
                while (next < steps.size() && dead.contains(steps.get(next).ip)) next++;
                if (next < steps.size() && running < RACE_WIDTH) {
                    Step step = steps.get(next++);
                    try {
                        pool.execute(() -> {
                            Outcome o = attempt(race, step, port, hello, host);
                            synchronized (race) {
                                if (race.done) {
                                    if (o != null && o.hit != null) close(o.hit.socket);
                                } else {
                                    race.results.add(o != null ? o : new Outcome(step, null, false));
                                }
                            }
                        });
                        running++;
                    } catch (RejectedExecutionException e) {
                        if (running == 0) return null;
                    }
                }
                if (running == 0) return null;
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) return null;
                boolean more = next < steps.size();
                Outcome o = race.results.poll(more ? Math.min(RACE_STAGGER_MS, left) : left, TimeUnit.MILLISECONDS);
                if (o == null) continue;
                running--;
                if (o.hit != null) {
                    winner = o.hit;
                    return winner;
                }
                if (o.unreachable) dead.add(o.step.ip);
                else routes.handshakeFailed(Routes.key(host, o.step.ip.getHostAddress(), o.step.strategy), System.currentTimeMillis());
                if (debug) android.util.Log.i("Bypass", host + ": " + o.step.strategy + " " + o.step.ip.getHostAddress()
                        + (o.unreachable ? " — адрес недоступен" : " — нет ServerHello") + (o.why != null ? " (" + o.why + ")" : ""));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            synchronized (race) {
                race.done = true;
                for (Socket s : race.sockets) if (winner == null || s != winner.socket) close(s);
                Outcome o;
                while ((o = race.results.poll()) != null) if (o.hit != null && o.hit != winner) close(o.hit.socket);
            }
        }
    }

    /** Один маршрут: TCP, ClientHello по способу, ждём начало ответа сервера. */
    private static Outcome attempt(Race race, Step step, int port, byte[] hello, String host) {
        Socket s = new Socket();
        synchronized (race) {
            if (race.done) return null;
            race.sockets.add(s);
        }
        try {
            s.setTcpNoDelay(true);
            try {
                s.connect(new InetSocketAddress(step.ip, port), CONNECT_MS);
            } catch (IOException e) {
                close(s);
                return new Outcome(step, null, true, e.toString());
            }
            Desync.Plan plan = Desync.plan(hello, host, step.strategy);
            if (plan == null) throw new IOException("no plan");
            OutputStream out = s.getOutputStream();
            for (int i = 0; i < plan.writes.size(); i++) {
                out.write(plan.writes.get(i));
                out.flush();
                if (i + 1 < plan.writes.size() && plan.delayMs > 0) Thread.sleep(plan.delayMs);
            }
            s.setSoTimeout(HELLO_MS);
            InputStream in = s.getInputStream();
            byte[] buf = new byte[16384];
            int n = 0;
            while (n < 2) {
                int r = in.read(buf, n, buf.length - n);
                if (r <= 0) break;
                n += r;
            }
            int type = n >= 2 ? buf[0] & 0xff : -1;
            // ServerHello (рукопожатие); «как есть» передаёт браузеру и отказ сервера (alert) — это настоящий ответ
            boolean ok = n >= 2 && (buf[1] & 0xff) == 0x03
                    && (type == 0x16 || (type == 0x15 && Desync.PLAIN.equals(step.strategy)));
            if (!ok) {
                close(s);
                return new Outcome(step, null, false, n <= 0 ? "сервер закрыл соединение" : String.format("ответ %02x %02x", buf[0], n > 1 ? buf[1] : 0));
            }
            s.setSoTimeout(0);
            return new Outcome(step, new Hit(s, Arrays.copyOf(buf, n), step.ip, step.strategy), false);
        } catch (IOException | InterruptedException e) {
            close(s);
            return new Outcome(step, null, false, e.toString());
        }
    }

    private static Socket connectAny(List<InetAddress> ips, int port) {
        for (int i = 0; i < Math.min(ips.size(), 3); i++) {
            Socket s = new Socket();
            try {
                s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress(ips.get(i), port), CONNECT_MS);
                return s;
            } catch (IOException e) {
                close(s);
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- копирование

    /** Копирует данные в обе стороны, пока одна из сторон не закроется. */
    private void relay(Socket client, Socket up, String host, InetAddress ip, String strategy, int firstDown) throws IOException {
        final long[] lastRequest = { 0 };
        final long[] lastActivity = { System.currentTimeMillis() };
        InputStream clientIn = client.getInputStream();
        OutputStream upOut = up.getOutputStream();
        Future<?> upstream;
        try {
            upstream = pool.submit(() -> {
                byte[] buf = new byte[16384];
                try {
                    while (true) {
                        int n = clientIn.read(buf);
                        if (n < 0) {
                            up.shutdownOutput();
                            return;
                        }
                        long now = System.currentTimeMillis();
                        lastActivity[0] = now;
                        if (n >= REQUEST_MIN_BYTES) lastRequest[0] = now;
                        upOut.write(buf, 0, n);
                        upOut.flush();
                    }
                } catch (IOException e) {
                    close(up);
                    close(client);
                }
            });
        } catch (RejectedExecutionException e) {
            return;
        }
        boolean watch = strategy != null;
        TlsRecords records = new TlsRecords();
        long down = firstDown;
        long lastDown = System.currentTimeMillis();
        boolean verified = false;
        boolean clean = false;
        InputStream upIn = up.getInputStream();
        OutputStream clientOut = client.getOutputStream();
        byte[] buf = new byte[16384];
        try {
            up.setSoTimeout(1000);
            while (true) {
                int n;
                try {
                    n = upIn.read(buf);
                } catch (SocketTimeoutException e) {
                    long now = System.currentTimeMillis();
                    if (watch && !verified) {
                        boolean noAnswer = lastRequest[0] > lastDown && now - lastRequest[0] >= STALL_MS;
                        boolean cutOff = records.incomplete() && now - lastDown >= STALL_MS;
                        if (noAnswer || cutOff) {
                            // ServerHello прошёл, а поток стоит — ТСПУ режет соединение: маршрут отдыхает, браузер переподключится
                            routes.stalled(host, ip.getHostAddress(), strategy, now);
                            note(host, strategy + " " + ip.getHostAddress() + " — завис, пробую другой способ");
                            return;
                        }
                    }
                    if (now - Math.max(lastActivity[0], lastDown) > IDLE_MS || upstream.isDone() && client.isClosed()) return;
                    continue;
                }
                if (n < 0) {
                    clean = true;
                    break;
                }
                if (watch) records.feed(buf, n);
                down += n;
                lastDown = System.currentTimeMillis();
                if (watch && !verified && down >= VERIFY_BYTES) {
                    verified = true;
                    routes.remember(host, ip.getHostAddress(), strategy, lastDown);
                }
                clientOut.write(buf, 0, n);
                clientOut.flush();
            }
            if (clean && watch && !verified && down > firstDown) routes.remember(host, ip.getHostAddress(), strategy, System.currentTimeMillis());
            try {
                client.shutdownOutput();
            } catch (IOException ignored) {
            }
            // Сервер закрыл соединение — даём браузеру дочитать и закрыть свою сторону
            try {
                upstream.get(2, TimeUnit.SECONDS);
            } catch (Exception ignored) {
            }
        } catch (IOException ignored) {
        } finally {
            close(up);
            close(client);
            upstream.cancel(true);
        }
    }

    /** Где кончается текущая запись TLS от сервера — чтобы отличить запись, оборванную на середине, от тишины. */
    static final class TlsRecords {
        private final byte[] header = new byte[5];
        private int headerLen;
        private int left;
        private boolean broken;

        void feed(byte[] data, int len) {
            int p = 0;
            while (p < len && !broken) {
                if (left > 0) {
                    int take = Math.min(left, len - p);
                    left -= take;
                    p += take;
                    continue;
                }
                header[headerLen++] = data[p++];
                if (headerLen == 5) {
                    int type = header[0] & 0xff;
                    if (type < 0x14 || type > 0x18 || (header[1] & 0xff) != 0x03) {
                        broken = true;
                        return;
                    }
                    left = ((header[3] & 0xff) << 8) | (header[4] & 0xff);
                    headerLen = 0;
                }
            }
        }

        boolean incomplete() {
            return !broken && (left > 0 || headerLen > 0);
        }
    }

    // ---------------------------------------------------------------- мелочи

    private static void reply(Socket client, String status) {
        try {
            OutputStream out = client.getOutputStream();
            out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException ignored) {
        }
    }

    static void close(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static int indexOf(byte[] buf, int len, byte[] what) {
        outer:
        for (int i = 0; i + what.length <= len; i++) {
            for (int j = 0; j < what.length; j++) if (buf[i + j] != what[j]) continue outer;
            return i;
        }
        return -1;
    }

    private static int indexOfIgnoreCase(byte[] buf, String what) {
        byte[] w = what.getBytes(StandardCharsets.ISO_8859_1);
        outer:
        for (int i = 0; i + w.length <= buf.length; i++) {
            for (int j = 0; j < w.length; j++) {
                int c = buf[i + j] & 0xff;
                if (c >= 'A' && c <= 'Z') c += 32;
                if (c != w[j]) continue outer;
            }
            return i;
        }
        return -1;
    }
}
