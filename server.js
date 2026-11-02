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
function iceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch (e) {
      console.warn('ICE_SERVERS is not valid JSON, ignoring it');
    }
  }
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
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
    return send(res, 200, JSON.stringify({ iceServers: iceServers() }), MIME['.json']);
  }
  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  let rel = decodeURIComponent(url.pathname);
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
});
