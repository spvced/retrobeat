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
let freqData = null;    // Uint8Array frequency
let timeData = null;    // Uint8Array waveform
let peakData = null;    // smoothed peaks for bars

function initAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  gainNode = audioCtx.createGain();
  sourceNode.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  timeData = new Uint8Array(analyser.frequencyBinCount);
  peakData = new Float32Array(64);
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
  } catch (e) {}
}
function saveSettings() {
  localStorage.setItem('retrobeat', JSON.stringify({
    theme: state.theme,
    viz: state.viz,
    volume: state.volume,
    driveClientId: state.driveClientId,
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
    starfield: 'STARFIELD', matrix: 'MATRIX', tunnel: 'TUNNEL', fire: 'FIRE'
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
// INIT
// ============================================
loadSettings();
renderPlaylist();
setTheme(state.theme || 'classic');
setViz(state.viz || 'bars');

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
