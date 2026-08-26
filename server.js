"use strict";

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const VERSION = "2.0.0";
const STARTED = Date.now();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

/* ============================================================
   Response contract:
   success → { "success": true,  "data": { ... } }
   failure → { "success": false, "error": { code, message } }
   ============================================================ */

function sendJSON(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}
const ok = (res, data) => sendJSON(res, 200, { success: true, data });
const fail = (res, code, errCode, message) => sendJSON(res, code, { success: false, error: { code: errCode, message } });

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function rateLimit(req, res, max = 60, windowMs = 10000) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (buckets.size > 5000) buckets.clear();
  b.count++;
  if (b.count > max) {
    fail(res, 429, "RATE_LIMITED", "Too many requests. Slow down and retry shortly.");
    return false;
  }
  return true;
}

/* ---------------- system collectors ---------------- */
let cachedCpuSample = null;
function cpuUsagePct() {
  return new Promise(resolve => {
    if (cachedCpuSample && Date.now() - cachedCpuSample.t < 1500) return resolve(cachedCpuSample.v);
    const cpus1 = os.cpus();
    setTimeout(() => {
      const cpus2 = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < cpus2.length; i++) {
        const t1 = cpus1[i].times, t2 = cpus2[i].times;
        const d = k => t2[k] - t1[k];
        idle += d("idle");
        total += d("user") + d("nice") + d("sys") + d("idle") + d("irq");
      }
      const v = total ? Math.round((1 - idle / total) * 100) : null;
      cachedCpuSample = { t: Date.now(), v };
      resolve(v);
    }, 200);
  });
}

function diskUsage() {
  return new Promise(resolve => {
    const fromStat = (st) => {
      if (!st || !st.blocks || !st.bsize) return false;
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      resolve({ total, free, used: total - free });
      return true;
    };
    if (typeof fs.statfs === "function") {
      const target = process.platform === "win32" ? (process.env.SystemDrive || "C:\\") : "/";
      fs.statfs(target, (err, st) => {
        if (fromStat(st)) return;
        resolve({});
      });
    } else if (process.platform !== "win32") {
      fs.statfs("/", (err, st) => { fromStat(st) || resolve({}); });
    } else {
      require("child_process").exec(
        "powershell -NoProfile -Command \"Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \\\"{0} {1}\\\" -f $_.FreeSpace,$_.Size }\"",
        (err, out) => {
          if (err || !out) return resolve({});
          let total = 0, free = 0;
          out.trim().split(/\r?\n/).filter(Boolean).forEach(line => {
            const p = line.trim().split(/\s+/);
            free += Number(p[0]) || 0;
            total += Number(p[1]) || 0;
          });
          resolve(total ? { total, free, used: total - free } : {});
        }
      );
    }
  });
}

function detectVirtualization() {
  return new Promise(resolve => {
    if (process.platform === "win32") return resolve(null);
    fs.readFile("/proc/cpuinfo", "utf8", (err, data) => {
      if (!err && /hypervisor/i.test(data)) return resolve("KVM / Hyper-V (hypervisor flag)");
      fs.readFile("/proc/1/cgroup", "utf8", (err2, cg) => {
        if (!err2) {
          const m = cg.match(/docker|lxc|containerd|kubepods/i);
          if (m) return resolve("Container: " + m[0]);
        }
        require("child_process").exec("systemd-detect-virt 2>/dev/null", (e3, out3) => {
          resolve(e3 || !String(out3).trim() ? null : String(out3).trim());
        });
      });
    });
  });
}

function detectDistro(cb) {
  if (process.platform === "win32") return cb({ dist: "Windows", version: os.release() });
  if (process.platform === "darwin") return cb({ dist: "macOS", version: os.release() });
  fs.readFile("/etc/os-release", "utf8", (err, data) => {
    if (err) return cb({});
    const get = k => (data.match(new RegExp("^" + k + "=?\"?([^\n\"]+)\"?", "m")) || [])[1];
    cb({ dist: get("NAME"), version: get("PRETTY_NAME")?.split(" ").slice(1).join(" ") || get("VERSION_ID") });
  });
}

function serverLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.internal && ni.family === "IPv4") return ni.address;
    }
  }
  return null;
}
function clientIpOf(req) {
  const h = req.headers;
  const cand = h["cf-connecting-ip"] || h["x-real-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim();
  return cand || (req.socket.remoteAddress || "").replace("::ffff:", "") || null;
}

function dnsProviderOf(ns) {
  const map = [
    [/cloudflare/i, "Cloudflare DNS"],
    [/dns\.google|googledomains/i, "Google Cloud DNS"],
    [/awsdns/i, "AWS Route 53"],
    [/azure|microsoft/i, "Azure DNS"],
    [/digitalocean/i, "DigitalOcean DNS"],
    [/namecheap|registrar-servers/i, "Namecheap"],
    [/domaincontrol|godaddy/i, "GoDaddy"],
    [/vultr/i, "Vultr"],
    [/hetzner/i, "Hetzner"]
  ];
  const joined = ns.join(" ");
  for (const [re, name] of map) if (re.test(joined)) return name;
  return null;
}

/* ---------------- handlers ---------------- */
async function hStatus(req, res) {
  ok(res, { service: "juan-web-lab-backend", version: VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000), time: new Date().toISOString(), platform: process.platform });
}

async function hPing(req, res) {
  ok(res, { t: Date.now() });
}

async function hServer(req, res) {
  const disk = await diskUsage();
  const virt = await detectVirtualization();
  const memTotal = os.totalmem(), memFree = os.freemem();
  detectDistro(distro => {
    ok(res, {
      hostname: os.hostname(),
      os: distro.dist || `${os.type()} ${os.release()}`,
      osVersion: distro.version || os.release(),
      kernel: os.release(),
      architecture: os.arch(),
      platform: process.platform,
      cpuModel: os.cpus()[0]?.model?.trim() || null,
      cpuCores: os.cpus().length,
      memoryTotal: memTotal,
      memoryUsed: memTotal - memFree,
      memoryFree: memFree,
      memoryPct: Math.round(((memTotal - memFree) / memTotal) * 100),
      diskTotal: disk.total ?? null,
      diskUsed: disk.used ?? null,
      diskFree: disk.free ?? null,
      diskPct: disk.total ? Math.round((disk.used / disk.total) * 100) : null,
      uptime: Math.round(os.uptime()),
      loadAverage: os.loadavg().map(n => Number(n.toFixed(2))),
      bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: new Date().toString(),
      virtualization: virt,
      container: virt && /^Container/i.test(virt) ? virt.replace(/^Container:\s*/i, "") : null,
      serverIp: serverLanIp()
    });
  });
}

async function hMetrics(req, res) {
  const cpuPct = await cpuUsagePct();
  const disk = await diskUsage();
  const memTotal = os.totalmem();
  ok(res, {
    cpuPct,
    memPct: Math.round(((memTotal - os.freemem()) / memTotal) * 100),
    diskPct: disk.total ? Math.round((disk.used / disk.total) * 100) : null,
    load1: Number(os.loadavg()[0].toFixed(2)),
    uptime: Math.round(os.uptime()),
    timestamp: Date.now()
  });
}

async function hNetwork(req, res) {
  ok(res, { ip: clientIpOf(req), source: req.headers["cf-connecting-ip"] ? "cdn-header" : "socket" });
}

async function hDns(req, res) {
  const host = (req.headers.host || "").split(":")[0];
  if (!host || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes("::")) {
    return fail(res, 200, "NO_PUBLIC_DOMAIN", "No public domain to resolve (host accessed by IP or localhost).");
  }
  const t0 = Date.now();
  try {
    const [a, aaaa, ns] = await Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
      dns.resolveNs(host).catch(() => [])
    ]);
    let cname = null;
    try { cname = (await dns.resolveCname(host))[0] || null; } catch {}
    ok(res, {
      domain: host,
      a, aaaa, ns, cname,
      provider: ns.length ? dnsProviderOf(ns) : null,
      resolveMs: Date.now() - t0
    });
  } catch (e) {
    fail(res, 200, "DNS_LOOKUP_FAILED", e.code || "DNS resolution failed.");
  }
}

async function hDatabase(req, res) {
  const probe = (port, name) => new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 1200 });
    sock.on("connect", () => { sock.destroy(); resolve(name); });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => { sock.destroy(); resolve(null); });
  });
  const t0 = Date.now();
  const found = (await probe(3306, "MySQL / MariaDB")) ||
    (await probe(5432, "PostgreSQL")) ||
    (await probe(27017, "MongoDB")) ||
    (await probe(6379, "Redis"));
  ok(res, {
    connected: !!found,
    database: found,
    version: null,
    latencyMs: Date.now() - t0,
    detail: found
      ? "TCP port open on localhost. Version requires credentials (not exposed)."
      : "No common database port detected on localhost."
  });
}

/* ---------------- static files ---------------- */
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/") p = "/index.html";
  const filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT)) return fail(res, 403, "FORBIDDEN", "Path traversal blocked.");
  fs.stat(filePath, (err, st) => {
    if (err || st.isDirectory()) return fail(res, 404, "NOT_FOUND", "Resource not found.");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- router ---------------- */
const API_ROUTES = {
  "/api/status":                 { handler: hStatus,   limit: 30 },
  "/api/ping":                   { handler: hPing,     limit: 240 },
  "/api/diagnostics/server":     { handler: hServer,   limit: 30 },
  "/api/diagnostics/metrics":    { handler: hMetrics,  limit: 120 },
  "/api/server/metrics":         { handler: hMetrics,  limit: 120 },
  "/api/diagnostics/network":    { handler: hNetwork,  limit: 20 },
  "/api/diagnostics/dns":        { handler: hDns,      limit: 10 },
  "/api/diagnostics/database":   { handler: hDatabase, limit: 10 }
};

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400"
    });
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return fail(res, 405, "METHOD_NOT_ALLOWED", "Only GET is supported.");
  }

  const routeBase = req.url.split("?")[0];
  const route = API_ROUTES[routeBase];
  if (route) {
    if (!rateLimit(req, res, route.limit)) return;
    try {
      return await route.handler(req, res);
    } catch (e) {
      console.error("[api]", routeBase, e.message);
      return fail(res, 500, "INTERNAL_ERROR", "Unable to complete diagnostics request.");
    }
  }
  serveStatic(req, res, req.url);
});

server.listen(PORT, () => {
  console.log("");
  console.log("  JUAN WEB LAB v" + VERSION + " — diagnostics backend running");
  console.log(`  http://localhost:${PORT}`);
  console.log("");
  console.log("  Endpoints:");
  Object.keys(API_ROUTES).forEach(r => console.log("   GET " + r));
  console.log("");
  console.log("  No secrets, credentials or environment variables are exposed.");
  console.log("");
});
