# Watch Together

Watch a video file (MKV, MP4, WebM) with a friend, in sync, with your cameras and mics on.

- **Send the movie straight to your friend** from your browser. It goes peer-to-peer and is never uploaded to a server. They can save a copy afterwards.
- **Or both open your own copy.** If you already both have the file, no transfer is needed.
- **Play, pause and skipping are synced.** If either of you pauses, it pauses for both. A heartbeat keeps you within a few hundredths of a second, nudging playback speed slightly rather than jumping.
- **Camera and mic** in floating tiles over the movie (draggable, and they stay visible in fullscreen).
- **Chat**, **subtitles** (load an `.srt` or `.vtt`), keyboard shortcuts, and a help screen with ready-made ffmpeg commands if a file won't play.

Rooms are for two people.

## Run it locally

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, start a room, and open the invite link in a second browser window (or a private window) to try it with yourself.

## Put it online

Cameras and microphones only work on `https://` sites (or `localhost`), so it needs to be hosted somewhere with HTTPS. Any host that runs a Node.js app and supports WebSockets works, for example [Render](https://render.com), [Railway](https://railway.app) or [Fly.io](https://fly.io):

- **Build command:** `npm install`
- **Start command:** `npm start`
- The app listens on the `PORT` environment variable that these hosts provide.

A `Dockerfile` is included if your host prefers containers.

The server does very little work (it just introduces the two browsers and relays small sync messages), so the smallest free or cheapest plan is plenty.

### TURN server (recommended)

The video, camera and file transfer go directly between the two browsers. That works on most home networks, but some networks (strict routers, mobile data, office or university Wi-Fi) block direct connections. When that happens, sync and chat still work but camera and sending the file don't, and the chat will say so.

The fix is a TURN relay server. You can get one free or cheaply from services such as [Metered](https://www.metered.ca/stun-turn) or [Cloudflare Calls](https://developers.cloudflare.com/calls/turn/), or run your own with [coturn](https://github.com/coturn/coturn). Then set these environment variables on your host:

```
TURN_URL=turn:your.turn.server:3478,turns:your.turn.server:5349
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

Or provide the whole list yourself as JSON:

```
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:...","username":"...","credential":"..."}]
```

Note that anything going through TURN uses that server's bandwidth, and a full movie is several GB.

## Which files play?

MKV is a container: a box holding video and audio that can be in many different formats. Browsers only support some of them.

| | Plays in the browser? |
|---|---|
| H.264, VP9 or AV1 video | Yes (Chrome, Edge, Firefox) |
| HEVC / H.265 video | Only on some computers (hardware-dependent) |
| AAC, Opus, MP3 or FLAC audio | Yes |
| AC3, E-AC3, DTS or TrueHD audio | Usually not; the picture may play with no sound |
| Subtitles inside the MKV | Not shown; load an `.srt` file instead |

Chrome and Edge handle the most MKV files. Safari generally won't play MKV at all.

If a file won't play, the app shows a help screen with the right ffmpeg command. The usual fixes are:

```bash
# Repackage into MP4 without re-encoding (seconds, no quality loss)
ffmpeg -i "movie.mkv" -map 0:v:0 -map 0:a:0 -c copy "movie.mp4"

# Convert only the audio to AAC (fixes AC3/DTS "no sound")
ffmpeg -i "movie.mkv" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k "movie.mp4"

# Convert everything (slow, but plays anywhere)
ffmpeg -i "movie.mkv" -map 0:v:0 -map 0:a:0 -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k "movie.mp4"
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / K | Play / pause (for both of you) |
| ← / → | Back / forward 5 seconds |
| J / L | Back / forward 10 seconds |
| F | Fullscreen |
| M | Mute the movie |
| C | Show / hide cameras |

## How it works

```
 Browser A  ──── WebSocket ────  server.js  ──── WebSocket ────  Browser B
     │          (sync, chat,        (pairs the two people            │
     │           signalling)         and relays messages)            │
     └────────────────── WebRTC (peer-to-peer) ──────────────────────┘
                camera + mic, and the movie file over a data channel
```

- `server.js`: a ~150-line Node server. Serves the page, pairs up to two people per room over WebSockets, and relays their messages. It never sees the video.
- `public/app.js`: everything else.
  - **Sync.** Pressing play, pause or seek sends `{action, time}` to the other person, who jumps there (adding half the measured round-trip time if playing). The first person in the room is the "host" and sends a heartbeat every second; the guest compares its position and either adjusts playback speed by up to 10% (small drift) or jumps (bigger drift), aiming slightly ahead to account for how long its own seeks take.
  - **File transfer.** The file is read in 4 MB slices and sent over an ordered WebRTC data channel in 64 KB messages with back-pressure. The receiver writes it to the browser's private disk storage (OPFS), so multi-GB movies don't need to fit in memory, then plays it from there.
  - **Calls.** Standard WebRTC with the "perfect negotiation" pattern, so cameras can be turned on and off by either person at any time.

## Limitations

- Two people per room.
- Both people need to keep the tab open during a file transfer. Transfer speed depends on both people's internet upload/download speed (a 4 GB movie on a 50 Mbit/s upload takes about 11 minutes).
- Received files live in the browser's private storage until the next transfer or the next time the page is opened. Use **Save a copy** to keep one.
- Rooms aren't password protected: anyone with the link can join if there's a free spot. Room names are random enough that they're hard to guess.
