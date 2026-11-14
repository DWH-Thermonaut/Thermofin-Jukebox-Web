// Thermofin Jukebox – Titel-Dienst und Stream-Weiterleitung (Cloudflare Worker)
// Titel:  https://<name>.workers.dev/?url=<Stream>        →  {"artist":"…","title":"…"} oder {"error":"…"}
// Stream: https://<name>.workers.dev/stream?url=<Stream>  →  Audio, nur für Server aus PROXY_HOSTS
// Die Weiterleitung ist für Server gedacht, deren veraltete Shoutcast-Antwort ("ICY 200 OK") Safari nicht abspielt.
import { connect } from "cloudflare:sockets";

const PROXY_HOSTS = /(^|\.)somafm\.com$/i;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 15;

const CORS = { "Access-Control-Allow-Origin": "*" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + CACHE_SECONDS };

function splitTitle(text) {
  text = String(text || "").replace(/\0+$/, "").trim();
  if (!text || /^[-–\s]*$/.test(text)) return { artist: "", title: "" };
  const i = text.indexOf(" - ");
  return i > 0 ? { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim() } : { artist: "", title: text };
}

function decodeMeta(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

/* Liest aus dem Stream bis zum ersten Metadatenblock; "first" sind bereits gelesene Bytes nach den Kopfzeilen */
async function readIcyTitle(reader, metaint, first) {
  let skip = metaint, need = -1, got = 0, total = 0, block = null, pending = first && first.length ? first : null;
  while (true) {
    let value;
    if (pending) { value = pending; pending = null; }
    else { const r = await reader.read(); if (r.done) throw new Error("Stream-Ende ohne Metadaten"); value = r.value; }
    if ((total += value.length) > MAX_BYTES) throw new Error("Keine Metadaten gefunden");
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
        if (m) return splitTitle(m[1]);
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
    "\r\nUser-Agent: Mozilla/5.0 (ThermofinJukebox)\r\nAccept: */*\r\nIcy-MetaData: " + (icy ? 1 : 0) + "\r\nConnection: close\r\n\r\n"));
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
  if (/^30[1278]$/.test(status) && headers.location && hops < 3) { reader.cancel().catch(() => {}); socket.close(); return openRaw(new URL(headers.location, url).href, icy, hops + 1); }
  if (status !== "200") { reader.cancel().catch(() => {}); socket.close(); throw new Error("Stream nicht erreichbar (" + (status || "keine HTTP-Antwort") + ")"); }
  return { socket, reader, headers, rest: buf.subarray(end) };
}

async function streamTitle(url) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let r;
    try { r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "Icy-MetaData": "1", "User-Agent": "Mozilla/5.0 (ThermofinJukebox)" } }); }
    catch (e) { if (e.name === "AbortError") throw e; r = null; }
    if (r) {
      const metaint = parseInt(r.headers.get("icy-metaint"), 10);
      if (!r.ok || !r.body) throw new Error("Stream nicht erreichbar (" + r.status + ")");
      if (!(metaint > 0)) { await r.body.cancel(); throw new Error("Sender liefert keine Titeldaten"); }
      const reader = r.body.getReader();
      try { return await readIcyTitle(reader, metaint); } finally { reader.cancel().catch(() => {}); }
    }
    const raw = await Promise.race([openRaw(url, true), new Promise((_, no) => ctrl.signal.addEventListener("abort", () => no(Object.assign(new Error("Zeitüberschreitung"), { name: "AbortError" }))))]);
    try {
      const metaint = parseInt(raw.headers["icy-metaint"], 10);
      if (!(metaint > 0)) throw new Error("Sender liefert keine Titeldaten");
      return await readIcyTitle(raw.reader, metaint, raw.rest);
    } finally { raw.reader.cancel().catch(() => {}); raw.socket.close(); }
  } finally { clearTimeout(timer); }
}

async function proxyStream(url, ctx) {
  const raw = await openRaw(url, false);
  const { readable, writable } = typeof IdentityTransformStream === "function" ? new IdentityTransformStream() : new TransformStream();
  raw.reader.releaseLock();
  const pump = (async () => {
    const writer = writable.getWriter();
    if (raw.rest.length) await writer.write(raw.rest);
    writer.releaseLock();
    await raw.socket.readable.pipeTo(writable);
  })().catch(() => {}).finally(() => raw.socket.close());
  if (ctx) ctx.waitUntil(pump);
  return new Response(readable, { headers: { ...CORS, "Content-Type": raw.headers["content-type"] || "audio/mpeg", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
    const reqUrl = new URL(request.url), url = reqUrl.searchParams.get("url") || "";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return new Response(JSON.stringify({ error: "Parameter url fehlt" }), { status: 400, headers: JSON_HEADERS });
    if (reqUrl.pathname.replace(/\/+$/, "").endsWith("/stream")) {
      if (!PROXY_HOSTS.test(new URL(url).hostname)) return new Response("Server nicht freigegeben", { status: 403, headers: CORS });
      try { return await proxyStream(url, ctx); } catch (e) { return new Response(String(e.message || e), { status: 502, headers: CORS }); }
    }
    const cache = typeof caches !== "undefined" ? caches.default : null, key = new Request(reqUrl.origin + "/?url=" + encodeURIComponent(url), { method: "GET" });
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    let body;
    try { body = await streamTitle(url); } catch (e) { body = { error: e.name === "AbortError" ? "Zeitüberschreitung" : String(e.message || e) }; }
    const res = new Response(JSON.stringify(body), { headers: JSON_HEADERS });
    if (cache && ctx) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
};
