package ru.vybiraem.vmeste;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLParameters;

/** Разбиение ClientHello: настоящий ClientHello от TLS-стека JVM разрезается так, что имя сайта не целиком ни в одном куске. */
public class DesyncTest {
    private static final String HOST = "www.aliexpress.ru";

    /** Первый пакет TLS-клиента, как его отправил бы браузер (здесь — SSLEngine JVM с SNI). */
    private static byte[] realClientHello(String host) throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, null, null);
        SSLEngine engine = ctx.createSSLEngine(host, 443);
        engine.setUseClientMode(true);
        SSLParameters params = engine.getSSLParameters();
        params.setServerNames(Collections.singletonList(new SNIHostName(host)));
        engine.setSSLParameters(params);
        ByteBuffer out = ByteBuffer.allocate(engine.getSession().getPacketBufferSize());
        engine.beginHandshake();
        engine.wrap(ByteBuffer.allocate(0), out);
        out.flip();
        byte[] b = new byte[out.remaining()];
        out.get(b);
        return b;
    }

    private static byte[] concat(List<byte[]> parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }

    private static boolean contains(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return true;
        }
        return false;
    }

    @Test
    public void parsesSniFromRealClientHello() throws Exception {
        byte[] hello = realClientHello(HOST);
        assertTrue(Desync.isTlsHandshake(hello, hello.length));
        assertEquals("одна запись целиком", hello.length, Desync.recordEnd(hello, hello.length));
        Desync.Range sni = Desync.findSni(hello);
        assertNotNull(sni);
        assertEquals(HOST, new String(hello, sni.start, sni.end - sni.start, StandardCharsets.US_ASCII));
        assertEquals(sni.start + HOST.length() / 2, Desync.sniSplitOffset(hello, HOST));
    }

    @Test
    public void tcpSegKeepsTheRecordAndCutsTheName() throws Exception {
        byte[] hello = realClientHello(HOST);
        Desync.Plan plan = Desync.plan(hello, HOST, Desync.TCP_SEG);
        assertNotNull(plan);
        assertEquals(3, plan.writes.size());
        assertEquals(2, plan.writes.get(0).length);
        assertArrayEquals("байты те же, только сегменты другие", hello, concat(plan.writes));
        Desync.Range sni = Desync.findSni(hello);
        int cut = 2 + plan.writes.get(1).length;
        assertTrue("разрез внутри имени", cut > sni.start && cut < sni.end);
        byte[] name = HOST.getBytes(StandardCharsets.US_ASCII);
        for (byte[] w : plan.writes) assertFalse("имя целиком не в одном сегменте", contains(w, name));
    }

    @Test
    public void chunk16SendsSmallPieces() throws Exception {
        byte[] hello = realClientHello(HOST);
        Desync.Plan plan = Desync.plan(hello, HOST, Desync.CHUNK16);
        assertNotNull(plan);
        assertArrayEquals(hello, concat(plan.writes));
        int limit = Math.min(hello.length, 640);
        for (int i = 0; i < limit / 16; i++) assertEquals(16, plan.writes.get(i).length);
        byte[] name = HOST.getBytes(StandardCharsets.US_ASCII);
        for (byte[] w : plan.writes) assertFalse(contains(w, name));
    }

    @Test
    public void tlsSniRfcMakesTwoValidRecordsAroundTheName() throws Exception {
        byte[] hello = realClientHello(HOST);
        Desync.Plan plan = Desync.plan(hello, HOST, Desync.TLS_SNI_RFC);
        assertNotNull(plan);
        assertEquals(2, plan.writes.size());
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        byte[] name = HOST.getBytes(StandardCharsets.US_ASCII);
        for (byte[] rec : plan.writes) {
            assertEquals(0x16, rec[0] & 0xff);
            assertEquals(hello[1], rec[1]);
            assertEquals(hello[2], rec[2]);
            int len = ((rec[3] & 0xff) << 8) | (rec[4] & 0xff);
            assertEquals("длина записи совпадает с содержимым", rec.length - 5, len);
            assertTrue("первая запись — не меньше 9 байт рукопожатия", len >= 9);
            payload.write(rec, 5, len);
            assertFalse("имя целиком не в одной записи", contains(rec, name));
        }
        assertArrayEquals("вместе — то же рукопожатие", Arrays.copyOfRange(hello, 5, hello.length), payload.toByteArray());
        Desync.Range sni = Desync.findSni(hello);
        int cut = 5 + ((plan.writes.get(0)[3] & 0xff) << 8 | (plan.writes.get(0)[4] & 0xff));
        assertEquals(sni.start + HOST.length() / 2 - 3, cut);
    }

    @Test
    public void bytesAfterTheRecordStayInPlace() throws Exception {
        byte[] hello = realClientHello(HOST);
        byte[] glued = Arrays.copyOf(hello, hello.length + 3);
        glued[hello.length] = 0x17;
        glued[hello.length + 1] = 0x03;
        glued[hello.length + 2] = 0x03;
        for (String s : Desync.STRATEGIES) {
            Desync.Plan plan = Desync.plan(glued, HOST, s);
            assertNotNull(s, plan);
            byte[] all = concat(plan.writes);
            assertArrayEquals(s, Arrays.copyOfRange(glued, glued.length - 3, glued.length), Arrays.copyOfRange(all, all.length - 3, all.length));
        }
    }

    @Test
    public void foundByNameWhenThereIsNoSniExtension() {
        // Ненастоящая запись рукопожатия с именем внутри: разрез — по найденному имени, без учёта регистра
        byte[] body = ("\u0001\u0000\u0000 xxxxWWW.AliExpress.RUyyyy").getBytes(StandardCharsets.ISO_8859_1);
        byte[] rec = new byte[5 + body.length];
        rec[0] = 0x16;
        rec[1] = 0x03;
        rec[2] = 0x01;
        rec[3] = 0;
        rec[4] = (byte) body.length;
        System.arraycopy(body, 0, rec, 5, body.length);
        assertEquals(5 + 8 + HOST.length() / 2, Desync.sniSplitOffset(rec, HOST));
    }

    @Test
    public void notTlsIsLeftAlone() {
        byte[] http = "GET / HTTP/1.1\r\nHost: ali.click\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1);
        assertNull(Desync.plan(http, "ali.click", Desync.TCP_SEG));
        assertNull(Desync.plan(http, "ali.click", Desync.TLS_SNI_RFC));
        assertEquals(1, Desync.plan(http, "ali.click", Desync.PLAIN).writes.size());
        // Запись пришла не целиком — не режем
        byte[] partial = Arrays.copyOf(new byte[] { 0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0, 0, 0, 0 }, 10);
        assertNull(Desync.plan(partial, "ali.click", Desync.TCP_SEG));
    }

    @Test
    public void dnsWireQueryAndAnswer() {
        byte[] q = DnsWire.query("ali.click", 0x1234);
        assertNotNull(q);
        assertEquals(0x12, q[0] & 0xff);
        assertEquals(0x34, q[1] & 0xff);
        // Ответ: вопрос из запроса + две записи A (имя — указатель на вопрос) и одна CNAME, которую пропускаем
        ByteArrayOutputStream r = new ByteArrayOutputStream();
        r.write(q, 0, q.length);
        byte[] resp = r.toByteArray();
        resp[2] = (byte) 0x81;
        resp[3] = (byte) 0x80;
        resp[7] = 3; // ANCOUNT
        r.reset();
        r.write(resp, 0, resp.length);
        int[][] answers = { { 5, 0, 0, 0, 0 }, { 1, 47, 246, 0, 1 }, { 1, 47, 246, 0, 2 } };
        int[] ttls = { 30, 300, 120 };
        for (int i = 0; i < answers.length; i++) {
            r.write(0xc0);
            r.write(12);
            r.write(0);
            r.write(answers[i][0]);
            r.write(0);
            r.write(1);
            r.write(0);
            r.write(0);
            r.write(ttls[i] >> 8);
            r.write(ttls[i]);
            r.write(0);
            r.write(4);
            for (int k = 1; k <= 4; k++) r.write(answers[i][k]);
        }
        byte[] buf = r.toByteArray();
        DnsWire.Answer a = DnsWire.parse(buf, buf.length, 0x1234);
        assertEquals(Arrays.asList("47.246.0.1", "47.246.0.2"), a.ips);
        assertEquals(120, a.ttl);
        assertTrue("чужой id — не наш ответ", DnsWire.parse(buf, buf.length, 0x4321).ips.isEmpty());
        assertNull(DnsWire.query("bad..host", 1));
    }
}
