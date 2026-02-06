"use strict";

/**
 * Bubble Rhythm (deterministic charts) — single-file engine
 * - Static GitHub Pages friendly
 * - Canvas rendering
 * - Click or 'E' triggers same hit logic at cursor
 * - Deterministic patterns with chords
 * - Overlap selection: min |timing error| under cursor, tie-breaker nearest center
 */

// ---------------------- Config ----------------------
const CONFIG = {
  // Visual/Timing
  PREEMPT_MS: 900,          // when a note becomes visible before hit time
  HIT_WINDOW_MS: 160,       // allowed +/- window around hit time
  AFTER_MS: 260,            // how long to keep rendering after window (fade out)
  BASE_RADIUS_PX: 34,       // base bubble radius (scaled slightly by canvas)
  APPROACH_RING_SCALE: 1.8, // approach circle starts at radius * scale then shrinks to radius

  // Judgments (abs error thresholds)
  PERFECT_MS: 45,
  GOOD_MS: 90,
  OK_MS: 140,

  // Scoring
  SCORE_PERFECT: 300,
  SCORE_GOOD: 150,
  SCORE_OK: 60,
  SCORE_MISS: 0,
  COMBO_BONUS: 0.06,        // score multiplier per combo step (soft)

  // Input
  KEY_HIT: "KeyE",
};

// ---------------------- Utilities ----------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function nowMs() { return performance.now(); }

function fmtPct(x) { return (x * 100).toFixed(2) + "%"; }
function fmtSec(ms) { return (ms / 1000).toFixed(2) + "s"; }

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// Deterministic pseudo-random (if you ever want “structured variability” without true randomness)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------- Beatmap (Deterministic) ----------------------
/**
 * Notes use normalized positions (0..1) then are mapped into canvas safe area.
 * Each note: { tMs, xN, yN, rN? } rN optional size factor.
 */
function buildBeatmap() {
  // Everything here is deterministic and learnable: waves + ring + chords
  const notes = [];
  let t = 1200; // lead-in before first note

  // Section A: horizontal wave (learnable progression)
  {
    const count = 18;
    const step = 420;
    for (let i = 0; i < count; i++) {
      const x = lerp(0.12, 0.88, i / (count - 1));
      const y = 0.50 + 0.22 * Math.sin(i * 0.55);
      notes.push({ tMs: t + i * step, xN: x, yN: y });
    }
    t += count * step + 600;
  }

  // Section B: ring / circular formation (rotating sequence)
  {
    const center = { x: 0.50, y: 0.52 };
    const ringR = 0.26;
    const count = 14;
    const step = 300;
    const startAngle = -Math.PI / 2;
    for (let i = 0; i < count; i++) {
      const a = startAngle + i * (2 * Math.PI / count);
      const x = center.x + ringR * Math.cos(a);
      const y = center.y + ringR * Math.sin(a);
      notes.push({ tMs: t + i * step, xN: x, yN: y });
    }
    t += count * step + 450;
  }

  // Section C: chord hits (multiple simultaneous bubbles)
  {
    const chordT = t;
    // 4-note chord on corners (structured and memorable)
    notes.push({ tMs: chordT, xN: 0.22, yN: 0.30 });
    notes.push({ tMs: chordT, xN: 0.78, yN: 0.30 });
    notes.push({ tMs: chordT, xN: 0.22, yN: 0.74 });
    notes.push({ tMs: chordT, xN: 0.78, yN: 0.74 });

    // Follow-up mini-wave
    const step = 340;
    for (let i = 0; i < 10; i++) {
      const x = 0.18 + 0.64 * (i / 9);
      const y = 0.50 + 0.18 * Math.sin(i * 0.9 + 1.2);
      notes.push({ tMs: chordT + 620 + i * step, xN: x, yN: y });
    }
    t = chordT + 620 + 10 * step + 500;
  }

  // Section D: “double” chords (two at once), then ending ring
  {
    const step = 320;
    for (let i = 0; i < 8; i++) {
      const tt = t + i * step;
      const xL = 0.30 + 0.10 * Math.sin(i * 0.6);
      const xR = 0.70 + 0.10 * Math.sin(i * 0.6 + 1.4);
      const y = 0.50 + 0.22 * Math.cos(i * 0.55);
      notes.push({ tMs: tt, xN: xL, yN: y });
      notes.push({ tMs: tt, xN: xR, yN: y });
    }
    t += 8 * step + 520;

    const center = { x: 0.50, y: 0.52 };
    const ringR = 0.24;
    const count = 10;
    const step2 = 260;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI / 2) + i * (2 * Math.PI / count);
      notes.push({
        tMs: t + i * step2,
        xN: center.x + ringR * Math.cos(a),
        yN: center.y + ringR * Math.sin(a),
      });
    }
    t += count * step2 + 450;
  }

  // Sort by time (important for consistent evaluation / end condition)
  notes.sort((a, b) => a.tMs - b.tMs);

  return {
    title: "Demo Deterministic Chart",
    durationMs: t + 1200,
    notes,
  };
}

// ---------------------- Game State ----------------------
const STATE = {
  running: false,
  paused: false,
  ended: false,

  startAtPerfMs: 0, // performance.now() when started
  pauseAtPerfMs: 0,
  pausedTotalMs: 0,

  cursorX: 0,
  cursorY: 0,

  score: 0,
  combo: 0,
  maxCombo: 0,

  p: 0, g: 0, o: 0, m: 0,
  totalJudged: 0,
  totalHit: 0,

  toastTimer: 0,

  beatmap: null,
  noteStates: [], // derived note objects with pixel coords etc
};

// Note runtime representation
function makeRuntimeNote(noteDef, px, py, radiusPx) {
  return {
    tMs: noteDef.tMs,
    x: px,
    y: py,
    r: radiusPx * (noteDef.rN ? clamp(noteDef.rN, 0.6, 1.6) : 1.0),

    // state: "pending" -> "hit" or "miss"
    state: "pending",
    judgedAtMs: null,
    deltaMs: null,
    judgment: null, // "P"|"G"|"O"|"M"
  };
}

// ---------------------- Canvas Setup ----------------------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: true });

let cssW = 0, cssH = 0;
let dpr = 1;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  cssW = Math.max(1, Math.floor(rect.width));
  cssH = Math.max(1, Math.floor(rect.height));

  dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));

  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Recompute note pixel positions if map already loaded
  if (STATE.beatmap) {
    rebuildRuntimeNotes();
  }
}

window.addEventListener("resize", resizeCanvas);

// ---------------------- UI Elements ----------------------
const el = {
  btnStart: document.getElementById("btnStart"),
  btnRestart: document.getElementById("btnRestart"),
  btnPause: document.getElementById("btnPause"),

  score: document.getElementById("score"),
  combo: document.getElementById("combo"),
  acc: document.getElementById("acc"),
  pCnt: document.getElementById("pCnt"),
  gCnt: document.getElementById("gCnt"),
  oCnt: document.getElementById("oCnt"),
  mCnt: document.getElementById("mCnt"),
  time: document.getElementById("time"),
  notesLeft: document.getElementById("notesLeft"),

  centerPrompt: document.getElementById("centerPrompt"),
  toast: document.getElementById("toast"),
};

function showPrompt(show) {
  el.centerPrompt.style.display = show ? "grid" : "none";
}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  STATE.toastTimer = nowMs();
}

function updateToast() {
  if (!el.toast.classList.contains("show")) return;
  const t = nowMs() - STATE.toastTimer;
  if (t > 1600) el.toast.classList.remove("show");
}

function updateHud(currentMs) {
  el.score.textContent = Math.floor(STATE.score).toString();
  el.combo.textContent = STATE.combo.toString();

  const acc = computeAccuracy();
  el.acc.textContent = fmtPct(acc);

  el.pCnt.textContent = STATE.p.toString();
  el.gCnt.textContent = STATE.g.toString();
  el.oCnt.textContent = STATE.o.toString();
  el.mCnt.textContent = STATE.m.toString();

  el.time.textContent = fmtSec(currentMs);
  el.notesLeft.textContent = countNotesLeft().toString();
}

function computeAccuracy() {
  // Weighted accuracy: P=1.0, G=0.75, O=0.45, M=0.0
  const denom = Math.max(1, STATE.totalJudged);
  const num = STATE.p * 1.0 + STATE.g * 0.75 + STATE.o * 0.45;
  return num / denom;
}

function countNotesLeft() {
  return STATE.noteStates.filter(n => n.state === "pending").length;
}

// ---------------------- Build / Reset ----------------------
function loadBeatmap() {
  STATE.beatmap = buildBeatmap();
  rebuildRuntimeNotes();
  updateHud(0);
  toast(`Loaded: ${STATE.beatmap.title} (${STATE.beatmap.notes.length} notes)`);
}

function rebuildRuntimeNotes() {
  const safePad = Math.max(26, Math.min(cssW, cssH) * 0.08);
  const left = safePad;
  const right = cssW - safePad;
  const top = safePad;
  const bottom = cssH - safePad;

  const baseR = Math.max(18, Math.min(CONFIG.BASE_RADIUS_PX, Math.min(cssW, cssH) * 0.055));

  STATE.noteStates = STATE.beatmap.notes.map((n) => {
    const px = lerp(left, right, clamp(n.xN, 0, 1));
    const py = lerp(top, bottom, clamp(n.yN, 0, 1));
    return makeRuntimeNote(n, px, py, baseR);
  });
}

function resetGameState() {
  STATE.running = false;
  STATE.paused = false;
  STATE.ended = false;

  STATE.startAtPerfMs = 0;
  STATE.pauseAtPerfMs = 0;
  STATE.pausedTotalMs = 0;

  STATE.score = 0;
  STATE.combo = 0;
  STATE.maxCombo = 0;

  STATE.p = 0; STATE.g = 0; STATE.o = 0; STATE.m = 0;
  STATE.totalJudged = 0;
  STATE.totalHit = 0;

  // Reset notes
  rebuildRuntimeNotes();

  el.btnStart.disabled = false;
  el.btnRestart.disabled = true;
  el.btnPause.disabled = true;
  el.btnPause.textContent = "Pause";

  showPrompt(true);
  updateHud(0);
}

// ---------------------- Timing ----------------------
function getSongTimeMs() {
  if (!STATE.running) return 0;
  if (STATE.paused) {
    return STATE.pauseAtPerfMs - STATE.startAtPerfMs - STATE.pausedTotalMs;
  }
  return nowMs() - STATE.startAtPerfMs - STATE.pausedTotalMs;
}

// ---------------------- Input ----------------------
function canvasPointFromEvent(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left);
  const y = (evt.clientY - rect.top);
  return { x, y };
}

canvas.addEventListener("mousemove", (e) => {
  const p = canvasPointFromEvent(e);
  STATE.cursorX = p.x;
  STATE.cursorY = p.y;
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (!STATE.running) return;
  if (STATE.paused || STATE.ended) return;
  const p = canvasPointFromEvent(e);
  STATE.cursorX = p.x;
  STATE.cursorY = p.y;
  attemptHit(STATE.cursorX, STATE.cursorY);
});

canvas.addEventListener("touchstart", (e) => {
  if (!STATE.running) return;
  if (STATE.paused || STATE.ended) return;
  const t = e.changedTouches[0];
  const rect = canvas.getBoundingClientRect();
  const x = (t.clientX - rect.left);
  const y = (t.clientY - rect.top);
  STATE.cursorX = x;
  STATE.cursorY = y;
  attemptHit(x, y);
  e.preventDefault();
}, { passive: false });

// Global key (E) → click at cursor location
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === CONFIG.KEY_HIT) {
    if (!STATE.running) return;
    if (STATE.paused || STATE.ended) return;
    attemptHit(STATE.cursorX, STATE.cursorY);
    e.preventDefault();
  }

  // Convenience: Space toggles pause
  if (e.code === "Space") {
    if (!STATE.running || STATE.ended) return;
    togglePause();
    e.preventDefault();
  }
});

// ---------------------- Hit Resolution ----------------------
function attemptHit(cx, cy) {
  const t = getSongTimeMs();

  // Candidate notes: pending, cursor inside, abs delta <= HIT_WINDOW
  const candidates = [];
  for (const n of STATE.noteStates) {
    if (n.state !== "pending") continue;

    const delta = t - n.tMs;
    if (Math.abs(delta) > CONFIG.HIT_WINDOW_MS) continue;

    const inside = dist2(cx, cy, n.x, n.y) <= (n.r * n.r);
    if (!inside) continue;

    candidates.push({ n, absDelta: Math.abs(delta), delta, d2: dist2(cx, cy, n.x, n.y) });
  }

  if (candidates.length === 0) {
    toast("No hittable bubble under cursor");
    // Optional: combo break on “empty click” — currently no, since your spec didn’t require it.
    return;
  }

  // Overlap selection:
  // 1) choose smallest abs timing error (closest scheduled hit time)
  // 2) tie-breaker: nearest center
  candidates.sort((a, b) => {
    if (a.absDelta !== b.absDelta) return a.absDelta - b.absDelta;
    return a.d2 - b.d2;
  });

  const pick = candidates[0].n;
  const delta = t - pick.tMs;

  const j = judge(delta);
  applyJudgment(pick, t, delta, j);
}

function judge(deltaMs) {
  const a = Math.abs(deltaMs);
  if (a <= CONFIG.PERFECT_MS) return "P";
  if (a <= CONFIG.GOOD_MS) return "G";
  if (a <= CONFIG.OK_MS) return "O";
  // within HIT_WINDOW but beyond OK threshold is still a hit, but lowest tier
  return "O";
}

function applyJudgment(note, judgedAtMs, deltaMs, judgment) {
  note.state = "hit";
  note.judgedAtMs = judgedAtMs;
  note.deltaMs = deltaMs;
  note.judgment = judgment;

  STATE.totalJudged += 1;
  STATE.totalHit += 1;

  // Combo
  STATE.combo += 1;
  STATE.maxCombo = Math.max(STATE.maxCombo, STATE.combo);

  let base = 0;
  if (judgment === "P") { STATE.p += 1; base = CONFIG.SCORE_PERFECT; toast(`Perfect (${deltaMs.toFixed(0)}ms)`); }
  else if (judgment === "G") { STATE.g += 1; base = CONFIG.SCORE_GOOD; toast(`Good (${deltaMs.toFixed(0)}ms)`); }
  else { STATE.o += 1; base = CONFIG.SCORE_OK; toast(`Ok (${deltaMs.toFixed(0)}ms)`); }

  // Soft combo multiplier (keeps it simple but rewarding)
  const mult = 1 + (STATE.combo - 1) * CONFIG.COMBO_BONUS;
  STATE.score += base * mult;
}

// ---------------------- Miss Processing ----------------------
function processAutoMisses(currentMs) {
  for (const n of STATE.noteStates) {
    if (n.state !== "pending") continue;

    // If time passed beyond allowed window => miss
    if (currentMs > n.tMs + CONFIG.HIT_WINDOW_MS) {
      n.state = "miss";
      n.judgedAtMs = currentMs;
      n.deltaMs = currentMs - n.tMs;
      n.judgment = "M";

      STATE.totalJudged += 1;
      STATE.m += 1;

      // combo break
      STATE.combo = 0;
    }
  }
}

// ---------------------- Rendering ----------------------
function clear() {
  ctx.clearRect(0, 0, cssW, cssH);
}

function drawBackground() {
  // subtle grid / vignette
  ctx.save();
  ctx.globalAlpha = 1;

  // vignette
  const g = ctx.createRadialGradient(cssW * 0.5, cssH * 0.45, 50, cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.7);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);

  // grid
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;

  const step = Math.max(40, Math.floor(Math.min(cssW, cssH) / 14));
  for (let x = 0; x <= cssW; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
  }
  for (let y = 0; y <= cssH; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
  }

  ctx.restore();
}

function drawCursor() {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(120,170,255,0.95)";
  ctx.beginPath();
  ctx.arc(STATE.cursorX, STATE.cursorY, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawNote(n, currentMs) {
  const appearAt = n.tMs - CONFIG.PREEMPT_MS;
  const vanishAt = n.tMs + CONFIG.HIT_WINDOW_MS + CONFIG.AFTER_MS;

  if (currentMs < appearAt) return;
  if (currentMs > vanishAt) return;

  // Determine alpha and approach progress
  let alpha = 1.0;

  if (n.state === "hit" || n.state === "miss") {
    const dt = currentMs - n.judgedAtMs;
    alpha = clamp(1 - dt / CONFIG.AFTER_MS, 0, 1);
  } else {
    // fade in during preempt
    const preT = clamp((currentMs - appearAt) / CONFIG.PREEMPT_MS, 0, 1);
    alpha = clamp(preT, 0.15, 1);
  }

  // Approach ring: only while pending and before hit time
  if (n.state === "pending") {
    const until = n.tMs - currentMs; // ms remaining
    if (until >= 0 && until <= CONFIG.PREEMPT_MS) {
      const t = clamp(1 - (until / CONFIG.PREEMPT_MS), 0, 1); // 0..1 towards hit
      const approachR = lerp(n.r * CONFIG.APPROACH_RING_SCALE, n.r, t);

      ctx.save();
      ctx.globalAlpha = alpha * 0.65;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(120,170,255,0.85)";
      ctx.beginPath();
      ctx.arc(n.x, n.y, approachR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Bubble base
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 2;

  // If judged, color hint
  if (n.state === "hit") {
    if (n.judgment === "P") ctx.strokeStyle = "rgba(160,255,190,0.95)";
    else if (n.judgment === "G") ctx.strokeStyle = "rgba(160,255,190,0.80)";
    else ctx.strokeStyle = "rgba(255,220,140,0.85)";
  } else if (n.state === "miss") {
    ctx.strokeStyle = "rgba(255,120,120,0.90)";
  }

  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Inner dot (helps aiming)
  ctx.globalAlpha = alpha * 0.85;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.arc(n.x, n.y, Math.max(3, n.r * 0.10), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Timing hint: small text during judgement fade
  if (n.state !== "pending" && alpha > 0.1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let label = n.judgment === "M" ? "MISS" : n.judgment;
    ctx.fillStyle = "rgba(255,255,255,0.70)";
    ctx.fillText(label, n.x, n.y);
    ctx.restore();
  }
}

function render(currentMs) {
  clear();
  drawBackground();

  // Draw notes (pending and fading)
  for (const n of STATE.noteStates) {
    drawNote(n, currentMs);
  }

  drawCursor();
}

// ---------------------- Main Loop ----------------------
function tick() {
  const t = getSongTimeMs();

  if (STATE.running && !STATE.paused && !STATE.ended) {
    processAutoMisses(t);

    // End condition: all notes judged and time past last note + after
    const last = STATE.noteStates[STATE.noteStates.length - 1];
    const endAt = last.tMs + CONFIG.HIT_WINDOW_MS + CONFIG.AFTER_MS + 200;
    if (t > endAt && countNotesLeft() === 0) {
      STATE.ended = true;
      el.btnPause.disabled = true;
      toast(`Finished • Max combo ${STATE.maxCombo} • Acc ${fmtPct(computeAccuracy())}`);
      showPrompt(true);
    }
  }

  render(t);
  updateHud(t);
  updateToast();

  requestAnimationFrame(tick);
}

// ---------------------- Controls ----------------------
function startGame() {
  resetGameState();

  STATE.running = true;
  STATE.paused = false;
  STATE.ended = false;
  STATE.startAtPerfMs = nowMs();
  STATE.pausedTotalMs = 0;

  el.btnStart.disabled = true;
  el.btnRestart.disabled = false;
  el.btnPause.disabled = false;

  showPrompt(false);
  toast("Go");
}

function restartGame() {
  startGame();
}

function togglePause() {
  if (!STATE.running || STATE.ended) return;

  if (!STATE.paused) {
    STATE.paused = true;
    STATE.pauseAtPerfMs = nowMs();
    el.btnPause.textContent = "Resume";
    toast("Paused");
    showPrompt(true);
  } else {
    STATE.paused = false;
    const resumeAt = nowMs();
    STATE.pausedTotalMs += (resumeAt - STATE.pauseAtPerfMs);
    el.btnPause.textContent = "Pause";
    toast("Resume");
    showPrompt(false);
  }
}

// ---------------------- Init ----------------------
function init() {
  resizeCanvas();
  loadBeatmap();
  resetGameState();

  // Ensure cursor has a valid default in center
  STATE.cursorX = cssW * 0.5;
  STATE.cursorY = cssH * 0.5;

  el.btnStart.addEventListener("click", startGame);
  el.btnRestart.addEventListener("click", restartGame);
  el.btnPause.addEventListener("click", togglePause);

  // Prevent context menu on canvas (optional)
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  requestAnimationFrame(tick);
}

init();
