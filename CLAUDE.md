# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Local Development

`fetch()` requires an HTTP server — opening `index.html` directly as a file will fail to load the quiz JSON.

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

VS Code Live Server also works.

There is no build step, bundler, linter, or test suite. Everything runs directly in the browser as native ES modules.

## Architecture

The app is two files: `index.html` (all CSS + HTML markup) and `app.js` (all JavaScript logic). There is no framework.

**Boot sequence:**
1. On page load, `initAvatarCanvas()` spins up a *separate* `WebGLRenderer` on `#avatar-canvas` (landing screen only) and renders `CesiumMan.glb` rotating in place.
2. `loadQuiz()` fetches `quiz_content_full_v2.json` in parallel and maps the raw JSON shape (`Option A/B/C/D`, `correct_answer`, `rationale`) into the internal `{ q, opts, ans, ok, bad }` shape.
3. The main Three.js renderer (`#ar-canvas`) and camera stream are **not** initialised until the user taps "Start Experience". On tap: camera starts → `initThree()` builds the scene → `startScan()` simulates a 2.3 s surface-detection delay → reticle becomes interactive.
4. On tap/click over the ground plane, `placeModel()` loads `Avocado.glb` (placeholder for `herostone.glb`) at the raycasted point, then calls `openQuiz()` after the pop-in animation.
5. The avatar renderer is disposed (`disposeAvatarCanvas()`) when the landing screen fades out.

**Two independent WebGL contexts:**
- `renderer` (main) — full-screen transparent canvas overlaid on the `<video>` camera feed; handles scene, reticle, hero model, and render loop.
- `renderer2` (avatar) — fixed 200×200 canvas on the landing screen only; disposed on Start.

**Quiz state machine:** `qIdx`, `score`, `answered` are module-level vars. `openQuiz()` / `retryQuiz()` both shuffle the full `QUIZ` pool and take a `SESSION_SIZE` (5) slice. Wrong answers allow retry on the same question; correct answers advance via `advance()`. Session ends at `showScore()`.

**Simulated AR:** There is no WebXR — surface detection is faked with a `setTimeout`. Hit-testing uses a `THREE.Raycaster` against an invisible `PlaneGeometry` ground mesh. The camera feed (`<video>`) is the background; the Three.js canvas sits on top with `alpha: true`.

**Design tokens** are CSS custom properties on `:root` in `index.html` (`--lk-primary`, `--lk-gold`, `--lk-ink`, `--lk-parchment`, `--lk-stone`, `--lk-correct`, `--lk-wrong`). Use these for any new UI elements rather than hardcoding colours.

**Reduced motion:** `window.matchMedia('(prefers-reduced-motion: reduce)')` is checked once at module load. Pass the result into animation loops — all Three.js delta-based animations and CSS transitions are gated on this flag.

## Key TODOs in the code

- Replace `'Avocado.glb'` with `'herostone.glb'` in `placeModel()` (`app.js:279`) when the real asset is ready.
- The `hint` field in `quiz_content_full_v2.json` is loaded but not used by the UI.
