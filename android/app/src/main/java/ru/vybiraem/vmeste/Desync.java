package ru.vybiraem.vmeste;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Как отправить первый пакет TLS (ClientHello) так, чтобы ТСПУ не прочитал в нём имя сайта (SNI).
 * Без Android-зависимостей — проверяется обычным JVM-тестом. Логика та же, что в kadr
 * ({@code planClientHelloWrites} в server/node/dpi-bypass.ts и {@code write_tls_client_hello_desync} в net.rs):
 * <ul>
 *   <li>{@code tcp-seg} — запись TLS как есть, но тремя TCP-сегментами: [0,2) [2,середина имени) [середина имени,конец);</li>
 *   <li>{@code chunk16} — первые 640 байт кусками по 16 байт, остальное разом;</li>
 *   <li>{@code tls-sni-rfc} — две отдельные записи TLS, разрез за 3 байта до середины имени (первая ≥ 9 байт рукопожатия);</li>
 *   <li>{@code plain} — без разбиения (запасной путь для строгих серверов).</li>
 * </ul>
 * Сервер собирает ClientHello из любых сегментов и записей, а ТСПУ, который смотрит только в первый сегмент
 * или первую запись, имени целиком не видит.
 */
final class Desync {
    static final String TCP_SEG = "tcp-seg";
    static final String CHUNK16 = "chunk16";
    static final String TLS_SNI_RFC = "tls-sni-rfc";
    static final String PLAIN = "plain";
    /** Порядок, в котором пробуем способы для нового сайта. */
    static final List<String> STRATEGIES = Collections.unmodifiableList(Arrays.asList(TCP_SEG, CHUNK16, TLS_SNI_RFC, PLAIN));

    private Desync() {
    }

    /** Записи в сокет по очереди и пауза между ними. */
    static final class Plan {
        final List<byte[]> writes;
        final int delayMs;

        Plan(List<byte[]> writes, int delayMs) {
            this.writes = writes;
            this.delayMs = delayMs;
        }
    }

    /** Начало и конец имени сайта (SNI) внутри буфера. */
    static final class Range {
        final int start;
        final int end;

        Range(int start, int end) {
            this.start = start;
            this.end = end;
        }
    }

    static boolean isTlsHandshake(byte[] buf, int len) {
        return len >= 10 && (buf[0] & 0xff) == 0x16 && (buf[1] & 0xff) == 0x03;
    }

    /** Длина первой записи TLS вместе с заголовком (5 байт); -1 — заголовок ещё не пришёл. */
    static int recordEnd(byte[] buf, int len) {
        if (len < 5) return -1;
        return 5 + (((buf[3] & 0xff) << 8) | (buf[4] & 0xff));
    }

    /**
     * Имя сайта из расширения server_name первой записи ClientHello: разбираем рукопожатие по полям.
     * null — это не ClientHello или расширения нет (тогда ищем имя как строку).
     */
    static Range findSni(byte[] buf) {
        if (!isTlsHandshake(buf, buf.length)) return null;
        int recEnd = Math.min(recordEnd(buf, buf.length), buf.length);
        int p = 5;
        if (p + 4 > recEnd || (buf[p] & 0xff) != 0x01) return null; // handshake type: client_hello
        p += 4; // тип + длина (3 байта)
        p += 2 + 32; // версия + random
        if (p + 1 > recEnd) return null;
        p += 1 + (buf[p] & 0xff); // session_id
        if (p + 2 > recEnd) return null;
        p += 2 + u16(buf, p); // cipher_suites
        if (p + 1 > recEnd) return null;
        p += 1 + (buf[p] & 0xff); // compression_methods
        if (p + 2 > recEnd) return null;
        int extEnd = Math.min(p + 2 + u16(buf, p), recEnd);
        p += 2;
        while (p + 4 <= extEnd) {
            int type = u16(buf, p);
            int len = u16(buf, p + 2);
            int data = p + 4;
            if (data + len > extEnd) return null;
            if (type == 0x0000) {
                // server_name_list: длина (2), тип имени (1) = host_name, длина имени (2), имя
                if (len < 5 || (buf[data + 2] & 0xff) != 0) return null;
                int nameLen = u16(buf, data + 3);
                int start = data + 5;
                if (nameLen == 0 || start + nameLen > data + len) return null;
                return new Range(start, start + nameLen);
            }
            p = data + len;
        }
        return null;
    }

    /**
     * Середина имени сайта (от начала буфера): по разбору ClientHello, а если не вышло — поиском имени
     * без учёта регистра, как в kadr. -1 — имени в первой записи нет.
     */
    static int sniSplitOffset(byte[] buf, String host) {
        if (!isTlsHandshake(buf, buf.length)) return -1;
        int recEnd = recordEnd(buf, buf.length);
        if (recEnd <= 9 || recEnd > buf.length) return -1;
        Range sni = findSni(buf);
        if (sni != null && sni.end - sni.start >= 2) {
            int mid = sni.start + (sni.end - sni.start) / 2;
            if (mid > 5 && mid < recEnd) return mid;
        }
        if (host == null || host.length() < 4) return -1;
        byte[] name = host.toLowerCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        outer:
        for (int i = 5; i + name.length <= recEnd; i++) {
            for (int j = 0; j < name.length; j++) {
                int c = buf[i + j] & 0xff;
                if (c >= 'A' && c <= 'Z') c += 32;
                if (c != (name[j] & 0xff)) continue outer;
            }
            int mid = i + name.length / 2;
            return mid > 5 && mid < recEnd ? mid : -1;
        }
        return -1;
    }

    /**
     * Как уйдёт ClientHello при данном способе. null — способ здесь неприменим (не TLS, запись пришла не целиком,
     * нет имени для разреза) — тогда этот способ пропускаем.
     */
    static Plan plan(byte[] buf, String host, String strategy) {
        if (PLAIN.equals(strategy)) return new Plan(Collections.singletonList(buf), 0);
        if (!isTlsHandshake(buf, buf.length)) return null;
        int recEnd = recordEnd(buf, buf.length);
        if (recEnd > buf.length) return null;
        switch (strategy) {
            case TCP_SEG: {
                int mid = sniSplitOffset(buf, host);
                if (mid < 0) mid = Math.min(Math.max(buf.length / 2, 2), buf.length - 1);
                List<byte[]> writes = new ArrayList<>(3);
                if (mid > 2 && mid < buf.length) {
                    writes.add(Arrays.copyOfRange(buf, 0, 2));
                    writes.add(Arrays.copyOfRange(buf, 2, mid));
                    writes.add(Arrays.copyOfRange(buf, mid, buf.length));
                } else {
                    writes.add(Arrays.copyOfRange(buf, 0, 1));
                    writes.add(Arrays.copyOfRange(buf, 1, buf.length));
                }
                return new Plan(writes, 4);
            }
            case CHUNK16: {
                int limit = Math.min(buf.length, 640);
                List<byte[]> writes = new ArrayList<>(limit / 16 + 2);
                for (int i = 0; i < limit; i += 16) writes.add(Arrays.copyOfRange(buf, i, Math.min(i + 16, limit)));
                if (limit < buf.length) writes.add(Arrays.copyOfRange(buf, limit, buf.length));
                return new Plan(writes, 2);
            }
            case TLS_SNI_RFC: {
                if (buf.length < 14 || recEnd - 5 <= 9) return null;
                int mid = sniSplitOffset(buf, host);
                if (mid <= 14 || mid >= recEnd) return null;
                int cut = Math.max(mid - 3, 14);
                byte[] first = record(buf, 5, cut, null, 0);
                byte[] second = record(buf, cut, recEnd, buf, recEnd);
                List<byte[]> writes = new ArrayList<>(2);
                writes.add(first);
                writes.add(second);
                return new Plan(writes, 4);
            }
            default:
                return null;
        }
    }

    /** Запись TLS-рукопожатия с куском buf[from, to); tail[tailFrom…] (что пришло после записи) — следом. */
    private static byte[] record(byte[] buf, int from, int to, byte[] tail, int tailFrom) {
        int len = to - from;
        int tailLen = tail == null ? 0 : tail.length - tailFrom;
        byte[] out = new byte[5 + len + tailLen];
        out[0] = 0x16;
        out[1] = buf[1];
        out[2] = buf[2];
        out[3] = (byte) (len >> 8);
        out[4] = (byte) len;
        System.arraycopy(buf, from, out, 5, len);
        if (tailLen > 0) System.arraycopy(tail, tailFrom, out, 5 + len, tailLen);
        return out;
    }

    private static int u16(byte[] b, int p) {
        return ((b[p] & 0xff) << 8) | (b[p + 1] & 0xff);
    }
}
