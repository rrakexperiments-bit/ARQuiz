/**
 * Lokakavya Heritage AR Experience — app.js
 * Three.js markerless surface AR + quiz loaded from quiz_content_full_v2.json
 *
 * NOTE: fetch() requires an HTTP server. For local dev use:
 *   python3 -m http.server 8080
 *   or VS Code Live Server extension
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ═══════════════════════════════════════════════════════════════
   REDUCED MOTION — gates all Three.js animation deltas
═══════════════════════════════════════════════════════════════ */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ═══════════════════════════════════════════════════════════════
   QUIZ DATA — loaded from quiz_content_full_v2.json
   Maps JSON fields → internal { q, opts, ans, ok, bad } shape.
   ans: index into opts[] matching correct_answer string.
═══════════════════════════════════════════════════════════════ */
let QUIZ = [];          // full pool loaded from JSON
let sessionQuiz = [];  // 5-question random subset for the current session

const SESSION_SIZE = 5;

/* Fisher-Yates shuffle — returns a new shuffled copy */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadQuiz() {
  const res  = await fetch('./quiz_content_full_v2.json');
  const data = await res.json();

  QUIZ = data.questions.map(raw => {
    const opts = [raw['Option A'], raw['Option B'], raw['Option C'], raw['Option D']];
    const ans  = opts.indexOf(raw.correct_answer);
    return {
      q:   raw.question,
      opts,
      ans,
      ok:  `Correct! ${raw.rationale}`,
      bad: raw.rationale,
    };
  });

  // Score ring always shows out of SESSION_SIZE (5), not the full pool
  document.querySelector('.score-of').textContent = `out of ${SESSION_SIZE}`;
}

/* ═══════════════════════════════════════════════════════════════
   AVATAR CANVAS
   cesiumman.glb rendered in its own WebGLRenderer (#avatar-canvas).
   Completely separate from the main AR renderer.
   Disposed when the landing screen is dismissed.
═══════════════════════════════════════════════════════════════ */
let renderer2   = null;
let avatarRafId = null;

function initAvatarCanvas() {
  const avatarCanvas = document.getElementById('avatar-canvas');
  renderer2 = new THREE.WebGLRenderer({ canvas: avatarCanvas, alpha: true, antialias: true });
  renderer2.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer2.setSize(200, 200);
  renderer2.setClearColor(0x000000, 0);

  const sc  = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  cam.position.set(0, 1, 3.5);
  cam.lookAt(0, 0.8, 0);

  sc.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun2 = new THREE.DirectionalLight(0xfff6e0, 1.2);
  sun2.position.set(2, 4, 3);
  sc.add(sun2);

  const loader2 = new GLTFLoader();
  loader2.load(
    'CesiumMan.glb',
    gltf => {
      const m   = gltf.scene;
      const box = new THREE.Box3().setFromObject(m);
      const sz  = box.getSize(new THREE.Vector3());
      const s   = 1.6 / Math.max(sz.x, sz.y, sz.z);
      m.scale.setScalar(s);
      const b2 = new THREE.Box3().setFromObject(m);
      m.position.y = -b2.min.y;
      sc.add(m);

      (function avatarLoop() {
        avatarRafId = requestAnimationFrame(avatarLoop);
        if (!reducedMotion) m.rotation.y += 0.008;
        renderer2.render(sc, cam);
      })();
    },
    undefined,
    () => {
      // CesiumMan.glb missing — render empty canvas silently
      (function avatarLoop() {
        avatarRafId = requestAnimationFrame(avatarLoop);
        renderer2.render(sc, cam);
      })();
    }
  );
}

function disposeAvatarCanvas() {
  if (avatarRafId !== null) { cancelAnimationFrame(avatarRafId); avatarRafId = null; }
  if (renderer2)            { renderer2.dispose(); renderer2 = null; }
}

/* ═══════════════════════════════════════════════════════════════
   THREE.JS — main AR renderer, scene, camera, reticle, model
═══════════════════════════════════════════════════════════════ */
let renderer, scene, camera;
let ground, reticleGroup, heroModel;
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

function initThree() {
  const canvas = document.getElementById('ar-canvas');

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);               // fully transparent — shows camera feed beneath
  renderer.outputEncoding  = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type  = THREE.PCFSoftShadowMap;

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 80);
  camera.position.set(0, 1.1, 2.2);
  camera.lookAt(0, 0, 0);

  /* ─ invisible ground plane for hit-testing ─ */
  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  /* ─ reticle: ring + fill + crosshair lines ─ */
  reticleGroup = new THREE.Group();
  reticleGroup.rotation.x = -Math.PI / 2;
  reticleGroup.position.y = 0.002;
  reticleGroup.visible    = false;
  scene.add(reticleGroup);

  const accent  = 0xB5451B;   // --lk-primary
  const accentG = 0xF0C078;   // --lk-gold
  const ringMat = new THREE.MeshBasicMaterial({ color: accent,  transparent: true, opacity: .9,  side: THREE.DoubleSide });
  const fillMat = new THREE.MeshBasicMaterial({ color: accentG, transparent: true, opacity: .12, side: THREE.DoubleSide });
  const lineMat = new THREE.LineBasicMaterial({ color: accentG, transparent: true, opacity: .55 });

  reticleGroup.add(new THREE.Mesh(new THREE.RingGeometry(0.13, 0.19, 48), ringMat));
  reticleGroup.add(new THREE.Mesh(new THREE.CircleGeometry(0.13, 48),     fillMat));

  const mkLine = (x1, z1, x2, z2) => {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x2, 0, z2)
    ]);
    return new THREE.Line(g, lineMat);
  };
  reticleGroup.add(mkLine(-0.3, 0, 0.3, 0));
  reticleGroup.add(mkLine(0, -0.3, 0, 0.3));

  /* ─ lights ─ */
  scene.add(new THREE.AmbientLight(0xffffff, 0.82));

  const sun = new THREE.DirectionalLight(0xfff6e0, 1.4);
  sun.position.set(3, 5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  const fillLight = new THREE.DirectionalLight(0xaaccff, 0.45);
  fillLight.position.set(-2, 2, -3);
  scene.add(fillLight);

  /* ─ shadow receiver (invisible plane at y=0) ─ */
  const shadowReceiver = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  shadowReceiver.rotation.x = -Math.PI / 2;
  shadowReceiver.position.y = 0.001;
  shadowReceiver.receiveShadow = true;
  scene.add(shadowReceiver);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ─ render loop ─ */
  (function loop() {
    requestAnimationFrame(loop);
    const t = reducedMotion ? 0 : performance.now() * 0.001;

    // pulse reticle ring opacity
    if (reticleGroup.visible) {
      reticleGroup.children[0].material.opacity = reducedMotion ? 0.9  : 0.52 + Math.sin(t * 2.8) * 0.38;
      reticleGroup.children[1].material.opacity = reducedMotion ? 0.12 : 0.07 + Math.sin(t * 2.8) * 0.05;
    }

    // gentle float + slow spin on placed model
    if (heroModel && !reducedMotion) {
      heroModel.rotation.y = t * 0.4;
      heroModel.position.y = heroModel.userData.baseY + Math.sin(t * 1.1) * 0.018;
    }

    renderer.render(scene, camera);
  })();
}

/* ═══════════════════════════════════════════════════════════════
   RAYCAST — pointer coords → world point on ground plane
   (unchanged from original architecture)
═══════════════════════════════════════════════════════════════ */
function groundHit(clientX, clientY) {
  pointer.x =  (clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(ground);
  return hits.length ? hits[0].point : null;
}

/* ═══════════════════════════════════════════════════════════════
   AR STATE — hit stage pointer events
═══════════════════════════════════════════════════════════════ */
let surfaceReady = false;
let modelPlaced  = false;

const stage = document.getElementById('ar-stage');

stage.addEventListener('mousemove', e => {
  if (!surfaceReady || modelPlaced) return;
  const p = groundHit(e.clientX, e.clientY);
  if (p) reticleGroup.position.set(p.x, 0.002, p.z);
});

stage.addEventListener('touchmove', e => {
  if (!surfaceReady || modelPlaced) return;
  const t = e.touches[0];
  const p = groundHit(t.clientX, t.clientY);
  if (p) reticleGroup.position.set(p.x, 0.002, p.z);
}, { passive: true });

stage.addEventListener('click', e => {
  if (!surfaceReady || modelPlaced) return;
  const p = groundHit(e.clientX, e.clientY);
  if (p) placeModel(p);
});

stage.addEventListener('touchend', e => {
  if (!surfaceReady || modelPlaced) return;
  e.preventDefault();
  const t = e.changedTouches[0];
  const p = groundHit(t.clientX, t.clientY);
  if (p) placeModel(p);
}, { passive: false });

/* ═══════════════════════════════════════════════════════════════
   PLACE MODEL
═══════════════════════════════════════════════════════════════ */
function placeModel(point) {
  const loader = new GLTFLoader();
  // TODO: replace 'Avocado.glb' with 'herostone.glb' when asset is ready
  loader.load(
    'Avocado.glb',
    gltf => {
      heroModel = gltf.scene;
      heroModel.traverse(n => {
        if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
      });

      // normalise: fit tallest axis to ~0.48 world units
      const box  = new THREE.Box3().setFromObject(heroModel);
      const size = box.getSize(new THREE.Vector3());
      const s    = 0.48 / Math.max(size.x, size.y, size.z);
      heroModel.scale.setScalar(s);

      // sit flush on ground
      const b2    = new THREE.Box3().setFromObject(heroModel);
      const baseY = -b2.min.y;
      heroModel.position.set(point.x, baseY, point.z);
      heroModel.userData.baseY = baseY;
      scene.add(heroModel);

      // pop-in ease-out cubic
      heroModel.scale.setScalar(0);
      let frame = 0;
      (function grow() {
        frame++;
        const prog  = Math.min(frame / 24, 1);
        const eased = 1 - Math.pow(1 - prog, 3);
        heroModel.scale.setScalar(s * eased);
        if (prog < 1) requestAnimationFrame(grow);
      })();

      modelPlaced = true;
      reticleGroup.visible = false;
      stage.style.pointerEvents = 'none';
      document.getElementById('hud').style.opacity = '0';
      document.getElementById('ar-loader').style.display = 'none';

      setTimeout(openQuiz, 950);   // let pop-in finish before quiz slides up
    },
    undefined,
    err => {
      console.error('GLB load error:', err);
      document.getElementById('status-pill').textContent = 'Failed to load model — check console';
    }
  );
}

/* ═══════════════════════════════════════════════════════════════
   SIMULATE SURFACE DETECTION (2.3 s scan → ready)
═══════════════════════════════════════════════════════════════ */
function startScan() {
  setTimeout(() => {
    surfaceReady = true;
    document.getElementById('scan-ring').style.display  = 'none';
    document.getElementById('status-pill').textContent  = 'Surface found — tap to place';
    document.getElementById('ar-loader').style.display  = 'none';
    reticleGroup.visible = true;
    stage.style.pointerEvents = 'auto';
  }, 2300);
}

/* ═══════════════════════════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════════════════════════ */
async function startCamera() {
  const video = document.getElementById('video');
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: 1280, height: 720 },
      audio: false
    });
  } catch {
    // fall back to any available camera (e.g. laptop webcam)
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

/* ═══════════════════════════════════════════════════════════════
   QUIZ LOGIC
═══════════════════════════════════════════════════════════════ */
let qIdx = 0, score = 0, answered = false;

function openQuiz() {
  qIdx = 0; score = 0; answered = false;
  sessionQuiz = shuffle(QUIZ).slice(0, SESSION_SIZE);   // fresh random set each session
  document.getElementById('score-overlay').className = '';
  renderQuestion();
  document.getElementById('quiz-q').classList.add('show');
  document.getElementById('quiz-opts-wrap').classList.add('show');
}

function renderQuestion() {
  answered = false;
  const d    = sessionQuiz[qIdx];
  const ltrs = ['A', 'B', 'C', 'D'];
  const cls  = ['a', 'b', 'c', 'd'];

  document.getElementById('q-num').textContent   = `Q ${qIdx + 1} / ${sessionQuiz.length}`;
  document.getElementById('q-score').textContent = `${score} / ${sessionQuiz.length}`;
  document.getElementById('q-text').textContent  = d.q;

  const el = document.getElementById('opts');
  el.innerHTML = '';
  d.opts.forEach((text, i) => {
    const btn = document.createElement('button');
    btn.className = `opt ${cls[i]}`;
    btn.innerHTML = `<span class="opt-ltr">${ltrs[i]}</span>${text}`;
    btn.addEventListener('click', () => pickAnswer(i));
    el.appendChild(btn);
  });
}

function pickAnswer(i) {
  if (answered) return;
  answered = true;

  const d    = sessionQuiz[qIdx];
  const btns = document.querySelectorAll('.opt');

  btns.forEach(b => b.classList.add('locked'));

  if (i === d.ans) {
    btns[i].classList.add('correct');
    btns.forEach((b, j) => { if (j !== i) b.classList.add('dim'); });
    score++;
    document.getElementById('q-score').textContent = `${score} / ${sessionQuiz.length}`;
    showFeedbackPopup(true, d.ok);
  } else {
    btns[i].classList.add('wrong');
    btns[d.ans].classList.add('correct');
    btns.forEach((b, j) => { if (j !== i && j !== d.ans) b.classList.add('dim'); });
    document.getElementById('q-score').textContent = `${score} / ${sessionQuiz.length}`;
    showFeedbackPopup(false, d.bad);
  }
}

/* ─ Centred animated feedback popup ─ */
function showFeedbackPopup(isCorrect, msg) {
  const popup  = document.getElementById('feedback-popup');
  const fpText = document.getElementById('fp-text');
  const fpBtn  = document.getElementById('fp-btn');

  fpText.textContent = msg;
  fpBtn.textContent  = isCorrect ? 'Next \u2192' : 'Try Again';
  popup.className    = isCorrect ? 'fp-correct show' : 'fp-wrong show';

  fpBtn.onclick = () => {
    popup.classList.remove('show');
    if (isCorrect) {
      advance();
    } else {
      // Re-enable same question for retry
      answered = false;
      document.querySelectorAll('.opt').forEach(b => {
        b.classList.remove('locked', 'correct', 'wrong', 'dim');
      });
    }
  };
}

function advance() {
  qIdx++;
  if (qIdx >= sessionQuiz.length) {
    showScore();
  } else {
    renderQuestion();
  }
}

/* ─ Score message derived from percentage rather than fixed array ─ */
function getScoreMessage(s, total) {
  const pct = s / total;
  if (s === total)  return { title: 'Heritage Champion!',  sub: `You answered all ${total} questions correctly. Amazing work!` };
  if (pct >= 0.8)   return { title: 'Almost perfect!',     sub: `${s} out of ${total} — brilliant! One more try to ace it.` };
  if (pct >= 0.6)   return { title: 'Well done!',          sub: `${s} out of ${total} — you are getting there!` };
  if (pct >= 0.4)   return { title: 'Good effort!',        sub: `${s} out of ${total}. Keep going — you are learning!` };
  if (s === 1)      return { title: 'Good start!',         sub: 'You got 1 right. Try again to learn more about inscription stones!' };
  return                   { title: 'Keep trying!',        sub: 'Every question you get wrong is something new you learned!' };
}

function showScore() {
  document.getElementById('quiz-q').classList.remove('show');
  document.getElementById('quiz-opts-wrap').classList.remove('show');

  const { title, sub } = getScoreMessage(score, sessionQuiz.length);
  document.getElementById('score-big').textContent   = score;
  document.getElementById('score-title').textContent = title;
  document.getElementById('score-sub').textContent   = sub;

  // SVG ring: r=40, circumference = 2π×40 ≈ 251.3
  const circ = 2 * Math.PI * 40;
  const arc  = document.getElementById('score-arc');
  arc.style.strokeDasharray  = `${circ}`;
  arc.style.strokeDashoffset = `${circ}`;

  document.getElementById('score-overlay').classList.add('show');

  // double-RAF so the CSS transition fires after element becomes visible
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.strokeDashoffset = `${circ * (1 - score / sessionQuiz.length)}`;
  }));
}

function retryQuiz() {
  qIdx = 0; score = 0; answered = false;
  sessionQuiz = shuffle(QUIZ).slice(0, SESSION_SIZE);   // new random set on retry
  document.getElementById('score-overlay').className = '';
  document.getElementById('feedback-popup').classList.remove('show');
  renderQuestion();
  document.getElementById('quiz-q').classList.add('show');
  document.getElementById('quiz-opts-wrap').classList.add('show');
}

document.getElementById('retry-btn').addEventListener('click', retryQuiz);

/* ═══════════════════════════════════════════════════════════════
   LANDING → START BUTTON
   Camera and Three.js are NOT initialised until the user taps Start.
═══════════════════════════════════════════════════════════════ */
document.getElementById('start-btn').addEventListener('click', async () => {
  const landing = document.getElementById('landing');
  landing.classList.add('fade-out');
  setTimeout(() => { landing.style.display = 'none'; disposeAvatarCanvas(); }, 400);

  document.getElementById('exit-btn').style.display  = 'block';
  document.getElementById('ar-loader').style.display = 'flex';

  try {
    await startCamera();
  } catch (err) {
    document.getElementById('scan-ring').style.display = 'none';
    document.getElementById('ar-loader').style.display = 'none';
    document.getElementById('status-pill').textContent =
      'Camera not allowed — please refresh and tap Allow';
    console.error('Camera error:', err);
    return;
  }

  initThree();
  startScan();
});

/* ═══════════════════════════════════════════════════════════════
   BOOT — initialise avatar and pre-fetch quiz data in parallel
═══════════════════════════════════════════════════════════════ */
initAvatarCanvas();

loadQuiz().catch(err => {
  console.error('Failed to load quiz data:', err);
  const btn = document.getElementById('start-btn');
  btn.textContent = 'Quiz data unavailable';
  btn.disabled    = true;
});
