"use strict";

/* ================================================================
   JUAN WEB LAB v2 — Diagnostic Engine
   Every test returns a consistent structure and runs in isolation.
   One failing/timeout test NEVER stops the rest of the suite.
   ================================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const NA = "NOT AVAILABLE";

/* ---------------- global state ---------------- */
const state = {
  headers: null,
  serverData: null,
  backendOk: false,
  lcp: null,
  tbt: 0,
  inp: null,
  serverOffsetMs: null,
  latencySamples: [],
  cpuHistory: [],
  currentRun: null
};

const Engine = {
  results: new Map(),
  controllers: new Set(),
  running: false,
  cancelled: false,
  runId: null,
  runStartedAt: null,
  runDurationMs: null
};

const Cleanup = {
  intervals: [],
  observers: [],
  streams: [],
  addInterval(id) { Cleanup.intervals.push(id); return id; },
  addObserver(o) { Cleanup.observers.push(o); return o; },
  addStream(s) { Cleanup.streams.push(s); return s; },
  all() {
    Cleanup.intervals.forEach(clearInterval);
    Cleanup.observers.forEach(o => { try { o.disconnect(); } catch {} });
    Cleanup.streams.forEach(s => { try { s.getTracks().forEach(t => t.stop()); } catch {} });
    Cleanup.intervals = []; Cleanup.observers = []; Cleanup.streams = [];
  }
};
window.addEventListener("pagehide", () => { Cleanup.all(); stopCamera(); stopMic(); });

/* ---------------- tiny utils ---------------- */
function esc(t) { const d = document.createElement("div"); d.textContent = String(t ?? ""); return d.innerHTML; }
function fmtBytes(b) {
  const n = Number(b);
  if (!isFinite(n) || n == null) return NA;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + u[i];
}
function fmtMs(ms) { const n = Number(ms); return isFinite(n) ? Math.round(n) + " ms" : NA; }
function fmtSec(s) {
  const n = Number(s);
  if (!isFinite(n)) return NA;
  const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}
function toast(msg, kind = "") {
  try {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    $("#toastWrap").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, 3600);
  } catch {}
}

function unsupportedErr(msg) { const e = new Error(msg || "NOT SUPPORTED"); e.unsupported = true; return e; }

/* ---------------- API client (contract aware) ---------------- */
async function api(path, { timeout = 6000, signal } = {}) {
  const ctrl = new AbortController();
  Engine.controllers.add(ctrl);
  const relay = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException("TIMEOUT", "TimeoutError")), timeout);
  try {
    let resp;
    try { resp = await fetch(path, { signal: ctrl.signal, cache: "no-store" }); }
    catch (e) {
      if (e?.name === "TimeoutError") { const te = new Error("TIMEOUT"); te.code = "TIMEOUT"; throw te; }
      const ne = new Error("Network unreachable"); ne.code = "NETWORK"; throw ne;
    }
    let j;
    try { j = await resp.json(); }
    catch { const e = new Error("Invalid JSON response (HTTP " + resp.status + ")"); e.code = "BAD_JSON"; throw e; }
    if (j && j.success === false) {
      const e = new Error(j.error?.message || "Request failed");
      e.code = j.error?.code || "API_ERROR";
      throw e;
    }
    return j?.data !== undefined ? j.data : j;
  } finally {
    clearTimeout(timer);
    Engine.controllers.delete(ctrl);
    if (signal) signal.removeEventListener("abort", relay);
  }
}

/* ================================================================
   DIAGNOSTIC ENGINE CORE
   ================================================================ */
function makeResult(id, name, category, weight) {
  return { id, name, category, status: "idle", duration: 0, value: null, unit: null, details: null, error: null, weight: weight || 5 };
}

/**
 * Runs a single test with timeout + abort isolation.
 * fn(signal) may be sync or async. Throw unsupportedErr() for unsupported.
 * Never throws — always resolves to a result object.
 */
async function runTest(id, name, category, fn, { timeout = 8000, weight = 5 } = {}) {
  const res = makeResult(id, name, category, weight);
  const ctrl = new AbortController();
  Engine.controllers.add(ctrl);
  const t0 = performance.now();
  let timer = null;
  try {
    const work = Promise.resolve().then(() => fn(ctrl.signal));
    const guard = new Promise((_, rej) => {
      timer = setTimeout(() => {
        try { ctrl.abort(); } catch {}
        const e = new Error("TIMEOUT"); e.code = "TIMEOUT"; rej(e);
      }, timeout);
    });
    const val = await Promise.race([work, guard]);
    if (val && typeof val === "object" && ["passed", "warning", "failed", "unsupported"].includes(val.__status)) {
      res.status = val.__status;
      res.details = val.details ?? null;
      res.error = val.error ?? null;
    } else {
      res.status = "passed";
      res.value = val;
    }
  } catch (e) {
    if (e?.code === "TIMEOUT") { res.status = "failed"; res.error = "TIMEOUT"; }
    else if (e?.name === "AbortError") { res.status = Engine.cancelled ? "cancelled" : "failed"; res.error = Engine.cancelled ? "CANCELLED" : "ABORTED"; }
    else if (e?.unsupported) { res.status = "unsupported"; res.error = e.message; }
    else { res.status = "failed"; res.error = e?.message || String(e); }
  } finally {
    clearTimeout(timer);
    Engine.controllers.delete(ctrl);
    res.duration = Math.round(performance.now() - t0);
  }
  Engine.results.set(id, res);
  return res;
}

/* ---------------- module registry ---------------- */
const MODULES = {
  client:      { title: "Client Detection",        timeout: 5000 },
  server:      { title: "Server Diagnostics",      timeout: 6000 },
  network:     { title: "Network Diagnostics",     timeout: 12000 },
  http:        { title: "HTTP Diagnostics",        timeout: 10000 },
  tls:         { title: "TLS / SSL Check",         timeout: 5000 },
  dns:         { title: "DNS Diagnostics",         timeout: 12000 },
  browser:     { title: "Browser Capability Test", timeout: 15000 },
  storage:     { title: "Storage Diagnostics",     timeout: 10000 },
  performance: { title: "Performance Diagnostics", timeout: 6000 },
  database:    { title: "Database Diagnostics",    timeout: 6000 },
  jsengine:    { title: "JavaScript Engine",       timeout: 8000 },
  edge:        { title: "Edge / CDN Detection",    timeout: 10000 },
  webserver:   { title: "Web Server Detection",    timeout: 10000 },
  clock:       { title: "Server Clock Sync",       timeout: 6000 }
};

const FULL_ORDER   = ["client", "server", "network", "http", "tls", "dns", "browser", "storage", "performance", "database"];
const QUICK_ORDER  = ["client", "network", "http", "performance"];
const SERVER_ONLY  = new Set(["server", "network", "http", "tls", "dns", "edge", "webserver", "clock", "database"]);

function summarizeStatus(results) {
  const order = { failed: 4, warning: 3, passed: 2, unsupported: 1 };
  let worst = "passed", anyUnsupportedOnly = true, n = 0;
  for (const r of results) {
    if (["cancelled", "idle"].includes(r.status)) continue;
    n++;
    if (order[r.status] > order[worst]) worst = r.status;
    if (r.status !== "unsupported") anyUnsupportedOnly = false;
  }
  if (n === 0) return "idle";
  return anyUnsupportedOnly ? "unsupported" : worst;
}
function moduleResults(cat) { return [...Engine.results.values()].filter(r => r.category === cat); }

function setStateBadge(key, status) {
  const el = $("#state-" + key);
  if (!el) return;
  el.dataset.state = status;
  el.textContent = status.toUpperCase();
}

function showSkeleton(sel) { const b = $(sel); if (b) b.innerHTML = '<div class="skeleton"></div>'; }

function renderRowsInto(sel, rows) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML = rows.map(([k, v]) => {
    const isSt = v && typeof v === "object" && v.__rowStatus;
    const cls = isSt ? ({ passed: "st-green", warning: "st-yellow", failed: "st-red", unsupported: "st-gray" }[v.st] || "st-gray") : "";
    const dotCol = { passed: "dot-green", warning: "dot-yellow", failed: "dot-red", unsupported: "dot-gray", idle: "dot-gray" }[isSt ? v.st : ""] || "dot-gray";
    const val = isSt
      ? `<span class="status-dot ${dotCol}"></span> <span class="status ${cls}">${esc(v.text)}</span>`
      : esc(v);
    return `<div class="row"><span class="k">${esc(k)}</span><span class="v ${v === NA ? "na" : ""}">${val}</span></div>`;
  }).join("");
}
const RS = (text, st) => ({ __rowStatus: true, text, st });

function renderErrorInto(sel, title, msg, retryAttr) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML =
    `<div class="err-box" role="alert">` +
    `<div class="err-title">⚠ ${esc(title)}</div>` +
    `<div class="err-msg">${esc(msg)}</div>` +
    `<button class="btn btn-small btn-outline" data-module-run="${esc(retryAttr || "")}">RETRY</button>` +
    `</div>`;
}

/* ================================================================
   CHART UTILITIES — never blank: loading / empty / error states
   ================================================================ */
const chartData = new Map();

function chartOverlay(box, kind, title, sub) {
  if (!box) return;
  let ov = box.querySelector(".chart-overlay");
  if (kind === "ok") { if (ov) ov.remove(); return; }
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "chart-overlay";
    ov.innerHTML = "<div></div><span></span>";
    box.appendChild(ov);
  }
  ov.className = "chart-overlay " + (kind === "empty" ? "chart-empty" : kind === "error" ? "chart-error" : "chart-loading");
  ov.children[0].textContent = title;
  ov.children[1].textContent = sub || "";
  ov.classList.remove("hidden");
}

function validNumbers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(Number).filter(n => Number.isFinite(n));
}
function validBars(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(it => it && typeof it.label === "string" && Number.isFinite(Number(it.value)));
}

function setupCanvas(canvas) {
  const box = canvas.parentElement;
  const rect = box.getBoundingClientRect();
  const w = Math.max(60, Math.floor(rect.width));
  const h = Math.max(60, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawLineChart(canvasId, rawValues, { maxOverride } = {}) {
  const canvas = document.getElementById(canvasId);
  const box = canvas?.parentElement;
  if (!canvas || !box) return;
  const values = validNumbers(rawValues);
  chartData.set(canvasId, { type: "line", values });
  if (!values.length) { chartOverlay(box, "empty", "NO DATA AVAILABLE", "Run the test to collect metrics."); return; }
  chartOverlay(box, "ok");
  let env;
  try { env = setupCanvas(canvas); } catch { chartOverlay(box, "error", "RENDER ERROR", "Canvas unavailable."); return; }
  const { ctx, w, h } = env;
  const padL = 34, padR = 10, padT = 12, padB = 18;
  const iw = w - padL - padR, ih = h - padT - padB;
  const max = maxOverride || Math.max(100, ...values);

  ctx.clearRect(0, 0, w, h);
  ctx.font = "9px " + getComputedStyle(document.body).fontFamily;
  ctx.strokeStyle = "#1c2230";
  ctx.fillStyle = "#5b6474";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(String(Math.round(max - (max * i) / 4)), 4, y + 3);
  }
  const px = i => values.length === 1 ? padL + iw / 2 : padL + (iw * i) / (values.length - 1);
  const py = v => padT + ih - (Math.min(v, max) / max) * ih;

  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => { i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)); });
  ctx.stroke();

  ctx.fillStyle = "#22d3ee";
  values.forEach((v, i) => { ctx.beginPath(); ctx.arc(px(i), py(v), 2.5, 0, Math.PI * 2); ctx.fill(); });

  const last = values[values.length - 1];
  ctx.fillStyle = "#dfe5ee";
  ctx.fillText("last: " + Math.round(last), w - padR - 52, padT + 8);
  ctx.fillStyle = "#5b6474";
  ctx.fillText("t-" + (values.length - 1), padL, h - 5);
  ctx.fillText("now", w - padR - 18, h - 5);
}

function drawBarChartH(canvasId, rawItems, unit = "ms") {
  const canvas = document.getElementById(canvasId);
  const box = canvas?.parentElement;
  if (!canvas || !box) return;
  const items = validBars(rawItems);
  chartData.set(canvasId, { type: "bar", items, unit });
  if (!items.length) { chartOverlay(box, "empty", "NO DATA AVAILABLE", "Metrics appear once measured."); return; }
  chartOverlay(box, "ok");
  let env;
  try { env = setupCanvas(canvas); } catch { chartOverlay(box, "error", "RENDER ERROR", "Canvas unavailable."); return; }
  const { ctx, w, h } = env;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...items.map(i => i.value), 1);
  const rowH = Math.min(30, (h - 16) / items.length);
  ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
  items.forEach((it, i) => {
    const y = 10 + i * ((h - 20) / items.length);
    const bw = Math.max(2, ((w - 190) * it.value) / max);
    ctx.fillStyle = "#1c2230";
    ctx.fillRect(90, y, w - 190, rowH * 0.55);
    ctx.fillStyle = "#22d3ee";
    ctx.fillRect(90, y, bw, rowH * 0.55);
    ctx.fillStyle = "#8b94a6";
    ctx.fillText(it.label.toUpperCase().slice(0, 14), 6, y + rowH * 0.42);
    ctx.fillStyle = "#dfe5ee";
    ctx.fillText(Math.round(it.value) + " " + unit, 96 + bw + 6 > w - 60 ? w - 62 : 96 + bw + 6, y + rowH * 0.42);
  });
}

const resizeObs = new ResizeObserver(entries => {
  for (const entry of entries) {
    const canvas = entry.target.querySelector("canvas");
    if (!canvas || !chartData.has(canvas.id)) continue;
    const d = chartData.get(canvas.id);
    if (d.type === "line" && d.values.length) drawLineChart(canvas.id, d.values);
    if (d.type === "bar" && d.items.length) drawBarChartH(canvas.id, d.items, d.unit);
  }
});
$$(".chart-box").forEach(b => { try { resizeObs.observe(b); } catch {} });
window.addEventListener("resize", () => {
  clearTimeout(window.__rszT);
  window.__rszT = setTimeout(() => {
    for (const [id, d] of chartData) {
      if (d.type === "line" && d.values.length) drawLineChart(id, d.values);
      if (d.type === "bar" && d.items.length) drawBarChartH(id, d.items, d.unit);
    }
  }, 150);
});

/* ================================================================
   MODULE: CLIENT DEVICE
   ================================================================ */
function detectBrowserInfo(ua) {
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
function detectOSName(ua) {
  const map = [
    [/Windows NT 10/, "Windows 10/11"], [/Windows NT 6\.3/, "Windows 8.1"], [/Windows NT 6\.1/, "Windows 7"],
    [/Android ([\d.]+)/], [/(?:iPhone|iPad|iPod).*OS ([\d_]+)/], [/Mac OS X ([\d_.]+)/],
    [/CrOS/, "ChromeOS"], [/Linux/, "Linux"]
  ];
  for (const [re, fixed] of map) {
    const m = ua.match(re);
    if (m) return fixed ? fixed.replace("_", " ") : m[0].split(" ").map(p => p.includes("/") ? p.split("/")[0] : p).join(" ");
  }
  return "Unknown";
}
function deviceType() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "Tablet";
  if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) return "Mobile";
  if (matchMedia("(pointer:coarse)").matches) return Math.min(screen.width, screen.height) >= 600 ? "Tablet" : "Mobile";
  return "Desktop";
}
function clientInfo() {
  const n = navigator;
  const br = detectBrowserInfo(n.userAgent);
  const conn = n.connection || n.mozConnection || n.webkitConnection;
  return {
    deviceType: deviceType(),
    os: detectOSName(n.userAgent),
    browser: br.name,
    version: br.version,
    engine: /Firefox/i.test(n.userAgent) ? "Gecko" : (/Safari/.test(n.userAgent) && !/Chrom|Edg|OPR/.test(n.userAgent) ? "WebKit" : /Chrom|Edg|OPR/.test(n.userAgent) ? "Blink" : "Unknown"),
    screen: screen.width + " × " + screen.height,
    pixelRatio: window.devicePixelRatio,
    colorDepth: screen.colorDepth + "-bit",
    touch: ("ontouchstart" in window || n.maxTouchPoints > 0) ? "Supported (" + (n.maxTouchPoints || "?") + ")" : "Not supported",
    cores: n.hardwareConcurrency != null ? n.hardwareConcurrency : null,
    memory: n.deviceMemory != null ? n.deviceMemory + " GB" : null,
    language: n.language || NA,
    platform: (n.userAgentData && n.userAgentData.platform) || n.platform || NA,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || NA,
    darkMode: matchMedia("(prefers-color-scheme: dark)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    ua: n.userAgent,
    connType: conn?.type || null,
    effType: conn?.effectiveType || null
  };
}

async function runClientTests() {
  const info = await runTest("client-gather", "Client environment detection", "client", () => clientInfo(), { timeout: 4000, weight: 6 });
  const c = info.status === "passed" ? info.value : clientInfo();
  renderRowsInto("#body-client", [
    ["Device Type", c.deviceType],
    ["Operating System", c.os],
    ["Browser", c.browser],
    ["Browser Version", c.version],
    ["Engine", c.engine],
    ["Platform", c.platform],
    ["Screen", c.screen],
    ["Pixel Ratio", String(c.pixelRatio)],
    ["Color Depth", c.colorDepth],
    ["Touch", c.touch],
    ["CPU Cores", c.cores != null ? c.cores + " logical" : NA],
    ["Device Memory", c.memory || NA],
    ["Language", c.language],
    ["Timezone", c.timezone],
    ["Online", RS(state.isOnline ? "ONLINE" : "OFFLINE", state.isOnline ? "passed" : "failed")],
    ["Color Scheme", c.darkMode ? "Dark preferred" : "Light preferred"],
    ["Reduced Motion", c.reducedMotion ? "Enabled" : "No preference"],
    ["User Agent", c.ua]
  ]);
  updateViewportPanel();
  return info;
}

/* ---- live viewport ---- */
let vpTimer = null;
function updateViewportPanel() {
  const orient = innerWidth >= innerHeight ? "Landscape" : "Portrait";
  renderRowsInto("#viewportData", [
    ["Viewport", innerWidth + " × " + innerHeight],
    ["Screen", screen.width + " × " + screen.height],
    ["DPR", String(window.devicePixelRatio)],
    ["Orientation", orient],
    ["Available Screen", (screen.availWidth || NA) + " × " + (screen.availHeight || NA)],
    ["Visual Viewport", window.visualViewport ? Math.round(visualViewport.width) + " × " + Math.round(visualViewport.height) : NA]
  ]);
}
window.addEventListener("resize", () => { clearTimeout(vpTimer); vpTimer = setTimeout(updateViewportPanel, 150); });
window.addEventListener("orientationchange", () => setTimeout(updateViewportPanel, 300));

/* ================================================================
   MODULE: SERVER
   ================================================================ */
async function runServerTests() {
  const res = await runTest("server-probe", "Backend server information", "server", async () => {
    if (!navigator.onLine) { const e = new Error("NETWORK OFFLINE"); e.code = "OFFLINE"; throw e; }
    return api("/api/diagnostics/server", { timeout: 6000 });
  }, { timeout: 7000, weight: 12 });

  if (res.status !== "passed") {
    state.serverData = null;
    const reason = res.error === "TIMEOUT" ? "Request timed out." :
      res.error === "NETWORK" || res.error === "NETWORK OFFLINE" ? "The diagnostics backend cannot be reached." : res.error;
    renderRowsInto("#body-server", [["Server API", RS("UNAVAILABLE", "failed")], ["Hostname", NA], ["OS", NA], ["Kernel", NA], ["CPU", NA], ["RAM", NA]]);
    renderRowsInto("#osData", [["Distribution", NA], ["Version", NA], ["Kernel", NA], ["Architecture", NA], ["Boot Time", NA], ["Virtualization", NA]]);
    $("#body-server").insertAdjacentHTML("beforeend",
      `<div class="warn-box">FRONTEND ONLINE — SERVER DIAGNOSTICS UNAVAILABLE.<br>${esc(reason)}<br>Deploy <b>node server.js</b> on your VPS to enable this panel.</div>`);
    $("#liveIndicator").textContent = "● OFFLINE";
    $("#liveIndicator").className = "live-indicator";
    return res;
  }

  const d = res.value;
  state.serverData = d;
  renderRowsInto("#body-server", [
    ["Server IP", d.serverIp || NA],
    ["Hostname", d.hostname || NA],
    ["Operating System", d.os || NA],
    ["Kernel", d.kernel || NA],
    ["Architecture", d.architecture || NA],
    ["CPU Model", d.cpuModel || NA],
    ["CPU Cores", d.cpuCores != null ? String(d.cpuCores) : NA],
    ["Memory Total", d.memoryTotal != null ? fmtBytes(d.memoryTotal) : NA],
    ["Memory Used", d.memoryUsed != null ? fmtBytes(d.memoryUsed) + (d.memoryPct != null ? " (" + d.memoryPct + "%)" : "") : NA],
    ["Disk Total", d.diskTotal != null ? fmtBytes(d.diskTotal) : NA],
    ["Disk Used", d.diskUsed != null ? fmtBytes(d.diskUsed) + (d.diskPct != null ? " (" + d.diskPct + "%)" : "") : NA],
    ["Load Average", Array.isArray(d.loadAverage) ? d.loadAverage.join(" / ") : NA],
    ["Uptime", d.uptime != null ? fmtSec(d.uptime) : NA],
    ["Timezone", d.timezone || NA],
    ["Server Time", d.serverTime || NA],
    ["Virtualization", d.virtualization || NA],
    ["Container", d.container || NA],
    ["Server Status", RS("ONLINE", "passed")]
  ]);
  renderRowsInto("#osData", [
    ["Distribution", d.os || NA],
    ["Version", d.osVersion || NA],
    ["Kernel", d.kernel || NA],
    ["Architecture", d.architecture || NA],
    ["Hostname", d.hostname || NA],
    ["Boot Time", d.bootTime || NA],
    ["Uptime", d.uptime != null ? fmtSec(d.uptime) : NA],
    ["Virtualization", d.virtualization || NA]
  ]);
  startLiveMonitor();
  return res;
}

/* ---------------- live metrics polling ---------------- */
let liveFails = 0;
async function pollMetrics() {
  const box = $("#liveData");
  try {
    const d = await api("/api/diagnostics/metrics", { timeout: 4000 });
    liveFails = 0;
    $("#liveIndicator").textContent = "● LIVE";
    $("#liveIndicator").className = "live-indicator on";
    const bar = (label, pct) => {
      const p = Number(pct);
      const f = isFinite(p) ? Math.max(0, Math.min(10, Math.round(p / 10))) : 0;
      return `${label.padEnd(5)}<span class="live-bar-fill">${"█".repeat(f)}</span><span class="live-bar-rest">${"░".repeat(10 - f)}</span> ${isFinite(p) ? p : "?"}%`;
    };
    box.innerHTML = `<div class="live-bars">${bar("CPU", d.cpuPct)}\n${bar("RAM", d.memPct)}\n${bar("DISK", d.diskPct)}\nLOAD    ${d.load1 ?? NA}    UPTIME ${fmtSec(d.uptime)}</div>`;
    if (Number.isFinite(Number(d.cpuPct))) {
      state.cpuHistory.push(Number(d.cpuPct));
      if (state.cpuHistory.length > 60) state.cpuHistory.shift();
      drawLineChart("cpuChart", state.cpuHistory, { maxOverride: 100 });
    }
  } catch (e) {
    liveFails++;
    if (liveFails >= 2) {
      stopLiveMonitor();
      $("#liveIndicator").textContent = "● OFFLINE";
      $("#liveIndicator").className = "live-indicator";
      box.innerHTML = `<div class="chart-state chart-error">SERVER METRICS UNAVAILABLE<br><span>Lost connection to the diagnostics backend. Press RUN on the Server panel to reconnect.</span></div>`;
      chartOverlay($("#cpuChartBox"), "empty", "NO DATA AVAILABLE", "Backend metrics stream stopped.");
    }
  }
}
let liveTimer = null;
function startLiveMonitor() {
  if (liveTimer) return;
  $("#liveIndicator").textContent = "● LIVE";
  $("#liveIndicator").className = "live-indicator on";
  pollMetrics();
  liveTimer = Cleanup.addInterval(setInterval(pollMetrics, 3000));
}
function stopLiveMonitor() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

/* ================================================================
   MODULE: NETWORK + LATENCY
   ================================================================ */
async function runNetworkTests() {
  const online = navigator.onLine;
  state.isOnline = online;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  const connRes = await runTest("net-conn", "Connection information", "network", () => {
    if (!conn) throw unsupportedErr("Network Information API not exposed by this browser");
    return { type: conn.type || null, eff: conn.effectiveType || null, downlink: conn.downlink ?? null, rtt: conn.rtt ?? null, saveData: !!conn.saveData };
  }, { timeout: 2000, weight: 4 });

  const cv = connRes.status === "passed" ? connRes.value : {};
  const ipRes = await runTest("net-ip", "Client IP lookup", "network", async () => {
    if (!online) { const e = new Error("NETWORK OFFLINE"); e.code = "OFFLINE"; throw e; }
    return api("/api/diagnostics/network", { timeout: 6000 });
  }, { timeout: 7000, weight: 6 });

  const latRes = await runLatencyTest();

  renderRowsInto("#body-network", [
    ["Online Status", RS(online ? "ONLINE" : "OFFLINE", online ? "passed" : "failed")],
    ["Client IP", ipRes.status === "passed" ? ipRes.value.ip || NA : RS(ipRes.error === "NETWORK OFFLINE" ? "UNAVAILABLE (OFFLINE)" : ipRes.status === "unsupported" ? "REQUIRES SERVER ENDPOINT" : ipRes.error || "FAILED", ipRes.status === "passed" ? "passed" : "warning")],
    ["IPv4", ipRes.status === "passed" && /^\d+\.\d+\.\d+\.\d+$/.test(ipRes.value.ip || "") ? ipRes.value.ip : NA],
    ["IPv6", ipRes.status === "passed" && (ipRes.value.ip || "").includes(":") ? ipRes.value.ip : NA],
    ["Connection Type", cv.type || NA],
    ["Effective Type", cv.eff ? cv.eff.toUpperCase() : NA],
    ["Downlink", cv.downlink != null ? cv.downlink + " Mbps" : NA],
    ["RTT (est.)", cv.rtt != null ? cv.rtt + " ms" : NA],
    ["Save Data", conn ? (cv.saveData ? "ON" : "OFF") : NA],
    ["Median Latency", state.latencySamples.length ? fmtMs(median(state.latencySamples)) : NA]
  ]);
  updateHealth("NETWORK", latRes.status === "passed" ? (median(state.latencySamples) < 500 ? "GOOD" : "FAIR") : "POOR", median(state.latencySamples) < 700 ? "passed" : "warning");
  return connRes;
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function pingOnce() {
  const t0 = performance.now();
  try {
    await fetch("/api/ping?t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(2800) });
    return performance.now() - t0;
  } catch {
    const t1 = performance.now();
    await fetch(location.pathname + "?_ping=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(2800) });
    return performance.now() - t1;
  }
}

async function runLatencyTest() {
  const rows = $("#latencyData");
  $("#latencyVerdict").innerHTML = "";
  if (rows) rows.innerHTML = '<div class="muted">Measuring… sending 8 sequential requests.</div>';
  chartOverlay($("#latencyChartBox"), "loading", "MEASURING…", "Collecting real response times.");

  state.latencySamples = [];
  let failures = 0;
  const res = await runTest("net-latency", "Latency measurement (8 requests)", "network", async (signal) => {
    for (let i = 0; i < 8; i++) {
      if (signal.aborted || Engine.cancelled) break;
      try {
        const ms = await pingOnce();
        state.latencySamples.push(ms);
      } catch { failures++; }
      renderRowsInto("#latencyData", [
        ["Requests Done", (i + 1) + " / 8"],
        ["Successful", String(state.latencySamples.length)],
        ["Failed", String(failures)],
        ["Last Response", state.latencySamples.length ? fmtMs(state.latencySamples[state.latencySamples.length - 1]) : NA],
        ["Best So Far", state.latencySamples.length ? fmtMs(Math.min(...state.latencySamples)) : NA],
        ["Median So Far", state.latencySamples.length ? fmtMs(median(state.latencySamples)) : NA]
      ]);
      drawLineChart("latencyChart", state.latencySamples);
    }
    if (!state.latencySamples.length) { const e = new Error("NETWORK TEST FAILED — no successful responses"); e.code = "NO_RESPONSE"; throw e; }
    return true;
  }, { timeout: 25000, weight: 8 });

  if (res.status === "passed" || state.latencySamples.length) {
    const med = median(state.latencySamples);
    const best = Math.min(...state.latencySamples);
    const q = med < 100 ? ["EXCELLENT", "passed"] : med < 300 ? ["GOOD", "passed"] : med < 700 ? ["FAIR", "warning"] : ["POOR", "failed"];
    renderRowsInto("#latencyData", [
      ["Requests Successful", state.latencySamples.length + " / 8"],
      ["Failed Requests", String(failures)],
      ["Median Response", fmtMs(med)],
      ["Best Response", fmtMs(best)],
      ["Worst Response", fmtMs(Math.max(...state.latencySamples))],
      ["All Samples", state.latencySamples.map(v => Math.round(v)).join(" · ") + " ms"]
    ]);
    $("#latencyVerdict").innerHTML = `QUALITY&nbsp;&nbsp;<span class="status ${q[2]}">● ${q[0]}</span>`;
    chartOverlay($("#latencyChartBox"), "ok");
    drawLineChart("latencyChart", state.latencySamples);
    res.status = q[1] === "warning" ? "warning" : res.status;
  } else if (rows) {
    renderRowsInto("#latencyData", [["Latency Test", RS("NETWORK TEST FAILED", "failed")], ["Detail", res.error || NA]]);
    chartOverlay($("#latencyChartBox"), "error", "NETWORK TEST FAILED", res.error || "No successful responses.");
  }
  return res;
}

/* ================================================================
   MODULE: HTTP (+ webserver + edge derivation)
   ================================================================ */
function cdnFromHeaders(h) {
  if (h["cf-ray"] || h["cf-cache-status"]) return "Cloudflare";
  if (h["x-amz-cf-id"]) return "CloudFront";
  if (h["x-served-by"]?.includes("cache") || h["x-fastly-request-id"]) return "Fastly";
  if (h["x-vercel-id"] || h["x-vercel-cache"]) return "Vercel";
  if (h["x-nf-request-id"]) return "Netlify";
  if (h["via"]) return "Proxy: " + h["via"];
  return null;
}

async function runHttpTests() {
  $("#httpTerminal").textContent = `$ GET ${location.pathname}\nHost: ${location.host}\n→ sending…`;

  const res = await runTest("http-request", "HTTP request analysis", "http", async () => {
    const t0 = performance.now();
    const resp = await fetch(location.href, { method: "GET", cache: "no-store" });
    await resp.arrayBuffer();
    const elapsed = performance.now() - t0;
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
    return { status: resp.status, ok: resp.ok, statusText: resp.statusText, elapsed, headers, protocol: nav?.nextHopProtocol || "unknown" };
  }, { timeout: 10000, weight: 10 });

  if (res.status !== "passed") {
    $("#httpTerminal").textContent = "$ GET /\n→ REQUEST FAILED: " + (res.error || "unknown error");
    renderRowsInto("#body-http", [["HTTP Request", RS("FAILED", "failed")], ["Error", res.error || NA]]);
    return res;
  }

  const { status, ok: isOk, statusText, elapsed, headers, protocol } = res.value;
  state.headers = headers;

  $("#httpTerminal").textContent =
    `$ GET ${location.pathname} HTTP\n` +
    `Host: ${location.host}\n` +
    `User-Agent: JUAN-WEB-LAB/2.0\n\n` +
    `← HTTP ${status} ${statusText || ""}\n` +
    `protocol: ${protocol.toUpperCase()}\n` +
    `total time: ${Math.round(elapsed)} ms`;

  renderRowsInto("#body-http", [
    ["Status Code", RS(`${status} ${(statusText || "").trim()}`, isOk ? "passed" : status < 500 ? "warning" : "failed")],
    ["HTTP Protocol", protocol !== "unknown" ? protocol.toUpperCase() : "LIMITED BY BROWSER"],
    ["Content-Type", headers["content-type"] || NA],
    ["Content-Encoding", headers["content-encoding"] || "none (identity)"],
    ["Cache-Control", headers["cache-control"] || NA],
    ["ETag", headers["etag"] || NA],
    ["Server Header", headers["server"] || NA],
    ["Date Header", headers["date"] || NA],
    ["Content-Length", headers["content-length"] || "(chunked / unknown)"],
    ["Response Time", fmtMs(elapsed)]
  ]);
  const hdrEl = $("#httpHeaders");
  if (hdrEl) hdrEl.textContent = Object.entries(headers).map(([k, v]) => k + ": " + v).join("\n") || "(headers not exposed by server)";

  /* derived: web server panel */
  const enc = headers["content-encoding"] || "";
  renderRowsInto("#body-webserver", [
    ["Web Server", headers["server"] || (state.serverData ? "Node.js (backend direct)" : NA)],
    ["Version", headers["server"]?.match(/[\d.]+/)?.[0] || "DETECTED · VERSION UNKNOWN"],
    ["PHP Version", NA],
    ["Node.js Version", state.serverData ? "backend runtime" : NA],
    ["HTTP Protocol", protocol !== "unknown" ? protocol.toUpperCase() : NA],
    ["TLS Version", headers["strict-transport-security"] ? "secure (HSTS active)" : NA],
    ["Compression", enc ? enc.toUpperCase() : "NOT DETECTED"],
    ["Gzip", /gzip/i.test(enc) ? RS("ENABLED", "passed") : RS("NOT DETECTED", "unsupported")],
    ["Brotli", /br\b/i.test(enc) ? RS("ENABLED", "passed") : RS("NOT DETECTED", "unsupported")]
  ]);

  /* derived: edge panel */
  const cdn = cdnFromHeaders(headers);
  renderRowsInto("#body-edge", [
    ["CDN / Edge", cdn || "Unknown (direct origin likely)"],
    ["Reverse Proxy", headers["via"] || headers["x-proxy"] ? RS("DETECTED", "passed") : RS("UNKNOWN", "unsupported")],
    ["Cache Status", headers["cf-cache-status"] || headers["x-vercel-cache"] || headers["x-cache"] || NA],
    ["Region / POP", headers["cf-ray"] ? (headers["cf-ray"].split("-")[1] || NA) : headers["x-vercel-ip-city"] || NA],
    ["Ray / Trace ID", headers["cf-ray"] || headers["x-amz-cf-id"] || NA],
    ["Age", headers["age"] ? headers["age"] + "s" : NA]
  ]);

  applyClockOffset(headers.date);
  return res;
}

/* ================================================================
   MODULE: TLS
   ================================================================ */
function hasMixedContent() {
  if (location.protocol !== "https:") return false;
  return $$("img[src], script[src], iframe[src]").some(el => (el.getAttribute("src") || "").startsWith("http://"));
}

async function runTlsTests() {
  const res = await runTest("tls-check", "TLS / HTTPS analysis", "tls", () => {
    const https = location.protocol === "https:";
    return { https, hsts: state.headers?.["strict-transport-security"] || null, mixed: hasMixedContent(), protocol: (performance.getEntriesByType("navigation")[0]?.nextHopProtocol || "unknown") };
  }, { timeout: 3000, weight: 10 });

  const v = res.status === "passed" ? res.value : { https: location.protocol === "https:", hsts: null, mixed: false, protocol: "unknown" };
  let verdict, vst;
  if (v.https && !v.mixed) { verdict = "SECURE"; vst = "passed"; }
  else if (v.https) { verdict = "⚠ WARNING — MIXED CONTENT"; vst = "warning"; }
  else if (location.protocol === "file:") { verdict = "N/A (FILE PROTOCOL)"; vst = "unsupported"; }
  else { verdict = "✕ INSECURE (PLAIN HTTP)"; vst = "failed"; }

  renderRowsInto("#body-tls", [
    ["HTTPS Enabled", RS(v.https ? "YES" : "NO", v.https ? "passed" : "failed")],
    ["Overall Verdict", RS(verdict, vst)],
    ["Negotiated Protocol", v.protocol !== "unknown" ? v.protocol.toUpperCase() : "LIMITED BY BROWSER"],
    ["TLS Version", "LIMITED BY BROWSER"],
    ["Certificate Issuer", "LIMITED BY BROWSER"],
    ["Certificate Expiry", "LIMITED BY BROWSER"],
    ["Mixed Content", v.https ? (v.mixed ? RS("DETECTED", "failed") : RS("NONE FOUND", "passed")) : RS("N/A", "unsupported")],
    ["HSTS Header", v.hsts ? RS("ENABLED", "passed") : RS("NOT SET", "warning")],
    ["HSTS Value", v.hsts || NA]
  ]);
  updateHealth("HTTPS", v.https ? "SECURE" : "INSECURE", vst);
  return res;
}

/* ================================================================
   MODULE: DNS
   ================================================================ */
async function runDnsTests() {
  const res = await runTest("dns-resolve", "DNS record resolution", "dns", async () => {
    if (!navigator.onLine) { const e = new Error("NETWORK OFFLINE"); e.code = "OFFLINE"; throw e; }
    return api("/api/diagnostics/dns", { timeout: 11000 });
  }, { timeout: 12000, weight: 8 });

  if (res.status !== "passed") {
    const msg = res.error === "TIMEOUT" ? "DNS LOOKUP FAILED — timed out"
      : res.error === "NETWORK" ? "REQUIRES SERVER ENDPOINT — backend unreachable"
      : res.error || "DNS LOOKUP FAILED";
    renderRowsInto("#body-dns", [
      ["Domain", location.hostname],
      ["Result", RS(res.error === "NO_PUBLIC_DOMAIN" ? "NO PUBLIC DOMAIN TO RESOLVE" : msg, "warning")],
      ["Note", res.error === "NETWORK" ? "The bundled backend performs real DNS lookups; deploy node server.js to enable." : NA]
    ]);
    return res;
  }
  const d = res.value;
  renderRowsInto("#body-dns", [
    ["Domain", d.domain],
    ["A Records", d.a?.length ? d.a.join(", ") : NA],
    ["AAAA Records", d.aaaa?.length ? d.aaaa.join(", ") : NA],
    ["CNAME", d.cname || NA],
    ["Nameservers", d.ns?.length ? d.ns.join(", ") : NA],
    ["DNS Provider", d.provider || "Unknown"],
    ["Resolution Time", d.resolveMs != null ? fmtMs(d.resolveMs) : NA],
    ["Lookup Status", RS("SUCCESS", "passed")]
  ]);
  return res;
}

/* ================================================================
   MODULE: BROWSER CAPABILITIES (real feature detection)
   ================================================================ */
function capResult(status, detail) { return { __cap: true, status, detail: detail || "" }; }

async function runBrowserTests() {
  const defs = [
    ["JavaScript", () => capResult("SUPPORTED", "executing"), 3],
    ["WebGL", async () => {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return capResult("NOT SUPPORTED");
      let renderer = "context created";
      try {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
      } catch {}
      return capResult("SUPPORTED", String(renderer).slice(0, 80));
    }, 5],
    ["WebGL2", () => {
      const gl = document.createElement("canvas").getContext("webgl2");
      return gl ? capResult("SUPPORTED", gl.getParameter(gl.VERSION) || "") : capResult("NOT SUPPORTED");
    }, 4],
    ["WebGPU", async () => {
      if (!navigator.gpu) return capResult("NOT SUPPORTED");
      const ad = await navigator.gpu.requestAdapter();
      return ad ? capResult("SUPPORTED", "adapter acquired") : capResult("BLOCKED", "adapter unavailable");
    }, 4],
    ["WebAssembly", () => typeof WebAssembly === "object" && WebAssembly.validate ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 4],
    ["WebSocket", () => {
      if (typeof WebSocket === "undefined") return capResult("NOT SUPPORTED");
      try { const ws = new WebSocket("wss://localhost:1"); setTimeout(() => { try { ws.close(); } catch {} }, 0); return capResult("SUPPORTED"); }
      catch { return capResult("BLOCKED"); }
    }, 3],
    ["Web Workers", () => typeof Worker === "undefined" ? capResult("NOT SUPPORTED") : (() => {
      try { const w = new Worker(URL.createObjectURL(new Blob(["self.onmessage=()=>{}"]))); w.terminate(); return capResult("SUPPORTED"); }
      catch { return capResult("BLOCKED"); }
    })(), 3],
    ["Service Worker", async () => {
      if (!("serviceWorker" in navigator)) return capResult("NOT SUPPORTED");
      try { await navigator.serviceWorker.getRegistrations(); return capResult("SUPPORTED"); }
      catch { return capResult("BLOCKED", "insecure context likely"); }
    }, 3],
    ["IndexedDB", () => new Promise(resolve => {
      if (!window.indexedDB) return resolve(capResult("NOT SUPPORTED"));
      const rq = indexedDB.open("__jwl_cap", 1);
      rq.onerror = () => resolve(capResult("BLOCKED"));
      rq.onsuccess = () => { try { rq.result.close(); indexedDB.deleteDatabase("__jwl_cap"); } catch {} resolve(capResult("SUPPORTED")); };
      setTimeout(() => resolve(capResult("ERROR", "open timeout")), 3000);
    }), 3],
    ["Fetch", () => typeof fetch === "function" ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 3],
    ["Streams", () => typeof ReadableStream !== "undefined" ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 2],
    ["Web Crypto", async () => {
      if (!crypto?.subtle) return capResult("NOT SUPPORTED");
      try { await crypto.subtle.digest("SHA-256", new TextEncoder().encode("test")); return capResult("SUPPORTED", "SHA-256 digest ok"); }
      catch { return capResult("ERROR"); }
    }, 3],
    ["Notifications", () => "Notification" in window ? capResult("PERMISSION REQUIRED", Notification.permission) : capResult("NOT SUPPORTED"), 2],
    ["Clipboard", () => navigator.clipboard ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 2],
    ["Geolocation", () => navigator.geolocation ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 2],
    ["Camera / Mic", () => navigator.mediaDevices?.getUserMedia ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 2],
    ["Bluetooth", () => navigator.bluetooth ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 1],
    ["USB", () => navigator.usb ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 1],
    ["Gamepad", () => navigator.getGamepads ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 1],
    ["Web Audio", () => (window.AudioContext || window.webkitAudioContext) ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 3],
    ["Screen Capture", () => navigator.mediaDevices?.getDisplayMedia ? capResult("PERMISSION REQUIRED") : capResult("NOT SUPPORTED"), 2],
    ["Cache Storage", () => window.caches ? capResult("SUPPORTED") : capResult("NOT SUPPORTED"), 2],
    ["LocalStorage", () => { localStorage.setItem("__jwl_cap", "1"); const okv = localStorage.getItem("__jwl_cap") === "1"; localStorage.removeItem("__jwl_cap"); return okv ? capResult("SUPPORTED") : capResult("BLOCKED"); }, 3],
    ["SessionStorage", () => { sessionStorage.setItem("__jwl_cap", "1"); const okv = sessionStorage.getItem("__jwl_cap") === "1"; sessionStorage.removeItem("__jwl_cap"); return okv ? capResult("SUPPORTED") : capResult("BLOCKED"); }, 3],
    ["Cookies", () => {
      if (!navigator.cookieEnabled) return capResult("BLOCKED");
      document.cookie = "__jwl_cap=1; SameSite=Lax; path=/";
      const okv = document.cookie.includes("__jwl_cap");
      document.cookie = "__jwl_cap=; Max-Age=0; path=/";
      return okv ? capResult("SUPPORTED") : capResult("BLOCKED");
    }, 3]
  ];

  const results = [];
  for (const [name, fn, weight] of defs) {
    if (Engine.cancelled) break;
    const r = await runTest("cap-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, "browser", fn, { timeout: 4000, weight });
    const cap = r.value && r.value.__cap ? r.value : (r.status === "unsupported" ? capResult("NOT SUPPORTED", r.error) : capResult("ERROR", r.error || ""));
    results.push({ name, status: cap.status, detail: cap.detail, duration: r.duration });
    Engine.results.get(r.id).details = cap.status;
  }

  const clsMap = { "SUPPORTED": "st-green", "NOT SUPPORTED": "st-gray", "PERMISSION REQUIRED": "st-yellow", "BLOCKED": "st-yellow", "ERROR": "st-red" };
  $("#capsSummary").textContent = results.filter(r => r.status === "SUPPORTED").length + " supported · " +
    results.filter(r => r.status === "PERMISSION REQUIRED").length + " need permission · " +
    results.filter(r => r.status === "NOT SUPPORTED").length + " unsupported · " +
    results.filter(r => r.status === "ERROR" || r.status === "BLOCKED").length + " blocked/error";
  $("#body-browser").innerHTML = `<div class="cap-grid">` + results.map(r =>
    `<div class="cap-item" title="${esc(r.detail)}"><span>${esc(r.name)}</span><span class="cap-status ${clsMap[r.status] || "st-gray"}">${esc(r.status)}${r.duration ? " · " + r.duration + "ms" : ""}</span></div>`
  ).join("") + `</div>
  <p class="panel-desc" style="margin-top:10px">Hover a tile for detail. Camera, microphone and location have dedicated interactive tests below.</p>`;

  updateHealth("BROWSER", "READY", "passed");
  return results;
}

/* ================================================================
   PERMISSION TESTS (camera / mic / geo) — user-initiated only
   ================================================================ */
let cameraStream = null, micStream = null, micAudioCtx = null, micRaf = 0;

async function startCamera() {
  const st = $("#cameraStatus");
  try {
    if (!navigator.mediaDevices?.getUserMedia) { st.textContent = "UNAVAILABLE"; st.className = "v st-gray"; return; }
    st.textContent = "REQUESTING…"; st.className = "v st-gray";
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    Cleanup.addStream(cameraStream);
    const video = $("#cameraVideo");
    video.srcObject = cameraStream;
    await video.play().catch(() => {});
    $("#cameraBox").classList.remove("hidden");
    $("#btnCameraStart").classList.add("hidden");
    $("#btnCameraStop").classList.remove("hidden");
    st.textContent = "GRANTED · LIVE PREVIEW"; st.className = "v st-green";
  } catch (e) {
    st.textContent = e.name === "NotAllowedError" ? "DENIED" : e.name === "NotFoundError" ? "NO DEVICE" : "ERROR";
    st.className = "v " + (e.name === "NotAllowedError" ? "st-red" : "st-gray");
  }
}
function stopCamera() {
  try { cameraStream?.getTracks().forEach(t => t.stop()); } catch {}
  const video = $("#cameraVideo");
  if (video) video.srcObject = null;
  cameraStream = null;
  $("#cameraBox")?.classList.add("hidden");
  $("#btnCameraStart")?.classList.remove("hidden");
  $("#btnCameraStop")?.classList.add("hidden");
  const st = $("#cameraStatus");
  if (st && st.textContent.includes("LIVE")) { st.textContent = "STOPPED"; st.className = "v st-gray"; }
}

async function startMic() {
  const st = $("#micStatus");
  try {
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) { st.textContent = "UNAVAILABLE"; st.className = "v st-gray"; return; }
    st.textContent = "REQUESTING…"; st.className = "v st-gray";
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    Cleanup.addStream(micStream);
    const AC = window.AudioContext || window.webkitAudioContext;
    micAudioCtx = new AC();
    const src = micAudioCtx.createMediaStreamSource(micStream);
    const analyser = micAudioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    $("#micBox").classList.remove("hidden");
    $("#btnMicStart").classList.add("hidden");
    $("#btnMicStop").classList.remove("hidden");
    st.textContent = "GRANTED · MEASURING"; st.className = "v st-green";
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const pct = Math.min(100, Math.round((rms / 128) * 100));
      $("#micMeterFill").style.width = pct + "%";
      $("#micLevelLabel").textContent = pct > 2 ? `MIC LEVEL — input detected (${pct}%)` : "MIC LEVEL — silence";
      micRaf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(micRaf);
    micRaf = requestAnimationFrame(tick);
  } catch (e) {
    st.textContent = e.name === "NotAllowedError" ? "DENIED" : e.name === "NotFoundError" ? "NO DEVICE" : "ERROR";
    st.className = "v " + (e.name === "NotAllowedError" ? "st-red" : "st-gray");
  }
}
function stopMic() {
  cancelAnimationFrame(micRaf);
  try { micStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { micAudioCtx?.close(); } catch {}
  micStream = null; micAudioCtx = null;
  $("#micBox")?.classList.add("hidden");
  $("#micMeterFill").style.width = "0%";
  $("#btnMicStart")?.classList.remove("hidden");
  $("#btnMicStop")?.classList.add("hidden");
  const st = $("#micStatus");
  if (st && st.textContent.includes("MEASURING")) { st.textContent = "STOPPED"; st.className = "v st-gray"; }
}

function testGeolocation() {
  const st = $("#geoStatus"), out = $("#geoResult");
  if (!navigator.geolocation) { st.textContent = "UNAVAILABLE"; st.className = "v st-gray"; out.textContent = "Geolocation API not supported by this browser."; return; }
  st.textContent = "PROMPTING…"; st.className = "v st-yellow";
  out.textContent = "Waiting for permission…";
  navigator.geolocation.getCurrentPosition(
    pos => {
      st.textContent = "GRANTED"; st.className = "v st-green";
      out.textContent = `Lat ${pos.coords.latitude.toFixed(5)}, Lon ${pos.coords.longitude.toFixed(5)} ±${Math.round(pos.coords.accuracy)}m`;
    },
    err => {
      st.textContent = err.code === 1 ? "DENIED" : err.code === 2 ? "UNAVAILABLE" : "TIMEOUT";
      st.className = "v st-red";
      out.textContent = "Location test failed: " + err.message;
    },
    { timeout: 12000, maximumAge: 0 }
  );
}

$("#btnCameraStart").addEventListener("click", startCamera);
$("#btnCameraStop").addEventListener("click", stopCamera);
$("#btnMicStart").addEventListener("click", startMic);
$("#btnMicStop").addEventListener("click", stopMic);
$("#btnGeoTest").addEventListener("click", testGeolocation);

/* ================================================================
   MODULE: STORAGE
   ================================================================ */
async function runStorageTests() {
  const out = [];

  const cookieRes = await runTest("stor-cookie", "Cookies write/read/cleanup", "storage", () => {
    document.cookie = "__jwl_st=1; SameSite=Lax; path=/";
    const okv = document.cookie.includes("__jwl_st");
    document.cookie = "__jwl_st=; Max-Age=0; path=/";
    const cleaned = !document.cookie.includes("__jwl_st");
    if (!okv) { const e = new Error("Cookie write blocked"); e.unsupported = true; throw e; }
    return cleaned ? "writable, cleaned up" : "writable, cleanup uncertain";
  }, { timeout: 2000, weight: 4 });
  out.push(["Cookies", storRow(cookieRes)]);

  const lsRes = await runTest("stor-local", "LocalStorage write/read/cleanup", "storage", () => {
    localStorage.setItem("__jwl_st_" + Date.now(), "v");
    const k = Object.keys(localStorage).find(k => k.startsWith("__jwl_st_"));
    const okv = k && localStorage.getItem(k) === "v";
    localStorage.removeItem(k);
    return okv ? "writable, cleaned up" : "write failed";
  }, { timeout: 2000, weight: 4 });
  out.push(["LocalStorage", storRow(lsRes)]);

  const ssRes = await runTest("stor-session", "SessionStorage write/read/cleanup", "storage", () => {
    sessionStorage.setItem("__jwl_st_" + Date.now(), "v");
    const k = Object.keys(sessionStorage).find(k => k.startsWith("__jwl_st_"));
    const okv = k && sessionStorage.getItem(k) === "v";
    sessionStorage.removeItem(k);
    return okv ? "writable, cleaned up" : "write failed";
  }, { timeout: 2000, weight: 4 });
  out.push(["SessionStorage", storRow(ssRes)]);

  const idbRes = await runTest("stor-idb", "IndexedDB open/write/cleanup", "storage", () => new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(unsupportedErr("IndexedDB not available")); return; }
    let db;
    const rq = indexedDB.open("__jwl_storage_test", 1);
    rq.onerror = () => reject(new Error("IndexedDB blocked"));
    rq.onsuccess = () => {
      db = rq.result;
      try { db.close(); indexedDB.deleteDatabase("__jwl_storage_test"); } catch {}
      resolve("opened, cleaned up");
    };
  }), { timeout: 5000, weight: 4 });
  out.push(["IndexedDB", storRow(idbRes)]);

  const cacheRes = await runTest("stor-cache", "Cache Storage write/read/cleanup", "storage", async () => {
    if (!window.caches) throw unsupportedErr("Cache Storage not available");
    const c = await caches.open("__jwl_cache_test");
    await c.put("/__jwl_probe", new Response("ok"));
    const hit = await c.match("/__jwl_probe");
    await caches.delete("__jwl_cache_test");
    return hit ? "writable, cleaned up" : "read-back failed";
  }, { timeout: 5000, weight: 4 });
  out.push(["Cache Storage", storRow(cacheRes)]);

  const swRes = await runTest("stor-sw", "Service Worker registration", "storage", async () => {
    if (!("serviceWorker" in navigator)) throw unsupportedErr("Service Worker API not available");
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length ? regs.length + " registered" : "API available, none registered";
  }, { timeout: 4000, weight: 3 });
  out.push(["Service Worker", storRow(swRes)]);

  renderRowsInto("#body-storage", out);
  return cookieRes;
}
function storRow(r) {
  if (r.status === "passed") return RS("PASS · " + (typeof r.value === "string" ? r.value : "ok") + ` (${r.duration}ms)`, "passed");
  if (r.status === "unsupported") return RS("NOT SUPPORTED", "unsupported");
  if (r.status === "warning") return RS("WARNING · " + r.error, "warning");
  return RS("FAILED · " + (r.error || ""), "failed");
}

/* ================================================================
   MODULE: PERFORMANCE (+ charts + resources)
   ================================================================ */
try {
  new PerformanceObserver(list => {
    const entries = list.getEntries();
    if (entries.length) state.lcp = entries[entries.length - 1].startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
} catch {}

try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration > 50) state.tbt += e.duration - 50;
  }).observe({ type: "longtask", buffered: true });
} catch {}

try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.interactionId) state.inp = Math.round(Math.max(state.inp || 0, e.duration));
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
} catch {}

async function runPerformanceTests() {
  const res = await runTest("perf-nav", "Navigation & paint timing", "performance", () => {
    if (!performance.getEntriesByType) throw unsupportedErr("Performance Timeline not available");
    const nav = performance.getEntriesByType("navigation")[0];
    if (!nav) throw unsupportedErr("Navigation Timing not available");
    const paint = performance.getEntriesByType("paint");
    return {
      ttfb: nav.responseStart - nav.requestStart,
      dcl: nav.domContentLoadedEventEnd - nav.startTime,
      load: nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : null,
      fp: paint.find(e => e.name === "first-paint")?.startTime ?? null,
      fcp: paint.find(e => e.name === "first-contentful-paint")?.startTime ?? null,
      transferSize: nav.transferSize ?? null,
      decodedSize: nav.decodedBodySize ?? null
    };
  }, { timeout: 4000, weight: 10 });

  const p = res.status === "passed" ? res.value : null;
  const rows = [];
  if (p) {
    rows.push(["TTFB", p.ttfb != null ? fmtMs(p.ttfb) : "NOT SUPPORTED BY THIS BROWSER"]);
    rows.push(["First Paint", p.fp != null ? (p.fp / 1000).toFixed(2) + "s" : "NOT SUPPORTED BY THIS BROWSER"]);
    rows.push(["First Contentful Paint", p.fcp != null ? (p.fcp / 1000).toFixed(2) + "s" : "NOT SUPPORTED BY THIS BROWSER"]);
    rows.push(["Largest Contentful Paint", state.lcp != null ? (state.lcp / 1000).toFixed(2) + "s" : "NOT SUPPORTED BY THIS BROWSER"]);
    rows.push(["DOM Content Loaded", (p.dcl / 1000).toFixed(2) + "s"]);
    rows.push(["Load Event", p.load != null ? (p.load / 1000).toFixed(2) + "s" : "still loading…"]);
    rows.push(["Total Blocking Time", state.tbt > 0 ? Math.round(state.tbt) + " ms" : NA]);
    rows.push(["Interaction Latency (INP)", state.inp != null ? state.inp + " ms" : "interact to measure"]);
    rows.push(["Document Transfer Size", p.transferSize != null ? fmtBytes(p.transferSize) : "NOT SUPPORTED BY THIS BROWSER"]);
    const resEntries = performance.getEntriesByType("resource") || [];
    rows.push(["Resources Loaded", String(resEntries.length)]);
    rows.push(["Total Transfer", fmtBytes(resEntries.reduce((a, r) => a + (r.transferSize || 0), 0) + (p.transferSize || 0))]);
  } else {
    rows.push(["Navigation Timing", RS("NOT SUPPORTED BY THIS BROWSER", "unsupported")]);
  }
  renderRowsInto("#body-performance", rows);

  if (p) {
    const bar = $("#perfBar");
    const loadSec = (p.load ?? p.dcl) / 1000;
    bar.style.width = Math.min(100, Math.max(5, 100 - loadSec * 10)) + "%";
    let v, st;
    if (loadSec < 1.5 && (p.fcp == null || p.fcp < 1800)) { v = "EXCELLENT"; st = "passed"; }
    else if (loadSec < 3) { v = "GOOD"; st = "passed"; }
    else if (loadSec < 6) { v = "FAIR"; st = "warning"; }
    else { v = "POOR"; st = "failed"; }
    $("#perfVerdict").innerHTML = `PERFORMANCE&nbsp;&nbsp;<span class="status ${st}">● ${v}</span>`;
    updateHealth("PERFORMANCE", v, st);
    drawBarChartH("perfChart", [
      p.ttfb != null && p.ttfb >= 0 ? { label: "TTFB", value: p.ttfb } : null,
      p.fcp != null ? { label: "FCP", value: p.fcp } : null,
      state.lcp != null ? { label: "LCP", value: state.lcp } : null,
      { label: "DOM Ready", value: p.dcl },
      p.load != null ? { label: "Load", value: p.load } : null
    ].filter(Boolean));
    renderResourceBreakdown();
  } else {
    $("#perfVerdict").innerHTML = `PERFORMANCE&nbsp;&nbsp;<span class="status st-gray">● UNKNOWN</span>`;
    chartOverlay($("#perfChartBox"), "empty", "NO DATA AVAILABLE", "This browser does not expose Navigation Timing.");
  }
  return res;
}

function renderResourceBreakdown() {
  const wrap = $("#resourceBreakdown");
  let entries;
  try { entries = performance.getEntriesByType("resource") || []; } catch { entries = []; }
  const cats = { JS: 0, CSS: 0, Images: 0, Fonts: 0, Other: 0 };
  let counted = 0;
  for (const r of entries) {
    const size = r.transferSize || r.encodedBodySize || 0;
    if (!size) continue;
    counted += size;
    const url = (r.name || "").split("?")[0];
    if (r.initiatorType === "script" || /\.js$/.test(url)) cats.JS += size;
    else if (r.initiatorType === "css" || r.initiatorType === "link" || /\.css$/.test(url)) cats.CSS += size;
    else if (r.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(url)) cats.Images += size;
    else if (/\.(woff2?|ttf|otf|eot)$/.test(url)) cats.Fonts += size;
    else cats.Other += size;
  }
  if (!counted) {
    wrap.innerHTML = `<div class="chart-state chart-empty">RESOURCE DATA UNAVAILABLE<br><span>Resource Timing returned no sized entries.</span></div>`;
    return;
  }
  wrap.innerHTML = `<div class="resource-list">` + Object.entries(cats).map(([label, size]) => `
    <div class="res-row">
      <span class="res-label">${label}</span>
      <div class="res-track"><div class="res-fill" style="width:${Math.max(counted ? (size / counted) * 100 : 0, size ? 1 : 0)}%"></div></div>
      <span class="res-val">${fmtBytes(size)} · ${counted ? Math.round((size / counted) * 100) : 0}%</span>
    </div>`).join("") + `
    <div class="res-row"><span class="res-label">TOTAL</span><span class="res-val" style="min-width:auto">${fmtBytes(counted)} across ${entries.length} resources</span></div>
  </div>`;
}

/* ================================================================
   MODULE: DATABASE
   ================================================================ */
async function runDatabaseTests() {
  const res = await runTest("db-check", "Database connectivity", "database", async () => {
    if (!navigator.onLine) { const e = new Error("NETWORK OFFLINE"); e.code = "OFFLINE"; throw e; }
    return api("/api/diagnostics/database", { timeout: 5500 });
  }, { timeout: 6500, weight: 8 });

  if (res.status !== "passed") {
    renderRowsInto("#body-database", [["Connection", RS(res.error === "NETWORK" ? "REQUIRES SERVER ENDPOINT" : "TEST FAILED", "failed")], ["Detail", res.error || NA]]);
    updateHealth("DATABASE", "UNAVAILABLE", "warning");
    $("#lsDatabase").textContent = "● UNAVAILABLE"; $("#lsDatabase").className = "v status st-gray";
    return res;
  }
  const d = res.value;
  renderRowsInto("#body-database", [
    ["Connection", d.connected ? RS("CONNECTED", "passed") : RS("UNAVAILABLE", "warning")],
    ["Database", d.database || NA],
    ["Version", d.version || NA],
    ["Probe Latency", d.latencyMs != null ? fmtMs(d.latencyMs) : NA],
    ["Detail", d.detail || NA]
  ]);
  updateHealth("DATABASE", d.connected ? "CONNECTED" : "UNAVAILABLE", d.connected ? "passed" : "warning");
  const ls = $("#lsDatabase");
  if (d.connected) { ls.textContent = "● ONLINE"; ls.className = "v status st-green"; }
  else { ls.textContent = "● UNAVAILABLE"; ls.className = "v status st-yellow"; }
  return res;
}

/* ================================================================
   MODULE: JS ENGINE (+ benchmark)
   ================================================================ */
async function runJsEngineTests() {
  const feats = await runTest("js-feats", "JavaScript engine features", "jsengine", () => ({
    wasm: typeof WebAssembly === "object",
    worker: typeof Worker !== "undefined",
    esm: "noModule" in document.createElement("script"),
    bigint: typeof BigInt === "function",
    optionalChaining: (() => { try { return ({}) ?.a === undefined; } catch { return false; } })(),
    crypto: !!(crypto && crypto.subtle),
    perf: typeof performance?.mark === "function",
    asyncAwait: (() => { try { return (async () => {})() instanceof Promise; } catch { return false; } })()
  }), { timeout: 2000, weight: 5 });

  const f = feats.status === "passed" ? feats.value : {};

  const bench = await runTest("js-bench", "JS micro-benchmark", "jsengine", () => {
    const N = 1_000_000;
    let t0 = performance.now(), x = 0;
    for (let i = 0; i < N; i++) x += Math.sqrt(i % 997);
    const loopMs = performance.now() - t0;
    if (x === -1) console.log(x);

    t0 = performance.now();
    const arr = Array.from({ length: 100_000 }, (_, i) => i);
    arr.sort((a, b) => b - a);
    const sortMs = performance.now() - t0;

    t0 = performance.now();
    const json = JSON.stringify({ sample: arr.slice(0, 500) });
    JSON.parse(json);
    const jsonMs = performance.now() - t0;

    return { loopMs, sortMs, jsonMs, total: loopMs + sortMs + jsonMs, opsPerSec: Math.round(N / (loopMs / 1000)) };
  }, { timeout: 8000, weight: 5 });

  renderRowsInto("#body-jsengine", [
    ["JavaScript", RS("ENABLED", "passed")],
    ["WebAssembly", f.wasm ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["Worker Support", f.worker ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["ES Modules", f.esm ? RS("PASS", "passed") : RS("UNKNOWN", "warning")],
    ["BigInt", f.bigint ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["Async/Await", f.asyncAwait ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["Optional Chaining", f.optionalChaining ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["Web Crypto", f.crypto ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")],
    ["Performance API", f.perf ? RS("PASS", "passed") : RS("NOT SUPPORTED", "unsupported")]
  ]);

  if (bench.status === "passed") {
    const b = bench.value;
    renderRowsInto("#benchData", [
      ["Numeric Loop (1M)", fmtMs(b.loopMs)],
      ["Array Sort (100K)", fmtMs(b.sortMs)],
      ["JSON Serialize", fmtMs(b.jsonMs)],
      ["Total Time", fmtMs(b.total)],
      ["Throughput", b.opsPerSec.toLocaleString() + " ops/s"],
      ["Benchmark Status", RS("COMPLETED", "passed")]
    ]);
  } else {
    renderRowsInto("#benchData", [["Benchmark", RS("FAILED · " + (bench.error || ""), "failed")]]);
  }
  return feats;
}

/* ================================================================
   MODULE: CLOCK
   ================================================================ */
async function runClockTests() {
  const res = await runTest("clock-offset", "Server/client clock comparison", "clock", async () => {
    const r = await fetch(location.href, { method: "HEAD", cache: "no-store" });
    const dateHeader = r.headers.get("date");
    if (!dateHeader) throw unsupportedErr("Server does not send Date header");
    const serverMs = new Date(dateHeader).getTime();
    const nav = performance.getEntriesByType("navigation")[0];
    const localAtResponse = nav?.responseStart ?? Date.now();
    return serverMs - localAtResponse;
  }, { timeout: 6000, weight: 4 });

  if (res.status !== "passed") {
    $("#serverClock").textContent = "NOT AVAILABLE";
    $("#clockOffset").textContent = "—";
    return res;
  }
  state.serverOffsetMs = res.value;
  tickClock();
  return res;
}
setInterval(() => { if ($("#clientClock")) tickClock(); }, 1000);
function tickClock() {
  const now = new Date();
  $("#clientClock").textContent = now.toTimeString().slice(0, 8);
  if (state.serverOffsetMs != null) {
    $("#serverClock").textContent = new Date(Date.now() + state.serverOffsetMs).toTimeString().slice(0, 8);
    const s = Math.round(state.serverOffsetMs / 1000);
    $("#clockOffset").textContent = (s === 0 ? "±0" : (s > 0 ? "+" : "") + s) + "s";
  }
}
function applyClockOffset(dateHeader) {
  if (!dateHeader) return;
  const serverMs = new Date(dateHeader).getTime();
  const nav = performance.getEntriesByType("navigation")[0];
  state.serverOffsetMs = serverMs - (nav?.responseStart ?? Date.now());
  tickClock();
}

/* ================================================================
   HEALTH + SCORE
   ================================================================ */
function updateHealth(label, text, st) {
  const el = $(`#healthRows [data-hl="${label}"]`);
  if (!el) return;
  const dot = { passed: "dot-green", warning: "dot-yellow", failed: "dot-red", unsupported: "dot-gray" }[st] || "dot-gray";
  const cls = { passed: "st-green", warning: "st-yellow", failed: "st-red", unsupported: "st-gray" }[st] || "st-gray";
  el.innerHTML = `<span class="status-dot ${dot}"></span> ${esc(text)}`;
  el.className = "v status " + cls;
}

function computeScore() {
  let got = 0, total = 0, passed = 0, warnings = 0, failed = 0, unsupported = 0;
  for (const r of Engine.results.values()) {
    if (r.status === "unsupported") { unsupported++; continue; }
    if (["idle", "cancelled"].includes(r.status)) continue;
    total += r.weight;
    if (r.status === "passed") { got += r.weight; passed++; }
    else if (r.status === "warning") { got += r.weight * 0.5; warnings++; }
    else { failed++; }
  }
  return { score: total ? Math.round((got / total) * 100) : null, passed, warnings, failed, unsupported, weightedTotal: total };
}

/* ================================================================
   FULL DIAGNOSTIC RUNNER
   ================================================================ */
function newRunId() {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function setProgress(frac, label) {
  const pct = Math.round(frac * 100);
  const filled = Math.round(frac * 20);
  $("#progressBar").textContent = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${String(pct).padStart(3)}%`;
  $("#progressLabel").textContent = label;
}

async function runModule(key) {
  const runners = {
    client: runClientTests, server: runServerTests, network: runNetworkTests,
    http: runHttpTests, tls: runTlsTests, dns: runDnsTests, browser: runBrowserTests,
    storage: runStorageTests, performance: runPerformanceTests, database: runDatabaseTests,
    jsengine: runJsEngineTests, clock: runClockTests
  };
  const fn = runners[key];
  if (!fn) return "idle";
  setStateBadge(key, "running");
  try {
    await fn();
  } catch (e) {
    /* runner-level isolation: module crashed but engine continues */
    console.warn("[module:" + key + "]", e);
    setStateBadge(key, "failed");
    renderErrorInto("#body-" + key, "TEST FAILED", e?.message || "Unexpected module error.", key);
    Engine.results.set("mod-" + key, { id: "mod-" + key, name: MODULES[key].title, category: key, status: "failed", duration: 0, value: null, unit: null, details: null, error: e?.message || "crashed", weight: 5 });
    return "failed";
  }
  const st = summarizeStatus(moduleResults(key));
  if (st !== "idle") setStateBadge(key, st);
  /* refresh health rollups */
  if (key === "server") updateHealth("SERVER", state.serverData ? "ONLINE" : "UNAVAILABLE", state.serverData ? "passed" : "failed");
  if (key === "browser") { /* handled inside */ }
  return st;
}

async function runDiagnostic(order) {
  if (Engine.running) return;
  Engine.running = true;
  Engine.cancelled = false;
  Engine.runId = newRunId();
  Engine.runStartedAt = Date.now();
  Engine.results.clear();
  state.currentRun = { id: Engine.runId, order };

  $("#btnFullDiag").disabled = true;
  $("#btnQuickTest").disabled = true;
  $("#btnCancelDiag").classList.remove("hidden");
  $("#diagProgress").classList.remove("hidden");
  $("#systemStatus").textContent = "RUNNING…";
  order.forEach(k => setStateBadge(k, "idle"));

  let completed = 0;
  const labelOf = k => MODULES[k]?.title || k;

  for (const key of order) {
    if (Engine.cancelled) break;
    setProgress(completed / order.length, "Current: " + labelOf(key));
    $("#progressCount").textContent = `${completed} / ${order.length} tests completed`;
    if (!navigator.onLine && SERVER_ONLY.has(key)) {
      setStateBadge(key, "unavailable");
      Engine.results.set("skip-" + key, { id: "skip-" + key, name: labelOf(key), category: key, status: "cancelled", duration: 0, value: null, unit: null, details: "offline", error: "SKIPPED (OFFLINE)", weight: 0 });
    } else {
      await runModule(key);
    }
    completed++;
    setProgress(completed / order.length, "Completed: " + labelOf(key));
    $("#progressCount").textContent = `${completed} / ${order.length} tests completed`;
  }

  Engine.runDurationMs = Math.round(performance.now() - Engine.runStartedAt) ;
  const { score, passed, warnings, failed, unsupported } = computeScore();
  Engine.running = false;

  $("#btnFullDiag").disabled = false;
  $("#btnQuickTest").disabled = false;
  $("#btnCancelDiag").classList.add("hidden");

  const meta = $("#runMeta");
  if (Engine.cancelled) {
    setProgress(completed / order.length, "Diagnostic cancelled.");
    $("#systemStatus").textContent = "CANCELLED";
    meta.textContent = `RUN #${Engine.runId} — cancelled. Completed: ${completed} / ${order.length}`;
    toast(`Diagnostic cancelled. Completed: ${completed} / ${order.length}`, "warn");
  } else {
    setProgress(1, "DIAGNOSTIC COMPLETE");
    $("#systemStatus").textContent = "DIAGNOSTIC COMPLETE";
    $("#healthScoreBadge").textContent = (score ?? "—") + " / 100";
    const done = new Date();
    meta.innerHTML =
      `RUN #${esc(Engine.runId)} — completed ${esc(done.toTimeString().slice(0, 8))} · duration ${(Engine.runDurationMs / 1000).toFixed(2)}s<br>` +
      `Passed: <b class="st-green">${passed}</b> · Warnings: <b class="st-yellow">${warnings}</b> · Failed: <b class="st-red">${failed}</b> · Unsupported (excluded): <b>${unsupported}</b> · Score: <b class="${score >= 70 ? "st-green" : score >= 40 ? "st-yellow" : "st-red"}">${score ?? "—"}/100</b>`;
    toast(`Diagnostic complete — health ${score ?? "?"}/100`, score >= 70 ? "ok" : "warn");
    setTimeout(() => $("#diagProgress").classList.add("hidden"), 2500);
  }
}

$("#btnFullDiag").addEventListener("click", () => runDiagnostic(FULL_ORDER));
$("#btnQuickTest").addEventListener("click", () => runDiagnostic(QUICK_ORDER));
$("#btnCancelDiag").addEventListener("click", () => {
  Engine.cancelled = true;
  Engine.controllers.forEach(c => { try { c.abort(new DOMException("CANCELLED", "AbortError")); } catch {} });
});

/* per-panel RUN/RETRY buttons */
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-module-run]");
  if (!btn) return;
  const key = btn.dataset.moduleRun;
  if (!MODULES[key] || Engine.running) return;
  btn.disabled = true;
  runModule(key).finally(() => { btn.disabled = false; });
});
$("#btnLatency").addEventListener("click", async e => {
  e.target.disabled = true;
  await runLatencyTest();
  e.target.disabled = false;
});

/* ================================================================
   REPORT EXPORT
   ================================================================ */
function buildReportJSON() {
  const { score, passed, warnings, failed, unsupported } = computeScore();
  return {
    tool: "JUAN WEB LAB",
    version: "2.0.0",
    runId: Engine.runId,
    timestamp: new Date().toISOString(),
    durationMs: Engine.runDurationMs,
    url: location.href,
    userAgent: navigator.userAgent,
    sections: {
      client: moduleSummary("client"),
      server: moduleSummary("server"),
      network: moduleSummary("network"),
      http: moduleSummary("http"),
      tls: moduleSummary("tls"),
      dns: moduleSummary("dns"),
      browser: moduleSummary("browser"),
      storage: moduleSummary("storage"),
      performance: moduleSummary("performance"),
      database: moduleSummary("database")
    },
    tests: [...Engine.results.values()].map(r => ({
      id: r.id, name: r.name, category: r.category, status: r.status,
      durationMs: r.duration, error: r.error, details: r.details
    })),
    score: { overall: score, passed, warnings, failed, unsupportedExcluded: unsupported, formula: "weighted: PASS=100%, WARNING=50%, FAILED=0%, UNSUPPORTED excluded" }
  };
}
function moduleSummary(cat) {
  return moduleResults(cat).filter(r => !r.id.startsWith("mod-")).map(r => ({ id: r.id, status: r.status, durationMs: r.duration }));
}
function buildReportText() {
  const rep = buildReportJSON();
  const L = [];
  L.push("JUAN WEB LAB — DIAGNOSTIC REPORT");
  L.push("Run #" + (rep.runId || "—") + "  ·  " + rep.timestamp);
  L.push("Target: " + rep.url);
  L.push("=".repeat(60));
  for (const [sec, items] of Object.entries(rep.sections)) {
    L.push("");
    L.push("-- " + sec.toUpperCase() + " --");
    if (!items.length) L.push("  (not run)");
    items.forEach(i => L.push(`  ${i.id.padEnd(22)} ${i.status.padEnd(12)} ${i.durationMs}ms`));
  }
  L.push("");
  L.push("-- SCORE --");
  L.push(`Overall: ${rep.score.overall ?? "—"}/100  (passed ${rep.score.passed}, warnings ${rep.score.warnings}, failed ${rep.score.failed}, excluded ${rep.score.unsupportedExcluded})`);
  L.push("");
  L.push("Values marked NOT AVAILABLE were genuinely undetectable.");
  return L.join("\n");
}
$("#btnExport").addEventListener("click", () => {
  if (!Engine.results.size) { toast("No results yet — run a diagnostic first.", "warn"); return; }
  const wrap = document.createElement("div");
  wrap.className = "toast";
  wrap.style.display = "flex"; wrap.style.gap = "8px"; wrap.style.flexWrap = "wrap"; wrap.style.alignItems = "center";
  wrap.append("Export:");
  const mk = (fmt, label) => {
    const b = document.createElement("button");
    b.className = "btn btn-small btn-outline";
    b.textContent = label;
    b.onclick = () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      if (fmt === "json") download(JSON.stringify(buildReportJSON(), null, 2), `juan-web-lab-${stamp}.json`, "application/json");
      else if (fmt === "txt") download(buildReportText(), `juan-web-lab-${stamp}.txt`, "text/plain");
      else window.print();
      wrap.remove();
    };
    return b;
  };
  wrap.append(mk("json", "JSON"), mk("txt", "TXT"), mk("pdf", "PDF (print)"));
  $("#toastWrap").appendChild(wrap);
  setTimeout(() => wrap.remove(), 9000);
});
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Report exported: " + filename, "ok");
}

/* ================================================================
   HTTP STATUS LAB
   ================================================================ */
const STATUS_CODES = {
  200: ["OK", "Standard success response.", "Resource found and returned normally."],
  201: ["Created", "Request succeeded and a new resource was created.", "POST that creates a resource."],
  204: ["No Content", "Success with no body returned.", "Successful DELETE or PUT without a body."],
  301: ["Moved Permanently", "Resource permanently moved to a new URL.", "Domain migration, HTTP → HTTPS redirect."],
  302: ["Found", "Temporary redirect to another URL.", "Temporary maintenance routing."],
  304: ["Not Modified", "Cached version still valid.", "Conditional request matched ETag."],
  400: ["Bad Request", "Server cannot process the malformed request.", "Invalid JSON, bad query parameters."],
  401: ["Unauthorized", "Authentication required or failed.", "Missing/expired token."],
  403: ["Forbidden", "Server refuses to authorize.", "IP blocked, permissions, disabled listing."],
  404: ["Not Found", "Requested resource does not exist.", "Broken link, wrong path, deleted file."],
  408: ["Request Timeout", "Client took too long to send the request.", "Slow connection uploading large body."],
  429: ["Too Many Requests", "Rate limit exceeded.", "API throttling or bot protection."],
  500: ["Internal Server Error", "Unexpected server-side failure.", "Unhandled exception, misconfiguration."],
  502: ["Bad Gateway", "Upstream returned an invalid response.", "App server down behind reverse proxy."],
  503: ["Service Unavailable", "Temporarily overloaded or in maintenance.", "Restarting service, capacity limit."],
  504: ["Gateway Timeout", "Upstream did not respond in time.", "Slow backend behind proxy timeout."]
};
(function initStatusLab() {
  const grid = $("#codeGrid");
  Object.keys(STATUS_CODES).sort((a, b) => a - b).forEach(code => {
    const b = document.createElement("button");
    b.className = "code-chip";
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-label", "HTTP " + code + " " + STATUS_CODES[code][0]);
    b.textContent = code;
    b.addEventListener("click", () => {
      $$(".code-chip").forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      const [meaning, desc, cause] = STATUS_CODES[code];
      $("#cdCode").textContent = code;
      $("#cdMeaning").textContent = meaning;
      renderRowsInto("#cdBody", [["Description", desc], ["Common Cause", cause], ["Example", `curl -I <your-url>  →  HTTP ${code} ${meaning}`]]);
      $("#codeDetail").classList.remove("hidden");
    });
    grid.appendChild(b);
  });
})();

/* ================================================================
   API TESTER
   ================================================================ */
$("#apiForm").addEventListener("submit", async e => {
  e.preventDefault();
  const method = $("#apiMethod").value;
  const urlStr = $("#apiUrl").value.trim();
  const resultBox = $("#apiResult");

  let target;
  try { target = new URL(urlStr); }
  catch { renderApiError(resultBox, "INVALID URL", "The URL could not be parsed."); return; }
  if (!/^https?:$/.test(target.protocol)) { renderApiError(resultBox, "PROTOCOL RESTRICTED", "Only http:// and https:// URLs are allowed."); return; }
  if (target.username || target.password) { renderApiError(resultBox, "CREDENTIALS IN URL", "Embedding credentials in URLs is blocked."); return; }

  let headers = {};
  const raw = $("#apiHeaders").value.trim();
  if (raw) {
    try {
      headers = JSON.parse(raw);
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw 0;
    } catch { renderApiError(resultBox, "INVALID HEADERS", "Headers must be a valid JSON object."); return; }
  }

  const opts = { method, headers, signal: AbortSignal.timeout(15000) };
  const bodyStr = $("#apiBody").value.trim();
  if (bodyStr && !["GET", "HEAD"].includes(method)) opts.body = bodyStr;

  const btn = $(".btn-send");
  btn.disabled = true; btn.textContent = "SENDING…";
  resultBox.classList.remove("hidden");
  renderRowsInto("#apiMeta", [["Request", RS("RUNNING…", "warning")]]);

  const t0 = performance.now();
  try {
    const resp = await fetch(target.href, opts);
    const ms = performance.now() - t0;
    const hdrLines = [];
    resp.headers.forEach((v, k) => hdrLines.push(k + ": " + v));
    let bodyText = "";
    try { bodyText = await resp.text(); } catch { bodyText = "(binary body — not displayed)"; }
    renderRowsInto("#apiMeta", [
      ["Status", RS(String(resp.status), resp.ok ? "passed" : resp.status < 500 ? "warning" : "failed")],
      ["Response Time", fmtMs(ms)],
      ["Body Size", fmtBytes(new Blob([bodyText]).size)],
      ["Content-Type", resp.headers.get("content-type") || NA]
    ]);
    $("#apiRespHeaders").textContent = hdrLines.join("\n") || "(none exposed by CORS)";
    $("#apiRespBody").textContent = bodyText.slice(0, 20000) || "(empty)";
    toast(`Request completed: HTTP ${resp.status} in ${Math.round(ms)}ms`, resp.ok ? "ok" : "warn");
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    renderRowsInto("#apiMeta", [
      ["Result", RS(isTimeout ? "TIMEOUT" : "REQUEST BLOCKED BY CORS POLICY / NETWORK", "failed")],
      ["Detail", isTimeout ? "Aborted after 15s." : err?.message || "TypeError: Failed to fetch"]
    ]);
    $("#apiRespHeaders").textContent = "";
    $("#apiRespBody").textContent =
      "The request was sent directly from YOUR browser.\n" +
      "'Failed to fetch' almost always means the TARGET did not send CORS headers,\n" +
      "or the network/firewall blocked it — it does not automatically mean the API is broken.";
  } finally {
    btn.disabled = false; btn.textContent = "SEND REQUEST";
  }
});
function renderApiError(box, title, msg) {
  box.classList.remove("hidden");
  renderRowsInto("#apiMeta", [["Result", RS(title, "failed")], ["Detail", msg]]);
}

/* ================================================================
   TERMINAL — fully interactive
   ================================================================ */
const termOut = $("#termOut");
const termInput = $("#termInput");
const termHistory = [];
let histIdx = 0;

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
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const ch of text) {
    div.textContent += ch;
    termOut.scrollTop = termOut.scrollHeight;
    if (!reduced) await new Promise(r => setTimeout(r, 5));
  }
  return div;
}

const COMMANDS = {
  help() {
    tprint("Available commands:", "t-dim");
    [["help", "Show available commands"], ["status", "Show system status"], ["server", "Show server information"],
     ["network", "Run network diagnostics"], ["browser", "Show browser information"], ["ssl", "Show TLS information"],
     ["dns", "Run DNS diagnostics"], ["performance", "Show performance metrics"], ["diagnostic", "Run full diagnostic"],
     ["clear", "Clear terminal"], ["about", "About JUAN WEB LAB"]]
      .forEach(([c, d]) => tprint(`  ${esc(c.padEnd(13))}<span class="t-dim">${esc(d)}</span>`));
  },
  clear() { termOut.innerHTML = ""; },
  about() {
    tprint(`<span class="t-ok">JUAN WEB LAB v2.0</span> — Web Infrastructure Diagnostics`);
    tprint(`Inspect your server. Test your network. Understand your environment.`, "t-dim");
    tprint(`Every value shown comes from real APIs or the bundled backend. No fake data.`, "t-dim");
  },
  status() {
    $$("#healthRows .row").forEach(r => {
      tprint(`${esc(r.querySelector(".k").textContent.padEnd(14))} ${esc(r.querySelector(".v").textContent.trim())}`);
    });
    const { score } = computeScore();
    if (score != null) tprint(`OVERALL        ${score}/100`, "t-ok");
    tprint(`BACKEND        ${state.backendOk ? "ONLINE" : "UNAVAILABLE"}`, state.backendOk ? "t-ok" : "t-warn");
  },
  server() {
    const d = state.serverData;
    if (!d) return ttype("SERVER DIAGNOSTICS UNAVAILABLE — deploy node server.js on your VPS.", "t-warn");
    tprint(`hostname   ${esc(d.hostname ?? NA)}`);
    tprint(`os         ${esc(d.os ?? NA)} ${esc(d.osVersion ?? "")}`);
    tprint(`kernel     ${esc(d.kernel ?? NA)}`);
    tprint(`arch       ${esc(d.architecture ?? NA)}`);
    tprint(`cpu        ${esc((d.cpuModel ?? NA).slice(0, 56))}`);
    tprint(`cores      ${esc(String(d.cpuCores ?? NA))}`);
    tprint(`ram        ${fmtBytes(d.memoryTotal)} (${d.memoryPct ?? "?"}% used)`);
    tprint(`disk       ${d.diskTotal != null ? fmtBytes(d.diskTotal) : NA}${d.diskPct != null ? " (" + d.diskPct + "% used)" : ""}`);
    tprint(`uptime     ${fmtSec(d.uptime)}`);
    tprint(`load       ${Array.isArray(d.loadAverage) ? d.loadAverage.join(" / ") : NA}`);
  },
  async network() {
    tprint(`online     ${navigator.onLine}`);
    const conn = navigator.connection;
    if (conn) tprint(`connection ${esc(conn.effectiveType || conn.type || "unknown")}`);
    await runLatencyTest();
    if (state.latencySamples.length) tprint(`latency    median ${Math.round(median(state.latencySamples))} ms over ${state.latencySamples.length} requests`, "t-ok");
  },
  browser() {
    const rows = $$("#body-browser .cap-item");
    if (!rows.length) return ttype("Capability tests have not run yet. Use 'diagnostic' or press RUN on Browser Capabilities.", "t-warn");
    rows.slice(0, 26).forEach(r => tprint(`${esc(r.children[0].textContent.padEnd(20))} ${esc(r.children[1].textContent)}`));
  },
  ssl() {
    const r = Engine.results.get("tls-check");
    if (!r) return ttype("SSL panel has not run yet.", "t-warn");
    tprint(`https      ${location.protocol === "https:" ? "enabled" : "DISABLED"}`, location.protocol === "https:" ? "t-ok" : "t-err");
    tprint(`hsts       ${state.headers?.["strict-transport-security"] ? "enabled" : "not set"}`);
    tprint(`mixed      ${hasMixedContent() ? "DETECTED" : "none found"}`);
    tprint(`cert       limited by browser — inspect via server-side tooling`, "t-dim");
  },
  async dns() {
    ttype("resolving " + location.hostname + " …", "t-dim");
    await runDnsTests();
    const r = Engine.results.get("dns-resolve");
    if (!r || r.status !== "passed") return tprint("DNS lookup failed or requires the backend endpoint.", "t-warn");
    const d = r.value;
    tprint(`A          ${d.a?.join(", ") || NA}`, d.a?.length ? "t-ok" : "");
    tprint(`AAAA       ${d.aaaa?.join(", ") || NA}`);
    tprint(`NS         ${d.ns?.join(", ") || NA}`);
    tprint(`resolved   ${d.resolveMs} ms`);
  },
  performance() {
    const r = Engine.results.get("perf-nav");
    if (!r || r.status !== "passed") return ttype("Performance metrics not available yet.", "t-warn");
    const p = r.value;
    tprint(`ttfb        ${Math.round(p.ttfb)} ms`);
    tprint(`fcp         ${p.fcp != null ? (p.fcp / 1000).toFixed(2) + "s" : "n/a"}`);
    tprint(`lcp         ${state.lcp != null ? (state.lcp / 1000).toFixed(2) + "s" : "n/a"}`);
    tprint(`dom ready   ${(p.dcl / 1000).toFixed(2)}s`);
    tprint(`resources   ${(performance.getEntriesByType("resource") || []).length}`);
  },
  async diagnostic() {
    tprint("starting full diagnostic…", "t-dim");
    await runDiagnostic(FULL_ORDER);
    tprint(`diagnostic finished — see SYSTEM HEALTH panel.`, "t-ok");
  }
};

async function execCommand(raw) {
  const cmd = raw.trim();
  tprint(`<span class="t-dim">juan@web-lab:~$</span> <span class="t-cmd">${esc(cmd)}</span>`);
  if (!cmd) return;
  termHistory.unshift(cmd);
  histIdx = -1;
  const [base, ...args] = cmd.split(/\s+/);
  const fn = COMMANDS[base.toLowerCase()];
  if (!fn) {
    tprint(`Command not found: ${esc(base)}`, "t-err");
    tprint(`Type <span class="t-cmd">help</span> for available commands.`, "t-dim");
    return;
  }
  try { await fn(args); }
  catch (e) { tprint("command error: " + esc(e?.message || e), "t-err"); }
}

$("#termForm").addEventListener("submit", async e => {
  e.preventDefault();
  const val = termInput.value;
  termInput.value = "";
  await execCommand(val);
  termInput.focus();
});
$("#termWindow").addEventListener("click", () => {
  if (!getSelection().toString()) termInput.focus();
});
termInput.addEventListener("keydown", e => {
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (histIdx < termHistory.length - 1) termInput.value = termHistory[++histIdx];
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx > 0) termInput.value = termHistory[--histIdx];
    else { histIdx = -1; termInput.value = ""; }
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const v = termInput.value.trim().toLowerCase();
    const match = Object.keys(COMMANDS).find(c => c.startsWith(v) && v);
    if (match) termInput.value = match;
    return;
  }
  if (e.key === "c" && e.ctrlKey) {
    e.preventDefault();
    tprint(`<span class="t-dim">juan@web-lab:~$</span> <span class="t-cmd">${esc(termInput.value)}</span>^C`);
    termInput.value = "";
  }
});

/* ================================================================
   LAB STATUS + OFFLINE + GLOBAL ERRORS
   ================================================================ */
state.isOnline = navigator.onLine;
function setOnlineUI(online) {
  state.isOnline = online;
  $("#offlineBanner").classList.toggle("hidden", online);
  $("#systemStatus").textContent = online ? $("#systemStatus").textContent.replace("SYSTEM OFFLINE", "SYSTEM ONLINE") : "SYSTEM OFFLINE";
  if (!online) $("#systemStatus").textContent = "NETWORK OFFLINE";
  else if (!Engine.running) $("#systemStatus").textContent = "SYSTEM ONLINE";
}
window.addEventListener("online", () => { setOnlineUI(true); toast("Back online.", "ok"); });
window.addEventListener("offline", () => { setOnlineUI(false); toast("Network offline — server tests disabled.", "err"); });
setOnlineUI(navigator.onLine);

window.addEventListener("error", e => { console.warn("[global]", e.message); });
window.addEventListener("unhandledrejection", e => { console.warn("[unhandled]", e.reason); });

/* ================================================================
   NAV
   ================================================================ */
$("#navToggle").addEventListener("click", () => {
  const open = $("#mainNav").classList.toggle("open");
  $("#navToggle").setAttribute("aria-expanded", String(open));
});
$$("#mainNav a").forEach(a => a.addEventListener("click", () => {
  $("#mainNav").classList.remove("open");
  $("#navToggle").setAttribute("aria-expanded", "false");
}));

/* ================================================================
   INIT — boot sequence with error isolation
   ================================================================ */
(async function init() {
  tprint(`<span class="t-ok">JUAN WEB LAB shell v2.0</span> <span class="t-dim">— connected ${new Date().toLocaleTimeString()}</span>`);
  tprint(`type <span class="t-cmd">help</span> to list commands.`, "t-dim");

  updateViewportPanel();
  tickClock();

  /* backend probe */
  try {
    const st = await api("/api/status", { timeout: 4000 });
    state.backendOk = true;
    const el = $("#lsBackend");
    el.textContent = `● ONLINE (v${st.version || "?"})`;
    el.className = "v status st-green";
  } catch {
    state.backendOk = false;
    const el = $("#lsBackend");
    el.textContent = "● UNAVAILABLE";
    el.className = "v status st-red";
  }

  /* boot-time modules, each isolated so one failure never blocks the rest */
  const bootOrder = ["client", "network", "http", "tls", "performance", "jsengine", "clock", "storage", "browser"];
  for (const key of bootOrder) {
    if (document.hidden) break;
    try { await runModule(key); } catch (e) { console.warn("[boot:" + key + "]", e); }
  }

  /* server-dependent extras (non-blocking) */
  if (navigator.onLine) {
    runModule("server").catch(() => {});
    runModule("database").catch(() => {});
  }
})();
