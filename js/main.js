import { Simulation } from './simulation.js';
import { Renderer } from './renderer.js';
import { Backend } from './nodes/Backend.js';

// --- Инициализация ---
const canvas = document.getElementById('sim-canvas');
const renderer = new Renderer(canvas);
const sim = new Simulation();

// --- Настройки (localStorage) ---
const SETTINGS_KEY = 'sim-settings';

const DEFAULT_SETTINGS = {
  timeoutMs: 5000,
  onTimeout: 'abort',
  sequential: true,
  dbRequestsMin: 1,
  dbRequestsMax: 5,
  processingMin: 300,
  processingMax: 1500,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (_) { /* ignore */ }
}

// Debounced версия для слайдеров (чтобы не спамить localStorage на каждое событие input)
let _saveTimer = null;
function saveSettingsDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveSettings(settings), 200);
}

const settings = loadSettings();

/** Применить настройки ко всем узлам */
function applySettingsToNodes() {
  for (const node of sim.nodes) {
    if (node instanceof Backend) {
      node.applySettings(settings);
    }
  }
  requestRender();
}

// --- Состояние взаимодействия ---
let paletteSelected = null;
let selectedNode = null;
let connectingFrom = null;
let dragTarget = null;
let dragState = null;
let mouse = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4;
let needsRender = true;
let simTime = 0;

// --- Палитра ---
function buildPalette() {
  const palette = document.getElementById('palette');
  palette.innerHTML = '';

  for (const [type, def] of Object.entries(Simulation.nodeTypes)) {
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.textContent = def.label;
    el.dataset.type = type;

    if (type === 'TrafficSource') el.classList.add('source');
    else if (type === 'Backend') el.classList.add('backend');
    else if (type === 'PostgreSQL') el.classList.add('database');

    el.addEventListener('click', () => {
      document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      paletteSelected = type;
      connectingFrom = null;
      selectedNode = null;
      requestRender();
    });

    palette.appendChild(el);
  }
}

// --- Поиск узла по координатам ---
function hitTest(x, y) {
  for (let i = sim.nodes.length - 1; i >= 0; i--) {
    if (sim.nodes[i].containsPoint(x, y)) {
      return sim.nodes[i];
    }
  }
  return null;
}

// --- Обработчики canvas ---
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('mousedown', (e) => {
  const pos = getCanvasPos(e);
  mouse = pos;
  const hitNode = hitTest(pos.x, pos.y);

  if (paletteSelected && !hitNode) {
    sim.createNode(paletteSelected, pos.x, pos.y, settings);
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
    requestRender();
    return;
  }

  if (hitNode) {
    dragState = {
      node: hitNode,
      startX: pos.x,
      startY: pos.y,
      offsetX: pos.x - hitNode.x,
      offsetY: pos.y - hitNode.y,
    };
  } else {
    connectingFrom = null;
    selectedNode = null;
    dragState = null;
    requestRender();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const pos = getCanvasPos(e);
  mouse = pos;

  const hitNode = hitTest(pos.x, pos.y);
  if (dragTarget) {
    canvas.style.cursor = 'grabbing';
  } else if (paletteSelected && !hitNode) {
    canvas.style.cursor = 'crosshair';
  } else if (connectingFrom && hitNode && hitNode !== connectingFrom) {
    canvas.style.cursor = 'pointer';
  } else if (hitNode) {
    canvas.style.cursor = 'grab';
  } else {
    canvas.style.cursor = 'default';
  }

  if (dragState) {
    const dx = pos.x - dragState.startX;
    const dy = pos.y - dragState.startY;
    if (!dragTarget && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      dragTarget = dragState.node;
    }
    if (dragTarget) {
      dragTarget.x = pos.x - dragState.offsetX;
      dragTarget.y = pos.y - dragState.offsetY;
      requestRender();
    }
  }

  if (connectingFrom && !dragTarget) {
    requestRender();
  }
});

canvas.addEventListener('mouseup', (e) => {
  const pos = getCanvasPos(e);
  const hitNode = hitTest(pos.x, pos.y);

  if (dragTarget) {
    dragTarget = null;
    dragState = null;
  } else if (dragState) {
    const node = dragState.node;
    dragState = null;

    if (connectingFrom === null) {
      connectingFrom = node;
      selectedNode = node;
    } else if (connectingFrom === node) {
      connectingFrom = null;
      selectedNode = null;
    } else {
      const conn = sim.createConnection(connectingFrom, node);
      if (!conn) {
        sim.createConnection(node, connectingFrom);
      }
      connectingFrom = null;
      selectedNode = null;
    }
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
  }

  requestRender();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const pos = getCanvasPos(e);
  const hitNode = hitTest(pos.x, pos.y);
  if (hitNode) {
    sim.removeNode(hitNode);
    if (selectedNode === hitNode) selectedNode = null;
    if (connectingFrom === hitNode) connectingFrom = null;
    requestRender();
  }
});

// Клавиатура
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedNode) {
      sim.removeNode(selectedNode);
      selectedNode = null;
      connectingFrom = null;
      requestRender();
    }
  }
  if (e.key === 'Escape') {
    connectingFrom = null;
    selectedNode = null;
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(el => el.classList.remove('selected'));
    requestRender();
  }
});

// --- Ресайз ---
window.addEventListener('resize', () => {
  renderer.resize();
  needsRender = true;
});

// --- Главный цикл рендеринга ---
function requestRender() {
  needsRender = true;
}

function render() {
  renderer.clear();
  renderer.drawConnections(sim.connections);

  if (connectingFrom && !dragTarget) {
    renderer.drawDraftLine(connectingFrom, mouse.x, mouse.y);
  }

  renderer.drawNodes(sim.nodes, selectedNode, connectingFrom);
  renderer.drawParticles(sim.particles, simTime);

  updateStats();
}

let lastFrameTime = performance.now();
let _hadParticles = false;
function frame(now) {
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  simTime += dt;

  sim.update(Math.min(dt, 100), simTime);

  const hasParticles = sim.particles.length > 0;
  if (needsRender || hasParticles || _hadParticles) {
    render();
    needsRender = false;
  }
  _hadParticles = hasParticles;

  requestAnimationFrame(frame);
}

// --- Статистика ---
let _lastStats = null;
function updateStats() {
  const el = document.getElementById('stats');
  const content = document.getElementById('stats-content');
  if (!el || !content) return;

  const s = sim.stats;
  const apiOk = s.get('requests_outcome', { type: 'api', status: 'success' });
  const apiErr = s.get('requests_outcome', { type: 'api', status: 'error' });
  const dbOk = s.get('requests_outcome', { type: 'sql', status: 'success' });
  const dbErr = s.get('requests_outcome', { type: 'sql', status: 'error' });
  const hasActivity = true; // always show stats

  const key = `${s.totalApiRequests}|${s.totalDbRequests}|${apiOk}|${apiErr}|${dbOk}|${dbErr}|${sim.particles.length}|${hasActivity}|${sim.satisfaction.toFixed(0)}|${sim.users}|${sim.userProgress.toFixed(1)}`;
  if (key === _lastStats) return;
  _lastStats = key;

  el.style.display = hasActivity ? 'block' : 'none';

  content.innerHTML = `
    <div class="stat-section">Users</div>
    <div class="stat-row"><span class="stat-label">👤 Online</span><span class="stat-value" style="color:#ffd54f;font-size:18px">${sim.users}</span></div>
    <div class="stat-row"><span class="stat-label">Progress</span><span class="stat-value total">${Math.floor(sim.userProgress)}/${sim.userProgressTarget}</span></div>
    <div class="stat-section">Health</div>
    <div class="stat-row"><span class="stat-label">Satisfaction</span><span class="stat-value" style="color:${sim.satisfaction > 60 ? '#66bb6a' : sim.satisfaction > 30 ? '#ffd54f' : '#ef5350'}">${sim.satisfaction.toFixed(0)}%</span></div>
    <div class="stat-section">API</div>
    <div class="stat-row"><span class="stat-label">sent</span><span class="stat-value total">${s.totalApiRequests}</span></div>
    <div class="stat-row"><span class="stat-label">ok / err</span><span class="stat-value success">${apiOk}</span><span class="stat-value fail" style="margin-left:4px">${apiErr}</span></div>
    <div class="stat-section">DB</div>
    <div class="stat-row"><span class="stat-label">sent</span><span class="stat-value total">${s.totalDbRequests}</span></div>
    <div class="stat-row"><span class="stat-label">ok / err</span><span class="stat-value success">${dbOk}</span><span class="stat-value fail" style="margin-left:4px">${dbErr}</span></div>
    <div class="stat-row"><span class="stat-label">In flight</span><span class="stat-value">${sim.particles.length}</span></div>
  `;
}

// --- Кнопка Generate ---
const generateBtn = document.getElementById('btn-generate');
if (generateBtn) {
  generateBtn.addEventListener('click', () => {
    if (sim.connections.length === 0) {
      generateBtn.textContent = 'Connect nodes first!';
      setTimeout(() => { generateBtn.textContent = '⚡ Generate Request'; }, 1500);
      return;
    }
    sim.generateFromSources();
  });
}

// --- Controls wiring ---
function bindSlider(id, settingKey, format, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = settings[settingKey];
  el.addEventListener('input', () => {
    settings[settingKey] = Number(el.value);
    saveSettingsDebounced();
    applySettingsToNodes();
    if (onChange) onChange();
  });
}

function bindSelect(id, settingKey, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = settings[settingKey];
  el.addEventListener('change', () => {
    settings[settingKey] = el.value;
    saveSettings(settings);
    applySettingsToNodes();
    if (onChange) onChange();
  });
}

// Timeout slider
const timeoutVal = document.getElementById('val-timeout');
bindSlider('ctl-timeout', 'timeoutMs', v => v + 'ms', () => {
  timeoutVal.textContent = settings.timeoutMs + 'ms';
});

// On-timeout dropdown
bindSelect('ctl-onTimeout', 'onTimeout');

// Sequential checkbox
const ctlSequential = document.getElementById('ctl-sequential');
if (ctlSequential) {
  ctlSequential.checked = settings.sequential;
  ctlSequential.addEventListener('change', () => {
    settings.sequential = ctlSequential.checked;
    saveSettings(settings);
    applySettingsToNodes();
  });
}

// DB requests range
const dbNVal = document.getElementById('val-db-n');
const ctlDbMin = document.getElementById('ctl-db-min');
const ctlDbMax = document.getElementById('ctl-db-max');

function clampRange(minEl, maxEl, setKey) {
  let vMin = Number(minEl.value);
  let vMax = Number(maxEl.value);
  if (vMin > vMax) {
    // The one being dragged wins — the other snaps to match
    if (setKey === 'dbRequestsMin' || setKey === 'processingMin') vMax = vMin;
    else vMin = vMax;
    minEl.value = vMin;
    maxEl.value = vMax;
  }
  return [vMin, vMax];
}

function updateDbNLabel() {
  dbNVal.textContent = settings.dbRequestsMin + ' \u2013 ' + settings.dbRequestsMax;
}

ctlDbMin.addEventListener('input', () => {
  const [vMin, vMax] = clampRange(ctlDbMin, ctlDbMax, 'dbRequestsMin');
  settings.dbRequestsMin = vMin;
  settings.dbRequestsMax = vMax;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbNLabel();
});
ctlDbMax.addEventListener('input', () => {
  const [vMin, vMax] = clampRange(ctlDbMin, ctlDbMax, 'dbRequestsMax');
  settings.dbRequestsMin = vMin;
  settings.dbRequestsMax = vMax;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbNLabel();
});

// Processing time range
const dbTimeVal = document.getElementById('val-db-time');
const ctlTimeMin = document.getElementById('ctl-time-min');
const ctlTimeMax = document.getElementById('ctl-time-max');

function updateDbTimeLabel() {
  dbTimeVal.textContent = settings.processingMin + ' \u2013 ' + settings.processingMax + 'ms';
}

ctlTimeMin.addEventListener('input', () => {
  const [vMin, vMax] = clampRange(ctlTimeMin, ctlTimeMax, 'processingMin');
  settings.processingMin = vMin;
  settings.processingMax = vMax;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbTimeLabel();
});
ctlTimeMax.addEventListener('input', () => {
  const [vMin, vMax] = clampRange(ctlTimeMin, ctlTimeMax, 'processingMax');
  settings.processingMin = vMin;
  settings.processingMax = vMax;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbTimeLabel();
});

// Initialise labels
timeoutVal.textContent = settings.timeoutMs + 'ms';
updateDbNLabel();
updateDbTimeLabel();

// User-count slider — задаёт users напрямую (для теста)
const autoRateVal = document.getElementById('val-auto-rate');
const ctlAutoRate = document.getElementById('ctl-auto-rate');
if (ctlAutoRate) {
  ctlAutoRate.value = 0;
  autoRateVal.textContent = '0 users';

  ctlAutoRate.addEventListener('input', () => {
    const count = Number(ctlAutoRate.value);
    sim.users = count;
    sim.userProgressTarget = 5 + count * 2;
    sim.userProgress = 0;
    autoRateVal.textContent = count + ' users';
  });
}

// --- Инициализация ---
buildPalette();

// Размещаем демо-узлы
const ts = sim.createNode('TrafficSource', 150, 200);
const be = sim.createNode('Backend', 400, 200, settings);
const pg = sim.createNode('PostgreSQL', 650, 200);

if (window.location.search.includes('test')) {
  sim.createConnection(ts, be);
  sim.createConnection(be, pg);
  requestRender();
}

requestAnimationFrame(frame);

// Экспорт для отладки
window.sim = sim;
window.renderer = renderer;