# RetroBeat ▸ Winamp-style PWA Music Player

A mobile-first, installable **Progressive Web App** that plays music from your Google Drive (or local files) with 8 classic retro skins and 7 visualizers.

## What you get

- **8 skins**: Classic Winamp • iPod Bento • Neon Grid • OS X Aqua • Frutiger Aero • Vaporwave • Brushed Metal • Windows XP Luna
- **7 visualizers**: Spectrum bars (LED segmented) • Oscilloscope • MilkDrop plasma • Starfield • Matrix rain • Tunnel • Fire
- **Google Drive integration**: browse and stream all audio files from your Drive
- **Local file support**: drag/drop or pick files to play
- **Installable to phone home screen** (Android and iOS)
- **Lock-screen controls** via MediaSession API
- **Offline-capable** app shell

---

## Install on your phone (2 steps)

### Step 1: Host the files

The app is a static bundle (HTML/CSS/JS). Fastest options:

**Option A — GitHub Pages (free, recommended):**
1. Create a new GitHub repo, e.g. `retrobeat`
2. Upload all files in this folder
3. Repo settings → Pages → deploy from `main` branch
4. Your URL will be `https://<your-username>.github.io/retrobeat/`

**Option B — Netlify/Vercel drag-drop (free):**
1. Go to netlify.com → drop this folder onto the dashboard
2. Get an instant `https://*.netlify.app` URL

**Option C — Run locally (testing only, no Drive auth):**
```
cd retrobeat
python3 -m http.server 8000
```
Open `http://localhost:8000` on your phone (same Wi-Fi).

### Step 2: Install to home screen

- **Android (Chrome)**: Visit the URL → tap the menu (⋮) → "Install app" or "Add to Home screen". An in-app `INSTALL TO HOME SCREEN` button also appears in the settings drawer (☰ top right).
- **iPhone (Safari)**: Visit the URL → tap the Share button → "Add to Home Screen".

Once installed, it launches like a native app — fullscreen, its own icon, works offline for the UI.

---

## Set up Google Drive (5 minutes, free)

Drive access requires a free Google Cloud OAuth client ID. Only yours — nobody else needs setup.

1. Go to https://console.cloud.google.com/
2. Create a new project (or pick one).
3. Enable the **Google Drive API**: APIs & Services → Library → search "Drive" → Enable.
4. Set up **OAuth consent screen**: User Type = External, app name = RetroBeat, your email as user support, add yourself as a Test user under "Audience". Add scope `.../auth/drive.readonly`.
5. Go to **Credentials** → Create Credentials → OAuth client ID → **Web application**.
6. Under "Authorized JavaScript origins", add your hosted URL (e.g. `https://you.github.io`). For local testing, add `http://localhost:8000`.
7. Copy the Client ID (ends in `.apps.googleusercontent.com`).
8. Open RetroBeat → tap **☰** (top right) → paste the Client ID → close.
9. Tap **+ DRIVE** in the playlist panel. First time, Google asks permission; then all your audio files load in.

---

## Controls

- **Playlist panel**: tap any track to play. `+ FILE` = local picker. `+ DRIVE` = Google Drive. `✕` = clear.
- **Transport**: previous / play / pause / stop / next / shuffle / repeat.
- **Sliders**: `POS` = seek, `VOL` = volume.
- **Viz tabs**: swipe horizontally, tap to switch.
- **Skin swatches** (bottom): tap to change theme. Your choice is saved.
- **☰ (top right)**: settings drawer.

---

## Notes

- **Audio formats**: anything the browser supports (MP3, M4A, OGG, FLAC, WAV on most modern browsers).
- **Drive streaming**: files are downloaded fully to a blob for seekable playback. Large files may take a moment.
- **iOS quirk**: the WebAudio API requires a user gesture to start — the first play tap initializes the audio graph.
- **Not a native app**: this is a PWA, not an app-store `.apk`/`.ipa`. The home-screen install gives you the same launch experience without an app-store review.

---

## Files

```
index.html       — app shell
styles.css       — 8 themes + responsive layout
app.js           — audio engine, visualizers, Drive, playlist
manifest.json    — PWA metadata
sw.js            — service worker (offline shell)
icon-192.png     — home-screen icon (small)
icon-512.png     — home-screen icon (large)
icon-maskable.png — adaptive icon for Android
```

Enjoy. ◆
