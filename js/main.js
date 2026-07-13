import { Simulation } from './simulation.js';
import { Renderer } from './renderer.js';

// --- Инициализация ---
const canvas = document.getElementById('sim-canvas');
const renderer = new Renderer(canvas);
const sim = new Simulation();

// --- Состояние взаимодействия ---
let paletteSelected = null;        // выбранный в палитре тип узла
let selectedNode = null;          // выделенный узел (для delete, connect start)
let connectingFrom = null;        // узел-источник для создания связи
let dragTarget = null;            // перетаскиваемый узел
let dragState = null;             // { node, startX, startY, offsetX, offsetY } — потенциальный drag
let mouse = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4;

// --- Палитра ---
function buildPalette() {
  const palette = document.getElementById('palette');
  palette.innerHTML = '';

  for (const [type, def] of Object.entries(Simulation.nodeTypes)) {
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.textContent = def.label;
    el.dataset.type = type;

    // CSS-класс для цвета
    if (type === 'TrafficSource') el.classList.add('source');
    else if (type === 'Backend') el.classList.add('backend');
    else if (type === 'PostgreSQL') el.classList.add('database');

    el.addEventListener('click', () => {
      // Снять выделение с предыдущего
      document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      paletteSelected = type;
      connectingFrom = null;
      selectedNode = null;
      render();
    });

    palette.appendChild(el);
  }
}

// --- Поиск узла по координатам ---
function hitTest(x, y) {
  // Ищем сверху вниз (последний добавленный — сверху)
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
    // Размещаем новый узел
    sim.createNode(paletteSelected, pos.x, pos.y);
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
    render();
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
    // Клик по пустоте — сброс
    connectingFrom = null;
    selectedNode = null;
    dragState = null;
    render();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const pos = getCanvasPos(e);
  mouse = pos;

  // Меняем курсор в зависимости от контекста
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
    }
  }

  render();
});

canvas.addEventListener('mouseup', (e) => {
  const pos = getCanvasPos(e);
  const hitNode = hitTest(pos.x, pos.y);

  if (dragTarget) {
    // Был drag — завершаем
    dragTarget = null;
    dragState = null;
  } else if (dragState) {
    // Был click (без перемещения) на узле
    const node = dragState.node;
    dragState = null;

    if (connectingFrom === null) {
      // Первый клик: начинаем соединение
      connectingFrom = node;
      selectedNode = node;
    } else if (connectingFrom === node) {
      // Клик по тому же узлу: отмена
      connectingFrom = null;
      selectedNode = null;
    } else {
      // Второй клик: пытаемся создать связь
      const conn = sim.createConnection(connectingFrom, node);
      if (!conn) {
        // Не удалось — возможно, пробуем обратное направление
        sim.createConnection(node, connectingFrom);
      }
      connectingFrom = null;
      selectedNode = null;
    }
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(e => e.classList.remove('selected'));
  }

  render();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const pos = getCanvasPos(e);
  const hitNode = hitTest(pos.x, pos.y);
  if (hitNode) {
    sim.removeNode(hitNode);
    if (selectedNode === hitNode) selectedNode = null;
    if (connectingFrom === hitNode) connectingFrom = null;
    render();
  }
});

// Клавиатура
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedNode) {
      sim.removeNode(selectedNode);
      selectedNode = null;
      connectingFrom = null;
      render();
    }
  }
  if (e.key === 'Escape') {
    connectingFrom = null;
    selectedNode = null;
    paletteSelected = null;
    document.querySelectorAll('.palette-item').forEach(el => el.classList.remove('selected'));
    render();
  }
});

// --- Ресайз ---
window.addEventListener('resize', () => {
  renderer.resize();
  render();
});

// --- Главный цикл рендеринга ---
function render() {
  renderer.clear();
  renderer.drawConnections(sim.connections);

  // Черновая линия при создании связи
  if (connectingFrom && !dragTarget) {
    renderer.drawDraftLine(connectingFrom, mouse.x, mouse.y);
  }

  renderer.drawNodes(sim.nodes, selectedNode, connectingFrom);
}

// --- Старт ---
buildPalette();

// Размещаем демо-узлы для наглядности
sim.createNode('TrafficSource', 150, 200);
sim.createNode('Backend', 400, 200);
sim.createNode('PostgreSQL', 650, 200);

render();

// Экспорт для доступа из консоли (удобно для отладки)
window.sim = sim;
window.renderer = renderer;