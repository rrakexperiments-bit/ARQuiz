/**
 * Lokakavya Heritage AR Experience — app.js
 * Three.js markerless surface AR + two-track quiz system
 *
 * NOTE: fetch() requires an HTTP server. For local dev use:
 *   python3 -m http.server 8080
 *   or VS Code Live Server extension
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ═══════════════════════════════════════════════════════════════
   REDUCED MOTION
═══════════════════════════════════════════════════════════════ */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ═══════════════════════════════════════════════════════════════
   QUIZ DATA — two tracks loaded in parallel on boot
   Hero Stones:       options[] + feedback_script.{correct,incorrect}
   Temple Inscription: Option A/B/C/D + rationale
   Both map to internal shape: { q, opts[], ans, ok, bad }
═══════════════════════════════════════════════════════════════ */
let QUIZ_HEROSTONE = [];
let QUIZ_TEMPLE    = [];
let activeTrack    = null;   // 'herostone' | 'temple'
let arInitialized  = false;  // camera + Three.js init guard
let sessionQuiz    = [];
const SESSION_SIZE = 5;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadAllQuizData() {
  const [hsRes, tmRes] = await Promise.all([
    fetch('./hero_stones_conservation_quiz.json'),
    fetch('./quiz_content_full_v2.json'),
  ]);
  const [hsData, tmData] = await Promise.all([hsRes.json(), tmRes.json()]);

  QUIZ_HEROSTONE = hsData.questions.map(raw => ({
    q:    raw.question,
    opts: raw.options,
    ans:  raw.options.indexOf(raw.correct_answer),
    ok:   raw.feedback_script.correct,
    bad:  raw.feedback_script.incorrect,
  }));

  QUIZ_TEMPLE = tmData.questions.map(raw => {
    const opts = [raw['Option A'], raw['Option B'], raw['Option C'], raw['Option D']];
    return {
      q:   raw.question,
      opts,
      ans: opts.indexOf(raw.correct_answer),
      ok:  `Correct! ${raw.rationale}`,
      bad: raw.rationale,
    };
  });

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
  renderer2.setSize(140, 140);
  renderer2.setClearColor(0x000000, 0);
  renderer2.shadowMap.enabled = true;
  renderer2.shadowMap.type = THREE.PCFSoftShadowMap;

  const sc  = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  cam.position.set(0, 1, 3.5);
  cam.lookAt(0, 0.8, 0);

  sc.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun2 = new THREE.DirectionalLight(0xfff6e0, 1.6);
  sun2.position.set(3, 5, 3.5);
  sun2.castShadow = true;
  sc.add(sun2);
  const fill = new THREE.DirectionalLight(0xaaccff, 0.6);
  fill.position.set(-2, 2, -3);
  sc.add(fill);

  let modelRef = null;
  let autoRotate = true;
  let dragStart = { x: 0, y: 0 };
  let isPointerDown = false;
  const modelRotation = { x: 0, y: 0 };

  const loader2 = new GLTFLoader();
  loader2.load(
    'bayabird.glb',
    gltf => {
      modelRef = gltf.scene;

      // Ensure all materials respond to lighting
      modelRef.traverse(node => {
        if (node.isMesh && node.material) {
          if (node.material.map) node.material.map.encoding = THREE.sRGBEncoding;
          node.material.side = THREE.DoubleSide;
          // Convert to lit material if needed
          if (node.material.type === 'MeshBasicMaterial' || !node.material.metalness) {
            const newMat = new THREE.MeshStandardMaterial({
              map: node.material.map,
              color: node.material.color,
              roughness: 0.6,
              metalness: 0.1,
            });
            node.material = newMat;
          }
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });

      const box = new THREE.Box3().setFromObject(modelRef);
      const sz  = box.getSize(new THREE.Vector3());
      const s   = 1.6 / Math.max(sz.x, sz.y, sz.z);
      modelRef.scale.setScalar(s);
      const b2 = new THREE.Box3().setFromObject(modelRef);
      modelRef.position.y = -b2.min.y;
      sc.add(modelRef);

      avatarCanvas.addEventListener('pointerdown', e => {
        isPointerDown = true;
        autoRotate = false;
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
      });
      avatarCanvas.addEventListener('pointermove', e => {
        if (!isPointerDown) return;
        const deltaX = e.clientX - dragStart.x;
        const deltaY = e.clientY - dragStart.y;
        modelRotation.y += deltaX * 0.01;
        modelRotation.x += deltaY * 0.01;
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
      });
      avatarCanvas.addEventListener('pointerup', () => {
        isPointerDown = false;
        autoRotate = true;
      });
      avatarCanvas.addEventListener('pointerleave', () => {
        isPointerDown = false;
        autoRotate = true;
      });

      (function avatarLoop() {
        avatarRafId = requestAnimationFrame(avatarLoop);
        if (!isPointerDown) {
          if (autoRotate && !reducedMotion) modelRotation.y += 0.008;
        }
        modelRef.rotation.order = 'YXZ';
        modelRef.rotation.y = modelRotation.y;
        modelRef.rotation.x = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, modelRotation.x));
        renderer2.render(sc, cam);
      })();
    },
    undefined,
    () => {
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

// Model interaction state
let modelInteraction = {
  rotation: { x: 0, y: 0 },
  zoom: 1,
  pan: { x: 0, z: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  initialPos: { x: 0, y: 0, z: 0 },
};

function initThree() {
  const canvas = document.getElementById('ar-canvas');

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type  = THREE.PCFSoftShadowMap;

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 80);
  camera.position.set(0, 0.8, 2.2);
  camera.lookAt(0, 0.5, 0);

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

  const accent  = 0x4F46E5;   // --lk-primary
  const accentG = 0x22D3EE;   // --lk-gold
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
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-2, 2, -3);
  scene.add(fillLight);

  /* ─ shadow receiver ─ */
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

    if (reticleGroup.visible) {
      reticleGroup.children[0].material.opacity = reducedMotion ? 0.9  : 0.52 + Math.sin(t * 2.8) * 0.38;
      reticleGroup.children[1].material.opacity = reducedMotion ? 0.12 : 0.07 + Math.sin(t * 2.8) * 0.05;
    }

    if (heroModel) {
      const bobbing = !reducedMotion ? Math.sin(t * 1.1) * 0.018 : 0;
      // Apply interactive transformations
      heroModel.rotation.order = 'YXZ';
      heroModel.rotation.y = modelInteraction.rotation.y;
      heroModel.rotation.x = modelInteraction.rotation.x;
      heroModel.scale.setScalar(heroModel.userData.baseScale * modelInteraction.zoom);
      heroModel.position.x = modelInteraction.initialPos.x + modelInteraction.pan.x;
      heroModel.position.y = modelInteraction.initialPos.y + bobbing;
      heroModel.position.z = modelInteraction.initialPos.z + modelInteraction.pan.z;
    }

    renderer.render(scene, camera);
  })();
}

/* ═══════════════════════════════════════════════════════════════
   RAYCAST — pointer coords → world point on ground plane
═══════════════════════════════════════════════════════════════ */
function groundHit(clientX, clientY) {
  pointer.x =  (clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(ground);
  return hits.length ? hits[0].point : null;
}

// Project a screen point onto the ground plane — used for accurate two-finger pan
function screenToGround(clientX, clientY) {
  const r = new THREE.Raycaster();
  const p = new THREE.Vector2(
    (clientX  / window.innerWidth)  * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1
  );
  r.setFromCamera(p, camera);
  const hits = r.intersectObject(ground);
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

// Model interaction: rotate, pan, zoom (use document to work even when stage is pointer-events: none)
// Multi-touch interaction: single pointer = rotate, two pointers = pinch-zoom + pan
const activePointers = new Map();
let lastPinchDist = null;
let lastPinchMid  = null;

function pinchState() {
  const pts = [...activePointers.values()];
  return {
    dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
    mid:  { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
  };
}

document.addEventListener('pointerdown', e => {
  if (!modelPlaced) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    modelInteraction.isDragging = true;
    modelInteraction.dragStart.x = e.clientX;
    modelInteraction.dragStart.y = e.clientY;
  } else if (activePointers.size === 2) {
    modelInteraction.isDragging = false;
    const s = pinchState();
    lastPinchDist = s.dist;
    lastPinchMid  = s.mid;
  }
});

document.addEventListener('pointermove', e => {
  if (!modelPlaced || !activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size >= 2) {
    const s = pinchState();
    if (lastPinchDist) modelInteraction.zoom *= s.dist / lastPinchDist;
    if (lastPinchMid) {
      const worldCurr = screenToGround(s.mid.x, s.mid.y);
      const worldLast = screenToGround(lastPinchMid.x, lastPinchMid.y);
      if (worldCurr && worldLast) {
        modelInteraction.pan.x += worldCurr.x - worldLast.x;
        modelInteraction.pan.z += worldCurr.z - worldLast.z;
      }
    }
    lastPinchDist = s.dist;
    lastPinchMid  = s.mid;
    return;
  }

  if (modelInteraction.isDragging) {
    const dx = e.clientX - modelInteraction.dragStart.x;
    const dy = e.clientY - modelInteraction.dragStart.y;
    if (e.shiftKey) {
      modelInteraction.pan.x += dx * 0.003;
      modelInteraction.pan.z -= dy * 0.003;
    } else {
      modelInteraction.rotation.y += dx * 0.01;
      modelInteraction.rotation.x += dy * 0.01;
    }
    modelInteraction.dragStart.x = e.clientX;
    modelInteraction.dragStart.y = e.clientY;
  }
});

document.addEventListener('pointerup', e => {
  activePointers.delete(e.pointerId);
  lastPinchDist = null;
  lastPinchMid  = null;
  if (activePointers.size === 1) {
    const [pt] = activePointers.values();
    modelInteraction.isDragging = true;
    modelInteraction.dragStart.x = pt.x;
    modelInteraction.dragStart.y = pt.y;
  } else if (activePointers.size === 0) {
    modelInteraction.isDragging = false;
  }
});

document.addEventListener('pointercancel', e => {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) { lastPinchDist = null; lastPinchMid = null; }
});

document.addEventListener('wheel', e => {
  if (!modelPlaced) return;
  e.preventDefault();
  modelInteraction.zoom -= e.deltaY * 0.001;
}, { passive: false });

/* ═══════════════════════════════════════════════════════════════
   PLACE MODEL
═══════════════════════════════════════════════════════════════ */
function placeModel(point) {
  const loader = new GLTFLoader();
  loader.load(
    'ChakkereCP155_vox2_colored.glb',
    gltf => {
      heroModel = gltf.scene;
      heroModel.traverse(n => {
        if (n.isMesh) {
          n.castShadow = false;
          n.receiveShadow = false;
          const mats = Array.isArray(n.material) ? n.material : [n.material];
          mats.forEach(m => {
            if (!m) return;
            m.side        = THREE.DoubleSide;
            m.transparent = false;
            m.alphaTest   = 0;
            m.depthWrite  = true;
            m.needsUpdate = true;
          });
        }
      });

      // Add dedicated lights for the model only
      const modelAmbient = new THREE.AmbientLight(0xffffff, 0.2);
      heroModel.add(modelAmbient);

      const modelSun = new THREE.DirectionalLight(0xffffff, 0.6);
      modelSun.position.set(3, 5, 3);
      heroModel.add(modelSun);

      const modelFill = new THREE.DirectionalLight(0xffffff, 0.15);
      modelFill.position.set(-2, 2, -3);
      heroModel.add(modelFill);

      const box  = new THREE.Box3().setFromObject(heroModel);
      const size = box.getSize(new THREE.Vector3());
      const baseScale = window.innerWidth > 768 ? 0.55 : 0.7;
      const s    = baseScale / Math.max(size.x, size.y, size.z);
      heroModel.scale.setScalar(s);

      const b2    = new THREE.Box3().setFromObject(heroModel);
      const baseY = -b2.min.y;
      heroModel.position.set(point.x, baseY, point.z);
      heroModel.userData.baseY = baseY;
      heroModel.userData.baseScale = s;
      // Try rotating 180 degrees
      heroModel.rotation.order = 'YXZ';
      heroModel.rotation.x = 0;
      heroModel.rotation.y = Math.PI;
      heroModel.rotation.z = 0;
      scene.add(heroModel);

      // Reset interaction state for new model
      modelInteraction.rotation = { x: 0, y: 0 };
      modelInteraction.zoom = 1;
      modelInteraction.pan = { x: 0, z: 0 };
      modelInteraction.initialPos = { x: point.x, y: baseY, z: point.z };

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

      setTimeout(openQuiz, 950);
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
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

/* ═══════════════════════════════════════════════════════════════
   SCREEN TRANSITIONS
   Landing (z:1000) → Track Select (z:900) → Track Intro (z:800) → AR
═══════════════════════════════════════════════════════════════ */
function showTrackSelect() {
  const landing = document.getElementById('landing');
  landing.classList.add('fade-out');
  setTimeout(() => { landing.style.display = 'none'; disposeAvatarCanvas(); }, 400);
  document.getElementById('track-select').classList.add('show');
}

const TRACK_CONFIG = {
  herostone: {
    icon:        'hero-icon.png',
    badge:       'Hero Stones',
    title:       'Guardians of History',
    body:        'This quiz explores the fascinating world of Hero Stones (known as Veeragallu in Karnataka), which are ancient monuments dedicated to brave individuals. You will learn about how these stones "tell" stories through carvings and why modern technology like 3D scanning is vital to saving them for the future.',
    accentClass: 'green',
  },
  temple: {
    icon:        'temple-icon.png',
    badge:       'Temple Inscription',
    title:       'Chronicles in Stone',
    body:        "This quiz will help you explore the historical secrets of the Chakkere Tirumala Temple inscription from 1534 CE. You'll learn about the kings, the special symbols carved on stone, and how people looked after temples during the Vijayanagar Empire.",
    accentClass: 'cyan',
  },
};

function showTrackIntro(trackId) {
  activeTrack = trackId;
  const cfg   = TRACK_CONFIG[trackId];

  document.getElementById('intro-icon').innerHTML    = `<img src="${cfg.icon}" alt="${cfg.badge}" style="width: 52px; height: 52px; object-fit: contain;">`;
  document.getElementById('intro-badge').textContent = cfg.badge;
  document.getElementById('intro-badge').className   = `intro-badge ${cfg.accentClass}`;
  document.getElementById('intro-title').textContent = cfg.title;
  document.getElementById('intro-body').textContent  = cfg.body;

  document.getElementById('track-select').classList.remove('show');
  setTimeout(() => {
    document.getElementById('track-intro').classList.add('show');
  }, 300);
}

function goBackToTrackSelect() {
  document.getElementById('track-intro').classList.remove('show');
  setTimeout(() => {
    document.getElementById('track-select').classList.add('show');
  }, 300);
}

async function beginExperience() {
  document.getElementById('track-intro').classList.remove('show');
  document.getElementById('exit-btn').style.display = 'block';

  if (!arInitialized) {
    try {
      await startCamera();
    } catch (err) {
      document.getElementById('scan-ring').style.display = 'none';
      document.getElementById('status-pill').textContent =
        'Camera not allowed — please refresh and tap Allow';
      console.error('Camera error:', err);
      return;
    }
    initThree();
    arInitialized = true;
  }

  // Reset scan state for each new session
  if (heroModel) { scene.remove(heroModel); heroModel = null; }
  modelPlaced  = false;
  surfaceReady = false;
  reticleGroup.visible = false;
  stage.style.pointerEvents = 'none';
  document.getElementById('scan-ring').style.display = '';
  document.getElementById('status-pill').textContent = 'Scanning for a flat surface…';
  document.getElementById('hud').style.opacity = '1';

  startScan();
}

/* ═══════════════════════════════════════════════════════════════
   QUIZ LOGIC
═══════════════════════════════════════════════════════════════ */
let qIdx = 0, score = 0, answered = false;

function openQuiz() {
  qIdx = 0; score = 0; answered = false;
  const pool = activeTrack === 'herostone' ? QUIZ_HEROSTONE : QUIZ_TEMPLE;
  sessionQuiz = shuffle(pool).slice(0, SESSION_SIZE);

  const trackLabel = activeTrack === 'herostone' ? 'Hero Stones' : 'Temple Inscription';
  document.getElementById('q-track-badge').innerHTML =
    `<span class="q-type-icon">?</span>${trackLabel}`;
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

  // Shuffle options and track the correct answer's new index
  const shuffled = d.opts.map((text, idx) => ({ text, originalIdx: idx }));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const correctIdx = shuffled.findIndex(o => o.originalIdx === d.ans);

  document.getElementById('q-num').textContent   = `Q ${qIdx + 1} / ${sessionQuiz.length}`;
  document.getElementById('q-score').textContent = `${score} / ${sessionQuiz.length}`;
  document.getElementById('q-text').textContent  = d.q;

  const el = document.getElementById('opts');
  el.innerHTML = '';
  shuffled.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.className = `opt ${cls[i]}`;
    btn.innerHTML = `<span class="opt-ltr">${ltrs[i]}</span>${item.text}`;
    btn.addEventListener('click', () => pickAnswer(i, correctIdx));
    el.appendChild(btn);
  });

  // Store correct index for this question
  sessionQuiz[qIdx].currentCorrectIdx = correctIdx;
}

function pickAnswer(i, correctIdx) {
  if (answered) return;
  answered = true;

  const d    = sessionQuiz[qIdx];
  const btns = document.querySelectorAll('.opt');

  btns.forEach(b => b.classList.add('locked'));

  if (i === correctIdx) {
    btns[i].classList.add('correct');
    btns.forEach((b, j) => { if (j !== i) b.classList.add('dim'); });
    score++;
    document.getElementById('q-score').textContent = `${score} / ${sessionQuiz.length}`;
    showFeedbackPopup(true, d.ok);
  } else {
    btns[i].classList.add('wrong');
    btns[correctIdx].classList.add('correct');
    btns.forEach((b, j) => { if (j !== i && j !== correctIdx) b.classList.add('dim'); });
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

function getScoreMessage(s, total) {
  const pct = s / total;
  if (s === total)  return { title: 'Heritage Champion!',  sub: `You answered all ${total} questions correctly. Amazing work!` };
  if (pct >= 0.8)   return { title: 'Almost perfect!',     sub: `${s} out of ${total} — brilliant! One more try to ace it.` };
  if (pct >= 0.6)   return { title: 'Well done!',          sub: `${s} out of ${total} — you are getting there!` };
  if (pct >= 0.4)   return { title: 'Good effort!',        sub: `${s} out of ${total}. Keep going — you are learning!` };
  if (s === 1)      return { title: 'Good start!',         sub: 'You got 1 right. Try again to learn more!' };
  return                   { title: 'Keep trying!',        sub: 'Every question you get wrong is something new you learned!' };
}

function showScore() {
  document.getElementById('quiz-q').classList.remove('show');
  document.getElementById('quiz-opts-wrap').classList.remove('show');

  const { title, sub } = getScoreMessage(score, sessionQuiz.length);
  document.getElementById('score-big').textContent   = score;
  document.getElementById('score-title').textContent = title;
  document.getElementById('score-sub').textContent   = sub;

  // Hero Stones track: show closing message
  const outroEl = document.getElementById('track-outro');
  if (activeTrack === 'herostone') {
    outroEl.textContent = "You've just completed a journey into the world of Hero Stones! These artifacts are the storybooks of our history, and by learning about digital conservation, you're helping to keep those stories alive for another thousand years. Great job!";
    outroEl.style.display = 'block';
  } else {
    outroEl.style.display = 'none';
  }

  // SVG ring: r=40, circumference = 2π×40 ≈ 251.3
  const circ = 2 * Math.PI * 40;
  const arc  = document.getElementById('score-arc');
  arc.style.strokeDasharray  = `${circ}`;
  arc.style.strokeDashoffset = `${circ}`;

  document.getElementById('score-overlay').classList.add('show');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.style.strokeDashoffset = `${circ * (1 - score / sessionQuiz.length)}`;
  }));
}

function showOutro() {
  document.getElementById('score-overlay').className = '';
  document.getElementById('outro-screen').classList.add('show');
}

function resetToTrackSelect() {
  // Hide outro and all quiz UI
  document.getElementById('outro-screen').classList.remove('show');
  document.getElementById('quiz-q').classList.remove('show');
  document.getElementById('quiz-opts-wrap').classList.remove('show');
  document.getElementById('feedback-popup').classList.remove('show');

  // Reset quiz state
  qIdx = 0; score = 0; answered = false;
  sessionQuiz = [];
  activeTrack = null;

  // Show track select
  document.getElementById('track-select').classList.add('show');
}

function retryQuiz() {
  qIdx = 0; score = 0; answered = false;
  const pool = activeTrack === 'herostone' ? QUIZ_HEROSTONE : QUIZ_TEMPLE;
  sessionQuiz = shuffle(pool).slice(0, SESSION_SIZE);
  document.getElementById('score-overlay').className = '';
  document.getElementById('feedback-popup').classList.remove('show');
  renderQuestion();
  document.getElementById('quiz-q').classList.add('show');
  document.getElementById('quiz-opts-wrap').classList.add('show');
}

/* ═══════════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════════ */
document.getElementById('retry-btn').addEventListener('click', retryQuiz);
document.getElementById('continue-btn').addEventListener('click', showOutro);
document.getElementById('outro-track-btn').addEventListener('click', resetToTrackSelect);
document.getElementById('outro-exit-btn').addEventListener('click', () => window.location.reload());
document.getElementById('ts-home-btn').addEventListener('click', () => window.location.reload());
document.getElementById('start-btn').addEventListener('click', showTrackSelect);
document.getElementById('track-herostone').addEventListener('click', () => showTrackIntro('herostone'));
document.getElementById('track-temple').addEventListener('click',    () => showTrackIntro('temple'));
document.getElementById('intro-back-btn').addEventListener('click', goBackToTrackSelect);
document.getElementById('begin-btn').addEventListener('click', beginExperience);

/* ═══════════════════════════════════════════════════════════════
   BOOT — pre-fetch both quiz files in parallel
═══════════════════════════════════════════════════════════════ */
// Avatar canvas replaced with static Lokakavya logo
// initAvatarCanvas();

loadAllQuizData().catch(err => {
  console.error('Failed to load quiz data:', err);
  const btn = document.getElementById('start-btn');
  btn.textContent = 'Quiz data unavailable';
  btn.disabled    = true;
});
