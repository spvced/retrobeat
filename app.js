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
// PERSISTENT PLAYLIST (IndexedDB for files, localStorage for drive refs)
// ============================================
let idb = null;
function openIDB() {
  return new Promise((resolve, reject) => {
    if (idb) return resolve(idb);
    const req = indexedDB.open('retrobeat-db', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { idb = e.target.result; resolve(idb); };
    req.onerror = () => reject(req.error);
  });
}

async function idbPutFile(id, name, blob) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ id, name, blob, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetFile(id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteFile(id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbListFiles() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror  = () => reject(req.error);
  });
}

async function idbClearFiles() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Save the playlist metadata (everything except blob URLs) for next launch
function savePlaylistMeta() {
  // only drive entries + local entries that have persistentId are saved
  const meta = state.playlist.map(t => ({
    id: t.id,
    name: t.name,
    source: t.source,
    driveId: t.driveId,
    persistentId: t.persistentId,  // IDB key if local
  }));
  localStorage.setItem('retrobeat-playlist', JSON.stringify({
    tracks: meta,
    currentIndex: state.currentIndex,
  }));
}

// Rebuild playlist on startup — recreate blob URLs for local files
async function restorePlaylist() {
  try {
    const raw = localStorage.getItem('retrobeat-playlist');
    if (!raw) return;
    const saved = JSON.parse(raw);
    const restored = [];
    for (const t of saved.tracks || []) {
      if (t.source === 'local' && t.persistentId) {
        const rec = await idbGetFile(t.persistentId).catch(() => null);
        if (rec && rec.blob) {
          restored.push({
            id: t.id,
            name: t.name,
            source: 'local',
            url: URL.createObjectURL(rec.blob),
            persistentId: t.persistentId,
          });
        }
      } else if (t.source === 'drive' && t.driveId) {
        // Store the reference; playback will trigger reauth if needed
        restored.push({
          id: t.id,
          name: t.name,
          source: 'drive',
          driveId: t.driveId,
        });
      }
    }
    state.playlist = restored;
    if (typeof saved.currentIndex === 'number' && saved.currentIndex < restored.length) {
      state.currentIndex = saved.currentIndex;
    }
  } catch (e) {
    console.warn('restorePlaylist failed', e);
  }
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
    vortex: 'VORTEX', lasers: 'LASERS', pixels: 'PIXELS',
    pacman: 'PAC-MAN', tetris: 'TETRIS', pong: 'PONG',
    dvd: 'DVD LOGO', rainbow: 'RAINBOW RD', banana: 'DANCING BANANA'
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
    case 'pacman':    drawPacman(W, H, accent, bg); break;
    case 'tetris':    drawTetris(W, H, accent, bg); break;
    case 'pong':      drawPong(W, H, accent, bg); break;
    case 'dvd':       drawDVD(W, H, accent, bg); break;
    case 'rainbow':   drawRainbow(W, H, accent, bg); break;
    case 'banana':    drawBanana(W, H, accent, bg); break;
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

// ---- PAC-MAN — chomps across the screen eating dots, reacts to bass ----
const pacman = { x: -40, y: 0, mouth: 0, dots: [], ghosts: [] };
function drawPacman(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.4);
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;
  pacman.y = H * 0.5;

  // spawn dots
  if (pacman.dots.length < 8 && Math.random() < 0.05) {
    pacman.dots.push({ x: W + Math.random() * 40, y: H * (0.2 + Math.random() * 0.6), size: 3 + Math.random() * 3 });
  }
  // spawn ghosts on big hits
  if (mid > 0.55 && pacman.ghosts.length < 3 && Math.random() < 0.08) {
    const colors = ['#ff0000', '#ffb8de', '#00ffff', '#ffb852'];
    pacman.ghosts.push({ x: W + 30, y: H * (0.2 + Math.random() * 0.6), color: colors[Math.floor(Math.random() * 4)] });
  }

  // move
  const speed = 2 + bass * 8;
  pacman.x += speed;
  if (pacman.x > W + 40) pacman.x = -40;
  pacman.mouth = (pacman.mouth + 0.2 + bass * 0.4) % (Math.PI * 2);

  for (const d of pacman.dots) d.x -= speed;
  pacman.dots = pacman.dots.filter(d => {
    if (Math.hypot(d.x - pacman.x, d.y - pacman.y) < 20) return false; // eaten
    return d.x > -10;
  });
  for (const g of pacman.ghosts) g.x -= speed * 0.7;
  pacman.ghosts = pacman.ghosts.filter(g => g.x > -30);

  // dots
  vctx.fillStyle = '#ffeb99';
  for (const d of pacman.dots) {
    vctx.beginPath(); vctx.arc(d.x, d.y, d.size, 0, Math.PI * 2); vctx.fill();
  }

  // ghosts
  for (const g of pacman.ghosts) {
    vctx.fillStyle = g.color;
    vctx.beginPath();
    vctx.arc(g.x, g.y, 18, Math.PI, 0);
    vctx.lineTo(g.x + 18, g.y + 18);
    // wavy bottom
    for (let i = 3; i >= 0; i--) {
      vctx.lineTo(g.x + (i * 9 - 13.5), g.y + (i % 2 === 0 ? 18 : 12));
    }
    vctx.closePath(); vctx.fill();
    // eyes
    vctx.fillStyle = '#fff';
    vctx.beginPath(); vctx.arc(g.x - 6, g.y - 2, 4, 0, Math.PI * 2); vctx.fill();
    vctx.beginPath(); vctx.arc(g.x + 6, g.y - 2, 4, 0, Math.PI * 2); vctx.fill();
    vctx.fillStyle = '#0000ff';
    vctx.beginPath(); vctx.arc(g.x - 6, g.y - 2, 2, 0, Math.PI * 2); vctx.fill();
    vctx.beginPath(); vctx.arc(g.x + 6, g.y - 2, 2, 0, Math.PI * 2); vctx.fill();
  }

  // pac-man himself
  const open = 0.15 + (Math.sin(pacman.mouth) * 0.5 + 0.5) * 0.6;
  vctx.fillStyle = '#ffeb3b';
  vctx.shadowColor = '#ffeb3b'; vctx.shadowBlur = 10;
  vctx.beginPath();
  vctx.arc(pacman.x, pacman.y, 22, open, -open);
  vctx.lineTo(pacman.x, pacman.y);
  vctx.closePath(); vctx.fill();
  vctx.shadowBlur = 0;
  // eye
  vctx.fillStyle = '#000';
  vctx.beginPath(); vctx.arc(pacman.x - 2, pacman.y - 10, 3, 0, Math.PI * 2); vctx.fill();
}

// ---- TETRIS — falling blocks driven by frequency ranges ----
const TETRIS_COLORS = ['#00f0f0', '#f0f000', '#a000f0', '#00f000', '#f00000', '#0000f0', '#f0a000'];
let tetrisBoard = null;
let tetrisCols = 10;
let tetrisRows = 16;
let tetrisTick = 0;
function initTetris() {
  tetrisBoard = [];
  for (let r = 0; r < tetrisRows; r++) tetrisBoard.push(new Array(tetrisCols).fill(null));
}
function drawTetris(W, H, color, bg) {
  if (!tetrisBoard) initTetris();
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;

  tetrisTick += 1 + bass * 2;
  // drop rows + spawn when tick hits
  if (tetrisTick > 20) {
    tetrisTick = 0;
    // clear full rows
    tetrisBoard = tetrisBoard.filter(row => row.some(c => c === null));
    while (tetrisBoard.length < tetrisRows) tetrisBoard.unshift(new Array(tetrisCols).fill(null));

    // seed some blocks in top row based on spectrum
    for (let c = 0; c < tetrisCols; c++) {
      const bucket = Math.floor((c / tetrisCols) * 64);
      const energy = freqData[bucket] / 255;
      if (energy > 0.35 + Math.random() * 0.2) {
        tetrisBoard[0][c] = TETRIS_COLORS[bucket % TETRIS_COLORS.length];
      }
    }
    // gravity: shift blocks down
    for (let r = tetrisRows - 1; r > 0; r--) {
      for (let c = 0; c < tetrisCols; c++) {
        if (tetrisBoard[r][c] === null && tetrisBoard[r - 1][c] !== null) {
          tetrisBoard[r][c] = tetrisBoard[r - 1][c];
          tetrisBoard[r - 1][c] = null;
        }
      }
    }
  }

  const cellSize = Math.min(W / tetrisCols, H / tetrisRows);
  const offsetX = (W - cellSize * tetrisCols) / 2;
  const offsetY = H - cellSize * tetrisRows;
  for (let r = 0; r < tetrisRows; r++) {
    for (let c = 0; c < tetrisCols; c++) {
      const cell = tetrisBoard[r][c];
      if (!cell) continue;
      const x = offsetX + c * cellSize;
      const y = offsetY + r * cellSize;
      vctx.fillStyle = cell;
      vctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      // inner highlight
      vctx.fillStyle = 'rgba(255,255,255,0.35)';
      vctx.fillRect(x + 2, y + 2, cellSize - 4, 3);
    }
  }
}

// ---- PONG — two paddles rally, ball reacts to beat ----
const pong = {
  ball: { x: 0, y: 0, vx: 3, vy: 2 },
  p1: 0.5, p2: 0.5, score1: 0, score2: 0, init: false,
};
function drawPong(W, H, color, bg) {
  if (!pong.init) { pong.ball.x = W/2; pong.ball.y = H/2; pong.init = true; }
  vctx.fillStyle = hex2rgba(bg, 0.6);
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const treble = avgBand(60, 120) / 255;

  // dashed center line
  vctx.strokeStyle = color;
  vctx.lineWidth = 2;
  vctx.setLineDash([6, 6]);
  vctx.beginPath(); vctx.moveTo(W/2, 0); vctx.lineTo(W/2, H); vctx.stroke();
  vctx.setLineDash([]);

  // track paddles toward ball + noise
  const targetP1 = pong.ball.y / H;
  const targetP2 = pong.ball.y / H + Math.sin(Date.now() / 500) * 0.1;
  pong.p1 += (targetP1 - pong.p1) * (0.08 + treble * 0.08);
  pong.p2 += (targetP2 - pong.p2) * (0.08 + treble * 0.08);

  const padH = H * 0.16;
  const padW = 6;
  vctx.fillStyle = color;
  vctx.fillRect(10, pong.p1 * H - padH/2, padW, padH);
  vctx.fillRect(W - 10 - padW, pong.p2 * H - padH/2, padW, padH);

  // ball physics with bass-scaled speed
  const speed = 1 + bass * 5;
  pong.ball.x += pong.ball.vx * speed;
  pong.ball.y += pong.ball.vy * speed;
  if (pong.ball.y < 5 || pong.ball.y > H - 5) pong.ball.vy *= -1;
  // paddle collisions
  if (pong.ball.x < 20 && Math.abs(pong.ball.y - pong.p1 * H) < padH/2) { pong.ball.vx = Math.abs(pong.ball.vx); pong.ball.vy += (Math.random() - 0.5) * 2; }
  if (pong.ball.x > W - 20 && Math.abs(pong.ball.y - pong.p2 * H) < padH/2) { pong.ball.vx = -Math.abs(pong.ball.vx); pong.ball.vy += (Math.random() - 0.5) * 2; }
  if (pong.ball.x < -10) { pong.score2++; pong.ball.x = W/2; pong.ball.y = H/2; pong.ball.vx = 3; }
  if (pong.ball.x > W + 10) { pong.score1++; pong.ball.x = W/2; pong.ball.y = H/2; pong.ball.vx = -3; }

  // ball
  vctx.shadowColor = color; vctx.shadowBlur = 8;
  vctx.fillRect(pong.ball.x - 5, pong.ball.y - 5, 10, 10);
  vctx.shadowBlur = 0;

  // scores
  vctx.font = 'bold 28px monospace';
  vctx.fillStyle = hex2rgba(color, 0.5);
  vctx.textAlign = 'center';
  vctx.fillText(pong.score1, W * 0.3, 36);
  vctx.fillText(pong.score2, W * 0.7, 36);
}

// ---- DVD LOGO — bounces around, beat colors change ----
const dvd = { x: 100, y: 100, vx: 2, vy: 1.5, hue: 0, hits: 0 };
function drawDVD(W, H, color, bg) {
  vctx.fillStyle = hex2rgba(bg, 0.5);
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const speed = 1 + bass * 4;
  dvd.x += dvd.vx * speed;
  dvd.y += dvd.vy * speed;

  const boxW = 110, boxH = 50;
  let corner = false;
  if (dvd.x < 0) { dvd.x = 0; dvd.vx = Math.abs(dvd.vx); corner = true; }
  if (dvd.x + boxW > W) { dvd.x = W - boxW; dvd.vx = -Math.abs(dvd.vx); corner = true; }
  if (dvd.y < 0) { dvd.y = 0; dvd.vy = Math.abs(dvd.vy); corner = true; }
  if (dvd.y + boxH > H) { dvd.y = H - boxH; dvd.vy = -Math.abs(dvd.vy); corner = true; }
  if (corner) { dvd.hue = (dvd.hue + 47) % 360; dvd.hits++; }

  const [r, g, b] = hsl2rgb(dvd.hue, 0.9, 0.6);
  vctx.fillStyle = `rgb(${r},${g},${b})`;
  vctx.shadowColor = `rgb(${r},${g},${b})`;
  vctx.shadowBlur = 12;
  // pill shape
  vctx.beginPath();
  vctx.ellipse(dvd.x + boxW/2, dvd.y + boxH/2, boxW/2, boxH/2, 0, 0, Math.PI * 2);
  vctx.fill();
  vctx.shadowBlur = 0;
  // DVD text
  vctx.fillStyle = '#000';
  vctx.font = 'bold 24px Arial';
  vctx.textAlign = 'center';
  vctx.textBaseline = 'middle';
  vctx.fillText('DVD', dvd.x + boxW/2, dvd.y + boxH/2 - 2);
  vctx.font = 'bold 10px Arial';
  vctx.fillText('VIDEO', dvd.x + boxW/2, dvd.y + boxH/2 + 14);
  vctx.textBaseline = 'alphabetic';
}

// ---- RAINBOW ROAD — Mario Kart style perspective road ----
let rrOffset = 0;
function drawRainbow(W, H, color, bg) {
  vctx.fillStyle = '#000';
  vctx.fillRect(0, 0, W, H);
  // stars
  vctx.fillStyle = '#fff';
  for (let i = 0; i < 40; i++) {
    const x = (i * 137.5) % W;
    const y = ((i * 91.7 + Date.now() / 50) % (H * 0.5));
    vctx.fillRect(x, y, 1, 1);
  }
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;
  rrOffset += 4 + bass * 10;

  const horizon = H * 0.5;
  const vp = W / 2;
  const rainbow = ['#ff0000', '#ff8800', '#ffee00', '#00cc00', '#0088ff', '#7733ff', '#ff00cc'];
  // perspective road: draw horizontal strips from bottom up
  for (let y = H; y > horizon; y -= 2) {
    const t = (y - horizon) / (H - horizon);       // 0 at horizon, 1 at bottom
    const bandW = 140 * t + 40 * mid;
    const ox = (rrOffset * (1 - t * 0.8)) % (bandW * 7);
    for (let i = -2; i < 8; i++) {
      const stripeLeft = vp - (bandW * 7) / 2 + i * bandW + (ox - bandW);
      vctx.fillStyle = rainbow[(i + Math.floor(rrOffset / 40)) % 7];
      vctx.fillRect(stripeLeft, y, bandW + 1, 2);
    }
  }
  // lane edges
  vctx.strokeStyle = '#fff';
  vctx.lineWidth = 2;
  vctx.beginPath(); vctx.moveTo(vp - 500, H); vctx.lineTo(vp - 50, horizon); vctx.stroke();
  vctx.beginPath(); vctx.moveTo(vp + 500, H); vctx.lineTo(vp + 50, horizon); vctx.stroke();
  // horizon glow
  const grad = vctx.createLinearGradient(0, horizon - 60, 0, horizon);
  grad.addColorStop(0, 'rgba(255,100,255,0)');
  grad.addColorStop(1, `rgba(255,100,255,${0.3 + mid * 0.5})`);
  vctx.fillStyle = grad;
  vctx.fillRect(0, horizon - 60, W, 60);
}

// ---- DANCING BANANA — the ASCII-art meme, dances to beat ----
let bananaFrame = 0;
let bananaTick = 0;
function drawBanana(W, H, color, bg) {
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, W, H);
  const bass = avgBand(0, 16) / 255;
  const mid = avgBand(24, 64) / 255;
  bananaTick += 0.3 + bass * 1.5;
  if (bananaTick > 1) { bananaFrame = (bananaFrame + 1) % 4; bananaTick = 0; }

  const cx = W / 2;
  const cy = H / 2;
  const scale = Math.min(W, H) / 240 * (1 + bass * 0.3);
  vctx.save();
  vctx.translate(cx, cy);
  vctx.scale(scale, scale);
  // wobble
  vctx.rotate(Math.sin(Date.now() / 200) * 0.15 * (1 + mid));

  // Draw a cartoon banana
  vctx.fillStyle = '#ffe135';
  vctx.strokeStyle = '#000';
  vctx.lineWidth = 3;
  // Body curve (banana shape via bezier)
  vctx.beginPath();
  vctx.moveTo(-50, 40);
  vctx.bezierCurveTo(-70, -20, -20, -70, 60, -50);
  vctx.bezierCurveTo(40, -20, 0, 40, -50, 40);
  vctx.closePath();
  vctx.fill();
  vctx.stroke();
  // Stem
  vctx.fillStyle = '#5a3a00';
  vctx.fillRect(52, -58, 10, 16);
  vctx.strokeRect(52, -58, 10, 16);
  // Eyes
  vctx.fillStyle = '#000';
  const blinkY = Math.sin(Date.now() / 400) > 0.9 ? 1 : 4;
  vctx.beginPath(); vctx.ellipse(-10, -15, 3, blinkY, 0, 0, Math.PI * 2); vctx.fill();
  vctx.beginPath(); vctx.ellipse(20, -20, 3, blinkY, 0, 0, Math.PI * 2); vctx.fill();
  // Smile
  vctx.beginPath();
  vctx.arc(5, -5, 10 + bass * 4, 0.1, Math.PI - 0.1);
  vctx.stroke();
  // Arms/legs sway
  const wave = Math.sin(Date.now() / 150) * 20;
  vctx.fillStyle = '#ffe135'; vctx.lineWidth = 4;
  vctx.beginPath();
  vctx.moveTo(-45, 30); vctx.lineTo(-65 + wave, 60 - wave * 0.5); vctx.stroke();
  vctx.beginPath();
  vctx.moveTo(45, 20); vctx.lineTo(65 - wave, 60 + wave * 0.5); vctx.stroke();
  vctx.restore();

  // "PEANUT BUTTER JELLY TIME" text that blinks
  if (Math.floor(Date.now() / 400) % 2 === 0) {
    vctx.fillStyle = '#ff00ff';
    vctx.strokeStyle = '#fff';
    vctx.lineWidth = 3;
    vctx.font = 'bold ' + Math.floor(W * 0.055) + 'px Impact, sans-serif';
    vctx.textAlign = 'center';
    const msg = 'PEANUT BUTTER JELLY TIME';
    vctx.strokeText(msg, W/2, H - 20);
    vctx.fillText(msg, W/2, H - 20);
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

let prevTrack = function() {
  if (state.playlist.length === 0) return;
  state.currentIndex = (state.currentIndex - 1 + state.playlist.length) % state.playlist.length;
  loadTrack(state.currentIndex, true);
  savePlaylistMeta();
};
let nextTrack = function(autoplay = false) {
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
  savePlaylistMeta();
};

let loadTrack = async function(idx, autoplay = true) {
  const t = state.playlist[idx];
  if (!t) return;
  $('track-title').querySelector('span').textContent = t.name;
  renderPlaylist();
  try {
    if (t.source === 'drive') {
      // Fetch via drive token; auto-reauth if token is gone/expired
      if (!state.driveToken) {
        flash('Drive signin required…');
        await connectDrive();
        if (!state.driveToken) return flash('Drive signin cancelled');
      }
      let res = await fetch(`https://www.googleapis.com/drive/v3/files/${t.driveId}?alt=media`, {
        headers: { Authorization: `Bearer ${state.driveToken}` }
      });
      if (res.status === 401 || res.status === 403) {
        // token expired — re-auth then retry once
        flash('Drive signin refresh…');
        state.driveToken = null;
        await connectDrive();
        if (!state.driveToken) return flash('Drive signin cancelled');
        res = await fetch(`https://www.googleapis.com/drive/v3/files/${t.driveId}?alt=media`, {
          headers: { Authorization: `Bearer ${state.driveToken}` }
        });
      }
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
};

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
$('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    const id = `l_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const persistentId = id; // same for local-picked files
    try {
      await idbPutFile(persistentId, f.name, f);
    } catch (err) {
      console.warn('IDB save failed', err);
      flash('Could not save file for next launch');
    }
    state.playlist.push({
      id,
      name: f.name.replace(/\.[^.]+$/, ''),
      source: 'local',
      url: URL.createObjectURL(f),
      persistentId,
    });
  }
  if (state.currentIndex < 0 && state.playlist.length > 0) state.currentIndex = 0;
  renderPlaylist();
  savePlaylistMeta();
  e.target.value = '';
});

// Drag + drop
['dragenter', 'dragover'].forEach(ev => {
  document.addEventListener(ev, e => { e.preventDefault(); });
});
document.addEventListener('drop', async e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('audio'));
  for (const f of files) {
    const id = `l_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    try { await idbPutFile(id, f.name, f); } catch {}
    state.playlist.push({
      id,
      name: f.name.replace(/\.[^.]+$/, ''),
      source: 'local',
      url: URL.createObjectURL(f),
      persistentId: id,
    });
  }
  if (state.currentIndex < 0 && state.playlist.length > 0) state.currentIndex = 0;
  renderPlaylist();
  savePlaylistMeta();
});

$('clear-pl-btn').addEventListener('click', async () => {
  state.playlist.forEach(t => { if (t.url?.startsWith('blob:')) URL.revokeObjectURL(t.url); });
  state.playlist = [];
  state.currentIndex = -1;
  audio.pause();
  audio.src = '';
  renderPlaylist();
  try { await idbClearFiles(); } catch {}
  localStorage.removeItem('retrobeat-playlist');
});

// ============================================
// GOOGLE DRIVE
// ============================================
$('load-drive-btn').addEventListener('click', () => connectDrive(true));

// awaitable: resolves once token received (or user closes popup)
// relist=true means also scan and add Drive audio files
function connectDrive(relist = true) {
  return new Promise((resolve) => {
    const cid = state.driveClientId || $('gdrive-cid').value.trim();
    if (!cid) {
      flash('Set Drive Client ID in menu');
      openDrawer();
      return resolve();
    }
    state.driveClientId = cid;
    saveSettings();

    if (!window.google?.accounts?.oauth2) {
      flash('Google SDK still loading…');
      return resolve();
    }
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: async (resp) => {
        if (resp.error) {
          flash('Drive auth denied');
          return resolve();
        }
        state.driveToken = resp.access_token;
        if (relist) await listDriveAudio();
        resolve();
      },
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
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
  savePlaylistMeta();
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
      <span class="eq-band-val" id="eq-val-${i}">${formatDb(state.eqGains[i])}</span>
      <div class="eq-slot" id="eq-slot-${i}">
        <div class="eq-slot-track"></div>
        <div class="eq-slot-zero"></div>
        <div class="eq-thumb" id="eq-thumb-${i}"></div>
      </div>
      <span class="eq-band-hz">${label}</span>
    `;
    container.appendChild(div);

    const slot = div.querySelector('.eq-slot');
    const thumb = div.querySelector('.eq-thumb');

    // Position thumb based on current value
    positionThumb(thumb, state.eqGains[i]);

    let dragging = false;
    const setFromEvent = (e) => {
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      const rect = slot.getBoundingClientRect();
      // y=0 at top -> +12dB; y=rect.height at bottom -> -12dB
      let frac = (touch.clientY - rect.top) / rect.height;
      frac = Math.max(0, Math.min(1, frac));
      const db = (0.5 - frac) * 24;  // -12..+12
      const snapped = Math.round(db * 2) / 2;  // 0.5dB steps
      state.eqGains[i] = snapped;
      positionThumb(thumb, snapped);
      $(`eq-val-${i}`).textContent = formatDb(snapped);
      // switch preset dropdown to "custom" hint by reverting to flat selection
      if (state.eqPreset !== 'custom') {
        state.eqPreset = 'custom';
        $('eq-preset').value = 'flat';
      }
      applyEQState();
    };

    slot.addEventListener('pointerdown', (e) => {
      dragging = true;
      slot.setPointerCapture?.(e.pointerId);
      setFromEvent(e);
      e.preventDefault();
    });
    slot.addEventListener('pointermove', (e) => {
      if (dragging) { setFromEvent(e); e.preventDefault(); }
    });
    slot.addEventListener('pointerup', (e) => {
      dragging = false;
      slot.releasePointerCapture?.(e.pointerId);
      saveSettings();
    });
    slot.addEventListener('pointercancel', () => { dragging = false; });
    // Touch fallback for older iOS
    slot.addEventListener('touchstart', (e) => { dragging = true; setFromEvent(e); e.preventDefault(); }, { passive: false });
    slot.addEventListener('touchmove',  (e) => { if (dragging) { setFromEvent(e); e.preventDefault(); } }, { passive: false });
    slot.addEventListener('touchend',   () => { dragging = false; saveSettings(); });
  });
}

function positionThumb(thumb, db) {
  // db in -12..+12 -> top from 0% (full up) to 100% (full down)
  const frac = 0.5 - db / 24;
  thumb.style.top = `${frac * 100}%`;
}

function formatDb(v) {
  if (v === 0) return '0';
  return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toFixed(v % 1 === 0 ? 0 : 1);
}

function refreshEQUI() {
  for (let i = 0; i < 8; i++) {
    const thumb = $(`eq-thumb-${i}`);
    const vl = $(`eq-val-${i}`);
    if (thumb) positionThumb(thumb, state.eqGains[i]);
    if (vl) vl.textContent = formatDb(state.eqGains[i]);
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

let toggleFullscreen = function() {
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
};

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
  // ignore inner control taps
  if (e.target.closest('#viz-fs-btn') || e.target.closest('.fs-transport') ||
      e.target.closest('.fs-seek') || e.target.closest('.fs-track-info')) return;
  const now = Date.now();
  if (now - lastTapTime < 400) {
    toggleFullscreen();
  } else if (state.fullscreen) {
    // single tap in fullscreen toggles controls visibility
    $('viz-panel').classList.toggle('controls-hidden');
    resetControlsHideTimer();
  }
  lastTapTime = now;
});

// ---- Fullscreen transport buttons ----
$('fs-play').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (audio.paused) {
    if (state.playlist.length === 0) return flash('Playlist empty');
    if (state.currentIndex < 0) state.currentIndex = 0;
    initAudioGraph();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!audio.src) loadTrack(state.currentIndex);
    try { await audio.play(); } catch {}
  } else {
    audio.pause();
  }
});
$('fs-prev').addEventListener('click',    (e) => { e.stopPropagation(); prevTrack(); });
$('fs-next').addEventListener('click',    (e) => { e.stopPropagation(); nextTrack(true); });
$('fs-shuffle').addEventListener('click', (e) => {
  e.stopPropagation();
  state.shuffle = !state.shuffle;
  $('fs-shuffle').classList.toggle('active', state.shuffle);
  $('shuffle-btn').classList.toggle('active', state.shuffle);
});
$('fs-repeat').addEventListener('click',  (e) => {
  e.stopPropagation();
  const modes = ['off', 'all', 'one'];
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % 3];
  const active = state.repeat !== 'off';
  $('fs-repeat').classList.toggle('active', active);
  $('repeat-btn').classList.toggle('active', active);
  $('fs-repeat').textContent = state.repeat === 'one' ? '↻1' : '↻';
  $('repeat-btn').textContent = state.repeat === 'one' ? '↻1' : '↻';
});

// Reflect play/pause icon on fs button
audio.addEventListener('play', () => { $('fs-play').textContent = '⏸'; });
audio.addEventListener('pause', () => { $('fs-play').textContent = '▶'; });

// Update fullscreen time + title
audio.addEventListener('timeupdate', () => {
  if (!isFinite(audio.duration)) return;
  $('fs-time').textContent = fmtTime(audio.currentTime);
  $('fs-dur').textContent  = fmtTime(audio.duration);
  const fsSeek = $('fs-seek');
  if (fsSeek && document.activeElement !== fsSeek) {
    fsSeek.value = (audio.currentTime / audio.duration) * 100 || 0;
  }
});
function updateFsTitle() {
  const t = state.playlist[state.currentIndex];
  $('fs-title').textContent = t ? t.name : '—';
}
// hook into loadTrack
const _origLoadTrack = loadTrack;
loadTrack = async function(...args) {
  const r = await _origLoadTrack(...args);
  updateFsTitle();
  return r;
};

$('fs-seek').addEventListener('input', (e) => {
  if (isFinite(audio.duration)) audio.currentTime = (e.target.value / 100) * audio.duration;
});

// auto-hide fullscreen controls after 3s
let controlsHideTimer = null;
function resetControlsHideTimer() {
  clearTimeout(controlsHideTimer);
  $('viz-panel').classList.remove('controls-hidden');
  if (state.fullscreen) {
    controlsHideTimer = setTimeout(() => {
      $('viz-panel').classList.add('controls-hidden');
    }, 3000);
  }
}
// reset timer on any interaction with fs controls
['fs-play', 'fs-prev', 'fs-next', 'fs-shuffle', 'fs-repeat', 'fs-seek'].forEach(id => {
  $(id).addEventListener('pointerdown', resetControlsHideTimer);
});

// When entering fullscreen, start the hide timer
const _origToggleFs = toggleFullscreen;
toggleFullscreen = function() {
  _origToggleFs();
  if (state.fullscreen) {
    updateFsTitle();
    resetControlsHideTimer();
  } else {
    clearTimeout(controlsHideTimer);
    $('viz-panel').classList.remove('controls-hidden');
  }
};

// ============================================
// INIT
// ============================================
loadSettings();
renderPlaylist();
setTheme(state.theme || 'classic');
setViz(state.viz || 'bars');
buildEQBands();
$('eq-preset').value = state.eqPreset in EQ_PRESETS ? state.eqPreset : 'flat';

// Restore saved playlist (local files from IDB + Drive refs) asynchronously
restorePlaylist().then(() => {
  renderPlaylist();
});

// Persist current track index whenever playback starts
function persistIndex() { savePlaylistMeta(); }
audio.addEventListener('play', persistIndex);

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
