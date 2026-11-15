// Thermofin Jukebox – Titel-Dienst und Stream-Weiterleitung (Cloudflare Worker)
// Titel:  https://<name>.workers.dev/?url=<Stream>[&name=<Sendername>][&wait=<Sekunden>]  →  {"artist":"…","title":"…"} oder {"error":"…"}
// Stream: https://<name>.workers.dev/stream?url=<Stream>  →  Audio, nur für Server aus PROXY_HOSTS
// Die Weiterleitung ist für Server gedacht, deren veraltete Shoutcast-Antwort ("ICY 200 OK") Safari nicht abspielt.
import { connect } from "cloudflare:sockets";

const PROXY_HOSTS = /(^|\.)somafm\.com$/i;
// Nur diese Webseiten dürfen den Dienst aus dem Browser nutzen. Anfragen ohne Herkunftsangabe (Desktop-Jukebox) bleiben erlaubt.
const ALLOWED_ORIGINS = ["https://dwh-thermonaut.github.io"];
// Gleiche Kennung wie die Desktop-Jukebox (BASS), damit die Server dieselben Metadaten schicken
const USER_AGENT = "BASS/2.4";
const MAX_BYTES = 2 * 1024 * 1024;
const ANSWER_MS = 9000;    // Standard-Wartezeit bis zur Antwort (Desktop wartet 12 s)
const MAX_ANSWER_MS = 20000;
const READ_MS = 28000;     // Lesezeit insgesamt; nach der Antwort läuft das Lesen im Hintergrund weiter
const FRESH_MS = 15000;    // so lange gilt ein gefundener Titel als aktuell
const KEEP_MS = 120000;    // so lange darf ein älterer Titel aushelfen, solange der Sender nur Werbung/Senderinfo schickt
// Zwischenspeicher im Worker; der Cache-Dienst von Cloudflare steht unter workers.dev nicht zur Verfügung
const songs = new Map();
const GENERIC_WORDS = new Set(["radio", "the", "fm", "web", "stream", "live", "digital", "online", "channel", "hits", "und", "die", "der", "das"]);

// Herkunft prüfen: Origin (fetch aus dem Browser) oder Referer (Audio-Element); fehlt beides, ist es kein fremder Browser-Aufruf
function callerAllowed(request) {
    const origin = request.headers.get("Origin"), referer = request.headers.get("Referer");
    let source = origin || "";
    if (!source && referer) { try { source = new URL(referer).origin; } catch { return false; } }
    return !source || ALLOWED_ORIGINS.includes(source);
}
function corsFor(request) {
    const origin = request.headers.get("Origin");
    return { "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], "Vary": "Origin" };
}

function splitTitle(text) {
    text = String(text || "").replace(/\0+$/, "").trim();
    if (!text || /^[-–\s]*$/.test(text)) return { artist: "", title: "" };
    const i = text.indexOf(" - ");
    return i > 0 ? { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim() } : { artist: "", title: text };
}

const normalize = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
// Kennwort eines Senders: erstes markantes Wort ("Radio Zwickau 90er" → "zwickau", "80s80s Digital" → "80s80s")
function stationKey(name) {
    const words = normalize(name).split(" ").filter(Boolean);
    return words.find(w => w.length >= 4 && !GENERIC_WORDS.has(w)) || words.join("");
}
// Senderinfo, Werbung oder Jingle statt Interpret/Titel?
function isStationText(text, name) {
    const plain = normalize(text);
    if (!plain || /^[-–\s]*$/.test(text)) return true;
    if (/https?:|www\.|\.(de|com|fm|net)\b/i.test(text) || /\b(werbung|nachrichten|verkehrsservice|jetzt einschalten)\b/i.test(text)) return true;
    const key = name ? stationKey(name) : "";
    return key.length >= 3 && (" " + plain + " ").includes(" " + key + " ");
}

function decodeMeta(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

/* Liefert nacheinander den Text jedes Metadatenblocks; "first" sind bereits gelesene Bytes nach den Kopfzeilen */
async function* icyTitles(reader, metaint, first) {
    let skip = metaint, need = -1, got = 0, total = 0, block = null, pending = first && first.length ? first : null;
    while (true) {
        let value;
        if (pending) { value = pending; pending = null; }
        else { const r = await reader.read(); if (r.done) return; value = r.value; }
        if ((total += value.length) > MAX_BYTES) return;
        let i = 0;
        while (i < value.length) {
            if (skip > 0) { const n = Math.min(skip, value.length - i); skip -= n; i += n; continue; }
            if (need < 0) {
                need = value[i++] * 16;
                if (need === 0) { need = -1; skip = metaint; }
                else { block = new Uint8Array(need); got = 0; }
                continue;
            }
            const n = Math.min(need - got, value.length - i);
            block.set(value.subarray(i, i + n), got); got += n; i += n;
            if (got === need) {
                const m = decodeMeta(block).match(/StreamTitle='([\s\S]*?)';/);
                if (m) yield m[1].replace(/\0+$/, "").trim();
                need = -1; skip = metaint;
            }
        }
    }
}

/* Direkte Verbindung per Socket: versteht auch "ICY 200 OK", folgt bis zu 3 Weiterleitungen */
async function openRaw(url, icy, hops = 0) {
    const u = new URL(url), tls = u.protocol === "https:";
    const socket = connect({ hostname: u.hostname, port: Number(u.port) || (tls ? 443 : 80) }, { secureTransport: tls ? "on" : "off" });
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode("GET " + (u.pathname + u.search || "/") + " HTTP/1.0\r\nHost: " + u.host +
        "\r\nUser-Agent: " + USER_AGENT + "\r\nAccept: */*\r\nIcy-MetaData: " + (icy ? 1 : 0) + "\r\nConnection: close\r\n\r\n"));
    writer.releaseLock();
    const reader = socket.readable.getReader();
    let buf = new Uint8Array(0), end = -1;
    while (end < 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Verbindung ohne Antwort beendet");
        const next = new Uint8Array(buf.length + value.length); next.set(buf); next.set(value, buf.length); buf = next;
        for (let i = 3; i < buf.length; i++) if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) { end = i + 1; break; }
        if (end < 0 && buf.length > 16384) throw new Error("Ungültige Serverantwort");
    }
    const lines = new TextDecoder("latin1").decode(buf.subarray(0, end)).split("\r\n");
    const status = (lines[0].match(/^(?:ICY|HTTP\/\d(?:\.\d)?)\s+(\d{3})/) || [])[1];
    const headers = {};
    for (const line of lines.slice(1)) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    if (/^30[1278]$/.test(status) && headers.location && hops < 3) { reader.cancel().catch(() => { }); socket.close(); return openRaw(new URL(headers.location, url).href, icy, hops + 1); }
    if (status !== "200") { reader.cancel().catch(() => { }); socket.close(); throw new Error("Stream nicht erreichbar (" + (status || "keine HTTP-Antwort") + ")"); }
    return { socket, reader, headers, rest: buf.subarray(end) };
}

/* Liest Metadatenblöcke, bis ein echter Titel kommt; Werbung und Senderinfo am Verbindungsanfang werden übersprungen.
   Ergebnis: { song } oder { station: "<letzte Senderinfo>" } */
async function readSong(url, name) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), READ_MS);
    let reader = null, socket = null, metaint = 0, first = null;
    try {
        let r;
        try { r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "Icy-MetaData": "1", "User-Agent": USER_AGENT } }); }
        catch (e) { if (e.name === "AbortError") throw e; r = null; }
        if (r) {
            if (!r.ok || !r.body) throw new Error("Stream nicht erreichbar (" + r.status + ")");
            metaint = parseInt(r.headers.get("icy-metaint"), 10);
            if (!(metaint > 0)) { await r.body.cancel(); throw new Error("Sender liefert keine Titeldaten"); }
            reader = r.body.getReader();
        } else {
            const abort = new Promise((_, no) => ctrl.signal.addEventListener("abort", () => no(Object.assign(new Error("Zeitüberschreitung"), { name: "AbortError" }))));
            const raw = await Promise.race([openRaw(url, true), abort]);
            ({ reader, socket } = raw); first = raw.rest;
            metaint = parseInt(raw.headers["icy-metaint"], 10);
            if (!(metaint > 0)) throw new Error("Sender liefert keine Titeldaten");
            ctrl.signal.addEventListener("abort", () => reader.cancel().catch(() => { }));
        }
        let station = "";
        try {
            for await (const text of icyTitles(reader, metaint, first)) {
                if (!isStationText(text, name)) return { song: splitTitle(text) };
                if (text) station = text;
            }
        } catch (e) { if (!ctrl.signal.aborted) throw e; }
        return { station };
    } finally {
        clearTimeout(timer);
        if (reader) reader.cancel().catch(() => { });
        if (socket) socket.close();
    }
}

function remember(url, song) {
    songs.delete(url);
    songs.set(url, { ...song, at: Date.now() });
    while (songs.size > 200) songs.delete(songs.keys().next().value);
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

async function proxyStream(url, ctx, CORS) {
    const raw = await openRaw(url, false);
    const { readable, writable } = typeof IdentityTransformStream === "function" ? new IdentityTransformStream() : new TransformStream();
    raw.reader.releaseLock();
    const pump = (async () => {
        const writer = writable.getWriter();
        if (raw.rest.length) await writer.write(raw.rest);
        writer.releaseLock();
        await raw.socket.readable.pipeTo(writable);
    })().catch(() => { }).finally(() => raw.socket.close());
    if (ctx) ctx.waitUntil(pump);
    return new Response(readable, { headers: { ...CORS, "Content-Type": raw.headers["content-type"] || "audio/mpeg", "Cache-Control": "no-store" } });
}

export default {
    async fetch(request, env, ctx) {
        const CORS = corsFor(request);
        const JSON_HEADERS = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
        const reply = body => new Response(JSON.stringify(body), { headers: JSON_HEADERS });
        if (!callerAllowed(request)) return new Response(JSON.stringify({ error: "Herkunft nicht erlaubt" }), { status: 403, headers: JSON_HEADERS });
        if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
        const reqUrl = new URL(request.url), url = reqUrl.searchParams.get("url") || "";
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return new Response(JSON.stringify({ error: "Parameter url fehlt" }), { status: 400, headers: JSON_HEADERS });
        if (reqUrl.pathname.replace(/\/+$/, "").endsWith("/stream")) {
            if (!PROXY_HOSTS.test(new URL(url).hostname)) return new Response("Server nicht freigegeben", { status: 403, headers: CORS });
            try { return await proxyStream(url, ctx, CORS); } catch (e) { return new Response(String(e.message || e), { status: 502, headers: CORS }); }
        }

        const known = songs.get(url), age = known ? Date.now() - known.at : Infinity;
        if (age < FRESH_MS) return reply({ artist: known.artist, title: known.title });
        const name = reqUrl.searchParams.get("name") || "";
        const wait = Math.min(MAX_ANSWER_MS, (parseFloat(reqUrl.searchParams.get("wait")) * 1000) || ANSWER_MS);
        const job = readSong(url, name).then(result => { if (result.song && result.song.title) remember(url, result.song); return result; });
        if (ctx) ctx.waitUntil(job.catch(() => { }));
        const result = await Promise.race([job.catch(e => ({ error: e.name === "AbortError" ? "Zeitüberschreitung" : String(e.message || e) })), sleep(wait).then(() => null)]);
        if (result && result.song) return reply(result.song);
        if (age < KEEP_MS) return reply({ artist: known.artist, title: known.title });
        if (result && result.error) return reply({ error: result.error });
        // Noch kein Titel (Werbung/Senderinfo läuft): leere Antwort, kein Fehler – die nächste Abfrage bekommt den Titel
        return reply({ artist: "", title: "", station: result ? result.station : "" });
    }
};