import { Port } from './Port.js';

let nextId = 1;

/**
 * Node — базовый класс узла архитектуры.
 * Узлы имеют входные и выходные порты, позицию на canvas и визуальные настройки.
 */
export class Node {
  /**
   * @param {string} type - идентификатор типа (TrafficSource, Backend, PostgreSQL)
   * @param {number} x
   * @param {number} y
   * @param {Object} config — { label, color, inputs: [{type}], outputs: [{type}], width, height }
   */
  constructor(type, x, y, config) {
    this.id = nextId++;
    this.type = type;
    this.x = x;
    this.y = y;
    this.label = config.label;
    this.color = config.color;
    this.width = config.width || 140;
    this.height = config.height || 48;

    // Создаём порты из конфигурации
    /** @type {Port[]} */
    this.inputs = (config.inputs || []).map(p => new Port(this, 'input', p.type));
    /** @type {Port[]} */
    this.outputs = (config.outputs || []).map(p => new Port(this, 'output', p.type));
  }

  /** Bounding box для hit-testing */
  getBounds() {
    return {
      x: this.x - this.width / 2,
      y: this.y - this.height / 2,
      width: this.width,
      height: this.height,
    };
  }

  /** Проверка попадания точки в узел */
  containsPoint(px, py) {
    const b = this.getBounds();
    return px >= b.x && px <= b.x + b.width &&
           py >= b.y && py <= b.y + b.height;
  }

  /** Вызвается когда приходит запрос. Переопределяется в подклассах. */
  receive(particle, portIndex) {
    // Базовая реализация — ничего не делает
  }
}