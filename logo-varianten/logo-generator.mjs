import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const C = "#19f0ff", M = "#ff2bd6", V = "#8a5cff";
function svg(sub, neon) {
  const glow = neon ? 'filter="url(#glow)"' : "";
  const tube = (w) => neon ? `stroke-width="${w}"` : `stroke-width="${w * 1.15}"`;
  const textFill = neon ? "none" : "#1d1140";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="240" viewBox="0 0 960 240">
<defs>
  <filter id="glow" x="-30%" y="-60%" width="160%" height="220%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b1"/>
    <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b2"/>
    <feMerge><feMergeNode in="b1"/><feMergeNode in="b1"/><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <linearGradient id="arch" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C}"/><stop offset=".55" stop-color="${V}"/><stop offset="1" stop-color="${M}"/></linearGradient>
  <linearGradient id="txt" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C}"/><stop offset="1" stop-color="${neon ? "#7ff8ff" : "#00a8c8"}"/></linearGradient>
</defs>
<g ${glow} fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M40 212 V104 a68 68 0 0 1 136 0 V212 Z" stroke="url(#arch)" ${tube(7)}/>
  <path d="M62 196 V108 a46 46 0 0 1 92 0 V196" stroke="${M}" ${tube(4)}/>
  <rect x="76" y="118" width="64" height="30" rx="6" stroke="${C}" ${tube(4)}/>
  <path d="M84 176 v-10 M98 176 v-18 M112 176 v-24 M126 176 v-14 M140 176 v-20" stroke="${C}" ${tube(5)}/>
  <path d="M30 212 H186" stroke="${V}" ${tube(6)}/>
</g>
<g ${glow}>
  <text x="214" y="120" font-family="Inter Display" font-weight="900" font-size="94" letter-spacing="-1" id="main"
    fill="${textFill}" stroke="url(#txt)" ${neon ? 'stroke-width="3.6"' : 'stroke-width="0"'} ${neon ? "" : 'fill-opacity="1"'}>DWH’s Jukebox</text>
  <text id="main-dummy" visibility="hidden"></text>
  <path id="l1" d="M0 0" stroke="${M}" stroke-width="4" stroke-linecap="round"/>
  <text id="sub" x="0" y="178" font-family="Inter Display" font-weight="700" font-size="50" letter-spacing="17" fill="${M}">${sub}</text>
  <path id="l2" d="M0 0" stroke="${M}" stroke-width="4" stroke-linecap="round"/>
</g>
</svg>`;
}
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const p = await b.newPage({ viewport: { width: 960, height: 240 } }); p.on("pageerror", e => console.log("ERR", e.message));
for (const sub of ["PLAYER", "STREAMER"]) for (const neon of [true, false]) {
  const s = svg(sub, neon);
  const layout = `<script>(()=>{const m=document.getElementById("main").getBBox(),t=document.getElementById("sub"),w=t.getComputedTextLength()-17,x=m.x+(m.width-w)/2;t.setAttribute("x",x);document.getElementById("l1").setAttribute("d","M"+(m.x+4)+" 160 H"+(x-22));document.getElementById("l2").setAttribute("d","M"+(x+w+22)+" 160 H"+(m.x+m.width-4));})()</script>`;
  await p.setContent(`<html><body style="margin:0;background:transparent">${s}${layout}</body></html>`);
  await p.screenshot({ path: `logo_${sub.toLowerCase()}_${neon ? "neon" : "hell"}.png`, omitBackground: true, clip: { x: 0, y: 0, width: 960, height: 240 } });
  for (const [bg, n] of [["#0b0716", "dunkel"], ["#f8f9fb", "weiss"]]) {
    await p.setContent(`<html><body style="margin:0;background:${bg}">${s}${layout}</body></html>`);
    await p.screenshot({ path: `preview_${sub.toLowerCase()}_${neon ? "neon" : "hell"}_${n}.png`, clip: { x: 0, y: 0, width: 960, height: 240 } });
  }
}
await b.close();
