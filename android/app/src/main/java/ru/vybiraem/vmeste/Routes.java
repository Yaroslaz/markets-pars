package ru.vybiraem.vmeste;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Что прокси обхода помнит о маршрутах, как route_health.rs и dpi-routes.json в kadr:
 * <ul>
 *   <li>рабочий маршрут сайта (адрес + способ) — 12 часов, переживает перезапуск приложения (SharedPreferences);
 *       запоминается, только когда через него пришло ≥ 24 КБ или соединение закрылось чисто;</li>
 *   <li>маршрут, на котором ТСПУ «проглотил» ClientHello, отдыхает 2 мин, потом 6, потом до 15
 *       (неудачи старше 30 мин забываются) — новое соединение не ждёт на нём снова;</li>
 *   <li>маршрут, на котором соединение зависло, отдыхает 3 мин и перестаёт быть рабочим.</li>
 * </ul>
 * Время — в миллисекундах от эпохи (переживает перезапуск); передаётся снаружи, чтобы логику можно было проверить.
 */
final class Routes {
    static final long ROUTE_TTL_MS = 12 * 3600_000L;
    static final long FAIL_REST_MS = 2 * 60_000L;
    static final long REST_MAX_MS = 15 * 60_000L;
    static final long FAILURE_MEMORY_MS = 30 * 60_000L;
    static final long STALL_REST_MS = 3 * 60_000L;

    /** Где хранить рабочие маршруты между запусками (в приложении — SharedPreferences). */
    interface Store {
        String load();

        void save(String text);
    }

    static final class Route {
        final String ip;
        final String strategy;
        final long at;

        Route(String ip, String strategy, long at) {
            this.ip = ip;
            this.strategy = strategy;
            this.at = at;
        }
    }

    private final Store store;
    private final Map<String, Route> working = new HashMap<>();
    private final Map<String, long[]> failures = new HashMap<>(); // ключ → {число, когда}
    private final Map<String, Long> resting = new HashMap<>();

    Routes(Store store, long now) {
        this.store = store;
        String text = store == null ? null : store.load();
        if (text == null || text.isEmpty()) return;
        try {
            JSONObject o = new JSONObject(text);
            if (o.optInt("v") != 1) return;
            JSONObject hosts = o.optJSONObject("hosts");
            if (hosts == null) return;
            for (Iterator<String> it = hosts.keys(); it.hasNext(); ) {
                String host = it.next();
                JSONObject r = hosts.optJSONObject(host);
                if (r == null) continue;
                long at = r.optLong("at");
                String strategy = r.optString("strategy");
                if (now - at >= ROUTE_TTL_MS || at > now || !Desync.STRATEGIES.contains(strategy)) continue;
                working.put(host, new Route(r.optString("ip"), strategy, at));
            }
        } catch (JSONException ignored) {
        }
    }

    static String key(String host, String ip, String strategy) {
        return host + "|" + strategy + " " + ip;
    }

    /** Рабочий маршрут сайта за последние 12 часов или null. */
    synchronized Route working(String host, long now) {
        Route r = working.get(host);
        if (r != null && now - r.at >= ROUTE_TTL_MS) {
            working.remove(host);
            return null;
        }
        return r;
    }

    /** Маршрут проверен (пришло достаточно данных): запоминаем и прощаем прошлые неудачи. */
    synchronized void remember(String host, String ip, String strategy, long now) {
        String k = key(host, ip, strategy);
        failures.remove(k);
        resting.remove(k);
        Route old = working.get(host);
        working.put(host, new Route(ip, strategy, now));
        // Тот же маршрут, сохранённый недавно, — не переписываем файл на каждое соединение
        if (old == null || !old.ip.equals(ip) || !old.strategy.equals(strategy) || now - old.at > 10 * 60_000L) save(now);
    }

    /** Маршрут подвёл (соединение зависло): он отдыхает и больше не рабочий. */
    synchronized void stalled(String host, String ip, String strategy, long now) {
        Route r = working.get(host);
        if (r != null && r.ip.equals(ip) && r.strategy.equals(strategy)) {
            working.remove(host);
            save(now);
        }
        rest(key(host, ip, strategy), STALL_REST_MS, now);
    }

    /** ClientHello ушёл, а ServerHello не пришёл: 2 мин × 3^(n−1), не больше 15 мин. Возвращает срок отдыха. */
    synchronized long handshakeFailed(String key, long now) {
        long[] f = failures.get(key);
        long n = f != null && now - f[1] < FAILURE_MEMORY_MS ? f[0] + 1 : 1;
        if (failures.size() > 2048) failures.clear();
        failures.put(key, new long[] { n, now });
        long rest = FAIL_REST_MS;
        for (int i = 1; i < n && rest < REST_MAX_MS; i++) rest *= 3;
        rest = Math.min(rest, REST_MAX_MS);
        rest(key, rest, now);
        return rest;
    }

    synchronized boolean isResting(String key, long now) {
        Long until = resting.get(key);
        return until != null && until > now;
    }

    private void rest(String key, long ms, long now) {
        if (resting.size() > 4096) resting.values().removeIf(until -> until <= now);
        resting.put(key, now + ms);
    }

    private void save(long now) {
        if (store == null) return;
        JSONObject hosts = new JSONObject();
        try {
            for (Map.Entry<String, Route> e : working.entrySet()) {
                Route r = e.getValue();
                if (now - r.at >= ROUTE_TTL_MS) continue;
                hosts.put(e.getKey(), new JSONObject().put("ip", r.ip).put("strategy", r.strategy).put("at", r.at));
            }
            store.save(new JSONObject().put("v", 1).put("hosts", hosts).toString());
        } catch (JSONException ignored) {
        }
    }
}
