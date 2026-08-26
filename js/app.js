"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const NA = "NOT AVAILABLE";
const state = { results: {}, serverApi: false, headers: null, score: null };

/* ---------------- helpers ---------------- */
function fmtBytes(b) {
  if (b == null || isNaN(b)) return NA;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + " " + u[i];
}
function fmtMs(ms) { return ms == null || isNaN(ms) ? NA : Math.round(ms) + " ms"; }
function fmtSec(s) {
  if (s == null || isNaN(s)) return NA;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}
function esc(t) { const d = document.createElement("div"); d.textContent = String(t ?? ""); return d.innerHTML; }

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toastWrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, 3200);
}

function statusClass(v) { return v === true ? "st-green" : v === "warn" ? "st-yellow" : v === false ? "st-red" : "st-gray"; }
function dotHtml(st) {
  const c = st === true ? "dot-green" : st === "warn" ? "dot-yellow" : st === false ? "dot-red" : "dot-gray";
  return `<span class="status-dot ${c}"></span>`;
}

function renderRows(containerSel, rows) {
  const box = $(containerSel);
  box.innerHTML = rows.map(([k, v]) => {
    const isStatus = typeof v === "object" && v !== null && v.__status;
    const val = isStatus ? `${dotHtml(v.st)} <span class="status ${statusClass(v.st)}">${esc(v.text)}</span>` : esc(v);
    return `<div class="row"><span class="k">${esc(k)}</span><span class="v ${v === NA ? "na" : ""}">${val}</span></div>`;
  }).join("");
}
const ST = (text, st) => ({ __status: true, text, st });

async function fetchJSON(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/* ---------------- nav ---------------- */
$("#navToggle").addEventListener("click", () => {
  const open = $("#mainNav").classList.toggle("open");
  $("#navToggle").setAttribute("aria-expanded", open);
});
$$("#mainNav a").forEach(a => a.addEventListener("click", () => {
  $("#mainNav").classList.remove("open");
  $("#navToggle").setAttribute("aria-expanded", "false");
}));

/* ---------------- client device ---------------- */
function detectBrowser(ua) {
  const tests = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/]
  ];
  for (const [name, re] of tests) {
    const m = ua.match(re);
    if (m) return { name, version: m[1].split(".")[0] };
  }
  return { name: "Unknown", version: NA };
}
function detectOS(ua) {
  const map = [
    [/Windows NT 10/, "Windows 10/11"], [/Windows NT 6\.3/, "Windows 8.1"], [/Windows NT 6\.1/, "Windows 7"],
    [/Android ([\d.]+)/, "Android"], [/(?:iPhone|iPad|iPod).*OS ([\d_]+)/, "iOS"], [/Mac OS X ([\d_.]+)/, "macOS"],
    [/CrOS/, "ChromeOS"], [/Linux/, "Linux"]
  ];
  for (const [re, name] of map) {
    const m = ua.match(re);
    if (m) return m[1] ? name.split(" ")[0] + " " + String(m[1]).replace(/_/g, ".") : name;
  }
  return "Unknown";
}
function deviceType() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "Tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return "Mobile";
  const coarse = matchMedia("(pointer:coarse)").matches;
  if (coarse && Math.min(screen.width, screen.height) >= 600) return "Tablet";
  return coarse ? "Mobile" : "Desktop";
}
function engineOf(browser) {
  if (/Safari/.test(navigator.userAgent) && browser === "Safari") return "WebKit";
  if (["Chrome", "Edge", "Opera", "Samsung Internet"].includes(browser)) return "Blink";
  if (browser === "Firefox") return "Gecko";
  if (browser === "Safari") return "WebKit";
  return "Unknown";
}

function runClientDetection() {
  const n = navigator;
  const browser = detectBrowser(n.userAgent);
  const conn = n.connection || n.mozConnection || n.webkitConnection;
  state.results.client = {
    deviceType: deviceType(), os: detectOS(n.userAgent),
    browser: browser.name, browserVersion: browser.version, engine: engineOf(browser.name),
    userAgent: n.userAgent,
    screen: `${screen.width} × ${screen.height}`, viewport: `${innerWidth} × ${innerHeight}`,
    pixelRatio: devicePixelRatio, colorDepth: screen.colorDepth + "-bit",
    touch: ("ontouchstart" in window || n.maxTouchPoints > 0) ? "Supported (" + (n.maxTouchPoints || "?") + " points)" : "Not supported",
    cpuCores: n.hardwareConcurrency ? n.hardwareConcurrency + " cores" : NA,
    memory: n.deviceMemory ? n.deviceMemory + " GB" : NA,
    online: n.onLine, language: n.language, platform: n.userAgentData?.platform || n.platform || NA,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || NA,
    darkMode: matchMedia("(prefers-color-scheme: dark)").matches ? "Dark preferred" : "Light preferred",
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "Enabled" : "No preference",
    connectionType: conn?.type || NA,
    effectiveType: conn?.effectiveType || NA
  };
  const c = state.results.client;
  renderRows("#clientData", [
    ["Device Type", c.deviceType], ["Operating System", c.os],
    ["Browser", c.browser], ["Browser Version", c.browserVersion],
    ["Engine", c.engine], ["Platform", c.platform],
    ["Screen", c.screen], ["Viewport", c.viewport],
    ["Pixel Ratio", c.pixelRatio], ["Color Depth", c.colorDepth],
    ["Touch", c.touch], ["CPU Cores", c.cpuCores],
    ["Device Memory", c.memory], ["Online", ST(c.online ? "ONLINE" : "OFFLINE", c.online)],
    ["Language", c.language], ["Timezone", c.timezone],
    ["Color Scheme", c.darkMode], ["Reduced Motion", c.reducedMotion],
    ["User Agent", c.userAgent]
  ]);
}

addEventListener("resize", () => {
  const row = $$('#clientData .row .v');
  if (state.results.client) { /* viewport refresh */ }
});

/* ---------------- network ---------------- */
async function runNetworkPanel() {
  const n = navigator;
  const conn = n.connection || n.mozConnection || n.webkitConnection;

  let clientIp = NA, ipSource = "";
  const apiIp = await fetchJSON("/api/diagnostics/ip");
  if (apiIp?.ip) { clientIp = apiIp.ip; ipSource = "server"; state.serverApi = true; }
  else {
    try {
      const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000), cache: "no-store" });
      const j = await r.json();
      if (j.ip) { clientIp = j.ip; ipSource = "public api"; }
    } catch {}
  }

  state.results.network = {
    clientIp, ipv6: NA, connectionType: conn?.type || NA,
    effectiveType: conn?.effectiveType ? conn.effectiveType.toUpperCase() : NA,
    downlink: conn?.downlink != null ? conn.downlink + " Mbps" : NA,
    rtt: conn?.rtt != null ? conn.rtt + " ms" : NA,
    saveData: conn?.saveData != null ? (conn.saveData ? "ON" : "OFF") : NA,
    online: n.onLine
  };
  renderRows("#networkData", [
    ["Client IP", state.results.network.clientIp + (ipSource ? ` (${ipSource})` : "")],
    ["IPv4", /^\d+\.\d+\.\d+\.\d+$/.test(clientIp) ? clientIp : NA],
    ["IPv6", clientIp.includes(":") ? clientIp : NA],
    ["Online Status", ST(state.results.network.online ? "ONLINE" : "OFFLINE", state.results.network.online)],
    ["Connection Type", state.results.network.connectionType],
    ["Effective Type", state.results.network.effectiveType],
    ["Downlink", state.results.network.downlink],
    ["RTT (est.)", state.results.network.rtt],
    ["Save Data", state.results.network.saveData]
  ]);
}

async function runLatencyTest() {
  renderRows("#latencyData", [["Status", "Running…"]]);
  $("#latencyVerdict").innerHTML = "";
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      await fetch(location.pathname + "?_lat=" + Date.now() + "&i=" + i, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      samples.push(performance.now() - t0);
    } catch {}
  }
  if (!samples.length) {
    renderRows("#latencyData", [["Server Response", ST("FAILED — NO RESPONSE", false)]]);
    $("#latencyVerdict").innerHTML = `<span class="st-red">● POOR</span>`;
    return;
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const best = samples[0];

  let phases = {};
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav) {
    phases = {
      dns: nav.domainLookupEnd - nav.domainLookupStart,
      tcp: nav.connectEnd - nav.connectStart,
      tls: nav.requestStart - nav.secureConnectionStart > 0 ? nav.requestStart - nav.secureConnectionStart : null,
      ttfb: nav.responseStart - nav.requestStart,
      download: nav.responseEnd - nav.responseStart,
      total: nav.responseEnd - nav.startTime
    };
  }

  state.results.latency = { median, best, ...phases, samples: samples.map(Math.round) };
  const q = median < 100 ? ["EXCELLENT", true] : median < 300 ? ["GOOD", true] : median < 700 ? ["FAIR", "warn"] : ["POOR", false];
  renderRows("#latencyData", [
    ["Server Response (median)", fmtMs(median)],
    ["Best Sample", fmtMs(best)],
    ...(phases.dns != null ? [["DNS", fmtMs(phases.dns)], ["TCP", fmtMs(phases.tcp)]] : []),
    ...(phases.tls != null ? [["TLS Handshake", fmtMs(phases.tls)]] : []),
    ...(phases.ttfb != null ? [["TTFB", fmtMs(phases.ttfb)], ["Download", fmtMs(phases.download)], ["Total Nav Time", fmtMs(phases.total)]] : []),
    ["Samples", samples.map(Math.round).join(" · ") + " ms"]
  ]);
  $("#latencyVerdict").innerHTML = `QUALITY&nbsp;&nbsp;<span class="status ${statusClass(q[1])}">● ${q[0]}</span>`;
  state.results.network.quality = q[0];
  updateHealthRow("NETWORK", ST(q[0] === "POOR" ? "POOR" : "GOOD", q[1]));
}

/* ---------------- server info via API ---------------- */
async function loadServerInfo() {
  const data = await fetchJSON("/api/diagnostics/server");
  state.results.serverApiOk = !!data;
  if (!data) {
    renderRows("#serverData", [["Server API", ST("NOT REACHABLE", "warn")], ["Hostname", NA], ["OS", NA], ["Kernel", NA], ["CPU Model", NA], ["Uptime", NA]]);
    renderRows("#osData", [["Distribution", NA], ["Version", NA], ["Kernel", NA], ["Architecture", NA], ["Boot Time", NA], ["Virtualization", NA]]);
    $("#serverBadge").textContent = "API OFFLINE";
    $("#liveIndicator").textContent = "● OFFLINE"; $("#liveIndicator").className = "live-indicator";
    return;
  }
  state.serverApi = true;
  state.results.server = data;
  renderRows("#serverData", [
    ["Server IP", data.ip || NA],
    ["Hostname", data.hostname || NA],
    ["Operating System", data.os || NA],
    ["Kernel", data.kernel || NA],
    ["Architecture", data.arch || NA],
    ["CPU Model", data.cpuModel || NA],
    ["CPU Cores", data.cpuCores || NA],
    ["CPU Usage", data.cpuUsage != null ? data.cpuUsage + "%" : NA],
    ["RAM Total", data.memTotal ? fmtBytes(data.memTotal) : NA],
    ["RAM Used", data.memUsed != null ? fmtBytes(data.memUsed) + " (" + data.memPct + "%)" : NA],
    ["RAM Free", data.memFree != null ? fmtBytes(data.memFree) : NA],
    ["Disk Total", data.diskTotal ? fmtBytes(data.diskTotal) : NA],
    ["Disk Used", data.diskUsed != null ? fmtBytes(data.diskUsed) + " (" + data.diskPct + "%)" : NA],
    ["Disk Free", data.diskFree != null ? fmtBytes(data.diskFree) : NA],
    ["Load Average", data.loadavg ? data.loadavg.join(" / ") : NA],
    ["Uptime", data.uptime != null ? fmtSec(data.uptime) : NA],
    ["Timezone", data.timezone || NA],
    ["Server Date/Time", data.datetime || NA],
    ["Virtualization", data.virtualization || NA],
    ["Container", data.container || NA],
    ["Server Status", ST("ONLINE", true)]
  ]);
  renderRows("#osData", [
    ["Distribution", data.osDist || data.os || NA],
    ["Version", data.osVersion || NA],
    ["Kernel", data.kernel || NA],
    ["Architecture", data.arch || NA],
    ["Hostname", data.hostname || NA],
    ["Boot Time", data.bootTime || NA],
    ["Uptime", data.uptime != null ? fmtSec(data.uptime) : NA],
    ["Virtualization", data.virtualization || NA]
  ]);
  updateHealthRow("SERVER", ST("ONLINE", true));
  if (state.headers) renderWebServerPanel(state.headers, state.results.http?.protocol || "unknown");
  startLiveMonitor();
}

let liveTimer = null, cpuHistory = [];
async function pollLive() {
  const d = await fetchJSON("/api/diagnostics/live");
  const box = $("#liveData");
  if (!d) { clearInterval(liveTimer); $("#liveIndicator").textContent = "● OFFLINE"; $("#liveIndicator").className = "live-indicator"; return; }
  $("#liveIndicator").textContent = "● LIVE"; $("#liveIndicator").className = "live-indicator on";
  const bar = (label, pct, suffix) => {
    const f = Math.round(pct / 10);
    return `<span class="k">${label.padEnd(5)}</span> <span class="live-bar-fill">${"█".repeat(f)}</span><span class="live-bar-rest">${"░".repeat(10 - f)}</span> ${pct}${suffix}`;
  };
  box.innerHTML = `<div class="live-bars">${bar("CPU", d.cpuPct ?? 0, "%")}\n${bar("RAM", d.memPct ?? 0, "%")}\n${bar("DISK", d.diskPct ?? 0, "%")}\nLOAD     ${d.load1 ?? NA}   UPTIME ${fmtSec(d.uptime)}</div>`;
  cpuHistory.push(d.cpuPct ?? 0);
  if (cpuHistory.length > 60) cpuHistory.shift();
  drawLiveChart();
}
function drawLiveChart() {
  const cv = $("#liveChart");
  const ctx = cv.getContext("2d");
  const w = cv.width = cv.clientWidth * devicePixelRatio;
  const h = cv.height = 90 * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#232a38"; ctx.beginPath();
  [0.25, 0.5, 0.75].forEach(f => { ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); }); ctx.stroke();
  if (cpuHistory.length < 2) return;
  ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 2 * devicePixelRatio; ctx.beginPath();
  cpuHistory.forEach((v, i) => {
    const x = (i / (cpuHistory.length - 1)) * w;
    const y = h - (v / 100) * h;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}
function startLiveMonitor() {
  if (liveTimer) return;
  $("#liveIndicator").textContent = "● LIVE"; $("#liveIndicator").className = "live-indicator on";
  pollLive();
  liveTimer = setInterval(pollLive, 3000);
}

/* ---------------- web server + http ---------------- */
async function runHttpDiagnostics() {
  $("#httpHost").textContent = location.host;
  const nav = performance.getEntriesByType("navigation")[0];
  const protocol = nav?.nextHopProtocol || "unknown";
  let resp;
  const t0 = performance.now();
  try {
    resp = await fetch(location.href, { method: "GET", cache: "no-store" });
  } catch (e) {
    renderRows("#httpData", [["Request", ST("FAILED", false)]]);
    $("#httpTerminal").textContent = "$ GET /\n→ request failed: " + e.message;
    return;
  }
  const elapsed = performance.now() - t0;
  const headers = {};
  resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  state.headers = headers;
  state.results.http = { protocol, statusCode: resp.status, elapsed, headers };

  $("#httpTerminal").innerHTML =
    `$ GET ${location.pathname} HTTP\n` +
    `Host: ${esc(location.host)}\n` +
    `User-Agent: JUAN-WEB-LAB/1.0\n\n` +
    `← HTTP ${resp.status} ${resp.statusText || ""}\n` +
    `protocol: ${esc(protocol)}\n` +
    `time: ${Math.round(elapsed)} ms`;

  renderRows("#httpData", [
    ["Status Code", ST(`${resp.status} ${resp.statusText || ""}`.trim(), resp.ok ? true : resp.status < 500 ? "warn" : false)],
    ["HTTP Protocol", protocol !== "unknown" ? protocol.toUpperCase() : NA],
    ["Content-Type", headers["content-type"] || NA],
    ["Content-Encoding", headers["content-encoding"] || "none (identity)"],
    ["Cache-Control", headers["cache-control"] || NA],
    ["ETag", headers["etag"] || NA],
    ["Server", headers["server"] || NA],
    ["Date (header)", headers["date"] || NA],
    ["Content-Length", headers["content-length"] || "(chunked)"],
    ["Response Time", fmtMs(elapsed)]
  ]);
  $("#httpHeaders").textContent = Object.entries(headers).map(([k, v]) => k + ": " + v).join("\n") || "(headers not exposed)";

  renderWebServerPanel(headers, protocol);
  renderEdgePanel(headers);
  renderSslPanel(headers, protocol);
  renderClockFromHeaders(headers.date);
}

function renderWebServerPanel(h, protocol) {
  const api = state.results.server || {};
  let compression = "none detected";
  if (h["content-encoding"]) compression = h["content-encoding"].toUpperCase();
  renderRows("#webServerData", [
    ["Web Server", h["server"] || api.serverSoftware || NA],
    ["Server Version", h["server"]?.match(/[\d.]+/)?.[0] || NA],
    ["PHP Version", api.phpVersion || NA],
    ["Node.js Version", api.nodeVersion || NA],
    ["Python Version", api.pythonVersion || NA],
    ["Database Software", api.database || NA],
    ["HTTP Protocol", protocol !== "unknown" ? protocol.toUpperCase() : NA],
    ["TLS Version", api.tlsVersion || (h["strict-transport-security"] ? "secure (HSTS active)" : NA)],
    ["OpenSSL", api.openssl || NA],
    ["Framework", api.framework || NA],
    ["Reverse Proxy", h["x-proxy"] || h["via"] || (h["x-powered-by"] ? "possible (x-powered-by present)" : NA)],
    ["CDN", cdnFromHeaders(h) || NA],
    ["Compression", compression],
    ["Gzip", /gzip/i.test(compression) ? ST("ENABLED", true) : ST("NOT DETECTED", "gray")],
    ["Brotli", /br/i.test(compression) ? ST("ENABLED", true) : ST("NOT DETECTED", "gray")]
  ]);
}

function cdnFromHeaders(h) {
  if (h["cf-ray"] || h["cf-cache-status"]) return "Cloudflare";
  if (h["x-amz-cf-id"]) return "CloudFront";
  if (h["x-fastly-request-id"] || h["x-served-by"]?.includes("cache")) return "Fastly";
  if (h["x-vercel-id"] || h["x-vercel-cache"]) return "Vercel";
  if (h["x-nf-request-id"]) return "Netlify";
  if (h["x-sucuri-id"]) return "Sucuri";
  if (h["x-arbiter"] || h["x-anypage"]) return "Unknown CDN";
  if (h["via"]) return "Via: " + h["via"];
  return null;
}

function renderEdgePanel(h) {
  const cdn = cdnFromHeaders(h);
  renderRows("#edgeData", [
    ["CDN", cdn || "Unknown (direct origin likely)"],
    ["Proxy / Reverse Proxy", h["via"] || h["x-proxy"] ? ST("DETECTED", true) : ST("UNKNOWN", "gray")],
    ["Cache Status", h["cf-cache-status"] || h["x-vercel-cache"] || h["x-cache"] || NA],
    ["Region / POP", h["cf-ray"] ? h["cf-ray"].split("-")[1] || NA : h["x-vercel-ip-city"] || NA],
    ["Ray ID", h["cf-ray"] || h["x-amz-cf-id"] || NA],
    ["Age", h["age"] ? h["age"] + "s" : NA]
  ]);
}

/* ---------------- SSL ---------------- */
function renderSslPanel(h, protocol) {
  const https = location.protocol === "https:";
  const api = state.results.server || {};
  const hsts = h["strict-transport-security"];
  let verdict = ST("UNKNOWN", "gray");
  if (https && !mixedContent()) verdict = ST("SECURE", true);
  else if (https) verdict = ST("⚠ WARNING — MIXED CONTENT", "warn");
  else if (location.protocol === "file:") verdict = ST("N/A (FILE)", "gray");
  else verdict = ST("✕ INSECURE (PLAIN HTTP)", false);

  $("#sslVerdict").outerHTML = `<span class="badge badge-cyan" id="sslVerdict">${verdict.text}</span>`;
  state.results.ssl = { https, tls: api.tlsVersion || null, hsts: !!hsts };
  renderRows("#sslData", [
    ["HTTPS Enabled", ST(https ? "YES" : "NO", https)],
    ["TLS Version", api.tlsVersion || NA],
    ["Certificate Issuer", api.certIssuer || NA],
    ["Certificate Expires", api.certExpires || NA],
    ["Secure Connection", ST(https ? "YES" : "NO", https)],
    ["Mixed Content", mixedContent() ? ST("DETECTED", false) : ST("NONE", true)],
    ["HSTS", hsts ? ST("ENABLED", true) : ST("NOT SET", "warn")],
    ["HSTS Value", hsts || NA]
  ]);
  updateHealthRow("HTTPS", https ? ST("SECURE", true) : ST("INSECURE", false));
}
function mixedContent() {
  if (location.protocol !== "https:") return false;
  return [...document.querySelectorAll("img[src], script[src], link[href]")].some(el => {
    const u = el.src || el.href || "";
    return u.startsWith("http://");
  });
}

/* ---------------- DNS ---------------- */
async function runDnsTest() {
  renderRows("#dnsData", [["Test", "Resolving…"]]);
  const d = await fetchJSON("/api/diagnostics/dns");
  if (!d || d.error) {
    renderRows("#dnsData", [
      ["Domain", location.hostname],
      ["DNS Test", ST(d?.error ? d.error : "API NOT AVAILABLE", "gray")]
    ]);
    state.results.dns = { ok: false };
    return;
  }
  state.results.dns = { ok: true, ...d };
  renderRows("#dnsData", [
    ["Domain", d.domain],
    ["A Record", d.a?.join(", ") || NA],
    ["AAAA Record", d.aaaa?.join(", ") || NA],
    ["CNAME", d.cname || NA],
    ["Nameservers", d.ns?.join(", ") || NA],
    ["DNS Provider", d.provider || "Unknown"],
    ["Resolution Time", fmtMs(d.resolveMs)]
  ]);
}

/* ---------------- server clock ---------------- */
let serverOffsetMs = null;
function renderClockFromHeaders(dateHeader) {
  if (!dateHeader) { $("#serverClock").textContent = NA; $("#clockOffset").textContent = UNKNOWN(); return; }
  const serverMs = new Date(dateHeader).getTime();
  const localAtResponse = performance.getEntriesByType("navigation")[0]?.responseStart ?? Date.now();
  serverOffsetMs = serverMs - localAtResponse;
  tickClock();
}
function UNKNOWN() { return NA; }
setInterval(tickClock, 1000);
function tickClock() {
  const now = new Date();
  $("#clientClock").textContent = now.toTimeString().slice(0, 8);
  if (serverOffsetMs != null) {
    $("#serverClock").textContent = new Date(Date.now() + serverOffsetMs).toTimeString().slice(0, 8);
    const s = Math.round(serverOffsetMs / 1000);
    $("#clockOffset").textContent = (s === 0 ? "±0" : (s > 0 ? "+" : "") + s) + " second" + (Math.abs(s) === 1 ? "" : "s");
  }
}

/* ---------------- performance ---------------- */
function runPerformancePanel() {
  const p = performance.getEntriesByType("navigation")[0];
  if (!p) { renderRows("#perfData", [["Performance API", NA]]); return; }
  const paint = performance.getEntriesByType("paint");
  const fp = paint.find(e => e.name === "first-paint")?.startTime;
  const fcp = paint.find(e => e.name === "first-contentful-paint")?.startTime;
  const res = performance.getEntriesByType("resource");
  const byType = t => res.filter(r => r.initiatorType === t);
  const sum = arr => arr.reduce((a, r) => a + (r.transferSize || 0), 0);

  const rows = [
    ["DOM Content Loaded", ((p.domContentLoadedEventEnd - p.startTime) / 1000).toFixed(2) + "s"],
    ["Load Event", ((p.loadEventEnd - p.startTime) / 1000).toFixed(2) + "s"],
    ["First Paint", fp != null ? (fp / 1000).toFixed(2) + "s" : NA],
    ["First Contentful Paint", fcp != null ? (fcp / 1000).toFixed(2) + "s" : NA],
    ["Largest Contentful Paint", state.results.lcp != null ? (state.results.lcp / 1000).toFixed(2) + "s" : NA],
    ["INP / FID", state.results.inp != null ? state.results.inp + " ms" : NA],
    ["Total Blocking Time", state.results.tbt != null ? state.results.tbt + " ms" : NA],
    ["Resources", String(res.length)],
    ["JS Transfer Size", fmtBytes(sum(byType("script")))],
    ["CSS Transfer Size", fmtBytes(sum(res.filter(r => /\.css($|\?)/.test(new URL(r.name, location.href).pathname))))],
    ["Image Transfer Size", fmtBytes(sum(byType("img")))],
    ["Total Transfer Size", fmtBytes(p.transferSize + sum(res))],
    ["Page Weight (decoded)", fmtBytes(p.decodedBodySize)]
  ];
  renderRows("#perfData", rows);
  state.results.perf = { load: p.loadEventEnd - p.startTime, fcp, lcp: state.results.lcp };

  const bar = $("#perfBar");
  const loadSec = (p.loadEventEnd - p.startTime) / 1000;
  bar.style.width = Math.min(100, Math.max(5, 100 - loadSec * 12)) + "%";

  let v, cls;
  if (loadSec < 1.5 && (fcp == null || fcp < 1800)) { v = "EXCELLENT"; cls = true; }
  else if (loadSec < 3) { v = "GOOD"; cls = true; }
  else if (loadSec < 6) { v = "FAIR"; cls = "warn"; }
  else { v = "POOR"; cls = false; }
  $("#perfVerdict").innerHTML = `PERFORMANCE&nbsp;&nbsp;<span class="status ${statusClass(cls)}">● ${v}</span>`;
  updateHealthRow("PERFORMANCE", ST(v, cls));
}

try {
  new PerformanceObserver(list => {
    const e = list.getEntries();
    state.results.lcp = e[e.length - 1].startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
} catch {}

try {
  let tbt = 0;
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration > 50) tbt += e.duration - 50;
    state.results.tbt = Math.round(tbt);
  }).observe({ type: "longtask", buffered: true });
} catch {}

try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.interactionId) state.results.inp = Math.round(e.duration);
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
} catch {}

/* ---------------- capabilities ---------------- */
function runCapabilityTests() {
  const results = [];
  const test = (name, fn) => {
    try {
      const r = fn();
      results.push([name, r]);
    } catch { results.push([name, "BLOCKED"]); }
  };

  test("JavaScript", () => ST("PASS", true));
  test("WebGL", () => {
    const c = document.createElement("canvas");
    return c.getContext("webgl") || c.getContext("experimental-webgl") ? ST("PASS", true) : ST("NOT SUPPORTED", false);
  });
  test("WebGL2", () => document.createElement("canvas").getContext("webgl2") ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("WebGPU", () => navigator.gpu ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("WebAssembly", () => typeof WebAssembly === "object" ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Web Workers", () => typeof Worker !== "undefined" ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Service Workers", () => "serviceWorker" in navigator ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("IndexedDB", () => window.indexedDB ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("LocalStorage", () => { localStorage.setItem("_t", "1"); localStorage.removeItem("_t"); return ST("PASS", true); });
  test("SessionStorage", () => { sessionStorage.setItem("_t", "1"); sessionStorage.removeItem("_t"); return ST("PASS", true); });
  test("Cookies", () => {
    if (!navigator.cookieEnabled) return ST("BLOCKED", false);
    document.cookie = "_jwl=1; SameSite=Lax";
    const ok = document.cookie.includes("_jwl");
    document.cookie = "_jwl=; Max-Age=0";
    return ok ? ST("PASS", true) : ST("BLOCKED", false);
  });
  test("WebSocket", () => typeof WebSocket !== "undefined" ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Fetch API", () => typeof fetch === "function" ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Streams API", () => typeof ReadableStream !== "undefined" ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Web Crypto", () => crypto?.subtle ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Notifications", () => "Notification" in window ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Clipboard", () => navigator.clipboard ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Geolocation", () => navigator.geolocation ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Camera", () => navigator.mediaDevices?.getUserMedia ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Microphone", () => navigator.mediaDevices?.getUserMedia ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Bluetooth", () => navigator.bluetooth ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("USB", () => navigator.usb ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));
  test("Gamepad", () => navigator.getGamepads ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Web Audio", () => window.AudioContext || window.webkitAudioContext ? ST("PASS", true) : ST("NOT SUPPORTED", false));
  test("Screen Capture", () => navigator.mediaDevices?.getDisplayMedia ? ST("PERMISSION REQUIRED", "warn") : ST("NOT SUPPORTED", false));

  state.results.capabilities = Object.fromEntries(results.map(([k, v]) => [k, typeof v === "string" ? v : v.text]));
  $("#capGrid").innerHTML = results.map(([name, v]) => {
    const text = typeof v === "string" ? v : v.text;
    const cls = typeof v === "string" ? "st-gray" : statusClass(v.st);
    return `<div class="cap-item"><span>${esc(name)}</span><span class="cap-status ${cls}">${esc(text)}</span></div>`;
  }).join("");
  const passCount = results.filter(([, v]) => typeof v !== "string" && v.st === true).length;
  $("#capsBadge").textContent = `${passCount}/${results.length} PASS`;
  updateHealthRow("BROWSER", ST("READY", true));
}

/* ---------------- storage ---------------- */
async function runStorageTests() {
  const out = [];
  const syncCheck = (name, fn) => { try { out.push([name, fn()]); } catch { out.push([name, ST("BLOCKED", false)]); } };

  syncCheck("Cookies", () => {
    document.cookie = "_jwl_s=1; SameSite=Lax; path=/";
    const ok = document.cookie.includes("_jwl_s");
    document.cookie = "_jwl_s=; Max-Age=0; path=/";
    return ok ? ST("WRITABLE", true) : ST("BLOCKED", false);
  });
  syncCheck("LocalStorage", () => {
    const k = "_jwl_ls_" + Date.now();
    localStorage.setItem(k, "ok");
    const ok = localStorage.getItem(k) === "ok";
    localStorage.removeItem(k);
    return ok ? ST("WRITABLE", true) : ST("FAILED", false);
  });
  syncCheck("SessionStorage", () => {
    const k = "_jwl_ss_" + Date.now();
    sessionStorage.setItem(k, "ok");
    const ok = sessionStorage.getItem(k) === "ok";
    sessionStorage.removeItem(k);
    return ok ? ST("WRITABLE", true) : ST("FAILED", false);
  });

  const asyncCheck = async (name, fn) => {
    try { out.push([name, await fn()]); }
    catch { out.push([name, ST("BLOCKED / NOT AVAILABLE", "gray")]); }
  };

  await asyncCheck("IndexedDB", () => new Promise(resolve => {
    if (!window.indexedDB) return resolve(ST("NOT SUPPORTED", false));
    let db;
    const req = indexedDB.open("_jwl_test", 1);
    req.onerror = () => resolve(ST("BLOCKED", false));
    req.onsuccess = () => { db.close(); indexedDB.deleteDatabase("_jwl_test"); resolve(ST("WRITABLE", true)); };
  }));
  await asyncCheck("Cache Storage", async () => {
    if (!window.caches) return ST("NOT SUPPORTED", false);
    const c = await caches.open("_jwl_test");
    await c.put("/_jwl_probe", new Response("ok"));
    const r = await c.match("/_jwl_probe");
    await caches.delete("_jwl_test");
    return r ? ST("WRITABLE", true) : ST("FAILED", false);
  });
  await asyncCheck("Service Worker", async () => {
    if (!("serviceWorker" in navigator)) return ST("NOT SUPPORTED", false);
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? ST("REGISTERED", true) : ST("AVAILABLE — NONE REGISTERED", "gray");
  });

  state.results.storage = Object.fromEntries(out.map(([k, v]) => [k, typeof v === "string" ? v : v.text]));
  renderRows("#storageData", out);
}

/* ---------------- js engine + benchmark ---------------- */
function runJsEnginePanel() {
  renderRows("#jsData", [
    ["JavaScript", ST("ENABLED", true)],
    ["WebAssembly", typeof WebAssembly === "object" ? ST("PASS", true) : ST("NOT SUPPORTED", false)],
    ["Worker Support", typeof Worker !== "undefined" ? ST("PASS", true) : ST("NOT SUPPORTED", false)],
    ["ES Modules", "noModule" in document.createElement("script") ? ST("PASS", true) : ST("CHECK FAILED", "gray")],
    ["BigInt", typeof BigInt === "function" ? ST("PASS", true) : ST("NOT SUPPORTED", false)],
    ["Async/Await", (() => { try { return (async () => {})() instanceof Promise ? ST("PASS", true) : ST("NOT SUPPORTED", false); } catch { return ST("NOT SUPPORTED", false); } })()],
    ["Optional Chaining", (() => { try { return ({}) ?.a === undefined ? ST("PASS", true) : ST("FAIL", false); } catch { return ST("NOT SUPPORTED", false); } })()],
    ["Web Crypto", crypto?.subtle ? ST("PASS", true) : ST("NOT SUPPORTED", false)],
    ["Performance API", performance.mark ? ST("PASS", true) : ST("NOT SUPPORTED", false)]
  ]);
}

function runBenchmark() {
  renderRows("#benchData", [["Benchmark", "Running…"]]);
  setTimeout(() => {
    const N = 2_000_000;
    let t0 = performance.now();
    let x = 0;
    for (let i = 0; i < N; i++) x += Math.sqrt(i % 1000);
    const loopMs = performance.now() - t0;

    t0 = performance.now();
    const arr = Array.from({ length: 200_000 }, (_, i) => i);
    arr.sort((a, b) => b - a);
    const sortMs = performance.now() - t0;

    t0 = performance.now();
    let s = "";
    for (let i = 0; i < 50_000; i++) s += "x";
    const strMs = performance.now() - t0;

    t0 = performance.now();
    const json = JSON.stringify({ arr: arr.slice(0, 1000) });
    JSON.parse(json);
    const jsonMs = performance.now() - t0;

    const total = loopMs + sortMs + strMs + jsonMs;
    state.results.benchmark = { loopMs, sortMs, strMs, jsonMs, total, opsPerSec: Math.round(N / (loopMs / 1000)) };
    renderRows("#benchData", [
      ["Numeric Loop (2M)", loopMs.toFixed(1) + " ms"],
      ["Array Sort (200K)", sortMs.toFixed(1) + " ms"],
      ["String Concat (50K)", strMs.toFixed(1) + " ms"],
      ["JSON Serialize", jsonMs.toFixed(1) + " ms"],
      ["Total Time", total.toFixed(1) + " ms"],
      ["Throughput", Math.round(N / (loopMs / 1000)).toLocaleString() + " ops/s"]
    ]);
    toast("Benchmark complete: " + total.toFixed(0) + " ms total", "ok");
  }, 30);
}

/* ---------------- database ---------------- */
async function loadDatabasePanel() {
  const d = await fetchJSON("/api/diagnostics/database");
  if (!d) {
    renderRows("#dbData", [["Connection", ST("UNKNOWN — API OFFLINE", "gray")], ["Database", NA], ["Version", NA], ["Response", NA]]);
    $("#dbBadge").textContent = "API OFFLINE";
    return;
  }
  state.results.database = d;
  renderRows("#dbData", [
    ["Connection", ST(d.connected ? "CONNECTED" : "NOT CONNECTED", d.connected ? true : "warn")],
    ["Database", d.database || NA],
    ["Version", d.version || NA],
    ["Response Time", d.responseMs != null ? d.responseMs + " ms" : NA],
    ["Detail", d.detail || NA]
  ]);
  $("#dbBadge").textContent = d.connected ? "CONNECTED" : "NO DATABASE";
}

/* ---------------- health / score ---------------- */
const healthState = {};
function updateHealthRow(label, stObj) {
  healthState[label] = stObj;
  const rows = $$("#healthRows .row");
  const map = { SERVER: 0, NETWORK: 1, HTTPS: 2, BROWSER: 3, PERFORMANCE: 4, DATABASE: 5 };
  const row = rows[map[label]];
  if (!row) return;
  const v = row.querySelector(".v");
  v.className = "v status " + statusClass(stObj.st);
  v.innerHTML = `${dotHtml(stObj.st)} ${esc(stObj.text)}`;
}

function computeScore() {
  let score = 0;
  const parts = [];
  const add = (label, cond, weight) => {
    const got = cond === true ? weight : cond === "warn" ? Math.round(weight * 0.5) : 0;
    parts.push([label, cond, weight, got]);
    score += got;
  };

  add("SERVER", healthState.SERVER?.st === true ? true : healthState.SERVER ? "warn" : "gray", 15);
  add("NETWORK", healthState.NETWORK?.st === true ? true : healthState.NETWORK?.st === "warn" ? "warn" : "gray", 15);
  add("HTTPS", healthState.HTTPS?.st === true ? true : healthState.HTTPS?.st === false ? false : "gray", 20);
  add("BROWSER", healthState.BROWSER?.st === true, 10);
  const perfSt = healthState.PERFORMANCE?.st;
  add("PERFORMANCE", perfSt === true ? true : perfSt === "warn" ? "warn" : perfSt === false ? false : "gray", 15);
  const caps = state.results.capabilities || {};
  const capPass = Object.values(caps).filter(v => v === "PASS").length;
  const capTotal = Math.max(1, Object.keys(caps).length);
  const capRatio = capPass / capTotal;
  add("CAPABILITIES", capRatio > 0.7 ? true : capRatio > 0.4 ? "warn" : false, 10);
  const storage = state.results.storage || {};
  const storPass = Object.values(storage).filter(v => v === "WRITABLE" || v === "REGISTERED").length;
  add("STORAGE", storPass >= 4 ? true : storPass >= 2 ? "warn" : false, 10);
  const dbSt = state.results.database;
  add("DATABASE", dbSt ? (dbSt.connected ? true : "warn") : "gray", 5);

  state.score = { score, parts };
  return { score, parts };
}

/* ---------------- full diagnostic ---------------- */
async function runFullDiagnostic(full = true) {
  const btn = $("#btnFullDiag"), quick = $("#btnQuickTest");
  btn.disabled = true; quick.disabled = true;
  $("#diagProgress").classList.remove("hidden");
  $("#systemStatus").textContent = "RUNNING…";

  const steps = full ? [
    ["Detecting client environment…", () => runClientDetection()],
    ["Testing network…", () => runNetworkPanel()],
    ["Querying server info…", () => loadServerInfo()],
    ["Analyzing HTTP response…", () => runHttpDiagnostics()],
    ["Checking TLS/SSL…", () => {}],
    ["Resolving DNS…", () => runDnsTest()],
    ["Probing browser capabilities…", () => runCapabilityTests()],
    ["Testing storage…", () => runStorageTests()],
    ["Measuring performance…", () => runPerformancePanel()],
    ["Testing database…", () => loadDatabasePanel()],
    ["Generating report…", () => { runJsEnginePanel(); }]
  ] : [
    ["Detecting client environment…", () => runClientDetection()],
    ["Testing network & latency…", () => runLatencyTest()],
    ["Analyzing HTTP response…", () => runHttpDiagnostics()],
    ["Measuring performance…", () => runPerformancePanel()]
  ];

  for (let i = 0; i < steps.length; i++) {
    const [label, fn] = steps[i];
    setProgress(i / steps.length, label);
    try { await fn(); } catch (e) { console.warn(e); }
    await new Promise(r => setTimeout(r, 120));
  }
  setProgress(1, "Diagnostic complete.");

  const { score, parts } = computeScore();
  $("#healthScoreBadge").textContent = `${score} / 100`;
  $("#systemStatus").textContent = "DIAGNOSTIC COMPLETE";
  toast(`Diagnostic complete — overall health ${score}/100`, score >= 70 ? "ok" : "warn");
  btn.disabled = false; quick.disabled = false;
  setTimeout(() => $("#diagProgress").classList.add("hidden"), 1500);
}
function setProgress(frac, label) {
  const pct = Math.round(frac * 100);
  const filled = Math.round(frac * 20);
  $("#progressBar").textContent = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${String(pct).padStart(3)}%`;
  $("#progressLabel").textContent = label;
}

$("#btnFullDiag").addEventListener("click", () => runFullDiagnostic(true));
$("#btnQuickTest").addEventListener("click", () => runFullDiagnostic(false));

/* ---------------- export report ---------------- */
function buildReportText() {
  const lines = [];
  lines.push("JUAN WEB LAB — DIAGNOSTIC REPORT");
  lines.push("Generated: " + new Date().toISOString());
  lines.push("Target: " + location.href);
  lines.push("=".repeat(60));
  for (const [key, val] of Object.entries(state.results)) {
    lines.push("");
    lines.push("-- " + key.toUpperCase() + " --");
    lines.push(JSON.stringify(val, null, 2));
  }
  if (state.score) {
    lines.push("");
    lines.push("-- OVERALL HEALTH --");
    lines.push("Score: " + state.score.score + "/100");
    state.score.parts.forEach(([l, c, w, g]) => lines.push(`  ${l}: ${g}/${w}`));
  }
  lines.push("");
  lines.push("Values marked NOT AVAILABLE could not be detected.");
  return lines.join("\n");
}
$("#btnExport").addEventListener("click", () => {
  if (Object.keys(state.results).length < 3) { toast("Run at least Quick Test first.", "warn"); return; }
  const wrap = document.createElement("div");
  wrap.className = "toast";
  wrap.innerHTML = `Export report as:
    <button class="btn btn-small btn-outline" data-fmt="json">JSON</button>
    <button class="btn btn-small btn-outline" data-fmt="txt">TXT</button>
    <button class="btn btn-small btn-outline" data-fmt="pdf">PDF</button>`;
  wrap.style.display = "flex"; wrap.style.gap = "8px"; wrap.style.flexWrap = "wrap"; wrap.style.alignItems = "center";
  $("#toastWrap").appendChild(wrap);
  wrap.querySelectorAll("[data-fmt]").forEach(b => b.onclick = () => {
    const fmt = b.dataset.fmt;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    if (fmt === "json") download(JSON.stringify(state.results, null, 2), `juan-web-lab-report-${stamp}.json`, "application/json");
    else if (fmt === "txt") download(buildReportText(), `juan-web-lab-report-${stamp}.txt`, "text/plain");
    else window.print();
    wrap.remove();
  });
  setTimeout(() => wrap.remove(), 8000);
});
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Report exported: " + filename, "ok");
}

/* ---------------- HTTP status lab ---------------- */
const STATUS_CODES = {
  200: ["OK", "Standard success response.", "Resource found and returned normally."],
  201: ["Created", "Request succeeded and a new resource was created.", "POST that creates a resource returns this."],
  204: ["No Content", "Success with no body returned.", "Successful DELETE or PUT without response body."],
  301: ["Moved Permanently", "Resource permanently moved to a new URL.", "Domain migration or HTTP → HTTPS redirect."],
  302: ["Found", "Temporary redirect to another URL.", "Temporary maintenance or A/B routing."],
  304: ["Not Modified", "Cached version is still valid.", "Client sends If-None-Match / If-Modified-Since and content unchanged."],
  400: ["Bad Request", "Server cannot process the malformed request.", "Invalid JSON body, bad query parameters."],
  401: ["Unauthorized", "Authentication required or failed.", "Missing/expired token or wrong credentials."],
  403: ["Forbidden", "Server understood but refuses to authorize.", "IP blocked, missing permission, directory listing disabled."],
  404: ["Not Found", "Requested resource does not exist.", "Broken link, wrong path, deleted file."],
  408: ["Request Timeout", "Client took too long to send the request.", "Slow mobile connection uploading large body."],
  429: ["Too Many Requests", "Rate limit exceeded.", "API rate limiting or bot protection triggered."],
  500: ["Internal Server Error", "Unexpected server-side failure.", "Application crash, unhandled exception, misconfiguration."],
  502: ["Bad Gateway", "Upstream returned an invalid response.", "Backend/app server down while reverse proxy still up."],
  503: ["Service Unavailable", "Server temporarily overloaded or under maintenance.", "Restarting service, capacity limits, maintenance mode."],
  504: ["Gateway Timeout", "Upstream did not respond in time.", "Backend too slow behind nginx/proxy timeout."]
};
(function initStatusLab() {
  const grid = $("#codeGrid");
  Object.keys(STATUS_CODES).sort((a, b) => a - b).forEach(code => {
    const b = document.createElement("button");
    b.className = "code-chip";
    b.type = "button";
    b.textContent = code;
    b.setAttribute("aria-label", "HTTP " + code);
    b.onclick = () => {
      $$(".code-chip").forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      const [meaning, desc, cause] = STATUS_CODES[code];
      $("#cdCode").textContent = code;
      $("#cdMeaning").textContent = meaning;
      renderRows("#cdBody", [["Description", desc], ["Common Cause", cause], ["Example", `curl -I https://httpstat.us/${code}  →  HTTP/${code.startsWith("4") || code.startsWith("5") ? "1.1" : "2"} ${code} ${meaning}`]]);
      $("#codeDetail").classList.remove("hidden");
    };
    grid.appendChild(b);
  });
})();

/* ---------------- API tester ---------------- */
$("#apiForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const method = $("#apiMethod").value;
  const urlStr = $("#apiUrl").value.trim();
  const resultBox = $("#apiResult");

  let target;
  try { target = new URL(urlStr); } catch { toast("Invalid URL", "err"); return; }
  if (!/^https?:$/.test(target.protocol)) { toast("Only http/https URLs allowed", "err"); return; }
  const local = [location.hostname, "localhost", "127.0.0.1", "[::1]", "0.0.0.0"].some(h => target.hostname === h || target.hostname.endsWith("." + h));
  if (local && target.port && !["80", "443", "8080", location.port].includes(target.port)) {
    toast("Blocked: requests to local network ports are not allowed", "err");
    return;
  }

  let headers = {};
  const rawHeaders = $("#apiHeaders").value.trim();
  if (rawHeaders) {
    try {
      headers = JSON.parse(rawHeaders);
      if (typeof headers !== "object" || Array.isArray(headers)) throw 0;
      for (const k of Object.keys(headers)) if (/^(authorization-internal|cookie)$/i.test(k)) delete headers[k];
    } catch { toast("Headers must be valid JSON object", "err"); return; }
  }
  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  const body = $("#apiBody").value.trim();
  if (body && !["GET", "HEAD"].includes(method)) opts.body = body;

  const btn = $(".btn-send");
  btn.disabled = true; btn.textContent = "SENDING…";
  const t0 = performance.now();
  try {
    const resp = await fetch(target.href, opts);
    const ms = performance.now() - t0;
    const hdrs = [];
    resp.headers.forEach((v, k) => hdrs.push(k + ": " + v));
    let bodyText = "";
    try { bodyText = await resp.text(); } catch {}
    resultBox.classList.remove("hidden");
    renderRows("#apiMeta", [
      ["Status", ST(String(resp.status), resp.ok ? true : resp.status < 500 ? "warn" : false)],
      ["Response Time", fmtMs(ms)],
      ["Response Size", fmtBytes(new Blob([bodyText]).size)],
      ["Content-Type", resp.headers.get("content-type") || NA]
    ]);
    $("#apiRespHeaders").textContent = hdrs.join("\n") || "(none exposed by CORS)";
    $("#apiRespBody").textContent = bodyText.slice(0, 20000) || "(empty)";
  } catch (err) {
    resultBox.classList.remove("hidden");
    renderRows("#apiMeta", [["Result", ST("REQUEST FAILED", false)], ["Reason", err.name === "TimeoutError" ? "Timed out after 15s" : err.message]]);
    $("#apiRespHeaders").textContent = ""; $("#apiRespBody").textContent =
      "Note: failures are usually CORS policy or network blocking on the target side.\nThe request was sent directly from your browser.";
  } finally {
    btn.disabled = false; btn.textContent = "SEND REQUEST";
  }
});

/* ---------------- terminal ---------------- */
const termOut = $("#termOut");
const termHistory = [];
let histIdx = -1;

function tprint(html, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.innerHTML = html;
  termOut.appendChild(div);
  termOut.scrollTop = termOut.scrollHeight;
  return div;
}
async function ttype(text, cls = "") {
  const div = tprint("", cls);
  for (const ch of text) {
    div.textContent += ch;
    termOut.scrollTop = termOut.scrollHeight;
    await new Promise(r => setTimeout(r, 6));
  }
}

const commands = {
  help: () => {
    tprint("Available commands:", "t-dim");
    [["help", "show this help"], ["status", "overall system health"], ["server", "server information summary"],
     ["network", "network + latency summary"], ["browser", "client/browser summary"], ["ssl", "TLS/SSL status"],
     ["dns", "run DNS resolution"], ["performance", "page performance metrics"], ["benchmark", "run JS benchmark"],
     ["clear", "clear terminal"]].forEach(([c, d]) => tprint(`  ${c.padEnd(12)}<span class="t-dim">${d}</span>`));
  },
  status: () => {
    const rows = $$("#healthRows .row");
    rows.forEach(r => {
      const k = r.querySelector(".k").textContent;
      tprint(`${k.padEnd(14)} ${r.querySelector(".v").textContent.trim()}`);
    });
    if (state.score) tprint(`OVERALL        ${state.score.score}/100`, "t-ok");
  },
  server: () => {
    const s = state.results.server;
    if (!s) return ttype("Server API not reachable on this host.", "t-warn");
    tprint(`hostname   ${s.hostname ?? NA}`);
    tprint(`os         ${s.os ?? NA}`);
    tprint(`kernel     ${s.kernel ?? NA}`);
    tprint(`arch       ${s.arch ?? NA}`);
    tprint(`cpu        ${(s.cpuModel ?? NA).slice(0, 60)}`);
    tprint(`cores      ${s.cpuCores ?? NA}`);
    tprint(`ram        ${s.memTotal ? fmtBytes(s.memTotal) : NA} (${s.memPct ?? "?"}% used)`);
    tprint(`disk       ${s.diskTotal ? fmtBytes(s.diskTotal) : NA} (${s.diskPct ?? "?"}% used)`);
    tprint(`uptime     ${s.uptime != null ? fmtSec(s.uptime) : NA}`);
    tprint(`load       ${s.loadavg?.join(" / ") ?? NA}`);
  },
  network: () => {
    const n = state.results.network;
    if (!n) return ttype("Network panel has not run yet. Use RUN FULL DIAGNOSTIC.", "t-warn");
    tprint(`ip         ${n.clientIp}`);
    tprint(`online     ${n.online}`);
    tprint(`conn type  ${n.connectionType}`);
    tprint(`effective  ${n.effectiveType}`);
    tprint(`downlink   ${n.downlink}`);
    if (state.results.latency) tprint(`latency    median ${Math.round(state.results.latency.median)} ms`);
    ttype("running fresh latency probe…", "t-dim").then(runLatencyTest);
  },
  browser: () => {
    const c = state.results.client;
    if (!c) return ttype("Client detection pending.", "t-warn");
    tprint(`device     ${c.deviceType}`);
    tprint(`os         ${c.os}`);
    tprint(`browser    ${c.browser} ${c.browserVersion}`);
    tprint(`engine     ${c.engine}`);
    tprint(`screen     ${c.screen} @${c.pixelRatio}x`);
    tprint(`viewport   ${c.viewport}`);
    tprint(`cores      ${c.cpuCores}`);
    tprint(`timezone   ${c.timezone}`);
  },
  ssl: () => {
    const s = state.results.ssl;
    if (!s) return ttype("SSL panel has not run yet.", "t-warn");
    tprint(`https      ${s.https ? "enabled" : "DISABLED"}`, s.https ? "t-ok" : "t-err");
    tprint(`tls        ${s.tls ?? NA}`);
    tprint(`hsts       ${s.hsts ? "enabled" : "not set"}`);
  },
  dns: async () => {
    ttype("resolving " + location.hostname + " …", "t-dim");
    await runDnsTest();
    const d = state.results.dns;
    if (!d?.ok) return tprint("DNS resolution failed or unavailable.", "t-warn");
    tprint(`A          ${d.a?.join(", ") ?? NA}`, "t-ok");
    tprint(`AAAA       ${d.aaaa?.join(", ") ?? NA}`);
    tprint(`NS         ${d.ns?.join(", ") ?? NA}`);
    tprint(`resolved in ${d.resolveMs ?? "?"} ms`);
  },
  performance: () => {
    const p = performance.getEntriesByType("navigation")[0];
    if (!p) return;
    tprint(`dom ready   ${((p.domContentLoadedEventEnd - p.startTime) / 1000).toFixed(2)}s`);
    tprint(`load        ${((p.loadEventEnd - p.startTime) / 1000).toFixed(2)}s`);
    tprint(`first paint ${performance.getEntriesByType("paint").find(e => e.name === "first-paint") ? (performance.getEntriesByType("paint").find(e => e.name === "first-paint").startTime / 1000).toFixed(2) + "s" : NA}`);
    tprint(`resources   ${performance.getEntriesByType("resource").length}`);
    tprint(`transfer    ${fmtBytes(p.transferSize)}`);
  },
  benchmark: () => { ttype("running benchmark…", "t-dim"); runBenchmark(); },
  clear: () => { termOut.innerHTML = ""; }
};

$("#termForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("#termInput");
  const cmd = input.value.trim();
  input.value = "";
  if (!cmd) return;
  tprint(`<span class="t-dim">juan@web-lab:~$</span> <span class="t-cmd">${esc(cmd)}</span>`);
  termHistory.push(cmd);
  histIdx = termHistory.length;
  const [base, ...args] = cmd.toLowerCase().split(/\s+/);
  if (commands[base]) {
    try { commands[base](args); } catch (err) { tprint("error: " + err.message, "t-err"); }
  } else {
    tprint(`command not found: ${esc(base)} — type 'help'`, "t-err");
  }
});
$("#termInput").addEventListener("keydown", e => {
  if (e.key === "ArrowUp") { e.preventDefault(); if (histIdx > 0) $("#termInput").value = termHistory[--histIdx]; }
  if (e.key === "ArrowDown") { e.preventDefault(); histIdx = Math.min(termHistory.length, histIdx + 1); $("#termInput").value = termHistory[histIdx] ?? ""; }
});

$$("[data-action]").forEach(btn => btn.addEventListener("click", () => {
  const action = btn.dataset.action;
  if (action === "latency") runLatencyTest();
  if (action === "dns") runDnsTest();
  if (action === "benchmark") runBenchmark();
}));

/* ---------------- init ---------------- */
(async function init() {
  tprint(`<span class="t-ok">JUAN WEB LAB shell</span> <span class="t-dim">— connected ${new Date().toLocaleTimeString()}</span>`);
  tprint(`type <span class="t-cmd">help</span> to list commands.`, "t-dim");

  runClientDetection();
  runJsEnginePanel();
  tickClock();

  runCapabilityTests();
  runStorageTests();
  await runLatencyTest();
  await runHttpDiagnostics();
  runPerformancePanel();
  loadDatabasePanel();
  loadServerInfo();
})();
