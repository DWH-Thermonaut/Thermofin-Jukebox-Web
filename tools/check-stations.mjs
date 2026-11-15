// Senderprüfung für radiostation.json (läuft täglich als GitHub Action, lokal: node tools/check-stations.mjs)
// Prüft jede Stream-Adresse so, wie die Web-App sie abspielt: Verbindung, Weiterleitungen, Antwortcode, Audio-Inhalt.
// Versteht auch alte Shoutcast-Server ("ICY 200 OK"), an denen fetch() scheitert.
import fs from "fs";
import net from "net";
import tls from "tls";

const FILE = process.argv[2] || "radiostation.json";
const REPORT = process.argv[3] || "report.md";
const TIMEOUT_MS = 15000;
const MIN_BYTES = 4096;
const PARALLEL = 8;

// Wie in index.html: Browser spielen auf https-Seiten nur https-Streams
function normalizeUrl(url) {
  const antenne = url.match(/^http:\/\/mp3channels\.webradio\.antenne\.de\/([^/?#]+)/);
  if (antenne) return "https://stream.antenne.de/" + antenne[1] + "/stream/mp3";
  const bob = url.match(/^http:\/\/streams\.radiobob\.de\/([^/]+)\/(mp3-\d+)\/mediaplayer/);
  if (bob) return "https://streams.radiobob.de/" + bob[1] + "/" + bob[2] + "/streams.radiobob.de/";
  return url.replace(/^http:\/\//, "https://");
}

function probe(url, hops = 0) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, error: "Ungültige Adresse" }); return; }
    const secure = u.protocol === "https:", port = Number(u.port) || (secure ? 443 : 80);
    const socket = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    let buf = Buffer.alloc(0), head = null, body = 0, done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish(head ? { ok: false, error: "Zu wenig Daten (" + body + " Bytes in 15 s)" } : { ok: false, error: "Zeitüberschreitung" }), TIMEOUT_MS);
    socket.on("error", e => finish({ ok: false, error: e.code === "ENOTFOUND" ? "Servername existiert nicht" : e.code === "ECONNREFUSED" ? "Verbindung abgelehnt" : (e.code || e.message) }));
    socket.on(secure ? "secureConnect" : "connect", () => socket.write("GET " + (u.pathname + u.search || "/") + " HTTP/1.0\r\nHost: " + u.host +
      "\r\nUser-Agent: Mozilla/5.0 (DWH-Jukebox-Senderpruefung)\r\nAccept: */*\r\nIcy-MetaData: 0\r\nConnection: close\r\n\r\n"));
    socket.on("data", chunk => {
      if (head) { body += chunk.length; if (body >= MIN_BYTES) finish({ ok: true, info: head.type }); return; }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) { if (buf.length > 16384) finish({ ok: false, error: "Ungültige Serverantwort" }); return; }
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const status = (lines[0].match(/^(?:ICY|HTTP\/\d(?:\.\d)?)\s+(\d{3})/) || [])[1];
      const headers = {};
      for (const line of lines.slice(1)) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
      if (/^30[1278]$/.test(status) && headers.location) {
        if (hops >= 5) { finish({ ok: false, error: "Zu viele Weiterleitungen" }); return; }
        clearTimeout(timer); done = true; socket.destroy();
        probe(new URL(headers.location, url).href, hops + 1).then(resolve);
        return;
      }
      if (status !== "200") { finish({ ok: false, error: "Server antwortet " + (status || "ohne HTTP-Status") }); return; }
      const type = (headers["content-type"] || "").toLowerCase();
      if (/text\/html|application\/json/.test(type)) { finish({ ok: false, error: "Kein Audio (" + type + ")" }); return; }
      head = { type: type || "unbekannt" };
      body = buf.length - end - 4;
      if (body >= MIN_BYTES) finish({ ok: true, info: head.type });
    });
    socket.on("end", () => finish(head ? { ok: false, error: "Stream bricht ab (" + body + " Bytes)" } : { ok: false, error: "Verbindung ohne Antwort beendet" }));
  });
}

async function runAll(stations) {
  const results = new Array(stations.length);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < stations.length) { const i = next++; results[i] = await probe(stations[i].url); }
  }));
  return results;
}

const list = JSON.parse(fs.readFileSync(FILE, "utf8").replace(/^﻿/, ""));
const stations = list.filter(s => s && s.ID && s.URL).map(s => ({ id: String(s.ID), name: String(s.Name), genre: String(s.Genre || ""), url: normalizeUrl(String(s.URL)) }));
let results = await runAll(stations);
// Fehlschläge einmal wiederholen, damit kurze Aussetzer nicht gemeldet werden
const retry = stations.map((s, i) => i).filter(i => !results[i].ok);
if (retry.length) {
  const again = await runAll(retry.map(i => stations[i]));
  retry.forEach((i, k) => { if (again[k].ok) results[i] = again[k]; });
}

const broken = stations.map((s, i) => ({ ...s, ...results[i] })).filter(r => !r.ok);
const date = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });
const esc = t => String(t).replace(/\|/g, "\\|");
let md = "## Senderprüfung vom " + date + "\n\n" + (stations.length - broken.length) + " von " + stations.length + " Sendern laufen.";
if (broken.length) {
  md += " **" + broken.length + " nicht erreichbar:**\n\n| ID | Name | Genre | Fehler | Adresse |\n|---|---|---|---|---|\n";
  md += broken.map(b => "| " + b.id + " | " + esc(b.name) + " | " + esc(b.genre) + " | " + esc(b.error) + " | " + esc(b.url) + " |").join("\n");
  md += "\n\n_Geprüft von einem GitHub-Server in den USA. Sender, die nur in Deutschland senden, können hier fälschlich als defekt erscheinen._\n";
} else md += " Alles in Ordnung.\n";
fs.writeFileSync(REPORT, md);
console.log(md);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "defekt=" + broken.length + "\n");
