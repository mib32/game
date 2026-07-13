/**
 * Port — точка подключения на узле.
 * direction: 'input' | 'output'
 * type: 'api' | 'sql' — тип запросов, которые проходит через порт
 */
export class Port {
  constructor(node, direction, type) {
    this.node = node;
    this.direction = direction;
    this.type = type;
    /** @type {Connection[]} */
    this.connections = [];
  }

  /** Можно ли соединить этот порт с другим */
  canConnectTo(otherPort) {
    if (this.node === otherPort.node) return false;
    if (this.direction === otherPort.direction) return false;
    if (this.type !== otherPort.type) return false;
    // Выход может идти на множество входов, вход — только от одного выхода
    if (otherPort.direction === 'input' && otherPort.connections.length > 0) return false;
    return true;
  }
}