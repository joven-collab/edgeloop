# What this fork changes

This project is a fork of **EdgeLoop** (AGPL-3.0, see `LICENSE`). The original app is still here, unchanged, at `/index.html`. This fork adds a local server, a heart-rate video player for The Handy driven from a Stash library, a library hub, and a few Stash plugins.

Upstream: <https://github.com/marshallmims/edgeloop>. The fork point is upstream commit `38d5671` (2026-09-22). Everything below was added after it.

---

## 1. The original app (upstream, untouched)

Built by the upstream author and contributors (Purple-Palm and others). This fork keeps all of it, as is:

- **Biofeedback edging engine**: a browser-only page that reads a Bluetooth heart-rate strap and speeds up or slows down a toy to hold you near a heart-rate ceiling. It uses a power-curve speed map, hysteresis, and Full Stop or Crawl at the peak.
- **Toy drivers**: The Handy (Wi-Fi API v2, HAMP), Intiface Central (vibrators and Bluetooth toys, smoothed linear strokes) and TCode over Web Serial (OSR2, SR6, OSSM).
- **Session guards**: signal watchdog, stall guard, dual-stimulation dampening and adaptive ceiling decay.
- **Games and voice**: Edge Training, Oracle climax/denial, voice-cue banks, a microphone noise gate.
- **Backup and import** (the connection key is opt-in), the settings schema, PWA / service worker, WebRTC remote control, the test suite and CI.

## 2. Original pieces this fork improved

| Area | What changed |
|---|---|
| Bluetooth heart rate (`src/js/hardware/ble.js`) | The first connect is retried up to 4 times. Chrome on Windows often refuses the first GATT connect right after pairing. A sensor picked earlier can reconnect without the chooser, and the reconnect schedule is configurable (the player keeps trying for about 3 minutes). |
| Service worker (`sw.js`) | Never caches or serves the player, the hub, `/api` or `/stash` routes, because those need the local server and a cached copy only showed a stale page. The cache version was bumped to clear old copies. |
| `.gitignore` | Local secrets and personal data (the Stash key, Handy key and app id, `data/`, `Synctest/`) can never be committed. |

Some safety ideas came from upstream's later branches and another fork. They were **re-implemented in the new player** rather than merged:
- stop a Handy left running by a crashed page
- pause when the browser freezes or the tab stays hidden
- a calibration peak that has to be *held*
- an edge counts only when the pulse holds at the mark

## 3. New: local server (`server/`)

A small Node server (`node server/server.js`, port 8420) that every new page runs on.

- **Stash relay.** It talks to Stash's GraphQL API and serves pictures, previews and sprites, so the Stash API key never reaches the browser.
- **Library index** (`library.js`). It reads every scripted scene and analyses each funscript into intensity levels. It builds a half-speed variant, rescales scripts that use a narrow range or are inverted, and keeps Stash markers. It is cached in `data/` and only re-read when something changed.
- **Learning store.** It records how the pulse really moved in each section, along with skips and panics, so later picks adapt.
- **Session recorder.** One row per second (heart rate, drive, mic, feel, level, beat intervals, skin contact) plus events, for diagnosing missed edges afterwards.
- **Thumbnails** (`thumbs.js`). Small WebP covers and performer photos (via `sharp`), built in the background and cached.
- **Hub feed** (`hub.js`), **sync-test** endpoint, **performer-check** endpoints (`visage-review.js`) and a static server with byte-range support.

## 4. New: heart-rate player (`player.html`, `src/js/player/`)

A full-screen video player that syncs the Handy to Stash videos and lets heart rate steer what plays.

**Modes**
- **Dynamic**: a random denial compilation. It stays 45 s to 3 min on a section (weighted by learning data) and usually cuts to a new clip at an edge.
- **Regular**: plays each chosen video from start to finish and handles edges in place.
- **PMV**: tracks play through. The player waits for the Handy before starting, and an edge turns the script off for the rest of the track as a cool-down.
- **Script only**: no video, any script, a centred console for a side monitor, and Faster / Slower pace.
- **Adventure**: choose-your-own-adventure cards built from performers, tags and Stash markers (funscript chapters are parsed into markers).

**The director** (`director.js`)
- Heart rate *caps* intensity. A drifting mood picks underneath it, so a low pulse never means maximum speed.
- At the edge it uses half speed, crawl or stop, then recovers.

**Catching edges sooner** (`early-warning.js`). The director acts on a "drive" value built from:
- the measured pulse
- an 8-second lookahead on fast climbs
- microphone loudness
- the instant beat rate
- a heart-rate-variability drop signal

**Manual and feel input**
- Manual arousal mode: number pad 1-9 replaces the strap.
- Feel ratings in heart-rate mode: a small nudge that is learned into a Climax HR suggestion.

**Session goals**. A length range (with a hidden end time) and/or a minimum number of edges unlock **Finish**. Finish drops pullbacks and favours the ending parts of videos.

**Calibration** (`calibration.js`). Marking *Finished* records the real held peak and suggests Climax HR and pullback %. A Calibrate switch runs with no pullbacks.

**Handy** (`handy-hssp.js`, `handy-hsp.js`)
- Classic mode: synced scripts over API v2 (HSSP).
- Newer mode: API v3 (HSP streaming, playback rate, instant seek), with automatic fallback to Classic.
- The device buffer is refilled in the background so pause and seek are immediate.

**Safety**
- Panic keys (Space / M also mark a missed edge).
- Esc stops everything.
- A crashed page's Handy is stopped on the next open.
- The player pauses when the browser freezes or the tab stays hidden.
- A No Handy toggle lets you test without the device.

**Playback**
- Live volume leveling (a custom automatic gain control).
- Stash sprite previews on the seek bar.
- Fullscreen.
- Click the video to play or pause.

**Settings panel** (`settings-panel.js`, `player-settings.js`). Live-applied, in tabs, with its own backup and restore (the Handy key only if ticked).

## 5. New: Loop hub (`hub.html`, `src/js/hub/`)

The home page at `http://localhost:8420/`.

- **Browse**: search, folder chips, sort and direction, performer and tag filters, 4K only, length range, hover previews.
- **Performers** page, sortable. Click a performer to filter Browse.
- **Watch** view with its own control strip that never covers the video:
  - a heatmap seek bar with previews
  - marker chips
  - sync offset
  - half speed
  - a two-handle stroke range slider for the Handy
  - Up Next (same performer plus similar scenes)
- **Calibrate**: plays the Handy sync test video and sets the shared offset.
- **Settings**: picture rebuild and a library re-read.
- A shared top bar on every page.

## 5b. New: first-run setup (`setup.html`, `src/js/setup/`, `server/setup.js`)

A guided setup that opens on first launch. It covers Stash, the library, The Handy, the optional newer mode, a heart-rate strap test and the sync test, and tests each part before moving on. It only saves to this app's own local files and browser settings. The server takes setup changes only from the app's own pages.

## 6. New: performer check (`review.html`, `tools/visage/`)

Batch scripts run face matching over scenes with no performer. Strong matches are added and unsure ones go to a checklist page, where you tick which to apply. You run them by hand, and they only send cover or sprite images to the matching service.

## 7. New: Stash plugins (`tools/stash-plugins/`)

| Plugin | What it does |
|---|---|
| EdgeLoop Link | Adds a "Loop" button to Stash's top bar that opens the hub. |
| Compact Scrubber | Hides Stash's thumbnail strip and keeps the heatmap. |
| Clean Scene Cards | Scene cards show only the thumbnail, heatmap and title. |
| Scene Up Next | A slim sidebar of similar scripted scenes. |
| Handy Newer Mode | Drives the Handy over API v3 inside Stash's own player. Kept for reference; not in use. |
| Stash Adventure | The Adventure mode inside Stash's own player. Kept for reference; replaced by the hub. |

## 8. New: launchers and tests

- `EdgeLoop.bat` starts Stash (if needed) and the server; `Stop EdgeLoop.bat` stops the server.
- New test files cover script analysis, the director, early warning, feel, learning, calibration, the Handy HSP driver, script clock, session goals, session log, audio leveler, Adventure, settings and thumbnails.

---

## Setting it up

You need [Node.js](https://nodejs.org/) 20 or newer, [Stash](https://stashapp.cc/) with your scripted videos in it, and The Handy.

1. Run `npm install` in the `server` folder (it installs `sharp`, which makes the thumbnails).
2. Start the server with `node server/server.js`. On Windows, `EdgeLoop.bat` does this too.
3. Open <http://localhost:8420/>. On first launch it opens **setup**, which checks and saves each part as you go:
   - **Stash**: its address and, if Stash has a password, an API key (saved in `.stash-key`).
   - **Library**: what was found, and analysing the scripts for heart-rate sessions.
   - **The Handy**: the connection key, tested against the device.
   - **Newer mode** (optional): explains it and takes your own Application ID from Handy's free developer account, tested and saved in `.handy-app-id`. Without one, Loop uses Classic mode.
   - **Heart rate** (optional): a quick Bluetooth strap test.
   - **Sync test** (optional): links to the Handy's own [sync video](https://playground.handyfeeling.com/assets/sync_video_2021.mp4) and [script](https://sweettecheu.s3.eu-central-1.amazonaws.com/testsync/sync_video_2021.csv), to put in a `Synctest` folder.

   Setup runs once. Hub **Settings > Run setup again** opens it later, and `setup.html#newer` (or `#stash`, `#handy`, ...) opens one step.

**Your library, your way.** The app reads your library folders from Stash (Settings > Library), and needs nothing set:
- Any layout works, including one big folder.
- The hub shows a chip for each first-level folder.
- Every scripted scene plays in the heart-rate player.
- Scenes tagged `PMV`, or in a folder with "PMV" in its name, become PMV tracks.

To change any of that, copy `loop.config.example.json` to `loop.config.json`:

| Field | Meaning |
|---|---|
| `stashUrl` | Where Stash runs (default `http://localhost:9999`). |
| `stashDir` | The folder holding `stash-win.exe`, so `EdgeLoop.bat` starts Stash too. |
| `libraryRoots` | Use these folders instead of the ones Stash reports. |
| `folders` | Folder name to `"regular"`, `"pmv"` or `"skip"`. |
| `otherFolders` | What unlisted folders do: `"regular"` (default) or `"skip"`. |
| `pmvTags` | Tags that make a scene a PMV track. |
| `faceMatchSkipFolders` | Folders the face-match tools leave alone. |

Everything personal (keys, `loop.config.json`, `data/`, `Synctest/`) is gitignored and stays on your machine.

---

**Size of the fork:** 69 files changed, about 9,600 lines added and 7 removed in the original files.
