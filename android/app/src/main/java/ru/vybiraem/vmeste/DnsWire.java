package ru.vybiraem.vmeste;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** DNS-запрос и ответ в «проводном» формате (RFC 1035) — для DoH по RFC 8484. Без Android-зависимостей. */
final class DnsWire {
    private DnsWire() {
    }

    /** Ответ: адреса IPv4 и наименьший TTL (секунды). */
    static final class Answer {
        final List<String> ips;
        final int ttl;

        Answer(List<String> ips, int ttl) {
            this.ips = ips;
            this.ttl = ttl;
        }
    }

    /** Запрос записи A для host. null — имя не годится для DNS. */
    static byte[] query(String host, int txId) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64);
        out.write(txId >> 8);
        out.write(txId);
        out.write(0x01); // RD — рекурсивный запрос
        out.write(0x00);
        out.write(0);
        out.write(1); // один вопрос
        for (int i = 0; i < 6; i++) out.write(0);
        String name = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
        if (name.isEmpty() || name.length() > 253) return null;
        for (String label : name.split("\\.", -1)) {
            byte[] b = label.getBytes(StandardCharsets.US_ASCII);
            if (b.length == 0 || b.length > 63) return null;
            out.write(b.length);
            out.write(b, 0, b.length);
        }
        out.write(0);
        out.write(0);
        out.write(1); // QTYPE A
        out.write(0);
        out.write(1); // QCLASS IN
        return out.toByteArray();
    }

    /** Адреса A из ответа; пустой список — ошибка, NXDOMAIN или ответ на чужой запрос. */
    static Answer parse(byte[] buf, int len, int txId) {
        List<String> ips = new ArrayList<>();
        int ttl = Integer.MAX_VALUE;
        if (len < 12 || u16(buf, 0) != txId || (buf[3] & 0x0f) != 0) return new Answer(ips, 0);
        int qd = u16(buf, 4);
        int an = u16(buf, 6);
        int p = 12;
        for (int i = 0; i < qd; i++) {
            p = skipName(buf, len, p) + 4;
            if (p > len) return new Answer(ips, 0);
        }
        for (int i = 0; i < an && p < len; i++) {
            p = skipName(buf, len, p);
            if (p + 10 > len) break;
            int type = u16(buf, p);
            long recTtl = ((long) u16(buf, p + 4) << 16) | u16(buf, p + 6);
            int rdlen = u16(buf, p + 8);
            p += 10;
            if (p + rdlen > len) break;
            if (type == 1 && rdlen == 4) {
                String ip = (buf[p] & 0xff) + "." + (buf[p + 1] & 0xff) + "." + (buf[p + 2] & 0xff) + "." + (buf[p + 3] & 0xff);
                if (!ips.contains(ip)) ips.add(ip);
                ttl = (int) Math.min(ttl, Math.min(recTtl, Integer.MAX_VALUE));
            }
            p += rdlen;
        }
        return new Answer(ips, ips.isEmpty() ? 0 : ttl);
    }

    private static int skipName(byte[] buf, int len, int p) {
        for (int jumps = 0; p < len && jumps < 128; jumps++) {
            int l = buf[p] & 0xff;
            if (l == 0) return p + 1;
            if ((l & 0xc0) == 0xc0) return p + 2;
            p += 1 + l;
        }
        return len + 1;
    }

    private static int u16(byte[] b, int p) {
        return ((b[p] & 0xff) << 8) | (b[p + 1] & 0xff);
    }
}
