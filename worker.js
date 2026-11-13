// Thermofin Jukebox – Titel-Dienst (Cloudflare Worker)
// Liest den aktuellen Titel (ICY-Metadaten) serverseitig aus einem Radiostream und gibt ihn als JSON zurück.
// Aufruf: https://<name>.workers.dev/?url=<Stream-Adresse>  →  {"artist":"…","title":"…"} oder {"error":"…"}
// Es werden nur wenige KB pro Abfrage gelesen, der Stream selbst wird nie weitergereicht.

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const CACHE_SECONDS = 15;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=" + CACHE_SECONDS
};

function splitTitle(text) {
  text = String(text || "").replace(/\0+$/, "").trim();
  if (!text || /^[-–\s]*$/.test(text)) return { artist: "", title: "" };
  const i = text.indexOf(" - ");
  return i > 0 ? { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim() } : { artist: "", title: text };
}

function decodeMeta(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}

async function readIcyTitle(reader, metaint) {
  let skip = metaint, need = -1, got = 0, total = 0, block = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Stream-Ende ohne Metadaten");
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

async function streamTitle(url) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "Icy-MetaData": "1", "User-Agent": "Mozilla/5.0 (ThermofinJukebox)" } });
    const metaint = parseInt(r.headers.get("icy-metaint"), 10);
    if (!r.ok || !r.body) throw new Error("Stream nicht erreichbar (" + r.status + ")");
    if (!(metaint > 0)) { await r.body.cancel(); throw new Error("Sender liefert keine Titeldaten"); }
    const reader = r.body.getReader();
    try { return await readIcyTitle(reader, metaint); } finally { reader.cancel().catch(() => {}); }
  } finally { clearTimeout(timer); }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" } });
    const url = new URL(request.url).searchParams.get("url") || "";
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return new Response(JSON.stringify({ error: "Parameter url fehlt" }), { status: 400, headers: HEADERS });
    const cache = typeof caches !== "undefined" ? caches.default : null, key = new Request(request.url, { method: "GET" });
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    let body;
    try { body = await streamTitle(url); } catch (e) { body = { error: e.name === "AbortError" ? "Zeitüberschreitung" : String(e.message || e) }; }
    const res = new Response(JSON.stringify(body), { headers: HEADERS });
    if (cache && ctx) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }
};
