"use strict";

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
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

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function rateLimit(req, res, max = 30, windowMs = 10000) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (buckets.size > 5000) buckets.clear();
  b.count++;
  if (b.count > max) {
    sendJSON(res, 429, { error: "rate limit exceeded" });
    return false;
  }
  return true;
}

/* ---------------- helpers ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

let cachedCpuSample = null;
function cpuUsagePct() {
  return new Promise(resolve => {
    if (cachedCpuSample && Date.now() - cachedCpuSample.t < 2000) return resolve(cachedCpuSample.v);
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
    }, 250);
  });
}

function diskUsage() {
  return new Promise(resolve => {
    if (typeof fs.statfs === "function") {
      const target = process.platform === "win32" ? process.env.SystemDrive || "C:\\" : "/";
      fs.statfs(target, (err, st) => {
        if (!err && st && st.blocks) {
          const total = st.blocks * st.bsize;
          const free = st.bavail * st.bsize;
          return resolve({ total, free, used: total - free });
        }
        resolve({});
      });
    } else if (process.platform !== "win32") {
      fs.statfs("/", (err, st) => {
        if (err || !st) return resolve({});
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        resolve({ total, free, used: total - free });
      });
    } else {
      require("child_process").exec(
        "powershell -NoProfile -Command \"Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \\\"{0} {1} {2}\\\" -f $_.FreeSpace,$_.Size,$_.DeviceID }\"",
        (err, out) => {
          if (err || !out) return resolve({});
          let total = 0, free = 0;
          out.trim().split(/\r?\n/).filter(Boolean).forEach(line => {
            const parts = line.trim().split(/\s+/);
            free += Number(parts[0]) || 0;
            total += Number(parts[1]) || 0;
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
        if (!err2 && /docker|lxc|containerd|kubepods/i.test(cg)) {
          const m = cg.match(/docker|lxc|containerd|kubepods/i);
          return resolve("Container: " + m[0]);
        }
        require("child_process").exec("systemd-detect-virt 2>/dev/null", (e3, out3) => {
          resolve(e3 || !out3.trim() ? null : out3.trim());
        });
      });
    });
  });
}

function detectDistro(cb) {
  if (process.platform === "win32") return cb({ osDist: "Windows", osVersion: os.release() });
  if (process.platform === "darwin") return cb({ osDist: "macOS", osVersion: os.release() });
  fs.readFile("/etc/os-release", "utf8", (err, data) => {
    if (err) return cb({});
    const get = k => (data.match(new RegExp("^" + k + "=.?([^\n]+?)\.?$", "m")) || [])[1];
    cb({ osDist: get("NAME"), osVersion: get("PRETTY_NAME")?.split(" ").slice(1).join(" ") || get("VERSION_ID") });
  });
}

function dnsProviderOf(ns) {
  const map = [
    [/cloudflare|ns1\.cloudflare/i, "Cloudflare DNS"],
    [/googledomains|dns\.google/i, "Google Cloud DNS"],
    [/awsdns/i, "AWS Route 53"],
    [/azure|microsoft/i, "Azure DNS"],
    [/digitalocean/i, "DigitalOcean DNS"],
    [/namecheap|registrar-servers/i, "Namecheap"],
    [/godaddy|domaincontrol/i, "GoDaddy"],
    [/vultr/i, "Vultr"],
    [/hetzner/i, "Hetzner"]
  ];
  const joined = ns.join(" ");
  for (const [re, name] of map) if (re.test(joined)) return name;
  return null;
}

/* ---------------- API handlers ---------------- */
function serverLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.internal && ni.family === "IPv4") return ni.address;
    }
  }
  return null;
}

async function handleServerInfo(req, res) {
  const disk = await diskUsage();
  const virt = await detectVirtualization();
  detectDistro(distro => {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    sendJSON(res, 200, {
      ip: serverLanIp(),
      hostname: os.hostname(),
      os: distro.osDist || `${os.type()} ${os.release()}`,
      osVersion: distro.osVersion || os.release(),
      kernel: os.release(),
      arch: os.arch(),
      platform: process.platform,
      cpuModel: os.cpus()[0]?.model?.trim() || null,
      cpuCores: os.cpus().length,
      cpuUsage: null,
      memTotal,
      memFree,
      memUsed: memTotal - memFree,
      memPct: Math.round(((memTotal - memFree) / memTotal) * 100),
      diskTotal: disk.total ?? null,
      diskUsed: disk.used ?? null,
      diskFree: disk.free ?? null,
      diskPct: disk.total ? Math.round((disk.used / disk.total) * 100) : null,
      loadavg: os.loadavg().map(n => Number(n.toFixed(2))),
      uptime: Math.round(os.uptime()),
      bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      datetime: new Date().toString(),
      virtualization: virt,
      container: virt && /^Container/i.test(virt) ? virt.replace(/^Container:\s*/i, "") : null
    });
  });
}

async function handleLive(req, res) {
  const cpuPct = await cpuUsagePct();
  const disk = await diskUsage();
  const memTotal = os.totalmem();
  sendJSON(res, 200, {
    cpuPct,
    memPct: Math.round(((memTotal - os.freemem()) / memTotal) * 100),
    diskPct: disk.total ? Math.round((disk.used / disk.total) * 100) : null,
    load1: os.loadavg()[0].toFixed(2),
    uptime: Math.round(os.uptime()),
    timestamp: Date.now()
  });
}

async function handleDNS(req, res) {
  let host = (req.headers.host || "").split(":")[0];
  if (!host || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes("::")) {
    return sendJSON(res, 200, { domain: host || null, error: "no public domain to resolve (accessed by IP or localhost)" });
  }
  const t0 = Date.now();
  const out = { domain: host };
  try {
    out.a = await dns.resolve4(host).catch(() => []);
    out.aaaa = await dns.resolve6(host).catch(() => []);
    out.ns = await dns.resolveNs(host).catch(() => []);
    try { out.cname = (await dns.resolveCname(host))[0] || null; } catch { out.cname = null; }
    out.provider = out.ns.length ? dnsProviderOf(out.ns) : null;
    out.resolveMs = Date.now() - t0;
  } catch (e) {
    return sendJSON(res, 200, { domain: host, error: e.code || "resolution failed" });
  }
  sendJSON(res, 200, out);
}

async function handleDatabase(req, res) {
  const t0 = Date.now();
  const probe = (port, name) => new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 1200 });
    sock.on("connect", () => { sock.destroy(); resolve(name); });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => { sock.destroy(); resolve(null); });
  });
  const found = (await probe(3306, "MySQL / MariaDB")) ||
    (await probe(5432, "PostgreSQL")) ||
    (await probe(27017, "MongoDB")) ||
    (await probe(6379, "Redis"));
  sendJSON(res, 200, {
    connected: !!found,
    database: found,
    version: null,
    responseMs: Date.now() - t0,
    detail: found ? "TCP port open on localhost. Version requires credentials (not exposed)." : "No common database port detected on localhost."
  });
}

/* ---------------- static ---------------- */
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/" ) p = "/index.html";
  const filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.stat(filePath, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 Not Found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=300"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  const url = req.url;

  if (url.startsWith("/api/diagnostics/")) {
    res.setHeader("Access-Control-Allow-Origin", location_origin_of(req));
    if (!rateLimit(req, res, 60, 10000)) return;
    try {
      switch (url.split("?")[0]) {
        case "/api/diagnostics/server": return await handleServerInfo(req, res);
        case "/api/diagnostics/live": return await handleLive(req, res);
        case "/api/diagnostics/ip": return sendJSON(res, 200, { ip: clientIpOf(req), source: req.headers["cf-connecting-ip"] ? "cdn header" : "socket" });
        case "/api/diagnostics/dns": return await handleDNS(req, res);
        case "/api/diagnostics/database": return await handleDatabase(req, res);
        default: return sendJSON(res, 404, { error: "unknown endpoint" });
      }
    } catch (e) {
      return sendJSON(res, 500, { error: "internal error" });
    }
  }

  serveStatic(req, res, url);
});

function clientIpOf(req) {
  const h = req.headers;
  const cand = h["cf-connecting-ip"] || h["x-real-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim();
  return cand || (req.socket.remoteAddress || "").replace("::ffff:", "") || null;
}
function location_origin_of(req) {
  return "*";
}

server.listen(PORT, () => {
  console.log("");
  console.log("  JUAN WEB LAB — diagnostics backend running");
  console.log(`  http://localhost:${PORT}`);
  console.log("  Endpoints:");
  console.log("   /api/diagnostics/server   /live   /ip   /dns   /database");
  console.log("  No secrets, credentials or environment variables are exposed.");
  console.log("");
});
