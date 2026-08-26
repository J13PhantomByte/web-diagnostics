# JUAN WEB LAB

**Web Infrastructure Diagnostics**
*Inspect your server. Test your network. Understand your environment.*

A real-world VPS / hosting / server / browser / network diagnostics test page.
Open it on any device (phone, tablet, laptop, desktop) and it detects as much
as possible about the client, server, network, hosting, browser and web
environment — using only **real data**. If something cannot be detected it
shows `NOT AVAILABLE`. No fake or random values.

## Run

### Option A — static only (client-side diagnostics)

Host the folder on any web server (nginx, Apache, cPanel, Vercel…).
All browser/network/performance panels work. Server panels show
`NOT AVAILABLE` because there is no backend.

### Option B — with the bundled Node.js backend (recommended)

```bash
node server.js
# → http://localhost:3000
```

No npm dependencies required. Enables:

| Endpoint | Purpose |
|---|---|
| `/api/diagnostics/server` | hostname, OS, kernel, CPU, RAM, disk, uptime, load, virtualization |
| `/api/diagnostics/live`   | live CPU / RAM / disk / load polling |
| `/api/diagnostics/ip`     | client IP (CDN-aware: CF / X-Real-IP / X-Forwarded-For) |
| `/api/diagnostics/dns`    | A / AAAA / CNAME / NS resolution of the host domain |
| `/api/diagnostics/database` | safe TCP probe for MySQL/PostgreSQL/MongoDB/Redis on localhost |

Rate limited (60 req / 10 s per IP). Exposes no secrets, credentials,
environment variables or private filesystem paths.

## Panels

Dashboard · System Health · Client Device · Network + Latency Test ·
Server Info · Server OS · Live Server Monitor (chart) · Web Server ·
HTTP Diagnostics (terminal view) · TLS/SSL · DNS · Edge/CDN detection ·
Server Clock offset · Web Performance (Paint/LCP/TBT/INP) · Browser
Capabilities (25 tests) · Storage · JavaScript Engine + Benchmark ·
Database · API Tester (browser-side fetch — no SSRF surface) · HTTP Status
Lab · Interactive Terminal (`juan@web-lab:~$`) · Full Diagnostic runner with
score · Export report as JSON / TXT / PDF (print).

## Deploying behind nginx (production example)

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Run under systemd or pm2 for a persistent diagnostic page on your VPS.

## Security notes

- Diagnostics API returns only safe system metadata.
- API Tester runs entirely in the visitor's browser — the backend never
  proxies arbitrary URLs, so there is no open-proxy/SSRF surface.
- Reports contain no credentials; nothing is stored server-side.
