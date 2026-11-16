package ru.vybiraem.vmeste;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PersistableBundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Уведомления без Firebase и других сторонних сервисов: приложение само спрашивает у своего сервера
 * новые события (GET /api/events) — раз в ~15 минут через системный JobScheduler и сразу при запуске
 * и уходе в фон — и показывает их обычными локальными уведомлениями.
 *
 * Адрес сервера, вход, роль и настройки присылает сайт (сообщение notify-config) — они лежат
 * в закрытых настройках приложения. Свои действия (actor = своя роль) не показываются.
 * «Курсор» lastId — последнее событие, которое человек уже видел: пока приложение открыто, сайт
 * показывает всё вживую, поэтому проверки при запуске и уходе в фон только сдвигают курсор, а
 * уведомления приходят о том, что случилось, пока приложение закрыто.
 */
final class Notifier {
    private static final String TAG = "Notifier";
    static final int JOB_PERIODIC = 1;
    static final int JOB_NOW = 2;
    static final String EXTRA_SILENT = "silent";
    static final String EXTRA_BOARD = "mp_board";
    static final String EXTRA_CARD = "mp_card";
    static final String ACTION_OPEN = "ru.vybiraem.vmeste.OPEN_CARD";

    private static final String PREFS = "notify";
    private static final String CHANNEL = "events";
    private static final String CHANNEL_QUIET = "events_quiet";
    private static final String GROUP = "events";
    private static final int SUMMARY_ID = 100;
    private static final String[] KINDS = { "like", "match", "add", "board" };
    private static final String[] KIND_SETTINGS = { "likes", "matches", "adds", "boards" };
    private static final String[] ACTORS = { "m", "f", "" };

    private Notifier() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ------------------------------ Настройки ------------------------------ */

    /** {"type":"notify-config","api":…,"token":…,"role":"m"|"f","settings":{on, likes, …, quiet, from, to}} */
    static void saveConfig(Context c, JSONObject msg) {
        SharedPreferences p = prefs(c);
        String api = msg.optString("api", "").replaceAll("/+$", "");
        if (!api.isEmpty() && !api.startsWith("https://") && !api.startsWith("http://")) api = "";
        JSONObject settings = msg.optJSONObject("settings");
        SharedPreferences.Editor e = p.edit()
                .putString("api", api)
                .putString("token", msg.optString("token", ""))
                .putString("role", msg.optString("role", ""))
                .putString("settings", settings != null ? settings.toString() : "{}");
        // Другой сервер — другие события: начинаем с чистого листа, без уведомлений о старом
        if (!api.equals(p.getString("api", ""))) e.putLong("lastId", -1).putLong("since", 0);
        e.apply();
        schedule(c);
    }

    private static JSONObject settings(SharedPreferences p) {
        try {
            return new JSONObject(p.getString("settings", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static boolean enabled(Context c) {
        SharedPreferences p = prefs(c);
        return settings(p).optBoolean("on", false) && !p.getString("api", "").isEmpty() && !p.getString("token", "").isEmpty();
    }

    /* ------------------------------ Расписание ------------------------------ */

    /** Периодическая проверка (не чаще раза в 15 минут — ограничение Android), только при наличии сети. */
    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        if (!enabled(c)) {
            js.cancel(JOB_PERIODIC);
            js.cancel(JOB_NOW);
            return;
        }
        if (js.getPendingJob(JOB_PERIODIC) != null) return;
        js.schedule(new JobInfo.Builder(JOB_PERIODIC, new ComponentName(c, NotifyJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L, 5 * 60 * 1000L)
                .setPersisted(true) // переживает перезагрузку телефона (нужен RECEIVE_BOOT_COMPLETED)
                .build());
    }

    /** Разовая проверка как можно скорее (как только будет сеть). silent — только сдвинуть курсор. */
    static void checkSoon(Context c, boolean silent) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || !enabled(c)) return;
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean(EXTRA_SILENT, silent);
        js.schedule(new JobInfo.Builder(JOB_NOW, new ComponentName(c, NotifyJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setExtras(extras)
                .build());
    }

    /* ------------------------------ Проверка ------------------------------ */

    /** Запрос к серверу и показ новых событий. Вызывается в фоновом потоке. */
    static void check(Context c, boolean silent) {
        SharedPreferences p = prefs(c);
        if (!enabled(c)) return;
        String api = p.getString("api", "");
        String token = p.getString("token", "");
        String role = p.getString("role", "");
        long since = p.getLong("since", 0);
        long lastId = p.getLong("lastId", -1);
        JSONObject answer;
        try {
            answer = new JSONObject(get(api + "/api/events?since=" + since, token));
        } catch (Exception e) {
            Log.w(TAG, "check failed: " + e.getMessage());
            return;
        }
        JSONArray all = answer.optJSONArray("events");
        if (all == null) return;
        JSONObject s = settings(p);
        List<JSONObject> fresh = new ArrayList<>();
        Set<String> matched = new HashSet<>();
        long maxId = Math.max(lastId, 0);
        for (int i = all.length() - 1; i >= 0; i--) { // сервер отдаёт новые сверху — идём от старых к новым
            JSONObject e = all.optJSONObject(i);
            if (e == null) continue;
            long id = e.optLong("id");
            maxId = Math.max(maxId, id);
            if (lastId < 0 || id <= lastId) continue;
            String actor = e.isNull("actor") ? "" : e.optString("actor");
            if (!actor.isEmpty() && actor.equals(role)) continue; // своё действие
            int k = kindIndex(e.optString("kind"));
            if (k < 0 || !s.optBoolean(KIND_SETTINGS[k], true)) continue;
            if ("match".equals(e.optString("kind"))) matched.add(e.optString("cardId"));
            fresh.add(e);
        }
        // Лайк, который сразу дал совпадение, показываем только как совпадение
        fresh.removeIf(e -> "like".equals(e.optString("kind")) && matched.contains(e.optString("cardId")));
        // Пока приложение на экране, сайт показывает всё сам — уведомления не нужны
        boolean quietly = silent || lastId < 0 || MainActivity.visible;
        p.edit()
                .putLong("lastId", maxId)
                // Небольшой запас по времени: события ловим по номеру, а «since» лишь ограничивает выборку
                .putLong("since", Math.max(0, answer.optLong("now", System.currentTimeMillis()) - 5 * 60 * 1000L))
                .apply();
        if (!quietly && !fresh.isEmpty()) show(c, fresh, quietHours(s));
    }

    private static int kindIndex(String kind) {
        for (int i = 0; i < KINDS.length; i++) if (KINDS[i].equals(kind)) return i;
        return -1;
    }

    private static String get(String url, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    if (out.size() > 512 * 1024) throw new IllegalStateException("too large");
                }
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            conn.disconnect();
        }
    }

    /** Тихие часы (например, 23:00–08:00): уведомления приходят без звука и вибрации. */
    static boolean quietHours(JSONObject s) {
        if (!s.optBoolean("quiet", false)) return false;
        int from = minutes(s.optString("from")), to = minutes(s.optString("to"));
        if (from < 0 || to < 0 || from == to) return false;
        Calendar now = Calendar.getInstance();
        int m = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        return from < to ? m >= from && m < to : m >= from || m < to;
    }

    private static int minutes(String hhmm) {
        if (hhmm == null || !hhmm.matches("\\d\\d:\\d\\d")) return -1;
        return Integer.parseInt(hhmm.substring(0, 2)) * 60 + Integer.parseInt(hhmm.substring(3));
    }

    /* ------------------------------ Показ ------------------------------ */

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel main = new NotificationChannel(CHANNEL, c.getString(R.string.notify_channel), NotificationManager.IMPORTANCE_DEFAULT);
        main.setDescription(c.getString(R.string.notify_channel_desc));
        NotificationChannel quiet = new NotificationChannel(CHANNEL_QUIET, c.getString(R.string.notify_channel_quiet), NotificationManager.IMPORTANCE_LOW);
        quiet.setDescription(c.getString(R.string.notify_channel_quiet_desc));
        nm.createNotificationChannel(main);
        nm.createNotificationChannel(quiet);
    }

    /**
     * Одно уведомление на «тип + автор» (например, все лайки девушки): новые события добавляются
     * к уже показанному — «Девушка лайкнула 3 товара». Несколько таких уведомлений собираются в группу.
     */
    private static void show(Context c, List<JSONObject> events, boolean quiet) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return;
        ensureChannels(c);
        Map<Integer, List<JSONObject>> groups = new LinkedHashMap<>();
        for (JSONObject e : events) {
            int id = notificationId(e);
            List<JSONObject> list = groups.get(id);
            if (list == null) groups.put(id, list = new ArrayList<>());
            list.add(0, e); // новые сверху
        }
        Map<Integer, JSONArray> shown = new LinkedHashMap<>();
        for (StatusBarNotification sbn : nm.getActiveNotifications()) {
            String items = sbn.getNotification().extras.getString("mp_items");
            if (items == null) continue;
            try {
                shown.put(sbn.getId(), new JSONArray(items));
            } catch (JSONException ignored) {
            }
        }
        for (Map.Entry<Integer, List<JSONObject>> g : groups.entrySet()) {
            List<JSONObject> items = new ArrayList<>(g.getValue());
            Set<Long> seen = new HashSet<>();
            for (JSONObject e : items) seen.add(e.optLong("id"));
            JSONArray before = shown.get(g.getKey());
            for (int i = 0; before != null && i < before.length() && items.size() < 30; i++) {
                JSONObject e = before.optJSONObject(i);
                if (e != null && seen.add(e.optLong("id"))) items.add(e);
            }
            nm.notify(g.getKey(), build(c, items, quiet));
            shown.put(g.getKey(), new JSONArray(items));
        }
        if (shown.size() > 1) nm.notify(SUMMARY_ID, summary(c, shown.size(), quiet));
    }

    private static int notificationId(JSONObject e) {
        String actor = e.isNull("actor") ? "" : e.optString("actor");
        int a = 2;
        for (int i = 0; i < ACTORS.length; i++) if (ACTORS[i].equals(actor)) a = i;
        return 101 + kindIndex(e.optString("kind")) * 3 + a;
    }

    private static Notification build(Context c, List<JSONObject> items, boolean quiet) {
        JSONObject top = items.get(0);
        String kind = top.optString("kind");
        String actor = top.isNull("actor") ? "" : top.optString("actor");
        int n = items.size();
        Notification.InboxStyle inbox = new Notification.InboxStyle();
        for (int i = 0; i < Math.min(n, 5); i++) inbox.addLine(line(items.get(i)));
        if (n > 5) inbox.setSummaryText("и ещё " + (n - 5));
        String board = top.optString("board", "main");
        boolean oneBoard = true;
        for (JSONObject e : items) oneBoard &= board.equals(e.optString("board"));
        Notification.Builder b = new Notification.Builder(c, quiet ? CHANNEL_QUIET : CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(0xFFFF4F9A)
                .setContentTitle(heading(kind, actor, n))
                .setContentText(n == 1 ? line(top) : joinLines(items))
                .setStyle(n > 1 ? inbox : new Notification.BigTextStyle().bigText(line(top)))
                .setWhen(top.optLong("createdAt", System.currentTimeMillis()))
                .setShowWhen(true)
                .setNumber(n)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setCategory(Notification.CATEGORY_SOCIAL)
                .setGroup(GROUP)
                .setContentIntent(openIntent(c, notificationId(top), board, "board".equals(kind) || top.isNull("cardId") ? null : top.optString("cardId")));
        if (oneBoard && !"main".equals(board) && !"board".equals(kind) && !top.isNull("boardName")) {
            b.setSubText(top.optString("boardName"));
        }
        Notification notification = b.build();
        JSONArray keep = new JSONArray();
        for (JSONObject e : items) keep.put(e);
        notification.extras.putString("mp_items", keep.toString());
        return notification;
    }

    private static Notification summary(Context c, int groups, boolean quiet) {
        return new Notification.Builder(c, quiet ? CHANNEL_QUIET : CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(0xFFFF4F9A)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText("Новое в подборках")
                .setGroup(GROUP)
                .setGroupSummary(true)
                .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openIntent(c, SUMMARY_ID, null, null))
                .build();
    }

    private static PendingIntent openIntent(Context c, int requestCode, String board, String card) {
        Intent intent = new Intent(c, MainActivity.class)
                .setAction(ACTION_OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (board != null) intent.putExtra(EXTRA_BOARD, board);
        if (card != null && !card.isEmpty()) intent.putExtra(EXTRA_CARD, card);
        return PendingIntent.getActivity(c, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String line(JSONObject e) {
        if ("board".equals(e.optString("kind"))) return "«" + e.optString("title", "Подборка") + "»";
        String title = e.isNull("title") ? "" : e.optString("title");
        return title.isEmpty() ? "Товар" : title;
    }

    private static String joinLines(List<JSONObject> items) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(items.size(), 3); i++) {
            if (i > 0) sb.append(", ");
            sb.append(line(items.get(i)));
        }
        return sb.toString();
    }

    private static String plural(int n, String one, String few, String many) {
        int m10 = n % 10, m100 = n % 100;
        return m10 == 1 && m100 != 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
    }

    private static String goods(int n) {
        return n == 1 ? "товар" : n + " " + plural(n, "товар", "товара", "товаров");
    }

    /** Те же тексты, что и у Web Push на сайте (docs/sw.js). */
    static String heading(String kind, String actor, int n) {
        String who = "m".equals(actor) ? "Парень" : "f".equals(actor) ? "Девушка" : null;
        boolean she = "f".equals(actor);
        switch (kind) {
            case "like":
                return (who != null ? who : "Кто-то") + (she ? " лайкнула " : " лайкнул ") + goods(n);
            case "match":
                return n == 1 ? "Совпадение! Нравится обоим" : n + " " + plural(n, "совпадение", "совпадения", "совпадений") + " — нравится обоим";
            case "add":
                if (who != null) return who + (she ? " добавила " : " добавил ") + goods(n);
                return n == 1 ? "Новый товар в подборке" : "Новые товары: " + n;
            case "board":
                if (n > 1) return who != null ? who + (she ? " создала " : " создал ") + n + " " + plural(n, "подборку", "подборки", "подборок") : "Новые подборки: " + n;
                return who != null ? who + (she ? " создала подборку" : " создал подборку") : "Новая подборка";
            default:
                return "Выбираем вместе";
        }
    }
}
