import { Simulation } from './simulation.js';
import { Renderer } from './renderer.js';
import { Backend } from './nodes/Backend.js';
import { PostgreSQL } from './nodes/PostgreSQL.js';
import { setParticleSpeedFromLatency } from './core/Particle.js';
import { LevelManager } from './levels/LevelManager.js';

// --- Инициализация ---
const canvas = document.getElementById('sim-canvas');
const renderer = new Renderer(canvas);
const sim = new Simulation();

// ── Менеджер уровней ──
const levelManager = new LevelManager(sim);

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
  dbSizeCoeff: 1.0, // коэффициент влияния DB size на время запроса (0.0 – 1.0, по умолчанию 1.0 = каждые 100 запросов +100ms)
  networkLatency: 400, // задержка сети между узлами в мс (50–2000, по умолчанию 400ms)
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
    if (node instanceof PostgreSQL) {
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
/**
 * Построить палитру узлов. Если activePalette не передан,
 * показывает все типы (Free Mode). При наличии уровня —
 * только разрешённые availableNodes.
 * @param {string[]} [allowed] — список разрешённых типов нод
 */
function buildPalette(allowed) {
  const palette = document.getElementById('palette');
  palette.innerHTML = '';

  for (const [type, def] of Object.entries(Simulation.nodeTypes)) {
    // Если задан фильтр — пропускаем ноды не из списка
    if (allowed && !allowed.includes(type)) continue;

    const el = document.createElement('div');
    el.className = 'palette-item';
    el.textContent = def.label;
    el.dataset.type = type;

    if (type === 'TrafficSource') el.classList.add('source');
    else if (type === 'Backend') el.classList.add('backend');
    else if (type === 'PostgreSQL') el.classList.add('database');
    else if (type === 'PgBouncer') el.classList.add('pgbouncer');

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

  // Если палитра пустая — показываем заглушку
  if (palette.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = '— no nodes available —';
    palette.appendChild(empty);
  }
}

/** Перестроить палитру с учётом текущего уровня */
function rebuildPalette() {
  if (levelManager.active) {
    buildPalette(levelManager.availableNodes);
  } else {
    buildPalette();
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
    // Проверка лимита нод на уровне
    if (!levelManager.canAddNode()) {
      // Показываем краткое предупреждение (можно заменить на toast позже)
      console.warn(`Level limit: max ${levelManager.maxNodes} nodes`);
      return;
    }
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
    sim.notifyChange();
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

  // Проверка условий уровня (если активен)
  levelManager.checkConditions();

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
  const inLevel = levelManager.active; // в режиме уровня рост отключён

  const key = `${s.totalApiRequests}|${s.totalDbRequests}|${apiOk}|${apiErr}|${dbOk}|${dbErr}|${sim.particles.length}|${hasActivity}|${sim.users}|${sim.usersGained}|${sim.usersLostToChurn}|${Math.floor(sim.userProgress)}|${sim.churnProgress}|${inLevel}`;
  if (key === _lastStats) return;
  _lastStats = key;

  el.style.display = hasActivity ? 'block' : 'none';

  // Рост и приток юзеров — только в песочнице (free mode)
  const growthBlock = inLevel ? '' : `
    <div class="stat-row"><span class="stat-label">Growth</span><span class="stat-value total">${Math.floor(sim.userProgress)}/${sim.userProgressTarget}</span></div>
    <div class="stat-bar"><div style="width:${Math.min(100, sim.userProgress / sim.userProgressTarget * 100).toFixed(0)}%"></div></div>
  `;

  const gainedLostBlock = inLevel ? '' : `
    <div class="stat-row"><span class="stat-label">Gained / Lost</span><span class="stat-value success">+${sim.usersGained}</span><span class="stat-value fail" style="margin-left:4px">−${sim.usersLostToChurn}</span></div>
  `;

  content.innerHTML = `
    <div class="stat-section">Users</div>
    <div class="stat-row"><span class="stat-label">👤 Online</span><span class="stat-value" style="color:#ffd54f;font-size:18px">${sim.users}</span></div>
    ${growthBlock}
    <div class="stat-row"><span class="stat-label">😡 Churn</span><span class="stat-value total">${Math.floor(sim.churnProgress)}/${sim.churnTarget}</span></div>
    <div class="stat-bar"><div style="width:${Math.min(100, sim.churnProgress / sim.churnTarget * 100).toFixed(0)}%"></div></div>
    ${gainedLostBlock}
    <div class="stat-section">API</div>
    <div class="stat-row"><span class="stat-label">sent</span><span class="stat-value total">${s.totalApiRequests}</span></div>
    <div class="stat-row"><span class="stat-label">ok / err</span><span class="stat-value success">${apiOk}</span><span class="stat-value fail" style="margin-left:4px">${apiErr}</span></div>
    <div class="stat-section">DB</div>
    <div class="stat-row"><span class="stat-label">sent</span><span class="stat-value total">${s.totalDbRequests}</span></div>
    <div class="stat-row"><span class="stat-label">ok / err</span><span class="stat-value success">${dbOk}</span><span class="stat-value fail" style="margin-left:4px">${dbErr}</span></div>
    <div class="stat-row"><span class="stat-label">In flight</span><span class="stat-value">${sim.particles.length}</span></div>
  `;
}

// ── Уровни: UI-функции ───────────────────────────────────

/** Заполнить выпадающий список уровней */
function populateLevelDropdown() {
  const select = document.getElementById('ctl-level');
  if (!select) return;
  // Сохраняем первый option (placeholder)
  select.innerHTML = '<option value="">-- Select level --</option>';
  for (const lvl of levelManager.getLevels()) {
    const opt = document.createElement('option');
    opt.value = lvl.id;
    opt.textContent = `${lvl.title}`;
    select.appendChild(opt);
  }
}

/** Запустить выбранный уровень */
function startLevel() {
  const select = document.getElementById('ctl-level');
  if (!select || !select.value) return;

  const ok = levelManager.loadLevel(select.value);
  if (!ok) return;

  // Применяем настройки уровня
  Object.assign(settings, levelManager.levelSettings);
  saveSettings(settings); // сохраняем в localStorage

  // Обновляем скорость частиц
  setParticleSpeedFromLatency(settings.networkLatency);

  // Применяем настройки к нодам
  applySettingsToNodes();

  // Перестраиваем палитру
  rebuildPalette();

  // Обновляем слайдеры (значения из уровня)
  updateAllSliders();

  // Показываем/прячем UI уровня
  showLevelUI(true);

  // Прячем тестовый слайдер
  const testUsersSection = document.getElementById('ctl-auto-rate')?.closest('.toolbar-section');
  if (testUsersSection) testUsersSection.style.display = 'none';

  // Обновляем лейблы
  updateDbTimeLabel();
  updateDbNLabel();
  updateDbCoeffLabel?.();
  updateNetLatencyLabel?.();

  // Сбрасываем симуляционное время для нового уровня
  simTime = 0;

  requestRender();
}

/** Выйти из режима уровня в свободный режим */
function exitToFreeMode() {
  levelManager.exitLevel();

  // Восстанавливаем настройки из localStorage
  const saved = loadSettings();
  Object.assign(settings, saved);

  // Обновляем скорость
  setParticleSpeedFromLatency(settings.networkLatency);

  // Сбрасываем симуляцию и загружаем демо
  sim.reset();
  sim._suppressNotify = true;
  const ts = sim.createNode('TrafficSource', 150, 200);
  const be = sim.createNode('Backend', 400, 200, settings);
  const pg = sim.createNode('PostgreSQL', 650, 200);
  sim.createConnection(ts, be);
  sim.createConnection(be, pg);
  sim._suppressNotify = false;

  // Обновляем UI
  rebuildPalette();
  updateAllSliders();
  showLevelUI(false);

  // Возвращаем тестовый слайдер
  const testUsersSection = document.getElementById('ctl-auto-rate')?.closest('.toolbar-section');
  if (testUsersSection) testUsersSection.style.display = '';

  // Сбрасываем время
  simTime = 0;

  requestRender();
}

/** Показать/спрятать UI уровня */
function showLevelUI(visible) {
  const objective = document.getElementById('level-objective');
  const overlay = document.getElementById('level-overlay');
  if (objective) objective.style.display = visible ? 'block' : 'none';
  if (overlay) overlay.classList.add('hidden');

  // Блокируем/разблокируем слайдеры
  updateSliderLocks();
}

/** Обновить панель цели уровня */
function updateLevelObjective() {
  const prog = levelManager.getProgress();
  if (!prog) return;

  const titleEl = document.getElementById('lvl-title');
  const descEl = document.getElementById('lvl-desc');
  const fillEl = document.getElementById('lvl-progress-fill');
  const textEl = document.getElementById('lvl-progress-text');
  const hintEl = document.getElementById('lvl-hint');

  if (titleEl) titleEl.textContent = prog.title;
  if (descEl) descEl.textContent = prog.description;
  if (fillEl) fillEl.style.width = prog.target > 0 ? (prog.current / prog.target * 100).toFixed(0) + '%' : '0%';
  if (textEl) textEl.textContent = `${prog.current} / ${prog.target} ${prog.label}`;
  if (hintEl) {
    // Показываем подсказку через 15 секунд
    if (prog.time > 15000 && prog.hint) {
      hintEl.textContent = '💡 ' + prog.hint;
    } else {
      hintEl.textContent = '';
    }
  }
}

/** Показать оверлей победы/поражения */
function showOverlay(isWin) {
  const overlay = document.getElementById('level-overlay');
  const title = document.getElementById('overlay-title');
  const desc = document.getElementById('overlay-desc');
  const btnNext = document.getElementById('btn-next');

  if (!overlay) return;
  overlay.classList.remove('hidden');

  if (isWin) {
    title.textContent = '🎉 Level Complete!';
    title.style.color = '#4caf50';
    desc.textContent = levelManager.currentLevel?.title || '';
    if (btnNext) btnNext.style.display = '';
  } else {
    title.textContent = '💥 Level Failed';
    title.style.color = '#f44336';
    desc.textContent = 'Попробуй другой подход.';
    if (btnNext) btnNext.style.display = 'none';
  }
}

/** Блокировка/разблокировка слайдеров согласно уровню */
function updateSliderLocks() {
  // Список всех слайдеров и их ключей настроек
  const sliderMap = [
    ['ctl-timeout', 'timeoutMs'],
    ['ctl-db-min', 'dbRequestsMin'],
    ['ctl-db-max', 'dbRequestsMax'],
    ['ctl-time-min', 'processingMin'],
    ['ctl-time-max', 'processingMax'],
    ['ctl-db-coeff', 'dbSizeCoeff'],
    ['ctl-net-latency', 'networkLatency'],
  ];

  for (const [elId, key] of sliderMap) {
    const el = document.getElementById(elId);
    if (!el) continue;
    if (levelManager.isSettingLocked(key)) {
      el.disabled = true;
    } else {
      el.disabled = false;
    }
  }

  // Чекбокс sequential и селект on-timeout тоже блокируем при уровне
  const ctlSeq = document.getElementById('ctl-sequential');
  const ctlOnTimeout = document.getElementById('ctl-on-timeout');
  if (ctlSeq) ctlSeq.disabled = levelManager.isSettingLocked('sequential');
  if (ctlOnTimeout) ctlOnTimeout.disabled = levelManager.isSettingLocked('onTimeout');
}

/** Обновить значения всех слайдеров из текущих settings */
function updateAllSliders() {
  const timeoutEl = document.getElementById('ctl-timeout');
  const dbMinEl = document.getElementById('ctl-db-min');
  const dbMaxEl = document.getElementById('ctl-db-max');
  const timeMinEl = document.getElementById('ctl-time-min');
  const timeMaxEl = document.getElementById('ctl-time-max');
  const dbCoeffEl = document.getElementById('ctl-db-coeff');
  const netLatEl = document.getElementById('ctl-net-latency');
  const seqEl = document.getElementById('ctl-sequential');
  const onTimeoutEl = document.getElementById('ctl-on-timeout');

  if (timeoutEl) timeoutEl.value = settings.timeoutMs;
  if (dbMinEl) dbMinEl.value = settings.dbRequestsMin;
  if (dbMaxEl) dbMaxEl.value = settings.dbRequestsMax;
  // Для логарифмических слайдеров конвертируем обратно
  if (timeMinEl) timeMinEl.value = msToSlider(settings.processingMin);
  if (timeMaxEl) timeMaxEl.value = msToSlider(settings.processingMax);
  if (dbCoeffEl) dbCoeffEl.value = Math.round(settings.dbSizeCoeff * 10);
  if (netLatEl) netLatEl.value = settings.networkLatency;
  if (seqEl) seqEl.checked = settings.sequential;
  if (onTimeoutEl) onTimeoutEl.value = settings.onTimeout;

  updateSliderLocks();
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
// Логарифмическая шкала: позиция слайдера (0-1000) → реальное значение (1-10000ms)
// Даёт гранулированный контроль на малых значениях (1-50ms) и более грубый на больших
const TIME_LOG_MIN = Math.log10(1);     // log10(1) = 0
const TIME_LOG_MAX = Math.log10(10000); // log10(10000) = 4

/** Конвертирует позицию слайдера (0-1000) в миллисекунды (1-10000) по экспоненциальной шкале */
function sliderToMs(sliderVal) {
  const logVal = TIME_LOG_MIN + (TIME_LOG_MAX - TIME_LOG_MIN) * (sliderVal / 1000);
  return Math.round(Math.pow(10, logVal));
}

/** Конвертирует миллисекунды обратно в позицию слайдера (0-1000) */
function msToSlider(msVal) {
  const logVal = Math.log10(Math.max(1, msVal));
  return Math.round((logVal - TIME_LOG_MIN) / (TIME_LOG_MAX - TIME_LOG_MIN) * 1000);
}

const dbTimeVal = document.getElementById('val-db-time');
const ctlTimeMin = document.getElementById('ctl-time-min');
const ctlTimeMax = document.getElementById('ctl-time-max');

// Инициализация позиций слайдеров из сохранённых настроек (или дефолтов)
ctlTimeMin.value = msToSlider(settings.processingMin);
ctlTimeMax.value = msToSlider(settings.processingMax);

function updateDbTimeLabel() {
  dbTimeVal.textContent = settings.processingMin + ' \u2013 ' + settings.processingMax + 'ms';
}

ctlTimeMin.addEventListener('input', () => {
  const [vMinSlider, vMaxSlider] = clampRange(ctlTimeMin, ctlTimeMax, 'processingMin');
  settings.processingMin = sliderToMs(vMinSlider);
  settings.processingMax = sliderToMs(vMaxSlider);
  // Синхронизируем позиции слайдеров обратно (на случай округления при clamp)
  ctlTimeMin.value = vMinSlider;
  ctlTimeMax.value = vMaxSlider;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbTimeLabel();
});
ctlTimeMax.addEventListener('input', () => {
  const [vMinSlider, vMaxSlider] = clampRange(ctlTimeMin, ctlTimeMax, 'processingMax');
  settings.processingMin = sliderToMs(vMinSlider);
  settings.processingMax = sliderToMs(vMaxSlider);
  ctlTimeMin.value = vMinSlider;
  ctlTimeMax.value = vMaxSlider;
  saveSettingsDebounced();
  applySettingsToNodes();
  updateDbTimeLabel();
});

// DB size impact coefficient — коэффициент влияния размера БД на время запроса
const dbCoeffVal = document.getElementById('val-db-coeff');
const dbCoeffValMs = document.getElementById('val-db-coeff-ms');
const ctlDbCoeff = document.getElementById('ctl-db-coeff');

if (ctlDbCoeff) {
  function updateDbCoeffLabel() {
    const coeff = settings.dbSizeCoeff;
    dbCoeffVal.textContent = coeff.toFixed(1) + '\u00d7';
    dbCoeffValMs.textContent = Math.round(coeff * 100);
  }

  // Инициализация из сохранённых настроек
  ctlDbCoeff.value = Math.round(settings.dbSizeCoeff * 10);
  updateDbCoeffLabel();

  ctlDbCoeff.addEventListener('input', () => {
    settings.dbSizeCoeff = Number(ctlDbCoeff.value) / 10;
    saveSettingsDebounced();
    applySettingsToNodes();
    updateDbCoeffLabel();
  });
}

// Network latency — задержка сети между узлами (влияет на скорость пролёта частиц)
const netLatencyVal = document.getElementById('val-net-latency');
const ctlNetLatency = document.getElementById('ctl-net-latency');

if (ctlNetLatency) {
  // Инициализация из сохранённых настроек
  ctlNetLatency.value = settings.networkLatency;
  setParticleSpeedFromLatency(settings.networkLatency);
  updateNetLatencyLabel();

  ctlNetLatency.addEventListener('input', () => {
    settings.networkLatency = Number(ctlNetLatency.value);
    setParticleSpeedFromLatency(settings.networkLatency);
    saveSettingsDebounced();
    updateNetLatencyLabel();
  });

  function updateNetLatencyLabel() {
    netLatencyVal.textContent = settings.networkLatency + 'ms';
  }
}

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

// --- Сохранение/загрузка графа ---
const GRAPH_KEY = 'sim-graph';

/** Debounced-сохранение графа в localStorage (только в Free Mode) */
let _graphSaveTimer = null;
function saveGraphDebounced() {
  // Не сохраняем граф в режиме уровня
  if (levelManager.active) return;
  if (_graphSaveTimer) clearTimeout(_graphSaveTimer);
  _graphSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(GRAPH_KEY, JSON.stringify(sim.saveState()));
    } catch (_) { /* ignore */ }
  }, 150);
}

/** Синхронное сохранение (для первого запуска, пока onChange ещё не подключён) */
function saveGraphNow() {
  if (_graphSaveTimer) clearTimeout(_graphSaveTimer);
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify(sim.saveState()));
  } catch (_) { /* ignore */ }
}

function loadGraph() {
  try {
    const raw = localStorage.getItem(GRAPH_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state.nodes && state.nodes.length > 0) {
        sim.loadState(state, settings);
        return true;
      }
    }
  } catch (_) { /* ignore */ }
  return false;
}

// --- Инициализация ---
buildPalette();
populateLevelDropdown();

// Колбэки менеджера уровней
levelManager.onWin = () => {
  showOverlay(true);
  requestRender();
};
levelManager.onLose = () => {
  showOverlay(false);
  requestRender();
};
levelManager.onProgress = () => {
  updateLevelObjective();
};

// ── Кнопки уровня ──
const btnLevelStart = document.getElementById('btn-level-start');
const btnLevelFree = document.getElementById('btn-level-free');
if (btnLevelStart) btnLevelStart.addEventListener('click', startLevel);
if (btnLevelFree) btnLevelFree.addEventListener('click', exitToFreeMode);

// ── Оверлей (победа/поражение) ──
const btnRetry = document.getElementById('btn-retry');
const btnNext = document.getElementById('btn-next');
const btnFreeMode = document.getElementById('btn-free-mode');
if (btnRetry) {
  btnRetry.addEventListener('click', () => {
    document.getElementById('level-overlay').classList.add('hidden');
    levelManager.retryLevel();
    Object.assign(settings, levelManager.levelSettings);
    setParticleSpeedFromLatency(settings.networkLatency);
    applySettingsToNodes();
    updateAllSliders();
    updateDbTimeLabel();
    updateDbNLabel();
    simTime = 0;
    requestRender();
  });
}
if (btnNext) {
  btnNext.addEventListener('click', () => {
    document.getElementById('level-overlay').classList.add('hidden');
    const hasNext = levelManager.nextLevel();
    if (hasNext) {
      Object.assign(settings, levelManager.levelSettings);
      setParticleSpeedFromLatency(settings.networkLatency);
      applySettingsToNodes();
      updateAllSliders();
      updateDbTimeLabel();
      updateDbNLabel();
      // Обновить селектор уровней
      const select = document.getElementById('ctl-level');
      if (select && levelManager.currentLevel) select.value = levelManager.currentLevel.id;
      simTime = 0;
    } else {
      exitToFreeMode();
    }
    requestRender();
  });
}
if (btnFreeMode) {
  btnFreeMode.addEventListener('click', () => {
    document.getElementById('level-overlay').classList.add('hidden');
    exitToFreeMode();
  });
}

if (!loadGraph()) {
  // Первый запуск — размещаем демо-схему
  const ts = sim.createNode('TrafficSource', 150, 200);
  const be = sim.createNode('Backend', 400, 200, settings);
  const pg = sim.createNode('PostgreSQL', 650, 200);
  sim.createConnection(ts, be);
  sim.createConnection(be, pg);
  saveGraphNow();
  requestRender();
}

// Применить сохранённые настройки ко всем узлам после загрузки графа
applySettingsToNodes();

// Автосохранение графа при любом изменении (debounced)
sim.onChange = () => saveGraphDebounced();

requestAnimationFrame(frame);

// Экспорт для отладки
window.sim = sim;
window.renderer = renderer;