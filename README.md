# Loop

**Your Stash library as a heart-rate-driven player for The Handy.**

Loop is a fork of [EdgeLoop](https://github.com/marshallmims/edgeloop). Huge thanks to its author and contributors for the biofeedback engine, Bluetooth heart-rate code and Handy driver it's built on.

EdgeLoop generates motion from your heart rate. Loop adds the other half: it **plays your real scripted videos from Stash** and uses your heart rate to choose *what* plays and *how hard*. Calm parts while you build, intense parts when you can take them, and a pull-back before you go over. The original EdgeLoop app is still included, unchanged, at `/index.html`.

- **What changed from the original:** [FORK-CHANGES.md](FORK-CHANGES.md)
- **The original README:** [ORIGINAL-README.md](ORIGINAL-README.md)

---

## Quick start

You need:
- [Stash](https://stashapp.cc/) with your videos and funscripts in it. Any folder layout works, including one big folder.
- The Handy on Wi-Fi, plus its connection key.
- [Node.js](https://nodejs.org/) 20 or newer.
- *Optional:* a Bluetooth heart-rate chest strap, with Chrome or Edge to connect it.

Then:

```bash
cd server
npm install
cd ..
node server/server.js
```

On Windows, `EdgeLoop.bat` starts it (and Stash, if you set `stashDir` in `loop.config.json`), and `Stop EdgeLoop.bat` stops it.

Open **http://localhost:8420/**. The first launch walks you through **setup**, which tests each part as you go:
- Stash, plus an API key if Stash has a password
- your library and the script analysis
- the Handy connection key
- optional Newer mode
- a heart-rate strap test
- the Handy sync test

You can run it again any time from Settings.

> **Newer mode** uses Handy's firmware-4 streaming API: instant starts, seeks and scene switches, with no upload wait. You need your own free Application ID from Handy's developer account, and setup explains how to get one. Without it, everything works in Classic mode.

Everything runs on your own PC. No account and no cloud, apart from Handy's own API, which every Handy app uses.

---

## Heart-rate player

Strap on, pick a mode, and the player runs the session:

- **Dynamic:** a never-ending denial compilation. It jumps between sections of different videos, picked by how intense they are against your current heart rate, and usually cuts to something new when you edge.
- **Regular:** plays whole videos start to finish and handles edges in place.
- **PMV:** whole tracks, never cut mid-song. An edge turns the script off for the rest of the track as a cool-down.
- **Script only:** no video, just the Handy. It's built for a side monitor, with a Faster / Slower pace.
- **Adventure:** choose-your-own-adventure. Every few minutes you pick the next step from cards built from performers, tags and chapter markers.

**How it reads you**
- Heart rate **caps** intensity rather than setting it. A drifting "mood" picks underneath, so a low pulse never means "maximum speed".
- **Catches edges early.** Besides your pulse it watches how fast your pulse is rising, beat-to-beat changes (heart-rate variability), and optionally your microphone, so it pulls back *before* you hit the wall.
- **No strap?** Manual mode: rate yourself 1-9 on the number pad. 0 = edge, . = panic.
- **It learns.** Sections that run hotter or colder on you than their script suggests get re-graded, and skipped videos come up less.
- **Calibrate:** run a session with no pull-backs, press *Finished*, and it suggests your Climax HR and pull-back point from your real peak.
- **Session goals:** set a length range (with a hidden end time) and/or a minimum number of edges. Once you reach them, **Finish** unlocks.

**Safety and comfort**
- Panic keys (Space / M also mark a missed edge), and Esc stops everything.
- If the page crashes, the Handy is stopped the next time you open it. The player also pauses if the browser freezes or the tab stays hidden.
- Live volume leveling, seek-bar previews, fullscreen and half speed.
- Every session is recorded second by second to your own disk, so you can see what actually happened.

## Library hub

A home page for browsing and watching your library with the Handy, no heart rate needed:
- **Browse:** search, folder chips, sorting, performer and tag filters, 4K only, length range, hover previews.
- **Performers** page.
- **Watch:** a heatmap seek bar with previews, chapter markers, Up Next, half speed, a stroke-range slider and a sync offset. The controls never cover the video.
- **Calibrate:** the Handy sync test. The offset is used everywhere.

## Stash extras (optional)

Stash plugins in `tools/stash-plugins/`. Copy a plugin's folder into Stash's `plugins` folder and reload plugins in Stash:
- **EdgeLoop Link:** a Loop button in Stash's top bar
- **Compact Scrubber:** keeps the heatmap, hides the thumbnail strip
- **Clean Scene Cards**
- **Scene Up Next:** a sidebar of similar scripted scenes

---

## Configuration

Nothing needs setting. To change how folders are used (which play in heart-rate sessions, which are PMV, which to skip), copy `loop.config.example.json` to `loop.config.json`. Every field is explained in [FORK-CHANGES.md](FORK-CHANGES.md#setting-it-up).

Your keys, settings, session logs and library data stay on your machine and are gitignored.

## Notes

- The new player and hub are **Handy only** (Wi-Fi). The original EdgeLoop page, with Intiface, TCode and other toys, is still there at `/index.html`.
- Tests: `npm test`.
- Bugs and ideas: please open an issue **on this repo**, not on the original project.

## License

AGPL-3.0, like EdgeLoop. See [LICENSE](LICENSE).
