# EYE MAZE — v4

A minimalist maze steered only by your eyes. A glowing cyan ball rolls in the direction you look; look at the middle of the screen and it stops. Built for the *Body & Space* interactive design assignment.

**v4 is calibration-free and hands-free:** allow the camera, look at the ring for about a second, and the first maze starts on its own. Natural head movement no longer pauses the game.

- **Input:** webcam eye movements only during play
- **Tech:** plain HTML / CSS / JavaScript (ES modules), [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (face, eye and iris landmarks + eye blendshapes)
- **Privacy:** every camera frame is processed in the browser by an on-device model. Video is never recorded, stored or uploaded. The only network request is a one-time download of the face model file from Google (see "Offline model" below).

---

## What changed in v4

| v2 | v4 |
|---|---|
| Position screen → 6-step calibration → 4-arrow control check → look at centre to start | **Start → allow camera → look at the ring (~1 s) → maze starts.** No calibration. Returning visitors who already allowed the camera don't even need the Start click. |
| Gaze worked only after calibration | **Calibration-free gaze model**: iris position relative to the eye corners and lids, blendshapes, and head-pose compensation, with population-average gains measured on real photos with the real model |
| Large "HEAD MOVED" overlay whenever the head turned ~15° | **Removed.** Head turns, nods and tilts are compensated (gaze = eye-in-face + head rotation, rotated by head roll). Play only stops when the eyes can't be read: face missing, turned far away (>38°), too far from the camera, or eyes closed. A small status pill shows that — never a blocking message. |
| Look at the centre to start each level | Each level starts by itself after a 2.6 s countdown. The neutral gaze is quietly refreshed while you watch the countdown. |
| — | **Automatic recovery:** if the ball keeps pushing into a wall for 3 s (usually means your "neutral" was captured while looking away), the game shows the ring for a second and re-centres itself. |
| Recalibrate / debug buttons in the HUD | One small **settings icon** (optional): sensitivity, up/down boost, smoothing, ball speed, swap left/right, re-centre, **optional 10-second quick calibration**, debug panel. Settings and calibration are kept for the whole session — level changes, replays and page reloads in the same tab. |
| Success → look at centre 2 s or click | Success screen → a new run starts automatically after 8 s (or "Play again now") |

Unchanged: the three levels and their mechanics (FIRST SIGHT static maze; TIDE GATES sliding gates that never close onto the ball; GAZE FIELD walls that switch after ~1.2 s of sustained sideways or up/down gaze), collision, the visuals, glow and particle trails. (There were no sound effects in earlier versions, so there are none here either.)

---

## Put it on GitHub Pages (no Terminal)

1. **Unzip** `eye-maze-v4.zip`. You get a folder with `index.html`, `css`, `js`, `vendor`, `models`, `tests`, `README.md`…
2. Go to **github.com** → **+** (top right) → **New repository**. Name it e.g. `eye-maze`, set it to **Public**, click **Create repository**.
   *(Updating an existing EYE MAZE repository instead? Open it, and continue at step 3 — uploaded files replace the old ones with the same names.)*
3. On the repository page click **Add file → Upload files** (or the link "uploading an existing file").
4. Open the unzipped folder, **select everything inside it** (not the folder itself) and **drag it into the browser window**. Folders upload with their structure. Wait until every file is listed (the largest file is ~14 MB).
5. Scroll down, write a message like "EYE MAZE v4", click **Commit changes**.
6. Go to **Settings → Pages**. Under **Build and deployment** choose **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, click **Save**.
7. Wait 1–2 minutes and refresh the Pages settings page: it shows **"Your site is live at https://YOURNAME.github.io/eye-maze/"**. Open it in Chrome, Edge, Firefox or Safari, click **Start**, allow the camera.

Notes: `index.html` must be at the top level of the repository (not inside another folder). GitHub Pages uses https, which the camera requires. The hidden `.nojekyll` file is optional — if your computer hides it during upload, nothing breaks. The `tests` folder is harmless on Pages; you may leave it out.

**Offline model (optional):** to avoid downloading the model from Google, download
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` in your browser and upload it into the `models/` folder of the repository (Add file → Upload files, inside `models`). The game uses the local copy when it exists.

**Running it on your computer:** double-clicking `index.html` does not work (browsers block the camera on `file://`). Use GitHub Pages, or any local web server (e.g. the "Live Server" extension in VS Code).
**Test mode without a camera:** add `?test` to the address (`…/eye-maze/?test`); the arrow keys simulate looking. Add `?debug` (or press **D**) for the debug panel.

---

## How to play

1. **Start** → allow the camera.
2. **Look at the ring** in the middle for about a second. It turns green: tracking is ready.
3. The level name appears with a short countdown, then the maze begins.
4. **Look** left / right / up / down to roll the ball. **Look at the middle** to stop. Reach the green portal.
5. Levels follow automatically. After level 3 a new run starts by itself.

Tips: even light on your face, camera roughly at eye level, about an arm's length away. Move your eyes clearly toward the screen edge you want. You can move your head normally — just keep looking at the screen.

**Level 3 — GAZE FIELD:** hold a sideways gaze ~1.2 s and the maze turns *sideways* (sideways gates open, vertical gates close); hold up/down and it turns *vertical*. Quick glances change nothing; the ring around the ball shows the build-up.

**If control feels off** (settings icon, top right — the game pauses while it is open):
- Ball drifts on its own → **Re-centre** (look at the ring for a second).
- Ball hard to start → raise **Sensitivity**; up/down specifically → raise **Up / down boost**.
- Jumpy → raise **Smoothing** or lower Sensitivity.
- Left and right reversed → tick **Swap left / right** (some cameras deliver a mirrored image).
- Still unreliable → **Quick calibration** (follow 5 dots, ~10 s). Optional; kept for the session; **Back to automatic** undoes it.

---

## How calibration-free tracking works

All in `js/gaze.js` (pure functions, unit-tested):

1. **Features (per frame):** iris centre relative to each eye's corners (horizontal) and to the corner line (vertical); eyelid opening; MediaPipe `eyeLook*` blendshapes. Everything is divided by eye width and measured along the eye's own axis, so it does not change when the head moves sideways, closer/further, or tilts.
2. **Head pose** from the 3D face landmarks, in the head's own frame (yaw, pitch, roll).
3. **Automatic neutral:** while the ring is shown, ~1 s of steady frames gives your personal rest position (iris, lids, head). Blinks are skipped; if your eyes never settle it falls back after a few seconds so it can't get stuck.
4. **Default gains:** how far the features move per degree of eye rotation, from real photos run through the real model (iris ≈ 0.0055 per degree; agrees with eyeball geometry) plus conservative vertical estimates. 1.0 ≈ looking at the screen edge of a ~14" laptop at ~60 cm.
5. **Head compensation:** screen gaze = eye-in-face rotation + head rotation; the result is rotated by the head's roll so "right" stays screen-right when you tilt your head. Turning your head while still looking at the same spot cancels out.
6. **Stability:** 3-frame median (kills one-frame spikes) → One-Euro smoothing → neutral dead zone (stop) → hysteresis (harder to start than to keep going) → the dominant axis must win clearly (diagonals = stop) → 150 ms dwell. The dead zone widens with large head rotations (less certain there).
7. **Neutral upkeep:** refreshed during each level countdown (only if your eyes were steady), slowly adapted while you rest near the centre (never while you hold a direction), and re-centred automatically if the ball is stuck against a wall.
8. **When unsure, stop:** blinks are bridged for 350 ms then the ball stops; no face / face turned >38° / too far / the two eyes disagree → the ball stops, a small status shows why, play resumes by itself.

The optional quick calibration replaces the default gains with your own (and detects a mirrored camera by itself); head compensation stays active.

---

## Tests

```
npm install                       # once, for the browser tests (puppeteer-core)
npm test                          # 51 unit tests (simulated gaze + maze/collision)
node tests/browser-game.mjs       # full game in headless Chrome, test mode (30 checks)
node tests/population-report.mjs  # robustness table across simulated people
# with the model file + face photos (see the file headers):
MODEL=… FACES=… node tests/browser-face.mjs
MODEL=… FACE=… OUT=… node tests/make-recording.mjs   then   MODEL=… VIDEO=… SEGMENTS=… node tests/browser-camera.mjs
```

### 1 · Automated tests with simulated gaze data — all passing
- **Unit (51):** automatic lock-on (~1 s, skips blinks, waits while eyes wander, falls back, resets on face loss) · all four directions + centre stop without calibration · dead zone · 20 s noisy centre gaze with no flicker · hysteresis · diagonals ignored · one-frame spikes filtered · natural head turning/nodding (±14°/±9°) with no movement and no "unreliable" state · head held at ±15° yaw, ±10° pitch, 20° roll: no movement, no pause · steering still works with the head turned · 35° head tilt still maps right→right · control experiment: without compensation the same head turn *would* steer · face turned 45° → safe stop, auto-resume · fast head motion → brief hold · short blink kept, long closure stops, looking down ≠ blink · face loss → stop → auto-resume · re-centring (applied when steady, rejected when not, slow drift, never absorbs a held direction) · sensitivity / vertical boost / swap left-right · quick calibration (rescues weak signals, detects mirrored cameras, refuses a flat signal) · population of 300 simulated people · plus all v2 maze tests: every level solvable in landscape and portrait, gates/gaze-walls actually required, collision never lets the ball overlap or cross a wall or tunnel, gates never close onto the ball, levels completable through the physics.
- **Population (simulated):** with differences between people similar to what the defaults assume, looking 90% toward an edge was detected for 98–100% of 300 people, with 0% wrong directions and 0% self-movement. With much larger differences (`population-report.mjs`), detection drops to ~85% and the ball moves by itself during head motion for up to 30% — the reason the settings and the optional calibration exist. Wrong-direction moves stayed at 0% in every case.
- **Browser (30 checks, headless Chrome, synthetic eyes):** one click → automatic lock-on → level 1 starts by itself (~3.6 s); no calibration screen; head turns/tilts don't move the ball or show messages; the old "HEAD MOVED" overlay is gone; left/right/down (with head turned) work; short blink shows nothing; face loss → small "looking for your face" pill, level clock holds, auto-resume; face turned away → small status; settings pause the game and sliders apply; optional quick calibration → personal model; all three levels with automatic transitions; calibration and settings kept through transitions; tracking set up once; success → automatic replay; back-to-automatic and re-centre; stuck guard fixes a wrong neutral by itself; portrait phone layout; no page errors.

### 2 · Tests with real face images / recorded inputs (real MediaPipe model, no person)
- **Still photos of two real faces:** 478 landmarks incl. irises; features and head yaw/pitch stay stable when the face is shifted, scaled or rolled 10°; mirror symmetry; head-yaw sign matches the nose; iris features follow a pixel-shifted iris; **head compensation on photos of people looking at the camera with the head turned: gaze x −1.36 → −0.21 and −0.97 → −0.37** (assumes a centred neutral, so approximate).
- **Recorded webcam input** (Chrome's fake camera playing an 88 s video built from each photo: rest, iris shifted right/left/up/down, head shifted/rolled/closer/further) through the *real camera code and the real game*: camera starts, face found, lock-on and level 1 start with no clicks or calibration; **ball perfectly still during all rest and head-movement segments (100% of frames, both faces)**; **0 wrong-direction frames**; iris shifted toward screen-right → "right" detected 100% (both faces); on the strongly tilted face (45° roll) up and down were detected 100% too. Not detected: the "left" shift on both photos (both people already have their eyes rotated that way toward the camera, so the shift is compressed in the eye corner) and up/down on the second face (the warp moves only the iris; real eyes also move the eyelids, which the vertical estimate relies on). These runs also found and fixed two real problems: a neutral captured while looking away (→ stuck-guard recovery) and head roll mixing axes (→ roll correction).
- Real head *turns* (yaw/pitch) cannot be produced from a single photo; those are covered by the simulated tests only.

### 3 · Live webcam test with a real person — **not done**
Live eye tracking with a real person in front of a real webcam **has not been verified**. Please test with several people, lighting conditions, and with/without glasses. Useful checks: does the ball stay still while you look at the middle and move your head naturally? Do all four directions work from a comfortable eye movement? If up/down is weak, try "Up / down boost" 1.3–1.6 and note what works, or use the quick calibration.

---

## Known limitations of calibration-free webcam eye tracking

- **Accuracy is limited by the webcam.** A 640×480 webcam sees an iris only ~10–15 pixels wide; this game detects four *directions*, not a point on the screen.
- **People differ.** Eye shape, eyelids, glasses, camera height and screen distance change how much the features move. The defaults are averages: for some people movement will need more eye travel (raise Sensitivity) or the quick calibration.
- **Up/down is harder than left/right.** Vertical iris movement is smaller in the image and partly hidden by the eyelids; the estimate leans on lid position. The vertical gains are the least certain numbers in the model — "Up / down boost" exists for that.
- **The neutral is captured automatically**, assuming you look at the ring when it appears. If you look elsewhere, the ball may drift; the countdown refresh, the stuck guard and "Re-centre" correct it, but the first seconds can feel off.
- **Head compensation is approximate.** It assumes average eye geometry; with large head turns (beyond ~15–20°) the dead zone widens on purpose, so more eye movement is needed.
- **Looking at the ball is looking somewhere.** When the ball is near a screen edge, glancing at it counts as looking that way — the game reacts to where you look, by design.
- Strong reflections on glasses, very low light, or a face partly out of frame make the tracker drop frames; the game then stops the ball rather than guess.
- Mirrored virtual cameras swap left/right until "Swap left / right" is ticked (or quick calibration is done).

---

## Files

```
index.html          screens, HUD, settings
css/style.css       visual design
js/main.js          app flow (auto lock-on, intro, play, transitions, settings, recovery)
js/gaze.js          features, automatic neutral, calibration-free model, estimator, optional calibration
js/calibrate.js     optional quick calibration screen
js/tracker.js       webcam + MediaPipe (and the synthetic test tracker)
js/maze.js          maze model, generation, BFS solver
js/levels.js        the three levels, sliding gates, gaze-reactive walls
js/physics.js       ball movement, collision, lane/corner assist
js/render.js        canvas drawing, glow and particles
js/synthetic.js     simulated eyes (tests / test mode only)
vendor/mediapipe/   MediaPipe Tasks Vision 1.2.2 (Apache-2.0)
models/             optional local face_landmarker.task
tests/              unit, browser, real-image and recorded-input tests
```
