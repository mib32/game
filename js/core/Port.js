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
    // Выход может идти на множество входов, вход — только от одного выхода.
    // Исключение: PgBouncer и PostgreSQL принимают множественные входящие соединения.
    if (otherPort.direction === 'input' && otherPort.connections.length > 0
        && otherPort.node.type !== 'PgBouncer'
        && otherPort.node.type !== 'PostgreSQL') return false;
    // Исходящий порт — по умолчанию только одно соединение.
    // Исключение: узлы с allowMultipleOutgoing = true (TrafficSource с round-robin).
    if (this.direction === 'output' && this.connections.length > 0
        && !this.node.allowMultipleOutgoing) return false;
    return true;
  }
}