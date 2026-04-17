// ============================================
// RETROBEAT — main app module
// ============================================

const $ = (id) => document.getElementById(id);
const app = $('app');

// ---- Audio + analyser ----
const audio = $('audio');
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let gainNode = null;
let preampNode = null;
let eqFilters = [];     // 8 biquad filters
let freqData = null;    // Uint8Array frequency
let timeData = null;    // Uint8Array waveform
let peakData = null;    // smoothed peaks for bars

// EQ band center frequencies (classic Winamp 8-band)
const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000];

function initAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  gainNode = audioCtx.createGain();

  // Preamp (simple gain before EQ chain)
  preampNode = audioCtx.createGain();
  preampNode.gain.value = 1.0;

  // Build 8-band EQ chain: source -> preamp -> f0 -> f1 -> ... -> f7 -> analyser -> gain -> dest
  eqFilters = EQ_FREQS.map((freq, i) => {
    const f = audioCtx.createBiquadFilter();
    // outer bands use shelf filters; inner bands use peaking — same Winamp behavior
    if (i === 0)                       f.type = 'lowshelf';
    else if (i === EQ_FREQS.length - 1) f.type = 'highshelf';
    else                               f.type = 'peaking';
    f.frequency.value = freq;
    f.Q.value = 1.0;
    f.gain.value = 0;
    return f;
  });

  // Wire the chain
  sourceNode.connect(preampNode);
  let node = preampNode;
  for (const f of eqFilters) {
    node.connect(f);
    node = f;
  }
  node.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.frequencyBinCount);
  peakData = new Float32Array(64);

  // Apply any stored EQ state now that the nodes exist
  applyEQState();
}

// ---- Playlist state ----
const state = {
  playlist: [],     // { id, name, source: 'local'|'drive', url?, driveId?, size? }
  currentIndex: -1,
  shuffle: false,
  repeat: 'off',    // 'off'|'one'|'all'
  theme: 'classic',
  viz: 'bars',
  volume: 0.8,
  driveClientId: '',
  driveToken: null,
  eqEnabled: true,
  eqGains: [0,0,0,0,0,0,0,0],  // dB per band
  eqPreamp: 0,                  // dB
  eqPreset: 'flat',
  fullscreen: false,
};

// Persist + restore settings
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('retrobeat') || '{}');
    if (s.theme) setTheme(s.theme);
    if (s.viz) setViz(s.viz);
    if (typeof s.volume === 'number') {
      state.volume = s.volume;
      $('volume').value = s.volume * 100;
    }
    if (s.driveClientId) {
      state.driveClientId = s.driveClientId;
      $('gdrive-cid').value = s.driveClientId;
    }
    if (Array.isArray(s.eqGains) && s.eqGains.length === 8) state.eqGains = s.eqGains;
    if (typeof s.eqPreamp === 'number') state.eqPreamp = s.eqPreamp;
    if (typeof s.eqEnabled === 'boolean') state.eqEnabled = s.eqEnabled;
    if (s.eqPreset) state.eqPreset = s.eqPreset;
  } catch (e) {}
}
function saveSettings() {
  localStorage.setItem('retrobeat', JSON.stringify({
    theme: state.theme,
    viz: state.viz,
    volume: state.volume,
    driveClientId: state.driveClientId,
    eqGains: state.eqGains,
    eqPreamp: state.eqPreamp,
    eqEnabled: state.eqEnabled,
    eqPreset: state.eqPreset,
  }));
}

// ============================================
// THEMES
// ============================================
function setTheme(name) {
  state.theme = name;
  app.className = `theme-${name}`;
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === name);
  });
  // update phone status bar
  const themeColors = {
    classic: '#1a2a3a', bento: '#e8e8e8', neon: '#0a0024',
    aqua: '#a8c0e8', frutiger: '#87ceeb', vaporwave: '#ff71ce',
    metal: '#a8a8a8', luna: '#245edb',
    amber: '#1a0e00', milkdrop: '#0a0030', gameboy: '#306230', y2k: '#7d95b8',
  };
  document.querySelector('meta[name="theme-color"]').content = themeColors[name] || '#000';
  saveSettings();
}
document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => setTheme(s.dataset.theme));
});

// ============================================
// VISUALIZERS
// ============================================
const canvas = $('viz-canvas');
const vctx = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resizeCanvas).observe(canvas);
window.addEventListener('load', resizeCanvas);

function setViz(name) {
  state.viz = name;
  document.querySelectorAll('.viz-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.viz === name);
  });
  $('viz-mode-label').textContent = {
    bars: 'SPECTRUM', oscope: 'OSCILLOSCOPE', milkdrop: 'PLASMA',
    starfield: 'STARFIELD', matrix: 'MATRIX', tunnel: 'TUNNEL', fire: 'FIRE',
    waves: 'WAVEFORM', rings: 'RINGS', dna: 'DNA HELIX',
    vortex: 'VORTEX', lasers: 'LASERS', pixels: 'PIXELS'
  }[name] || name.toUpperCase();
  saveSettings();
}
document.querySelectorAll('.viz-tab').forEach(t => {
  t.addEventListener('click', () => setViz(t.dataset.viz));
});

// Starfield state
const stars = Array.from({length: 200}, () => ({
  x: (Math.random() - 0.5) * 2,
  y: (Math.random() - 0.5) * 2,
  z: Math.random(),
}));

// Matrix rain
let matrixCols = [];
function resetMatrix() {
  const rect = canvas.getBoundingClientRect();
  const colW = 14;
  matrixCols = [];
  for (let x = 0; x < rect.width; x += colW) {
    matrixCols.push({ x, y: Math.random() * rect.height, speed: 2 + Math.random() * 3 });
  }
}

// Fire buffer
let firePixels = null;
let fireW = 0, fireH = 0;
function resetFire() {
  const rect = canvas.getBoundingClientRect();
  fireW = Math.max(1, Math.floor(rect.width / 4));
  fireH = Math.max(1, Math.floor(rect.height / 4));
  firePixels = new Uint8Array(fireW * fireH);
}
const firePalette = Array.from({length: 256}, (_, i) => {
  // classic fire palette: black -> red -> orange -> yellow -> white
  if (i < 64)   return [i * 4, 0, 0];
  if (i < 128)  return [255, (i - 64) * 4, 0];
  if (i < 192)  return [255, 255, (i - 128) * 4];
  return [255, 255, 255];
});

let tunnelAngle = 0;
let plasmaT = 0;

// ---- Main draw loop ----
function draw() {
  requestAnimationFrame(draw);
  if (!analyser) {
    // idle: soft ambient
    idleDraw();
    return;
  }
  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(timeData);
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const accent = cssVar('--accent') || '#00ff4a';
  const lcd = cssVar('--lcd-fg') || accent;
  const bg = cssVar('--viz-bg') || '#000';

  switch (state.viz) {
    case 'bars':      drawBars(W, H, accent, bg); break;
    case 'oscope':    drawOscope(W, H, lcd, bg); break;
    case 'milkdrop':  drawPlasma(W, H); break;
    case 'starfield': drawStarfield(W, H, accent, bg); break;
    case 'matrix':    drawMatrix(W, H, lcd, bg); break;
    case 'tunnel':    drawTunnel(W, H, accent, bg); break;
    case 'fire':      drawFire(W, H); break;
    case 'waves':     drawWaves(W, H, accent, bg); break;
    case 'rings':     drawRings(W, H, accent, bg); break;
    case 'dna':       drawDNA(W, H, accent, bg); break;
    case 'vortex':    drawVortex(W, H, accent, bg); break;
    case 'lasers':    drawLasers(W, H, accent, bg); break;
    case 'pixels':    drawPixels(W, H, accent, bg); break;
  }
}
requestAnimationFrame(draw);

function idleDraw() {
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const bg = cssVar('--viz-bg') || '#000';
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const accent = cssVar('--accent') || '#00ff4a';
  vctx.fillStyle = accent;
  vctx.globalAlpha = 0.4 + 0.3 * Math.sin(Date.now() / 500);
  vctx.font = '16px monospace';
  vctx.textAlign = 'center';
  vctx.fillText('▸ PRESS PLAY ◂', W / 2, H / 2);
  vctx.globalAlpha = 1;
}

function cssVar(name) {
  const v = getComputedStyle(app).getPropertyValue(name).trim();
  // Strip gradients for canvas: take first color
  if (v.startsWith('linear') || v.startsWith('radial') || v.startsWith('repeating')) {
    const m = v.match(/#[0-9a-f]{3,8}|rgba?\([^)]+\)/i);
    return m ? m[0] : '#fff';
  }
  return v;
}

// ---- SPECTRUM BARS (classic Winamp) ----
function drawBars(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const bars = 48;
  const step = Math.floor(freqData.length / bars / 2);
  const barW = W / bars;
  const gap = Math.max(1, barW * 0.15);
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freqData[i * step + j];
    const avg = sum / step / 255;
    const h = avg * H * 0.95;
    // peak hold
    if (avg > peakData[i]) peakData[i] = avg;
    else peakData[i] *= 0.96;

    // gradient bar
    const x = i * barW + gap / 2;
    const bw = barW - gap;
    const grad = vctx.createLinearGradient(0, H, 0, H - h);
    grad.addColorStop(0, shift(color, -30));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, shift(color, 60));
    vctx.fillStyle = grad;
    // segmented LED look
    const segH = 4;
    const segs = Math.floor(h / segH);
    for (let s = 0; s < segs; s++) {
      const y = H - (s + 1) * segH + 1;
      vctx.fillRect(x, y, bw, segH - 1);
    }
    // peak line
    const py = H - peakData[i] * H * 0.95;
    vctx.fillStyle = shift(color, 80);
    vctx.fillRect(x, py, bw, 2);
  }
}

// ---- OSCILLOSCOPE ----
function drawOscope(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  // grid
  vctx.strokeStyle = hex2rgba(color, 0.12);
  vctx.lineWidth = 1;
  for (let x = 0; x < W; x += W / 10) {
    vctx.beginPath(); vctx.moveTo(x, 0); vctx.lineTo(x, H); vctx.stroke();
  }
  for (let y = 0; y < H; y += H / 6) {
    vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(W, y); vctx.stroke();
  }
  // wave
  vctx.strokeStyle = color;
  vctx.lineWidth = 2;
  vctx.shadowColor = color;
  vctx.shadowBlur = 8;
  vctx.beginPath();
  const slice = W / timeData.length;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i] / 128 - 1;
    const y = H / 2 + v * (H / 2) * 0.85;
    const x = i * slice;
    if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
  }
  vctx.stroke();
  vctx.shadowBlur = 0;
}

// ---- PLASMA (MilkDrop-style) ----
function drawPlasma(W, H) {
  plasmaT += 0.015;
  // bass-driven warp
  const bass = avgBand(0, 8) / 255;
  const treble = avgBand(60, 120) / 255;
  const img = vctx.createImageData(Math.floor(W / 3), Math.floor(H / 3));
  const iw = img.width, ih = img.height;
  const d = img.data;
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const cx = x - iw / 2, cy = y - ih / 2;
      const r = Math.sqrt(cx * cx + cy * cy);
      const a = Math.atan2(cy, cx);
      const v = Math.sin(r * 0.12 - plasmaT * 3 + bass * 5)
              + Math.sin(a * 4 + plasmaT * 2)
              + Math.sin((x + y) * 0.04 + plasmaT);
      const t = (v + 3) / 6; // 0..1
      // palette shift with treble
      const hue = (t * 360 + plasmaT * 30 + treble * 120) % 360;
      const [R, G, B] = hsl2rgb(hue, 0.85, 0.5);
      const i = (y * iw + x) * 4;
      d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255;
    }
  }
  // draw scaled up
  const tmp = document.createElement('canvas');
  tmp.width = iw; tmp.height = ih;
  tmp.getContext('2d').putImageData(img, 0, 0);
  vctx.imageSmoothingEnabled = true;
  vctx.drawImage(tmp, 0, 0, W, H);
}

// ---- STARFIELD ----
function drawStarfield(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.4);
  vctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const speed = 0.005 + (avgBand(0, 16) / 255) * 0.06;
  vctx.fillStyle = color;
  for (const s of stars) {
    s.z -= speed;
    if (s.z <= 0.01) {
      s.z = 1;
      s.x = (Math.random() - 0.5) * 2;
      s.y = (Math.random() - 0.5) * 2;
    }
    const px = (s.x / s.z) * W / 2 + cx;
    const py = (s.y / s.z) * H / 2 + cy;
    const size = (1 - s.z) * 3;
    if (px >= 0 && px < W && py >= 0 && py < H) {
      vctx.globalAlpha = 1 - s.z;
      vctx.fillRect(px, py, size, size);
    }
  }
  vctx.globalAlpha = 1;
}

// ---- MATRIX RAIN ----
function drawMatrix(W, H, color, bg) {
  if (matrixCols.length === 0) resetMatrix();
  vctx.fillStyle = hex2rgba(bg, 0.12);
  vctx.fillRect(0, 0, W, H);
  vctx.font = '14px monospace';
  const bass = avgBand(0, 16) / 255;
  for (const c of matrixCols) {
    const ch = String.fromCharCode(0x30A0 + Math.random() * 96 | 0);
    vctx.fillStyle = shift(color, 40);
    vctx.fillText(ch, c.x, c.y);
    vctx.fillStyle = color;
    vctx.fillText(String.fromCharCode(0x30A0 + Math.random() * 96 | 0), c.x, c.y - 14);
    c.y += c.speed + bass * 8;
    if (c.y > H + 20) c.y = -20;
  }
}

// ---- TUNNEL ----
function drawTunnel(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  tunnelAngle += 0.02 + (avgBand(0, 8) / 255) * 0.05;
  const rings = 24;
  const bass = avgBand(0, 16) / 255;
  for (let i = rings; i > 0; i--) {
    const t = i / rings;
    const r = (1 - t) * Math.min(W, H) * 0.7 + bass * 30;
    const sides = 8;
    vctx.strokeStyle = hex2rgba(shift(color, (i * 20) % 180), 1 - t);
    vctx.lineWidth = 2;
    vctx.beginPath();
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2 + tunnelAngle * (i % 2 === 0 ? 1 : -1);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (s === 0) vctx.moveTo(px, py); else vctx.lineTo(px, py);
    }
    vctx.stroke();
  }
}

// ---- FIRE ----
function drawFire(W, H) {
  if (!firePixels) resetFire();
  // seed bottom row with bass-reactive intensity
  const bass = avgBand(0, 16) / 255;
  for (let x = 0; x < fireW; x++) {
    const heat = 180 + Math.random() * 75 * (0.5 + bass);
    firePixels[(fireH - 1) * fireW + x] = Math.min(255, heat);
  }
  // propagate upward with cooling
  for (let y = 0; y < fireH - 1; y++) {
    for (let x = 0; x < fireW; x++) {
      const src = Math.min(fireW - 1, Math.max(0, x + (Math.random() * 3 | 0) - 1));
      const val = firePixels[(y + 1) * fireW + src];
      const cooled = Math.max(0, val - (Math.random() * 6 | 0));
      firePixels[y * fireW + x] = cooled;
    }
  }
  // render
  const img = vctx.createImageData(fireW, fireH);
  for (let i = 0; i < firePixels.length; i++) {
    const [r, g, b] = firePalette[firePixels[i]];
    const di = i * 4;
    img.data[di] = r;
    img.data[di + 1] = g;
    img.data[di + 2] = b;
    img.data[di + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = fireW; tmp.height = fireH;
  tmp.getContext('2d').putImageData(img, 0, 0);
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(tmp, 0, 0, W, H);
  vctx.imageSmoothingEnabled = true;
}

// ---- WAVES — scrolling persistent waveform (AVS-style) ----
let waveHistory = [];
function drawWaves(W, H, color, bg) {
  // persistence fade
  vctx.fillStyle = hex2rgba(bg, 0.15);
  vctx.fillRect(0, 0, W, H);
  // grid
  vctx.strokeStyle = hex2rgba(color, 0.1);
  vctx.lineWidth = 1;
  for (let y = 0; y < H; y += H / 8) {
    vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(W, y); vctx.stroke();
  }
  // capture current wave snapshot
  const snap = new Float32Array(64);
  const step = Math.floor(timeData.length / 64);
  for (let i = 0; i < 64; i++) snap[i] = (timeData[i * step] / 128 - 1);
  waveHistory.unshift(snap);
  if (waveHistory.length > 30) waveHistory.length = 30;
  // draw fading trail of past waves
  for (let h = waveHistory.length - 1; h >= 0; h--) {
    const alpha = 1 - h / waveHistory.length;
    vctx.strokeStyle = hex2rgba(color, alpha * 0.8);
    vctx.lineWidth = h === 0 ? 2.5 : 1;
    vctx.shadowColor = h === 0 ? color : 'transparent';
    vctx.shadowBlur = h === 0 ? 6 : 0;
    vctx.beginPath();
    const wave = waveHistory[h];
    for (let i = 0; i < wave.length; i++) {
      const x = (i / (wave.length - 1)) * W;
      const y = H / 2 + wave[i] * (H / 2) * 0.8 - h * 2;
      if (i === 0) vctx.moveTo(x, y); else vctx.lineTo(x, y);
    }
    vctx.stroke();
  }
  vctx.shadowBlur = 0;
}

// ---- RINGS — concentric bass-reactive circles ----
let ringPulses = [];
function drawRings(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.2);
  vctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const bass = avgBand(0, 8) / 255;
  const mid = avgBand(16, 48) / 255;
  // trigger new pulse on bass hits
  if (bass > 0.55 && (ringPulses.length === 0 || ringPulses[0].r > 40)) {
    ringPulses.unshift({ r: 0, intensity: bass });
  }
  // advance pulses
  for (const p of ringPulses) p.r += 4 + bass * 6;
  ringPulses = ringPulses.filter(p => p.r < Math.max(W, H));

  for (const p of ringPulses) {
    const alpha = Math.max(0, 1 - p.r / Math.max(W, H));
    vctx.strokeStyle = hex2rgba(color, alpha * p.intensity);
    vctx.lineWidth = 2 + p.intensity * 4;
    vctx.beginPath();
    vctx.arc(cx, cy, p.r, 0, Math.PI * 2);
    vctx.stroke();
  }
  // center dot reactive to mids
  vctx.fillStyle = color;
  vctx.shadowColor = color;
  vctx.shadowBlur = 15;
  vctx.beginPath();
  vctx.arc(cx, cy, 4 + mid * 20, 0, Math.PI * 2);
  vctx.fill();
  vctx.shadowBlur = 0;
}

// ---- DNA HELIX — Y2K rotating double-helix ----
let dnaAngle = 0;
function drawDNA(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const treble = avgBand(60, 120) / 255;
  dnaAngle += 0.03 + bass * 0.08;

  const cx = W / 2;
  const segments = 40;
  const amp = W * 0.22 + bass * 20;
  const nodes = [];
  // compute both strands
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const y = t * H;
    const phase = t * Math.PI * 3 + dnaAngle;
    const x1 = cx + Math.sin(phase) * amp;
    const x2 = cx + Math.sin(phase + Math.PI) * amp;
    const z1 = Math.cos(phase);   // depth cue
    const z2 = Math.cos(phase + Math.PI);
    nodes.push({ x1, x2, y, z1, z2 });
  }
  // rungs
  for (let i = 0; i < nodes.length; i += 2) {
    const n = nodes[i];
    const avgZ = (n.z1 + n.z2) / 2;
    vctx.strokeStyle = hex2rgba(shift(color, 40 * avgZ | 0), 0.4 + avgZ * 0.3);
    vctx.lineWidth = 1.5;
    vctx.beginPath();
    vctx.moveTo(n.x1, n.y);
    vctx.lineTo(n.x2, n.y);
    vctx.stroke();
  }
  // strand 1
  vctx.strokeStyle = color;
  vctx.lineWidth = 3;
  vctx.shadowColor = color;
  vctx.shadowBlur = 8;
  vctx.beginPath();
  nodes.forEach((n, i) => i === 0 ? vctx.moveTo(n.x1, n.y) : vctx.lineTo(n.x1, n.y));
  vctx.stroke();
  // strand 2 — accent-shifted
  vctx.strokeStyle = shift(color, 80);
  vctx.beginPath();
  nodes.forEach((n, i) => i === 0 ? vctx.moveTo(n.x2, n.y) : vctx.lineTo(n.x2, n.y));
  vctx.stroke();
  vctx.shadowBlur = 0;

  // nucleotide dots pulse on treble
  const dotR = 3 + treble * 8;
  for (const n of nodes) {
    vctx.fillStyle = n.z1 > 0 ? color : shift(color, -60);
    vctx.beginPath(); vctx.arc(n.x1, n.y, dotR * (0.6 + Math.abs(n.z1) * 0.4), 0, Math.PI * 2); vctx.fill();
    vctx.fillStyle = n.z2 > 0 ? shift(color, 80) : shift(color, -60);
    vctx.beginPath(); vctx.arc(n.x2, n.y, dotR * (0.6 + Math.abs(n.z2) * 0.4), 0, Math.PI * 2); vctx.fill();
  }
}

// ---- VORTEX — swirling particles (Y2K screensaver) ----
const vortexParticles = Array.from({length: 180}, () => ({
  angle: Math.random() * Math.PI * 2,
  radius: Math.random() * 0.5 + 0.1,
  speed: 0.01 + Math.random() * 0.04,
  size: 1 + Math.random() * 2,
  hueOffset: Math.random() * 360,
}));
function drawVortex(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.18);
  vctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2;
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;
  const pull = 0.998 - bass * 0.004; // bass sucks particles inward

  for (const p of vortexParticles) {
    p.angle += p.speed + mid * 0.04;
    p.radius *= pull;
    if (p.radius < 0.05) p.radius = 1;
    const x = cx + Math.cos(p.angle) * p.radius * R;
    const y = cy + Math.sin(p.angle) * p.radius * R;
    const brightness = 1 - p.radius;
    vctx.fillStyle = hex2rgba(shift(color, (p.hueOffset % 120) - 60 | 0), brightness);
    vctx.beginPath();
    vctx.arc(x, y, p.size + bass * 2, 0, Math.PI * 2);
    vctx.fill();
  }
}

// ---- LASERS — rave-style radiating beams ----
let laserAngle = 0;
function drawLasers(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.25);
  vctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.85;
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;
  const treble = avgBand(60, 120) / 255;
  laserAngle += 0.015 + bass * 0.05;

  const beams = 12;
  const maxLen = Math.hypot(W, H);
  for (let i = 0; i < beams; i++) {
    const spread = Math.PI * 0.9;
    const base = -Math.PI / 2 - spread / 2;
    const a = base + (i / (beams - 1)) * spread + Math.sin(laserAngle + i * 0.4) * 0.2;
    const len = maxLen * (0.6 + 0.4 * Math.sin(laserAngle * 2 + i));
    const x2 = cx + Math.cos(a) * len;
    const y2 = cy + Math.sin(a) * len;
    const beamColor = i % 3 === 0 ? color : (i % 3 === 1 ? shift(color, 90) : shift(color, -60));
    // beam glow
    const grad = vctx.createLinearGradient(cx, cy, x2, y2);
    grad.addColorStop(0, hex2rgba(beamColor, 0.9));
    grad.addColorStop(1, hex2rgba(beamColor, 0));
    vctx.strokeStyle = grad;
    vctx.lineWidth = 2 + mid * 6;
    vctx.shadowColor = beamColor;
    vctx.shadowBlur = 12;
    vctx.beginPath();
    vctx.moveTo(cx, cy);
    vctx.lineTo(x2, y2);
    vctx.stroke();
  }
  vctx.shadowBlur = 0;
  // emitter dot
  vctx.fillStyle = color;
  vctx.shadowColor = color;
  vctx.shadowBlur = 20;
  vctx.beginPath();
  vctx.arc(cx, cy, 6 + treble * 10, 0, Math.PI * 2);
  vctx.fill();
  vctx.shadowBlur = 0;
}

// ---- PIXELS — 8-bit spectrogram grid ----
let pixelHistory = [];
function drawPixels(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const cols = 32;
  const rows = 20;
  const cellW = W / cols;
  const cellH = H / rows;
  // compute current column
  const col = new Uint8Array(rows);
  const step = Math.floor(freqData.length / rows / 2);
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freqData[r * step + j];
    col[rows - 1 - r] = sum / step;  // bass at bottom
  }
  pixelHistory.unshift(col);
  if (pixelHistory.length > cols) pixelHistory.length = cols;
  // draw grid — newer columns on right
  for (let c = 0; c < pixelHistory.length; c++) {
    const x = W - (c + 1) * cellW;
    const column = pixelHistory[c];
    for (let r = 0; r < rows; r++) {
      const v = column[r] / 255;
      if (v < 0.08) continue;
      // palette: bass = warm, treble = cool
      let px;
      if (r > rows * 0.66)      px = shift(color, -40); // bass band (darker)
      else if (r > rows * 0.33) px = color;
      else                      px = shift(color, 80);  // treble (brighter)
      vctx.fillStyle = hex2rgba(px, v);
      vctx.fillRect(Math.floor(x) + 1, Math.floor(r * cellH) + 1, Math.ceil(cellW) - 2, Math.ceil(cellH) - 2);
    }
  }
}

// ---- helpers ----
function avgBand(lo, hi) {
  let sum = 0;
  const end = Math.min(hi, freqData.length);
  for (let i = lo; i < end; i++) sum += freqData[i];
  return sum / Math.max(1, end - lo);
}
function hex2rgba(hex, a) {
  if (hex.startsWith('rgba')) return hex;
  if (hex.startsWith('rgb(')) return hex.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.substr(0, 2), 16);
  const g = parseInt(full.substr(2, 2), 16);
  const b = parseInt(full.substr(4, 2), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function shift(hex, amt) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = Math.max(0, Math.min(255, parseInt(full.substr(0, 2), 16) + amt));
  const g = Math.max(0, Math.min(255, parseInt(full.substr(2, 2), 16) + amt));
  const b = Math.max(0, Math.min(255, parseInt(full.substr(4, 2), 16) + amt));
  return `rgb(${r},${g},${b})`;
}
function hsl2rgb(h, s, l) {
  h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// ============================================
// TRANSPORT
// ============================================
$('play-btn').addEventListener('click', async () => {
  if (state.playlist.length === 0) return flash('Playlist empty');
  if (state.currentIndex < 0) state.currentIndex = 0;
  initAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!audio.src) loadTrack(state.currentIndex);
  try { await audio.play(); } catch (e) { flash('Tap play again'); }
});
$('pause-btn').addEventListener('click', () => audio.pause());
$('stop-btn').addEventListener('click', () => { audio.pause(); audio.currentTime = 0; });
$('prev-btn').addEventListener('click', prevTrack);
$('next-btn').addEventListener('click', nextTrack);
$('shuffle-btn').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('shuffle-btn').classList.toggle('active', state.shuffle);
});
$('repeat-btn').addEventListener('click', () => {
  const modes = ['off', 'all', 'one'];
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % 3];
  $('repeat-btn').classList.toggle('active', state.repeat !== 'off');
  $('repeat-btn').textContent = state.repeat === 'one' ? '↻1' : '↻';
});

audio.addEventListener('ended', () => {
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  nextTrack(true);
});
audio.addEventListener('timeupdate', () => {
  if (!isFinite(audio.duration)) return;
  $('track-time').textContent = fmtTime(audio.currentTime);
  $('track-duration').textContent = fmtTime(audio.duration);
  $('seek').value = (audio.currentTime / audio.duration) * 100 || 0;
});
audio.addEventListener('loadedmetadata', () => {
  $('track-duration').textContent = fmtTime(audio.duration);
});
audio.addEventListener('error', () => {
  flash('Playback error — try another track');
});

$('seek').addEventListener('input', (e) => {
  if (isFinite(audio.duration)) {
    audio.currentTime = (e.target.value / 100) * audio.duration;
  }
});
$('volume').addEventListener('input', (e) => {
  state.volume = e.target.value / 100;
  audio.volume = state.volume;
  saveSettings();
});
audio.volume = state.volume;

function prevTrack() {
  if (state.playlist.length === 0) return;
  state.currentIndex = (state.currentIndex - 1 + state.playlist.length) % state.playlist.length;
  loadTrack(state.currentIndex, true);
}
function nextTrack(autoplay = false) {
  if (state.playlist.length === 0) return;
  if (state.shuffle) {
    state.currentIndex = Math.floor(Math.random() * state.playlist.length);
  } else {
    const next = state.currentIndex + 1;
    if (next >= state.playlist.length) {
      if (state.repeat === 'all') state.currentIndex = 0;
      else { audio.pause(); return; }
    } else {
      state.currentIndex = next;
    }
  }
  loadTrack(state.currentIndex, autoplay || !audio.paused);
}

async function loadTrack(idx, autoplay = true) {
  const t = state.playlist[idx];
  if (!t) return;
  $('track-title').querySelector('span').textContent = t.name;
  renderPlaylist();
  try {
    if (t.source === 'drive') {
      // Fetch via drive token; create blob URL for seek support
      if (!state.driveToken) return flash('Drive token expired');
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${t.driveId}?alt=media`, {
        headers: { Authorization: `Bearer ${state.driveToken}` }
      });
      if (!res.ok) return flash('Drive fetch failed');
      const blob = await res.blob();
      if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
      t.blobUrl = URL.createObjectURL(blob);
      audio.src = t.blobUrl;
    } else {
      audio.src = t.url;
    }
    if (autoplay) {
      initAudioGraph();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await audio.play();
    }
  } catch (e) {
    flash('Load failed: ' + e.message);
  }
}

function fmtTime(s) {
  if (!isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function flash(msg) {
  const el = $('track-title').querySelector('span');
  const orig = el.textContent;
  el.textContent = `⚠ ${msg}`;
  setTimeout(() => { el.textContent = orig; }, 2500);
}

// ============================================
// PLAYLIST UI
// ============================================
function renderPlaylist() {
  const ol = $('playlist');
  if (state.playlist.length === 0) {
    ol.innerHTML = '<li class="pl-empty">&lt;playlist empty — add files&gt;</li>';
    return;
  }
  ol.innerHTML = state.playlist.map((t, i) => `
    <li class="${i === state.currentIndex ? 'active' : ''}" data-idx="${i}">
      <span class="pl-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="pl-name">${escapeHtml(t.name)}</span>
      <span class="pl-src">${t.source === 'drive' ? '☁' : '◦'}</span>
    </li>
  `).join('');
  ol.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('click', () => {
      state.currentIndex = Number(li.dataset.idx);
      loadTrack(state.currentIndex, true);
    });
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Local file loading ----
$('load-local-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    state.playlist.push({
      id: `l_${Date.now()}_${Math.random()}`,
      name: f.name.replace(/\.[^.]+$/, ''),
      source: 'local',
      url: URL.createObjectURL(f),
    });
  }
  if (state.currentIndex < 0 && state.playlist.length > 0) state.currentIndex = 0;
  renderPlaylist();
  e.target.value = '';
});

// Drag + drop
['dragenter', 'dragover'].forEach(ev => {
  document.addEventListener(ev, e => { e.preventDefault(); });
});
document.addEventListener('drop', e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('audio'));
  for (const f of files) {
    state.playlist.push({
      id: `l_${Date.now()}_${Math.random()}`,
      name: f.name.replace(/\.[^.]+$/, ''),
      source: 'local',
      url: URL.createObjectURL(f),
    });
  }
  if (state.currentIndex < 0 && state.playlist.length > 0) state.currentIndex = 0;
  renderPlaylist();
});

$('clear-pl-btn').addEventListener('click', () => {
  state.playlist.forEach(t => { if (t.url?.startsWith('blob:')) URL.revokeObjectURL(t.url); });
  state.playlist = [];
  state.currentIndex = -1;
  audio.pause();
  audio.src = '';
  renderPlaylist();
});

// ============================================
// GOOGLE DRIVE
// ============================================
$('load-drive-btn').addEventListener('click', connectDrive);

async function connectDrive() {
  const cid = state.driveClientId || $('gdrive-cid').value.trim();
  if (!cid) {
    flash('Set Drive Client ID in menu');
    openDrawer();
    return;
  }
  state.driveClientId = cid;
  saveSettings();

  if (!window.google?.accounts?.oauth2) {
    return flash('Google SDK still loading…');
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    callback: async (resp) => {
      if (resp.error) return flash('Drive auth denied');
      state.driveToken = resp.access_token;
      await listDriveAudio();
    },
  });
  tokenClient.requestAccessToken({ prompt: '' });
}

async function listDriveAudio() {
  flash('Listing Drive audio…');
  const q = encodeURIComponent("mimeType contains 'audio/' and trashed=false");
  const fields = encodeURIComponent('files(id,name,mimeType,size)');
  let added = 0;
  let pageToken = '';
  for (let i = 0; i < 5; i++) { // cap at 5 pages (~500 files)
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields},nextPageToken&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${state.driveToken}` } });
    if (!res.ok) { flash('Drive list failed'); return; }
    const data = await res.json();
    for (const f of data.files || []) {
      if (!state.playlist.find(t => t.driveId === f.id)) {
        state.playlist.push({
          id: `d_${f.id}`,
          name: f.name.replace(/\.[^.]+$/, ''),
          source: 'drive',
          driveId: f.id,
          size: f.size,
        });
        added++;
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  if (state.currentIndex < 0 && state.playlist.length > 0) state.currentIndex = 0;
  renderPlaylist();
  flash(`Added ${added} Drive track${added === 1 ? '' : 's'}`);
}

// ============================================
// DRAWER
// ============================================
function openDrawer() { $('drawer').classList.remove('hidden'); }
function closeDrawer() { $('drawer').classList.add('hidden'); }
$('menu-btn').addEventListener('click', openDrawer);
$('close-drawer').addEventListener('click', closeDrawer);
$('gdrive-cid').addEventListener('change', (e) => {
  state.driveClientId = e.target.value.trim();
  saveSettings();
});

// ============================================
// PWA INSTALL
// ============================================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
$('install-btn').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    flash(outcome === 'accepted' ? 'Installed!' : 'Install dismissed');
  } else {
    // iOS: show manual instructions
    flash('iOS: Share → Add to Home Screen');
  }
});

// register SW
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ============================================
// 8-BAND EQ
// ============================================
const EQ_PRESETS = {
  flat:      [0, 0, 0, 0, 0, 0, 0, 0],
  rock:      [5, 3, -2, -4, -1, 2, 5, 6],
  pop:       [-1, 2, 4, 5, 3, 0, -1, -1],
  dance:     [7, 5, 2, 0, -1, 1, 4, 6],
  jazz:      [4, 3, 1, 2, -2, -1, 0, 3],
  classical: [4, 3, 0, 0, 0, 0, -3, -4],
  bass:      [8, 6, 4, 2, 0, 0, 0, 0],
  vocal:     [-2, -3, 0, 3, 4, 3, 1, -1],
  trance:    [6, 4, 1, -1, -1, 2, 5, 7],
};

function applyEQState() {
  if (!audioCtx) return;
  // If disabled, set all band gains to 0 (bypass) but keep nodes connected
  for (let i = 0; i < eqFilters.length; i++) {
    eqFilters[i].gain.value = state.eqEnabled ? state.eqGains[i] : 0;
  }
  // Preamp in dB -> gain multiplier
  const preampGain = state.eqEnabled ? Math.pow(10, state.eqPreamp / 20) : 1;
  if (preampNode) preampNode.gain.value = preampGain;
}

function buildEQBands() {
  const container = $('eq-bands');
  container.innerHTML = '';
  EQ_FREQS.forEach((freq, i) => {
    const div = document.createElement('div');
    div.className = 'eq-band';
    const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
    div.innerHTML = `
      <span class="eq-band-val" id="eq-val-${i}">${state.eqGains[i].toFixed(0)}</span>
      <input type="range" class="eq-band-slider" id="eq-slider-${i}"
             min="-12" max="12" step="0.5" value="${state.eqGains[i]}" orient="vertical" />
      <span class="eq-band-hz">${label}</span>
    `;
    container.appendChild(div);
    const slider = div.querySelector('input');
    const valEl  = div.querySelector('.eq-band-val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      state.eqGains[i] = v;
      valEl.textContent = v.toFixed(0);
      state.eqPreset = 'custom';
      $('eq-preset').value = 'flat'; // no custom in select — just deselect
      applyEQState();
      saveSettings();
    });
  });
}

function refreshEQUI() {
  for (let i = 0; i < 8; i++) {
    const sl = $(`eq-slider-${i}`);
    const vl = $(`eq-val-${i}`);
    if (sl) sl.value = state.eqGains[i];
    if (vl) vl.textContent = state.eqGains[i].toFixed(0);
  }
  $('eq-preamp').value = state.eqPreamp;
  $('eq-preamp-val').textContent = `${state.eqPreamp > 0 ? '+' : ''}${state.eqPreamp.toFixed(1)}dB`;
  $('eq-enable').checked = state.eqEnabled;
}

$('eq-btn').addEventListener('click', () => {
  $('eq-panel').classList.remove('hidden');
  refreshEQUI();
});
$('eq-close').addEventListener('click', () => $('eq-panel').classList.add('hidden'));

$('eq-preset').addEventListener('change', (e) => {
  const preset = e.target.value;
  if (EQ_PRESETS[preset]) {
    state.eqGains = [...EQ_PRESETS[preset]];
    state.eqPreset = preset;
    applyEQState();
    refreshEQUI();
    saveSettings();
  }
});

$('eq-enable').addEventListener('change', (e) => {
  state.eqEnabled = e.target.checked;
  applyEQState();
  saveSettings();
});

$('eq-preamp').addEventListener('input', (e) => {
  state.eqPreamp = parseFloat(e.target.value);
  $('eq-preamp-val').textContent = `${state.eqPreamp > 0 ? '+' : ''}${state.eqPreamp.toFixed(1)}dB`;
  applyEQState();
  saveSettings();
});

$('eq-reset').addEventListener('click', () => {
  state.eqGains = [0,0,0,0,0,0,0,0];
  state.eqPreamp = 0;
  state.eqPreset = 'flat';
  $('eq-preset').value = 'flat';
  applyEQState();
  refreshEQUI();
  saveSettings();
});

// ============================================
// FULLSCREEN viz
// ============================================
$('viz-fs-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});

function toggleFullscreen() {
  const panel = $('viz-panel');
  state.fullscreen = !state.fullscreen;
  panel.classList.toggle('fullscreen', state.fullscreen);
  // Try real browser fullscreen for immersive experience
  if (state.fullscreen) {
    if (panel.requestFullscreen) panel.requestFullscreen().catch(() => {});
    else if (panel.webkitRequestFullscreen) panel.webkitRequestFullscreen();
  } else {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  // Force canvas resize after layout settles
  setTimeout(resizeCanvas, 50);
  setTimeout(resizeCanvas, 300);
}

// Sync state if user exits FS via OS
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.fullscreen) {
    state.fullscreen = false;
    $('viz-panel').classList.remove('fullscreen');
    setTimeout(resizeCanvas, 50);
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && state.fullscreen) {
    state.fullscreen = false;
    $('viz-panel').classList.remove('fullscreen');
    setTimeout(resizeCanvas, 50);
  }
});

// Double-tap viz to toggle fullscreen as well
let lastTapTime = 0;
$('viz-panel').addEventListener('click', (e) => {
  // ignore fullscreen button taps (already handled)
  if (e.target.closest('#viz-fs-btn')) return;
  const now = Date.now();
  if (now - lastTapTime < 400) toggleFullscreen();
  lastTapTime = now;
});

// ============================================
// INIT
// ============================================
loadSettings();
renderPlaylist();
setTheme(state.theme || 'classic');
setViz(state.viz || 'bars');
buildEQBands();
$('eq-preset').value = state.eqPreset in EQ_PRESETS ? state.eqPreset : 'flat';

// Media session (lock screen controls on phones)
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(true));
}
audio.addEventListener('play', () => {
  if ('mediaSession' in navigator) {
    const t = state.playlist[state.currentIndex];
    if (t) navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name, artist: 'RetroBeat', album: 'Now Playing',
    });
  }
});