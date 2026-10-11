import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT } from './config.js';
import { ActionQueue } from './queue.js';
import { Pipeline } from './pipeline.js';
import { TikTokBridge } from './tiktok.js';
import { Hub } from './hub.js';
import { getMappings, setMappings } from './mappings.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));

class HttpError extends Error {
  constructor(status, message, code = 'ERROR') { super(message); this.status = status; this.code = code; }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Body terlalu besar.', 'PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON tidak valid.', 'BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

function makeLimiter(perMinute) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 30000).unref();
  return (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset < now) { h = { count: 0, reset: now + 60000 }; hits.set(ip, h); }
    return ++h.count <= perMinute;
  };
}

export function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const queue = new ActionQueue();
  const pipeline = new Pipeline(queue);
  const bridge = new TikTokBridge();
  const hub = new Hub();
  const adminLimit = makeLimiter(cfg.RATE_LIMIT_PER_MINUTE);
  const robloxLimit = makeLimiter(1200);

  bridge.on('event', (ev) => pipeline.handle(ev));
  bridge.on('status', (s) => hub.broadcast('status', s));
  pipeline.on('feed', (ev) => hub.broadcast('feed', ev));
  queue.on('change', (it) => { hub.broadcast('action', it); });
  queue.on('cleared', () => hub.broadcast('snapshot', snapshot()));
  const statsTimer = setInterval(() => hub.broadcast('stats', fullStats()), 2000);
  statsTimer.unref();

  const fullStats = () => ({ queue: queue.stats(), counters: pipeline.counters, likes: pipeline.likes.total });
  const snapshot = () => ({
    tiktok: bridge.state, stats: fullStats(), mappings: getMappings(),
    feed: pipeline.feed.slice(-60), actions: queue.list({ limit: 60 }),
  });

  const requireAdmin = (req, url) => {
    const key = req.headers['x-admin-api-key'] || url.searchParams.get('key');
    if (!safeEqual(key, cfg.ADMIN_API_KEY)) throw new HttpError(401, 'Admin API key salah atau tidak ada.', 'UNAUTHORIZED');
  };
  const requireRoblox = (req) => {
    if (!safeEqual(req.headers['x-roblox-api-key'], cfg.ROBLOX_API_KEY)) throw new HttpError(401, 'Roblox API key salah atau tidak ada.', 'UNAUTHORIZED');
  };

  function originOf(req) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }

  // [method, path, auth('admin'|'roblox'|null), handler(req, url, body)]
  const routes = [
    ['GET', '/api/health', null, () => ({ status: 'ok', uptime: Math.round(process.uptime()), tiktok: bridge.state.status, queue: queue.stats() })],

    ['GET', '/api/status', 'admin', () => snapshot()],

    ['POST', '/api/tiktok/connect', 'admin', async (req, url, body) => {
      await bridge.connect(body.username, {
        signApiKey: body.signApiKey || undefined, sessionId: body.sessionId || undefined,
        waitForLive: body.waitForLive,
      });
      pipeline.resetSession();
      return { tiktok: bridge.state };
    }],
    ['POST', '/api/tiktok/disconnect', 'admin', async () => { await bridge.disconnect(); return { tiktok: bridge.state }; }],

    ['GET', '/api/mappings', 'admin', () => getMappings()],
    ['PUT', '/api/mappings', 'admin', (req, url, body) => {
      try { return setMappings(body); } catch (e) { throw new HttpError(400, e.message, 'INVALID_MAPPING'); }
    }],

    ['GET', '/api/actions', 'admin', (req, url) => ({
      items: queue.list({ status: url.searchParams.get('status') || undefined, limit: Math.min(200, Number(url.searchParams.get('limit')) || 50) }),
      stats: queue.stats(),
    })],
    ['DELETE', '/api/actions', 'admin', () => ({ cleared: queue.clear() })],

    // Simulator: memasukkan event palsu lewat jalur yang sama dengan event TikTok asli
    ['POST', '/api/simulate', 'admin', (req, url, body) => {
      const user = { uniqueId: String(body.user || 'penonton_test'), nickname: String(body.nickname || body.user || 'Penonton Test') };
      const t = body.type;
      let ev;
      if (t === 'chat') ev = { type: 'chat', user, comment: String(body.comment || '') };
      else if (t === 'gift') ev = { type: 'gift', user, giftName: String(body.giftName || 'Rose'), diamonds: Number(body.diamonds) || 1, repeatCount: Number(body.repeatCount) || 1 };
      else if (t === 'follow' || t === 'share') ev = { type: t, user };
      else if (t === 'like') ev = { type: 'like', user, likeCount: Number(body.likeCount) || 15, totalLikeCount: Number(body.totalLikeCount) || pipeline.likes.total + (Number(body.likeCount) || 15) };
      else throw new HttpError(400, 'type harus chat | gift | follow | share | like', 'BAD_TYPE');
      return pipeline.handle({ source: 'simulation', ...ev });
    }],

    // ---- Dipanggil oleh server game Roblox ----
    ['POST', '/api/roblox/claim', 'roblox', (req, url, body) => {
      const workerId = String(body.workerId || 'roblox').slice(0, 80);
      const items = queue.claim(workerId, Number(body.max) || 5);
      return { items };
    }],
    ['POST', '/api/roblox/ack', 'roblox', (req, url, body) => {
      const workerId = body.workerId ? String(body.workerId).slice(0, 80) : null;
      return queue.ack(Array.isArray(body.results) ? body.results.slice(0, 50) : [], workerId);
    }],

    // Skrip Luau siap tempel (URL & key sudah terisi)
    ['GET', '/api/roblox/script', 'admin', (req, url) => {
      const file = fs.readFileSync(path.join(ROOT, 'roblox', 'BridgeClient.server.lua'), 'utf8');
      const base = (url.searchParams.get('base') || originOf(req)).replace(/\/$/, '');
      return { script: file.replace('__BASE_URL__', base).replace('__ROBLOX_API_KEY__', cfg.ROBLOX_API_KEY), baseUrl: base };
    }],
  ];

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || 'x';
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

      if (url.pathname === '/api/stream' && req.method === 'GET') {
        requireAdmin(req, url);
        return hub.add(req, res, snapshot());
      }

      const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
      if (!route) throw new HttpError(404, 'Endpoint tidak ditemukan.', 'NOT_FOUND');
      const [, , auth, handler] = route;

      const limiter = auth === 'roblox' ? robloxLimit : adminLimit;
      if (!limiter(ip)) throw new HttpError(429, 'Terlalu banyak request.', 'RATE_LIMITED');
      if (auth === 'admin') requireAdmin(req, url);
      if (auth === 'roblox') requireRoblox(req);

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const data = await handler(req, url, body);
      sendJson(res, 200, { success: true, data });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[error]', e);
      if (!res.headersSent) sendJson(res, status, { success: false, error: { code: e.code || 'INTERNAL', message: status === 500 ? 'Kesalahan server.' : e.message } });
    }
  });

  return {
    server, queue, pipeline, bridge, hub, cfg,
    start() {
      queue.start();
      return new Promise((resolve) => server.listen(cfg.PORT, cfg.HOST, () => resolve(server.address())));
    },
    async stop() {
      clearInterval(statsTimer); queue.stop();
      await bridge.disconnect(true);
      for (const c of hub.clients) { try { c.end(); } catch { /* */ } }
      await new Promise((r) => server.close(r));
    },
  };
}
