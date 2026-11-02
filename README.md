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

## Put it online for free (Render)

Cameras and microphones only work on `https://` sites, so it needs hosting. [Render](https://render.com)'s free plan is enough: the server only introduces the two browsers and relays tiny sync messages. No credit card needed.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/degujoe/watch-together)

1. Sign up at [render.com](https://render.com) with **Sign in with GitHub**.
2. Click the **Deploy to Render** button above. Render reads `render.yaml` from this repo (free plan, Frankfurt).
3. Click **Deploy Blueprint** (or **Apply**). The first build takes 2–3 minutes.
4. Your site is at `https://watch-together-xxxx.onrender.com`. Open it, start a room, and send the invite link.

Things to know about the free plan:

- After **15 minutes with nobody connected**, it goes to sleep. The next visit takes **about a minute** to wake it up, so open the site a minute before you want to start. While either of you has a room open, it stays awake.
- New pushes to this repo redeploy automatically.

Any other host that runs Node.js with WebSockets also works (Railway, Fly.io, a VPS). Build with `npm ci`, start with `npm start`; the app uses the `PORT` environment variable. A `Dockerfile` is included.

### Free relay for when the connection fails (Cloudflare TURN)

The video, cameras and file transfer go directly between your two browsers. That works on most home broadband, but some networks (mobile data, hotspots, university or office Wi-Fi, some routers) block direct connections. Then sync and chat still work, but cameras and file sending don't, and the chat says *"Could not make a direct connection"*.

The fix is a TURN relay, which passes the traffic through a server instead. Cloudflare's is **free up to 1,000 GB a month** (a 2-hour video call through the relay is roughly 1–2 GB, and sending a movie is 2–10 GB):

1. Make a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. In the sidebar, go to **Realtime** → **TURN Server** (it may be under *Calls*) and click **Create**. Give it any name.
3. Copy the **Turn Token ID** and **API Token** it shows you.
4. In Render, open your service → **Environment** → add these two variables, then save (it redeploys itself):

```
CF_TURN_KEY_ID=<Turn Token ID>
CF_TURN_API_TOKEN=<API Token>
```

The server then fetches short-lived relay credentials from Cloudflare automatically. Direct connections are still tried first; the relay is only used when they fail.

Other TURN options: set `TURN_URL` (comma-separated), `TURN_USERNAME` and `TURN_CREDENTIAL` for any TURN server (such as [Metered](https://www.metered.ca/stun-turn) or your own [coturn](https://github.com/coturn/coturn)), or `ICE_SERVERS` to a full JSON list.

## Watching across the world

It's built to work long-distance, such as UK ↔ Korea:

- **Sync allows for the delay.** The app measures the round trip between you (often 250–300 ms between Europe and East Asia) and adds half of it when following the other person's play or skip, so you stay within a few hundredths of a second.
- **Calls will have the normal international delay** of about a quarter of a second, like any video call that distance. Wear headphones so the movie doesn't echo through your mic.
- **Sending a movie takes a while.** Speed is usually limited by the sender's *upload* speed. On 20 Mbit/s upload a 4 GB movie takes roughly half an hour, and both tabs have to stay open the whole time. For big files it's often easier to put the file on Google Drive or similar beforehand, let both people download it, and each open your own copy. The app syncs that just the same.
- **Use a laptop or desktop with Chrome or Edge** on both ends. Phones (especially iPhones) can't play most MKV files.

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
