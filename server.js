// Watch Together – tiny server.
// Serves the web app, and runs a WebSocket "switchboard" that pairs two people
// in a room and relays their messages (sync commands, chat, WebRTC signalling).
// The movie itself never touches this server: it goes browser-to-browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PER_ROOM = 2;
const ROOM_RE = /^[a-z0-9-]{3,48}$/;

// ---------- ICE (STUN/TURN) config handed to browsers ----------
// Three ways to add a TURN relay (for networks that block direct connections):
//   1. Cloudflare (free up to 1,000 GB/month): CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   2. Any TURN server: TURN_URL + TURN_USERNAME + TURN_CREDENTIAL
//   3. A full JSON list: ICE_SERVERS
const STUN_DEFAULT = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CF_KEY_ID = (process.env.CF_TURN_KEY_ID || '').trim();
const CF_TOKEN = (process.env.CF_TURN_API_TOKEN || '').trim();
const CF_TTL = 24 * 60 * 60; // credentials last 24h; we refresh them every 12h
let cfCache = { servers: null, expires: 0, pending: null };

async function cloudflareIce() {
  if (cfCache.servers && Date.now() < cfCache.expires) return cfCache.servers;
  if (cfCache.pending) return cfCache.pending;
  cfCache.pending = (async () => {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: CF_TTL }),
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) throw new Error(`Cloudflare TURN API returned ${res.status}`);
      const data = await res.json();
      // Browsers block port 53, so drop those URLs rather than waiting for them to time out.
      const servers = (data.iceServers || [])
        .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
        .filter((s) => s.urls.length);
      if (!servers.length) throw new Error('Cloudflare TURN API returned no servers');
      cfCache.servers = servers;
      cfCache.expires = Date.now() + (CF_TTL / 2) * 1000;
      return servers;
    } catch (e) {
      console.warn('Could not get Cloudflare TURN credentials:', e.message);
      return null;
    } finally {
      cfCache.pending = null;
    }
  })();
  return cfCache.pending;
}

async function iceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch (e) {
      console.warn('ICE_SERVERS is not valid JSON, ignoring it');
    }
  }
  if (CF_KEY_ID && CF_TOKEN) {
    const cf = await cloudflareIce();
    if (cf) return cf;
  }
  const servers = [...STUN_DEFAULT];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

function turnMode() {
  if (process.env.ICE_SERVERS) return 'custom ICE_SERVERS';
  if (CF_KEY_ID && CF_TOKEN) return 'Cloudflare TURN';
  if (process.env.TURN_URL) return 'TURN_URL';
  return 'none (direct connections only)';
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), fullscreen=(self)',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/config.json') {
    iceServers().then(
      (ice) => send(res, 200, JSON.stringify({ iceServers: ice }), MIME['.json']),
      () => send(res, 200, JSON.stringify({ iceServers: STUN_DEFAULT }), MIME['.json'])
    );
    return;
  }
  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel === '/' || rel.startsWith('/room/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

// ---------- rooms ----------
/** @type {Map<string, Map<string, {ws: import('ws'), name: string, role: string}>>} */
const rooms = new Map();

function others(room, id) {
  return [...room.entries()].filter(([pid]) => pid !== id);
}

function sendJson(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = (url.searchParams.get('room') || '').toLowerCase();
  const name = (url.searchParams.get('name') || 'Friend').slice(0, 32);

  if (!ROOM_RE.test(roomId)) {
    sendJson(ws, { type: 'error', code: 'bad-room', message: 'That room code is not valid.' });
    return ws.close(4000, 'bad room');
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.size >= MAX_PER_ROOM) {
    sendJson(ws, { type: 'error', code: 'full', message: 'This room already has two people in it.' });
    return ws.close(4001, 'room full');
  }

  const id = crypto.randomUUID();
  const role = room.size === 0 ? 'host' : 'guest';
  room.set(id, { ws, name, role });

  const peer = others(room, id)[0];
  sendJson(ws, {
    type: 'welcome',
    id,
    role,
    peer: peer ? { id: peer[0], name: peer[1].name } : null,
  });
  if (peer) sendJson(peer[1].ws, { type: 'peer-joined', peer: { id, name } });
  console.log(`[${roomId}] ${name} joined as ${role} (${room.size}/${MAX_PER_ROOM})`);

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    // Everything else is relayed to the other person in the room.
    for (const [, p] of others(room, id)) sendJson(p.ws, { ...msg, from: id });
  });

  ws.on('close', () => {
    room.delete(id);
    for (const [pid, p] of room) {
      // Whoever is left becomes the host (the clock everyone follows).
      p.role = 'host';
      sendJson(p.ws, { type: 'peer-left', id, role: 'host' });
      console.log(`[${roomId}] ${name} left; ${p.name} is now host (${pid.slice(0, 8)})`);
    }
    if (room.size === 0) rooms.delete(roomId);
  });
});

// Drop connections that silently died (closed laptops, lost Wi-Fi).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Watch Together running on http://localhost:${PORT}`);
  console.log(`Relay (TURN): ${turnMode()}`);
  if (CF_KEY_ID && CF_TOKEN) cloudflareIce().then((s) => s && console.log('Cloudflare TURN credentials OK'));
});
