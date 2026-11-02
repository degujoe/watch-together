'use strict';
/*
 * Watch Together – browser app.
 *
 * Pieces:
 *   - WebSocket to the server: pairs two people, carries sync commands + chat + WebRTC signalling.
 *   - WebRTC peer connection: camera/mic, and a data channel that streams the video file directly.
 *   - Sync: every button press sends {play|pause|seek, time}. The "host" (first person in the room)
 *     also sends a heartbeat each second; the guest nudges its playback speed or seeks to stay aligned.
 */

const $ = (id) => document.getElementById(id);
const now = () => performance.now();

// ====================================================================
// Small helpers
// ====================================================================
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${u[i]}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function toast(text, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => el.classList.add('fade'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

/** Simple modal. actions: [{label, value, primary}] → resolves with the chosen value. */
function modal(html, actions, { onOpen } = {}) {
  return new Promise((resolve) => {
    $('modalBody').innerHTML = html;
    const bar = $('modalActions');
    bar.innerHTML = '';
    const close = (v) => {
      $('modal').hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn' + (a.primary ? ' btn-primary' : '');
      b.textContent = a.label;
      b.onclick = () => close(a.value);
      bar.appendChild(b);
    }
    const onKey = (e) => {
      if (e.key === 'Enter') {
        const p = actions.find((a) => a.primary);
        if (p) { e.preventDefault(); close(p.value); }
      }
    };
    document.addEventListener('keydown', onKey);
    $('modal').hidden = false;
    onOpen && onOpen();
  });
}

const ADJ = ['amber', 'velvet', 'cosy', 'midnight', 'golden', 'quiet', 'neon', 'lazy', 'silver', 'sunny', 'misty', 'crimson', 'popcorn', 'cinema', 'starry', 'mellow'];
const NOUN = ['otter', 'fox', 'reel', 'sofa', 'comet', 'panda', 'lantern', 'harbour', 'meadow', 'falcon', 'pebble', 'badger', 'orbit', 'teapot', 'willow', 'koala'];
function randomRoom() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)}-${pick(NOUN)}-${Math.floor(10 + Math.random() * 90)}`;
}

// ====================================================================
// Routing: landing page vs room
// ====================================================================
const ROOM_RE = /^[a-z0-9-]{3,48}$/;

function showLanding() {
  $('landing').hidden = false;
  $('landingName').value = store.get('wt-name', '');
  const saveName = () => store.set('wt-name', $('landingName').value.trim().slice(0, 32));
  $('createRoom').onclick = () => {
    saveName();
    location.href = `/room/${randomRoom()}`;
  };
  $('joinForm').onsubmit = (e) => {
    e.preventDefault();
    let v = $('joinCode').value.trim().toLowerCase();
    const m = v.match(/\/room\/([^/?#]+)/);
    if (m) v = m[1];
    v = v.replace(/\s+/g, '-');
    if (!ROOM_RE.test(v)) {
      $('joinCode').focus();
      $('joinCode').style.borderColor = 'var(--bad)';
      return;
    }
    saveName();
    location.href = `/room/${v}`;
  };
}

// ====================================================================
// Room state
// ====================================================================
const S = {
  roomId: '',
  name: '',
  ws: null,
  wsBackoff: 500,
  myId: null,
  role: null, // 'host' | 'guest'
  peer: null, // {id, name, file, media}
  ice: [{ urls: 'stun:stun.l.google.com:19302' }],

  // WebRTC
  pc: null,
  polite: false,
  makingOffer: false,
  ignoreOffer: false,
  sigQueue: Promise.resolve(),
  p2p: false,
  p2pWarned: false,

  // call
  localStream: null,
  micOn: false,
  camOn: false,
  camsHidden: false,
  levelStops: [],

  // player
  file: null,
  fileUrl: null,
  fileReady: false,
  fileInfo: null,
  rtt: 0.1,
  seekLatency: 0.15, // how long this computer takes to seek; learned as we go
  lastJump: 0,
  hasState: false, // true once this player has been played/synced, so its position means something
  seekStartedAt: 0,
  lastLocalAction: -1e9,
  lastRemoteApply: -1e9,
  blockedCatchup: false,
  audioChecked: false,
  peerDrift: null,

  // transfers
  outgoing: null,
  incoming: null,
  cancelledOffers: new Set(),
  saveUrl: null,
  opfsName: null,
};
const video = $('movie');

async function enterRoom(roomId) {
  S.roomId = roomId;
  $('room').hidden = false;
  $('roomCode').textContent = roomId;
  document.title = `Watch Together · ${roomId}`;
  bindRoomUI();

  S.name = store.get('wt-name', '');
  if (!S.name) {
    const v = await modal(
      `<h2>What should we call you?</h2>
       <p>Your friend will see this name.</p>
       <input id="nameInput" maxlength="32" placeholder="Your name" autocomplete="nickname" />`,
      [{ label: 'Join room', value: 'ok', primary: true }],
      { onOpen: () => $('nameInput').focus() }
    );
    S.name = ($('nameInput')?.value || '').trim().slice(0, 32) || 'Guest';
    store.set('wt-name', S.name);
    void v;
  }
  $('localAvatar').textContent = initials(S.name);

  try {
    const cfg = await (await fetch('/config.json')).json();
    if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) S.ice = cfg.iceServers;
  } catch {}

  cleanupOldReceivedFiles();
  connectWS();
  setInterval(hostTick, 1000);
  setInterval(() => sendMsg({ type: 'ping', t: now() }), 3000);
}

// ====================================================================
// WebSocket
// ====================================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(S.roomId)}&name=${encodeURIComponent(S.name)}`);
  S.ws = ws;
  setStatus('', 'Connecting…');

  ws.onopen = () => { S.wsBackoff = 500; };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMsg(msg);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    teardownPeer();
    if (e.code === 4001) {
      setStatus('bad', 'Room full');
      modal(
        `<h2>This room is full</h2><p>Watch Together rooms are for two people, and two are already here.</p>`,
        [{ label: 'Start a new room', value: 'new', primary: true }]
      ).then(() => (location.href = `/room/${randomRoom()}`));
      return;
    }
    if (e.code === 4000) {
      setStatus('bad', 'Invalid room');
      return;
    }
    setStatus('bad', 'Reconnecting…');
    setTimeout(connectWS, S.wsBackoff);
    S.wsBackoff = Math.min(S.wsBackoff * 2, 8000);
  };
}

function sendMsg(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function setStatus(kind, text) {
  const el = $('peerStatus');
  el.className = 'status-pill ' + kind;
  el.querySelector('.txt').textContent = text;
}

function handleMsg(msg) {
  // Ignore stale messages from someone who has since left.
  if (msg.from && (!S.peer || msg.from !== S.peer.id)) return;

  switch (msg.type) {
    case 'welcome':
      S.myId = msg.id;
      S.role = msg.role;
      if (msg.peer) onPeerPresent(msg.peer);
      else {
        setStatus('waiting', 'Waiting for your friend…');
        sysChat('Room ready. Send your friend the invite link.');
      }
      break;
    case 'peer-joined':
      onPeerPresent(msg.peer);
      sysChat(`${msg.peer.name} joined`);
      toast(`${msg.peer.name} joined`);
      break;
    case 'peer-left':
      if (S.peer) {
        sysChat(`${S.peer.name} left`);
        toast(`${S.peer.name} left`);
      }
      S.role = msg.role || 'host';
      teardownPeer();
      setStatus('waiting', 'Waiting for your friend…');
      break;
    case 'error':
      console.warn('server:', msg.message);
      break;

    case 'hello':
      Object.assign(S.peer, { name: msg.name || S.peer.name, file: msg.file || null, media: msg.media || null });
      updateAllUI();
      break;
    case 'file-info':
      S.peer.file = msg.file || null;
      updateFileUI();
      break;
    case 'media':
      S.peer.media = msg.media;
      updateCamDock();
      break;
    case 'signal':
      S.sigQueue = S.sigQueue.then(() => onSignal(msg)).catch((e) => console.error(e));
      break;

    case 'control':
      onRemoteControl(msg);
      break;
    case 'tick':
      onTick(msg);
      break;
    case 'state-request':
      // A player that has only just been opened (sitting at 0:00) isn't an authority;
      // answering would drag the other person back to the start.
      if (S.fileReady && S.hasState) sendMsg({ type: 'state', time: video.currentTime, playing: isPlaying() });
      break;
    case 'state':
      if (S.fileReady) {
        applyState(msg.time, msg.playing);
        S.lastRemoteApply = now();
      }
      break;
    case 'drift':
      S.peerDrift = msg.value;
      updateSyncBadge(msg.value);
      break;
    case 'ping':
      sendMsg({ type: 'pong', t: msg.t });
      break;
    case 'pong': {
      const rtt = (now() - msg.t) / 1000;
      if (rtt >= 0 && rtt < 5) {
        // Take the first few measurements at face value, then smooth.
        S.rttSamples = (S.rttSamples || 0) + 1;
        S.rtt = S.rttSamples <= 2 ? (S.rttSamples === 1 ? rtt : (S.rtt + rtt) / 2) : S.rtt * 0.7 + rtt * 0.3;
      }
      break;
    }

    case 'chat':
      addChat(S.peer.name, msg.text, '');
      if (document.hidden || document.fullscreenElement) toast(`${S.peer.name}: ${msg.text}`, 4000);
      break;

    case 'file-offer':
      onFileOffer(msg);
      break;
    case 'file-accept':
      if (S.outgoing && S.outgoing.tid === msg.tid) startSending();
      break;
    case 'file-decline':
      if (S.outgoing && S.outgoing.tid === msg.tid) {
        S.outgoing = null;
        hideTransferUI();
        toast(msg.reason === 'have' ? `${S.peer.name} already has the video` : `${S.peer.name} declined`);
        updateFileUI();
      }
      break;
    case 'file-cancel':
      S.cancelledOffers.add(msg.tid);
      if (S.outgoing && S.outgoing.tid === msg.tid) abortOutgoing(`${S.peer.name} cancelled the transfer`);
      if (S.incoming && S.incoming.tid === msg.tid) abortIncoming(`${S.peer.name} cancelled the transfer`);
      break;
    case 'file-complete':
      if (S.outgoing && S.outgoing.tid === msg.tid) finishOutgoing();
      break;
  }
}

function onPeerPresent(peer) {
  S.peer = { id: peer.id, name: peer.name, file: null, media: null };
  setStatus('ok', `With ${peer.name}`);
  S.rttSamples = 0;
  for (const ms of [0, 400, 1000]) setTimeout(() => sendMsg({ type: 'ping', t: now() }), ms);
  sendMsg({ type: 'hello', name: S.name, file: S.fileReady ? S.fileInfo : null, media: mediaState() });
  if (S.fileReady) sendMsg({ type: 'state-request' });
  createPC();
  updateAllUI();
}

function teardownPeer() {
  if (S.outgoing) abortOutgoing(null);
  if (S.incoming) abortIncoming(null);
  closePC();
  S.peer = null;
  S.peerDrift = null;
  video.playbackRate = 1;
  updateAllUI();
}

// ====================================================================
// WebRTC (perfect negotiation pattern)
// ====================================================================
function createPC() {
  closePC();
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  S.pc = pc;
  S.polite = S.role === 'guest';
  S.makingOffer = false;
  S.ignoreOffer = false;
  S.sigQueue = Promise.resolve();
  S.p2p = false;

  // Only the host starts the connection (with a data channel, so there is always
  // a transport for file transfers even without cameras). The guest just answers.
  // Later changes (cameras on/off) can come from either side.
  if (!S.polite) pc.createDataChannel('ctrl');

  if (S.localStream) for (const t of S.localStream.getTracks()) pc.addTrack(t, S.localStream);

  pc.onnegotiationneeded = async () => {
    try {
      S.makingOffer = true;
      await pc.setLocalDescription();
      sendMsg({ type: 'signal', description: pc.localDescription });
    } catch (e) {
      console.error('negotiation', e);
    } finally {
      S.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendMsg({ type: 'signal', candidate });
  };
  pc.ontrack = ({ track, streams }) => {
    const rv = $('remoteVideo');
    const stream = streams[0] || (rv.srcObject instanceof MediaStream ? rv.srcObject : new MediaStream());
    if (!streams[0]) stream.addTrack(track);
    if (rv.srcObject !== stream) rv.srcObject = stream;
    track.onunmute = () => { playRemote(); updateCamDock(); };
    track.onended = updateCamDock;
    if (track.kind === 'audio') watchLevel(stream, $('remoteTile'));
    playRemote();
    updateCamDock();
  };
  pc.ondatachannel = ({ channel }) => {
    if (channel.label.startsWith('file:')) onIncomingFileChannel(channel);
  };
  pc.onconnectionstatechange = () => {
    if (pc !== S.pc) return;
    const st = pc.connectionState;
    S.p2p = st === 'connected';
    if (st === 'failed') {
      pc.restartIce();
      if (!S.p2pWarned) {
        S.p2pWarned = true;
        sysChat('Could not make a direct connection. Sync and chat still work, but camera and sending the video need a TURN server (see README).');
      }
    }
    updateFileUI();
  };
}

async function onSignal({ description, candidate }) {
  const pc = S.pc;
  if (!pc) return;
  if (description) {
    const collision = description.type === 'offer' && (S.makingOffer || pc.signalingState !== 'stable');
    S.ignoreOffer = !S.polite && collision;
    if (S.ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      sendMsg({ type: 'signal', description: pc.localDescription });
    }
  } else if (candidate) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      if (!S.ignoreOffer) console.warn('ice candidate', e);
    }
  }
}

function closePC() {
  if (S.pc) {
    try { S.pc.close(); } catch {}
  }
  S.pc = null;
  S.p2p = false;
  const rv = $('remoteVideo');
  rv.srcObject = null;
  $('remoteTile').classList.remove('speaking');
}

// ====================================================================
// Camera & microphone
// ====================================================================
function mediaState() {
  return { inCall: !!S.localStream, cam: !!S.localStream && S.camOn, mic: !!S.localStream && S.micOn };
}
function sendMedia() {
  sendMsg({ type: 'media', media: mediaState() });
}

async function joinCall() {
  const v = { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' };
  const a = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream = null;
  let lastErr = null;
  for (const c of [{ video: v, audio: a }, { audio: a }, { video: v }]) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' && c.video && c.audio) {
        // User blocked everything; no point retrying silently.
        break;
      }
    }
  }
  if (!stream) {
    const blocked = lastErr && lastErr.name === 'NotAllowedError';
    modal(
      `<h2>Couldn't turn on camera or mic</h2>
       <p>${blocked
         ? 'Your browser blocked access. Click the camera icon in the address bar to allow it, then try again.'
         : 'No camera or microphone was found, or another app is using it.'}</p>
       ${location.protocol !== 'https:' && location.hostname !== 'localhost' ? '<p>Cameras only work on <b>https://</b> sites (or localhost).</p>' : ''}`,
      [{ label: 'OK', value: 1, primary: true }]
    );
    return;
  }
  S.localStream = stream;
  S.micOn = stream.getAudioTracks().length > 0;
  S.camOn = stream.getVideoTracks().length > 0;
  $('localVideo').srcObject = stream;
  if (S.pc) for (const t of stream.getTracks()) S.pc.addTrack(t, stream);
  if (S.micOn) watchLevel(stream, $('localTile'));
  S.camsHidden = false;
  sendMedia();
  updateCallUI();
  updateCamDock();
}

function toggleMic() {
  if (!S.localStream) return;
  const tracks = S.localStream.getAudioTracks();
  if (!tracks.length) return toast('No microphone in this call');
  S.micOn = !S.micOn;
  tracks.forEach((t) => (t.enabled = S.micOn));
  sendMedia();
  updateCallUI();
}
function toggleCam() {
  if (!S.localStream) return;
  const tracks = S.localStream.getVideoTracks();
  if (!tracks.length) return toast('No camera in this call');
  S.camOn = !S.camOn;
  tracks.forEach((t) => (t.enabled = S.camOn));
  sendMedia();
  updateCallUI();
  updateCamDock();
}
function hangUp() {
  if (!S.localStream) return;
  S.localStream.getTracks().forEach((t) => t.stop());
  if (S.pc) {
    for (const s of S.pc.getSenders()) if (s.track) S.pc.removeTrack(s);
  }
  S.localStream = null;
  S.micOn = S.camOn = false;
  $('localVideo').srcObject = null;
  $('localTile').classList.remove('speaking');
  sendMedia();
  updateCallUI();
  updateCamDock();
}

function playRemote() {
  const rv = $('remoteVideo');
  rv.volume = Number($('peerVolume').value);
  rv.play().then(
    () => ($('remoteUnblock').hidden = true),
    () => ($('remoteUnblock').hidden = false)
  );
}

/** Light up a tile's border while that person is talking. */
let audioCtx = null;
function watchLevel(stream, tile) {
  try {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    const iv = setInterval(() => {
      if (track.readyState === 'ended') {
        clearInterval(iv);
        tile.classList.remove('speaking');
        return;
      }
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      tile.classList.toggle('speaking', track.enabled && rms > 0.035);
    }, 150);
  } catch (e) {
    console.warn('level meter', e);
  }
}

// ====================================================================
// Player + sync
// ====================================================================
const isPlaying = () => !video.paused && !video.ended;
const oneWay = () => Math.min(S.rtt / 2, 1);

function loadVideo(file) {
  if (S.fileUrl) URL.revokeObjectURL(S.fileUrl);
  S.file = file;
  S.fileReady = false;
  S.hasState = false;
  S.fileInfo = null;
  sendMsg({ type: 'file-info', file: null });
  S.audioChecked = false;
  S.blockedCatchup = false;
  $('errorPanel').hidden = true;
  $('audioWarn').hidden = true;
  removeSubtitles();
  S.fileUrl = URL.createObjectURL(file);
  video.src = S.fileUrl;
  video.load();
  $('emptyState').hidden = true;
  $('receivingState').hidden = true;
  $('controls').hidden = false;
  updateFileUI();
}

function onVideoReady() {
  S.fileReady = true;
  S.fileInfo = { name: S.file.name, size: S.file.size, duration: video.duration };
  sendMsg({ type: 'file-info', file: S.fileInfo });
  if (S.peer) sendMsg({ type: 'state-request' });
  $('bigPlay').hidden = false;
  updatePlayerUI();
  updateFileUI();
}

function sendControl(action) {
  S.lastLocalAction = now();
  S.hasState = true;
  const playing = action === 'play' ? true : action === 'pause' ? false : isPlaying();
  sendMsg({ type: 'control', action, time: video.currentTime, playing });
  if (S.peer && !S.peer.file && action === 'play') toast(`${S.peer.name} hasn't opened the video yet`);
}

function doPlay() {
  if (!S.fileReady) return;
  if (video.ended) video.currentTime = 0;
  video.play().catch(() => {});
  sendControl('play');
}
function doPause() {
  if (!S.fileReady) return;
  video.pause();
  sendControl('pause');
}
function togglePlay() {
  if (S.blockedCatchup) return catchUp();
  isPlaying() ? doPause() : doPlay();
}
function seekTo(t) {
  if (!S.fileReady) return;
  video.currentTime = Math.max(0, Math.min(t, (video.duration || 0) - 0.05));
  sendControl('seek');
}
const seekBy = (d) => seekTo(video.currentTime + d);

function onRemoteControl(msg) {
  const who = S.peer ? S.peer.name : 'Your friend';
  if (!S.fileReady) {
    toast(`${who} pressed ${msg.action}. Open the video to join in.`);
    return;
  }
  applyState(msg.time, msg.playing);
  S.lastRemoteApply = now();
  const verb = { play: 'pressed play', pause: 'paused', seek: 'skipped to' }[msg.action] || msg.action;
  toast(`${who} ${verb} ${msg.action === 'play' ? '' : fmtTime(msg.time)}`.trim());
}

/** Jump to where the other person is, accounting for network delay. */
function applyState(time, playing, extra = 0) {
  if (!S.fileReady) return;
  S.hasState = true;
  let target = time + (playing ? oneWay() + extra : 0);
  if (video.duration) target = Math.min(target, video.duration - 0.05);
  video.playbackRate = 1;
  if (!playing && !video.paused) video.pause();
  // While playing, small gaps are left to the gentle speed nudge. When paused,
  // line up exactly so both screens show the same frame.
  if (Math.abs(video.currentTime - target) > (playing ? 0.25 : 0.03)) {
    video.currentTime = playing ? target + S.seekLatency : target;
  }
  if (playing && video.paused) {
    video.play().then(
      () => { S.blockedCatchup = false; },
      () => {
        // Browser blocked autoplay: ask for one click.
        S.blockedCatchup = true;
        $('bigPlay').hidden = false;
        toast('Click play to catch up');
      }
    );
  }
}

function catchUp() {
  S.blockedCatchup = false;
  video.play().catch(() => {});
  sendMsg({ type: 'state-request' });
}

/** Host → guest heartbeat. */
function hostTick() {
  if (S.role !== 'host' || !S.peer || !S.fileReady || !S.hasState) return;
  sendMsg({ type: 'tick', time: video.currentTime, playing: isPlaying() });
}

/** Guest: gently follow the host's clock. */
function onTick(msg) {
  if (S.role !== 'guest' || !S.fileReady || video.seeking || S.blockedCatchup) return;
  const t = now();
  if (t - S.lastLocalAction < 2000 || t - S.lastRemoteApply < 1200) return;

  if (msg.playing !== isPlaying()) {
    // Don't restart a finished video just because the host has a few frames left.
    if (!(video.ended && msg.playing && video.duration - msg.time < 1.5)) applyState(msg.time, msg.playing);
    return;
  }
  const expected = msg.time + (msg.playing ? oneWay() : 0);
  const drift = video.currentTime - expected; // + means we're ahead
  if (msg.playing) {
    const a = Math.abs(drift);
    if (a > 0.6) {
      // Far off: jump. Seeking takes a moment, so aim a little ahead. If the last
      // jump still left us off, learn from that and aim further next time.
      if (t - S.lastJump < 4000) S.seekLatency = Math.min(3, Math.max(0, S.seekLatency - drift));
      video.currentTime = expected + S.seekLatency;
      video.playbackRate = 1;
      S.lastJump = t;
      S.lastRemoteApply = t; // let the seek settle before judging again
    } else if (a > 0.08) {
      // Close: speed up or slow down slightly (inaudible with pitch correction)
      // to close about half the gap each second.
      video.playbackRate = Math.min(1.1, Math.max(0.9, 1 - drift * 0.5));
    } else {
      video.playbackRate = 1;
    }
  } else if (Math.abs(drift) > 0.05) {
    video.currentTime = expected;
  }
  sendMsg({ type: 'drift', value: drift });
  updateSyncBadge(drift);
}

let badgeTimer = null;
function updateSyncBadge(drift) {
  const b = $('syncBadge');
  b.hidden = false;
  const ok = Math.abs(drift) < 0.35;
  b.classList.toggle('drift', !ok);
  b.textContent = ok ? '● synced' : '● syncing…';
  b.title = `Difference from your friend: ${Math.round(Math.abs(drift) * 1000)} ms`;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => (b.hidden = true), 4000);
}

// ---------- unsupported format help ----------
function ffmpegCmds(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const out = `${base}.mp4`;
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  return {
    remux: `ffmpeg -i ${q(name)} -map 0:v:0 -map 0:a:0 -c copy ${q(out)}`,
    audio: `ffmpeg -i ${q(name)} -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k ${q(out)}`,
    full: `ffmpeg -i ${q(name)} -map 0:v:0 -map 0:a:0 -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k ${q(out)}`,
  };
}
function codeLine(cmd) {
  return `<div class="code"><code>${esc(cmd)}</code><button class="btn btn-sm" data-copy="${esc(cmd)}">Copy</button></div>`;
}
function showFormatError() {
  const name = S.file ? S.file.name : 'video.mkv';
  const c = ffmpegCmds(name);
  const el = $('errorPanel');
  el.innerHTML = `<div class="inner">
    <h2>This browser can't play “${esc(name)}”</h2>
    <p>Video files like MKV are a box holding video and audio in different formats (codecs). Browsers only understand some of them. Usually Chrome or Edge handle more than Firefox or Safari, so trying a different browser is the quickest fix.</p>
    <p>Otherwise, convert it to MP4 with <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener">ffmpeg</a> (free). Try these in order:</p>
    <ol>
      <li><b>Repackage only</b> (takes seconds, no quality loss)${codeLine(c.remux)}</li>
      <li><b>Convert just the audio</b> (if the audio is AC3/DTS/TrueHD)${codeLine(c.audio)}</li>
      <li><b>Convert everything</b> (slow, works on anything)${codeLine(c.full)}</li>
    </ol>
    <p>Then open the new .mp4 here. You can also send the converted file to your friend from this page.</p>
    <div><label class="btn btn-primary">Open a different file<input type="file" accept="video/*,.mkv,.mp4,.m4v,.webm,.mov" hidden data-open-file /></label></div>
  </div>`;
  el.hidden = false;
  $('controls').hidden = true;
  $('bigPlay').hidden = true;
  if (S.peer) sendMsg({ type: 'chat', text: `(I can't play this file format in my browser, trying to fix it)` });
}
function checkAudio() {
  if (S.audioChecked) return;
  S.audioChecked = true;
  setTimeout(() => {
    // Chrome-only counters: video frames decoded but zero audio bytes = audio codec not supported.
    if (!isPlaying() || !('webkitAudioDecodedByteCount' in video)) return;
    if (video.webkitAudioDecodedByteCount === 0 && video.webkitVideoDecodedByteCount > 0 && !video.muted && video.volume > 0) {
      const c = ffmpegCmds(S.file ? S.file.name : 'video.mkv');
      const w = $('audioWarn');
      w.innerHTML = `<div><b>No sound?</b> This file's audio format (often AC3 or DTS in MKVs) may not be supported by your browser. Converting just the audio fixes it:</div>
        ${codeLine(c.audio)}
        <div><button class="btn btn-sm" data-dismiss>Dismiss</button></div>`;
      w.hidden = false;
    }
  }, 4000);
}

// ---------- subtitles ----------
function removeSubtitles() {
  for (const t of [...video.querySelectorAll('track')]) {
    URL.revokeObjectURL(t.src);
    t.remove();
  }
  $('subsBtn').classList.remove('active');
}
async function loadSubtitles(file) {
  let text = await file.text();
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT/.test(text)) {
    text = 'WEBVTT\n\n' + text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }
  removeSubtitles();
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = file.name;
  track.srclang = 'en';
  track.src = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
  track.default = true;
  video.appendChild(track);
  setTimeout(() => {
    if (video.textTracks[0]) video.textTracks[0].mode = 'showing';
  }, 0);
  $('subsBtn').classList.add('active');
  toast(`Subtitles on: ${file.name}`);
}
function subsClick() {
  const tt = video.textTracks[0];
  if (!tt) return $('subsInput').click();
  modal(
    `<h2>Subtitles</h2><p>${esc(video.querySelector('track')?.label || '')}</p>`,
    [
      { label: 'Load another file', value: 'load' },
      { label: tt.mode === 'showing' ? 'Turn off' : 'Turn on', value: 'toggle', primary: true },
    ]
  ).then((v) => {
    if (v === 'load') $('subsInput').click();
    if (v === 'toggle') {
      tt.mode = tt.mode === 'showing' ? 'hidden' : 'showing';
      $('subsBtn').classList.toggle('active', tt.mode === 'showing');
    }
  });
}

// ====================================================================
// Sending the video file peer-to-peer
// ====================================================================
const CHUNK_MAX = 64 * 1024;
const READ_SIZE = 4 * 1024 * 1024;
const BUF_HIGH = 8 * 1024 * 1024;
const BUF_LOW = 1 * 1024 * 1024;

function offerFile() {
  if (!S.file || !S.peer) return;
  if (!S.p2p) return toast('Still connecting to your friend, try again in a moment');
  const tid = Math.random().toString(36).slice(2, 10);
  S.outgoing = { tid, file: S.file, sent: 0, started: 0, cancelled: false, dc: null };
  sendMsg({ type: 'file-offer', tid, name: S.file.name, size: S.file.size, mime: S.file.type });
  showTransferUI(`Waiting for ${S.peer.name} to accept…`, 0);
  updateFileUI();
}

function startSending() {
  const out = S.outgoing;
  if (!out || !S.pc) return;
  const pc = S.pc;
  const dc = pc.createDataChannel(`file:${out.tid}`, { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUF_LOW;
  out.dc = dc;
  const maxMsg = pc.sctp && pc.sctp.maxMessageSize > 0 ? pc.sctp.maxMessageSize : CHUNK_MAX;
  const chunk = Math.min(CHUNK_MAX, maxMsg);
  const file = out.file;

  const waitLow = () =>
    new Promise((res) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        dc.removeEventListener('close', done);
        res();
      };
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
    });

  dc.onopen = async () => {
    out.started = now();
    out.timer = setInterval(() => renderTransfer(out, file.size, Math.max(0, out.sent - dc.bufferedAmount), 'Sending'), 500);
    try {
      dc.send(JSON.stringify({ kind: 'header', name: file.name, size: file.size, mime: file.type }));
      let offset = 0;
      while (offset < file.size) {
        const buf = await file.slice(offset, offset + READ_SIZE).arrayBuffer();
        for (let p = 0; p < buf.byteLength; p += chunk) {
          if (dc.bufferedAmount > BUF_HIGH) await waitLow();
          if (out.cancelled || dc.readyState !== 'open') throw new Error('closed');
          dc.send(buf.slice(p, p + chunk));
          out.sent += Math.min(chunk, buf.byteLength - p);
        }
        offset += buf.byteLength;
      }
      dc.send(JSON.stringify({ kind: 'done' }));
      out.allSent = true;
    } catch (e) {
      if (!out.cancelled && S.outgoing === out) abortOutgoing('The transfer was interrupted');
    }
  };
  dc.onclose = () => {
    if (S.outgoing !== out || out.finished || out.cancelled) return;
    // The receiver closes the channel once it has everything; its "complete"
    // message may arrive a moment later over the other connection.
    if (out.allSent) finishOutgoing();
    else abortOutgoing('The transfer was interrupted');
  };
}

function finishOutgoing() {
  const out = S.outgoing;
  if (!out) return;
  out.finished = true;
  clearInterval(out.timer);
  S.outgoing = null;
  hideTransferUI();
  toast(`${S.peer ? S.peer.name : 'Your friend'} has the video`);
  sysChat(`Video sent: ${out.file.name}`);
  updateFileUI();
}

function abortOutgoing(reason) {
  const out = S.outgoing;
  if (!out) return;
  out.cancelled = true;
  clearInterval(out.timer);
  try { out.dc && out.dc.close(); } catch {}
  S.outgoing = null;
  hideTransferUI();
  if (reason) toast(reason);
  updateFileUI();
}

function cancelOutgoing() {
  if (!S.outgoing) return;
  sendMsg({ type: 'file-cancel', tid: S.outgoing.tid });
  abortOutgoing('Transfer cancelled');
}

// ---------- receiving ----------
async function onFileOffer(msg) {
  if (S.incoming) {
    sendMsg({ type: 'file-decline', tid: msg.tid, reason: 'busy' });
    return;
  }
  let storageNote = '';
  try {
    const est = await navigator.storage.estimate();
    const free = est.quota - est.usage;
    if (free < msg.size * 1.05) {
      storageNote = `<p class="note">Your browser says it only has about ${fmtBytes(free)} of space for this. The transfer may fail. Freeing disk space can help.</p>`;
    }
  } catch {}
  const same = S.fileInfo && S.fileInfo.size === msg.size;
  const choice = await modal(
    `<h2>${esc(S.peer.name)} wants to send you a video</h2>
     <p><b style="color:var(--text)">${esc(msg.name)}</b> · ${fmtBytes(msg.size)}</p>
     <p>It goes straight from their computer to yours. Keep this tab open until it finishes. You'll be able to save a copy afterwards.</p>
     ${same ? '<p class="note ok">You already have a file this size open.</p>' : ''}
     ${storageNote}`,
    [
      { label: 'I already have it', value: 'have' },
      { label: 'Receive', value: 'yes', primary: true },
    ]
  );
  if (!S.peer || S.cancelledOffers.has(msg.tid)) {
    if (choice === 'yes') toast('Your friend cancelled the transfer');
    return;
  }
  if (choice !== 'yes') {
    sendMsg({ type: 'file-decline', tid: msg.tid, reason: 'have' });
    if (!S.file) $('fileInput').click();
    return;
  }
  let sink;
  try {
    sink = await makeSink(msg.name, msg.size, msg.mime);
  } catch (e) {
    console.error(e);
    sendMsg({ type: 'file-decline', tid: msg.tid, reason: 'error' });
    toast("Couldn't prepare storage for the video");
    return;
  }
  S.incoming = { tid: msg.tid, name: msg.name, size: msg.size, mime: msg.mime, received: 0, sink, started: now(), dc: null };
  sendMsg({ type: 'file-accept', tid: msg.tid });
  showTransferUI('Waiting for data…', 0);
  const inc = S.incoming;
  setTimeout(() => {
    if (S.incoming === inc && !inc.dc) abortIncoming("The transfer didn't start. Try sending again.");
  }, 20000);
  if (!S.file) {
    $('emptyState').hidden = true;
    $('receivingState').hidden = false;
    $('recvName').textContent = msg.name;
  }
}

function onIncomingFileChannel(channel) {
  const inc = S.incoming;
  if (!inc || channel.label !== `file:${inc.tid}`) {
    channel.close();
    return;
  }
  channel.binaryType = 'arraybuffer';
  inc.dc = channel;
  inc.timer = setInterval(() => renderTransfer(inc, inc.size, inc.received, 'Receiving'), 500);
  channel.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.kind === 'done') finishIncoming(inc);
      return;
    }
    inc.sink.write(e.data);
    inc.received += e.data.byteLength;
  };
  channel.onclose = () => {
    if (S.incoming === inc && !inc.done) abortIncoming('The transfer was interrupted');
  };
}

async function finishIncoming(inc) {
  inc.done = true;
  clearInterval(inc.timer);
  renderTransfer(inc, inc.size, inc.received, 'Saving');
  let file;
  try {
    file = await inc.sink.close();
  } catch (e) {
    console.error(e);
    S.incoming = null;
    hideTransferUI();
    $('receivingState').hidden = true;
    if (!S.file) $('emptyState').hidden = false;
    toast('Saving the video failed (out of disk space?)');
    sendMsg({ type: 'file-cancel', tid: inc.tid });
    return;
  }
  S.incoming = null;
  hideTransferUI();
  sendMsg({ type: 'file-complete', tid: inc.tid });
  try { inc.dc.close(); } catch {}
  if (file.size !== inc.size) toast(`Warning: received ${fmtBytes(file.size)} of ${fmtBytes(inc.size)}`);
  sysChat(`Received ${file.name}`);
  loadVideo(file);
  if (S.saveUrl) URL.revokeObjectURL(S.saveUrl);
  S.saveUrl = URL.createObjectURL(file);
  const a = $('saveCopy');
  a.href = S.saveUrl;
  a.download = file.name;
  a.hidden = false;
}

function abortIncoming(reason) {
  const inc = S.incoming;
  if (!inc) return;
  inc.done = true;
  clearInterval(inc.timer);
  try { inc.dc && inc.dc.close(); } catch {}
  try { inc.sink.abort(); } catch {}
  S.incoming = null;
  hideTransferUI();
  $('receivingState').hidden = true;
  if (!S.file) $('emptyState').hidden = false;
  if (reason) toast(reason);
  updateFileUI();
}

function cancelIncoming() {
  if (!S.incoming) return;
  sendMsg({ type: 'file-cancel', tid: S.incoming.tid });
  abortIncoming('Transfer cancelled');
}

/**
 * Where incoming bytes go. Prefer the browser's private disk storage (OPFS) so
 * multi-GB movies don't need to fit in memory; fall back to in-memory blobs.
 */
async function makeSink(name, size, mime) {
  const type = mime || (name.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4');
  try {
    const root = await navigator.storage.getDirectory();
    const fname = `wt-${Date.now()}`;
    const handle = await root.getFileHandle(fname, { create: true });
    if (typeof handle.createWritable !== 'function') throw new Error('no createWritable');
    const w = await handle.createWritable();
    try { navigator.storage.persist && navigator.storage.persist(); } catch {}
    let q = Promise.resolve();
    let err = null;
    return {
      write(buf) {
        q = q.then(() => (err ? null : w.write(buf))).catch((e) => (err = err || e));
      },
      async close() {
        await q;
        if (err) throw err;
        await w.close();
        const f = await handle.getFile();
        const prev = S.opfsName;
        S.opfsName = fname;
        if (prev) root.removeEntry(prev).catch(() => {});
        return new File([f], name, { type });
      },
      abort() {
        w.abort ? w.abort().catch(() => {}) : null;
        root.removeEntry(fname).catch(() => {});
      },
    };
  } catch (e) {
    console.info('Disk storage unavailable, receiving into memory:', e.message);
  }
  // In-memory fallback: group chunks into ~32MB blobs so the browser can page them out.
  let parts = [];
  let pending = [];
  let pendingBytes = 0;
  return {
    write(buf) {
      pending.push(buf);
      pendingBytes += buf.byteLength;
      if (pendingBytes >= 32 * 1024 * 1024) {
        parts.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
    },
    async close() {
      parts.push(new Blob(pending));
      return new File(parts, name, { type });
    },
    abort() {
      parts = [];
      pending = [];
    },
  };
}

async function cleanupOldReceivedFiles() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) if (n.startsWith('wt-')) await root.removeEntry(n).catch(() => {});
  } catch {}
}

// ---------- transfer UI ----------
function showTransferUI(text, frac) {
  $('sendProgress').hidden = false;
  $('sendBar').style.width = `${(frac * 100).toFixed(1)}%`;
  $('sendStats').textContent = text;
  $('sendFileBtn').hidden = true;
}
function hideTransferUI() {
  $('sendProgress').hidden = true;
  $('receivingState').hidden = true;
}
function renderTransfer(t, total, done, verb) {
  const frac = total ? done / total : 0;
  const secs = (now() - (t.started || now())) / 1000;
  const speed = secs > 0.5 ? done / secs : 0;
  const eta = speed > 0 ? (total - done) / speed : 0;
  const text = `${verb} ${Math.floor(frac * 100)}% · ${fmtBytes(done)} of ${fmtBytes(total)}` +
    (speed ? ` · ${fmtBytes(speed)}/s · ${fmtTime(eta)} left` : '');
  showTransferUI(text, frac);
  if (!$('receivingState').hidden) {
    $('recvBar').style.width = `${(frac * 100).toFixed(1)}%`;
    $('recvStats').textContent = text;
  }
}

// ====================================================================
// UI updates
// ====================================================================
function updateAllUI() {
  updateFileUI();
  updateCallUI();
  updateCamDock();
}

function sameFile(a, b) {
  if (!a || !b) return false;
  return a.size === b.size || (isFinite(a.duration) && isFinite(b.duration) && Math.abs(a.duration - b.duration) < 2);
}

function updateFileUI() {
  const mine = S.file;
  $('myFile').textContent = mine ? `${mine.name} · ${fmtBytes(mine.size)}` : 'Nothing open';
  $('myFile').classList.toggle('has', !!mine);
  $('myFile').title = mine ? mine.name : '';
  $('changeFileBtn').hidden = !mine;

  const p = S.peer;
  $('peerWho').textContent = p ? p.name : 'Friend';
  $('remoteLabel').textContent = p ? p.name : 'Friend';
  $('remoteAvatar').textContent = initials(p ? p.name : '?');
  const pf = $('peerFile');
  pf.textContent = !p ? 'Not here yet' : p.file ? `${p.file.name} · ${fmtBytes(p.file.size)}` : 'No video open';
  pf.classList.toggle('has', !!(p && p.file));
  pf.title = p && p.file ? p.file.name : '';

  const note = $('matchNote');
  if (p && p.file && S.fileInfo) {
    const same = sameFile(S.fileInfo, p.file);
    note.hidden = false;
    note.className = 'note' + (same ? ' ok' : '');
    note.textContent = same
      ? 'You both have the same video. Playback is synced.'
      : `These look like different files (lengths ${fmtTime(S.fileInfo.duration)} vs ${fmtTime(p.file.duration)}). Sync will still follow the same timestamps.`;
  } else if (p && !p.file && S.fileReady) {
    note.hidden = false;
    note.className = 'note';
    note.textContent = `${p.name} doesn't have the video yet. Send it, or they can open their own copy.`;
  } else {
    note.hidden = true;
  }

  const btn = $('sendFileBtn');
  const canSend = !!(S.fileReady && p && !sameFile(S.fileInfo, p.file) && !S.outgoing && !S.incoming);
  btn.hidden = !canSend;
  btn.disabled = !S.p2p;
  btn.textContent = S.p2p ? `Send video to ${p ? p.name : 'friend'} (${fmtBytes(S.file ? S.file.size : 0)})` : 'Connecting to your friend…';
}

function updateCallUI() {
  const inCall = !!S.localStream;
  $('callIdle').hidden = inCall;
  $('callActive').hidden = !inCall;
  const mic = $('micBtn');
  mic.textContent = S.micOn ? 'Mic on' : 'Mic off';
  mic.classList.toggle('off', !S.micOn);
  mic.classList.toggle('on', S.micOn);
  const cam = $('camBtn');
  cam.textContent = S.camOn ? 'Camera on' : 'Camera off';
  cam.classList.toggle('off', !S.camOn);
  cam.classList.toggle('on', S.camOn);
}

function updateCamDock() {
  const pm = S.peer && S.peer.media;
  const rv = $('remoteVideo');
  const remoteStream = rv.srcObject;
  const remoteInCall = !!(pm && pm.inCall && remoteStream);
  const localInCall = !!S.localStream;

  $('remoteTile').hidden = !remoteInCall;
  $('localTile').hidden = !localInCall;
  const hasRemoteVideo = remoteStream && remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
  $('remoteTile').classList.toggle('no-video', !(pm && pm.cam && hasRemoteVideo));
  $('remoteMuted').hidden = !(pm && pm.inCall && !pm.mic);
  $('localTile').classList.toggle('no-video', !S.camOn);

  const any = remoteInCall || localInCall;
  $('camDock').hidden = !any || S.camsHidden;
  $('camsBtn').classList.toggle('active', any && !S.camsHidden);
}

function updatePlayerUI() {
  const d = video.duration || 0;
  const t = seeking.active ? seeking.value : video.currentTime;
  $('timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  $('seekFill').style.width = d ? `${(t / d) * 100}%` : '0';
  if (!seeking.active) $('seek').value = d ? Math.round((video.currentTime / d) * 1000) : 0;
  let buf = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime) buf = Math.max(buf, video.buffered.end(i));
  }
  $('seekBuffered').style.width = d ? `${(buf / d) * 100}%` : '0';
}

// ---------- chat ----------
function addChat(name, text, cls) {
  const log = $('chatLog');
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.innerHTML = `<b>${esc(name)}</b>${esc(text)}`;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(el);
  if (atBottom || cls === 'me') log.scrollTop = log.scrollHeight;
}
function sysChat(text) {
  const log = $('chatLog');
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

// ====================================================================
// Event bindings
// ====================================================================
const seeking = { active: false, value: 0 };
let idleTimer = null;

function bindRoomUI() {
  // invite link
  $('copyLink').onclick = async () => {
    const link = `${location.origin}/room/${S.roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied. Send it to your friend!');
    } catch {
      prompt('Copy this link and send it to your friend:', link);
    }
  };

  // opening files
  const onPick = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) openLocalFile(f);
  };
  $('fileInput').onchange = onPick;
  $('fileInput2').onchange = onPick;
  $('subsInput').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) loadSubtitles(f);
  };
  document.addEventListener('change', (e) => {
    if (e.target.matches && e.target.matches('[data-open-file]')) onPick(e);
  });
  document.addEventListener('click', (e) => {
    const c = e.target.closest && e.target.closest('[data-copy]');
    if (c) {
      navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied'), () => {});
    }
    if (e.target.closest && e.target.closest('[data-dismiss]')) $('audioWarn').hidden = true;
  });

  // drag & drop
  const stage = $('stage');
  let dragDepth = 0;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').hidden = false; });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (/\.(srt|vtt)$/i.test(f.name)) loadSubtitles(f);
    else openLocalFile(f);
  });

  // video element → UI
  video.addEventListener('loadedmetadata', onVideoReady);
  video.addEventListener('timeupdate', updatePlayerUI);
  video.addEventListener('seeking', () => (S.seekStartedAt = now()));
  video.addEventListener('seeked', () => {
    const d = (now() - S.seekStartedAt) / 1000;
    if (S.seekStartedAt && d > 0 && d < 3 && isPlaying()) S.seekLatency = S.seekLatency * 0.6 + d * 0.4;
    S.seekStartedAt = 0;
  });
  video.addEventListener('progress', updatePlayerUI);
  video.addEventListener('durationchange', updatePlayerUI);
  video.addEventListener('play', () => { $('room').classList.add('playing'); $('bigPlay').hidden = true; });
  video.addEventListener('playing', checkAudio);
  video.addEventListener('pause', () => { $('room').classList.remove('playing'); showControls(); });
  video.addEventListener('ended', () => { $('room').classList.remove('playing'); video.playbackRate = 1; showControls(); });
  video.addEventListener('volumechange', () => {
    $('room').classList.toggle('is-muted', video.muted || video.volume === 0);
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    const code = video.error && video.error.code;
    if (code === 3 || code === 4) showFormatError();
  });
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFullscreen);

  // controls
  $('playBtn').onclick = togglePlay;
  $('bigPlay').onclick = togglePlay;
  $('backBtn').onclick = () => seekBy(-10);
  $('fwdBtn').onclick = () => seekBy(10);
  $('fsBtn').onclick = toggleFullscreen;
  $('subsBtn').onclick = subsClick;
  $('camsBtn').onclick = () => { S.camsHidden = !S.camsHidden; updateCamDock(); };
  $('muteBtn').onclick = () => { video.muted = !video.muted; store.set('wt-muted', video.muted ? '1' : '0'); };
  const vol = $('volume');
  vol.value = store.get('wt-vol', '1');
  video.volume = Number(vol.value);
  video.muted = store.get('wt-muted', '0') === '1';
  vol.oninput = () => {
    video.volume = Number(vol.value);
    video.muted = video.volume === 0;
    store.set('wt-vol', vol.value);
  };

  const seek = $('seek');
  const tip = $('seekTip');
  seek.addEventListener('input', () => {
    seeking.active = true;
    seeking.value = (seek.value / 1000) * (video.duration || 0);
    updatePlayerUI();
  });
  seek.addEventListener('change', () => {
    seeking.active = false;
    seekTo((seek.value / 1000) * (video.duration || 0));
  });
  seek.addEventListener('pointermove', (e) => {
    const r = seek.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    tip.hidden = !video.duration;
    tip.style.left = `${f * 100}%`;
    tip.textContent = fmtTime(f * (video.duration || 0));
  });
  seek.addEventListener('pointerleave', () => (tip.hidden = true));

  // auto-hide controls while playing
  stage.addEventListener('pointermove', showControls);
  stage.addEventListener('pointerdown', showControls);

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || !$('modal').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); seekBy(k === 'j' ? -10 : -5); }
    else if (k === 'arrowright' || k === 'l') { e.preventDefault(); seekBy(k === 'l' ? 10 : 5); }
    else if (k === 'f') toggleFullscreen();
    else if (k === 'm') $('muteBtn').click();
    else if (k === 'c') $('camsBtn').click();
    else return;
    showControls();
  });

  // panel
  $('sendFileBtn').onclick = offerFile;
  $('sendCancel').onclick = () => (S.outgoing ? cancelOutgoing() : cancelIncoming());
  $('recvCancel').onclick = cancelIncoming;
  $('joinCall').onclick = joinCall;
  $('micBtn').onclick = toggleMic;
  $('camBtn').onclick = toggleCam;
  $('hangupBtn').onclick = hangUp;
  $('remoteUnblock').onclick = playRemote;
  $('peerVolume').value = store.get('wt-peervol', '1');
  $('peerVolume').oninput = () => {
    $('remoteVideo').volume = Number($('peerVolume').value);
    store.set('wt-peervol', $('peerVolume').value);
  };
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    addChat('You', text, 'me');
    if (S.peer) sendMsg({ type: 'chat', text });
    else sysChat('(Nobody else is here yet)');
  };

  makeDockDraggable();

  window.addEventListener('beforeunload', (e) => {
    if (S.outgoing || S.incoming) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function openLocalFile(f) {
  if (!/^video\//.test(f.type) && !/\.(mkv|mp4|m4v|webm|mov|ogv|avi)$/i.test(f.name)) {
    toast("That doesn't look like a video file");
    return;
  }
  if (S.outgoing) {
    const v = await modal('<h2>Stop sending?</h2><p>You\'re still sending the current video to your friend.</p>',
      [{ label: 'Keep sending', value: 'no' }, { label: 'Stop and open new file', value: 'yes', primary: true }]);
    if (v !== 'yes') return;
    cancelOutgoing();
  }
  $('saveCopy').hidden = true;
  loadVideo(f);
}

function showControls() {
  const stage = $('stage');
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (isPlaying() && !seeking.active) stage.classList.add('idle');
  }, 2500);
}

function toggleFullscreen() {
  const stage = $('stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen().catch(() => {});
  } else if (stage.webkitRequestFullscreen) {
    stage.webkitRequestFullscreen();
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen(); // iPhone: native player (sync still works, cams hidden)
  }
}

function makeDockDraggable() {
  const dock = $('camDock');
  const handle = dock.querySelector('.cam-handle');
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    const stage = $('stage').getBoundingClientRect();
    const r = dock.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left - stage.left, top: r.top - stage.top, stage };
    handle.setPointerCapture(e.pointerId);
    dock.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = dock.getBoundingClientRect();
    const left = Math.max(4, Math.min(start.stage.width - r.width - 4, start.left + e.clientX - start.x));
    const top = Math.max(4, Math.min(start.stage.height - r.height - 4, start.top + e.clientY - start.y));
    dock.style.left = `${left}px`;
    dock.style.top = `${top}px`;
    dock.style.right = 'auto';
  });
  const end = () => { start = null; dock.classList.remove('dragging'); };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ====================================================================
// Start
// ====================================================================
const roomMatch = location.pathname.match(/^\/room\/([^/]+)\/?$/);
if (roomMatch && ROOM_RE.test(roomMatch[1].toLowerCase())) {
  enterRoom(roomMatch[1].toLowerCase());
} else {
  showLanding();
}
