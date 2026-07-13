import { TrafficSource } from './nodes/TrafficSource.js';
import { Backend } from './nodes/Backend.js';
import { PostgreSQL } from './nodes/PostgreSQL.js';
import { Connection } from './core/Connection.js';

/**
 * Simulation — управляет графом узлов и связей.
 * Центральный state: nodes[], connections[], частицы.
 */
export class Simulation {
  constructor() {
    /** @type {import('./core/Node.js').Node[]} */
    this.nodes = [];
    /** @type {import('./core/Connection.js').Connection[]} */
    this.connections = [];
    /** @type {import('./core/Particle.js').Particle[]} */
    this.particles = [];

    // Статистика
    this.stats = {
      totalApiRequests: 0,
      totalDbRequests: 0,
      success: 0,
      fail: 0,
    };
  }

  /** Реестр типов узлов — pluggable! */
  static nodeTypes = {
    TrafficSource: {
      label: 'Traffic Source',
      color: '#3a3a3a',
      inputs: [],
      outputs: [{ type: 'api' }],
      factory: (x, y) => new TrafficSource(x, y),
    },
    Backend: {
      label: 'Backend',
      color: '#4a3f1a',
      inputs: [{ type: 'api' }],
      outputs: [{ type: 'sql' }],
      factory: (x, y) => new Backend(x, y),
    },
    PostgreSQL: {
      label: 'PostgreSQL',
      color: '#1a3a5c',
      inputs: [{ type: 'sql' }],
      outputs: [],
      factory: (x, y) => new PostgreSQL(x, y),
    },
  };

  /** Создать узел заданного типа */
  createNode(type, x, y) {
    const def = Simulation.nodeTypes[type];
    if (!def) throw new Error(`Unknown node type: ${type}`);
    const node = def.factory(x, y);
    this.nodes.push(node);
    return node;
  }

  /** Удалить узел и все его связи */
  removeNode(node) {
    // Удаляем связи
    const toRemove = [];
    for (const port of [...node.inputs, ...node.outputs]) {
      for (const conn of port.connections) {
        toRemove.push(conn);
      }
    }
    for (const conn of toRemove) {
      this.removeConnection(conn);
    }
    this.nodes = this.nodes.filter(n => n !== node);
  }

  /** Создать связь между двумя узлами (если возможна) */
  createConnection(fromNode, toNode) {
    // Ищем совместимые порты: выход fromNode → вход toNode
    for (const outPort of fromNode.outputs) {
      for (const inPort of toNode.inputs) {
        if (outPort.canConnectTo(inPort)) {
          const conn = new Connection(outPort, inPort);
          this.connections.push(conn);
          return conn;
        }
      }
    }
    return null; // Нет совместимых портов
  }

  /** Разорвать связь */
  removeConnection(conn) {
    conn.destroy();
    this.connections = this.connections.filter(c => c !== conn);
  }

  /** Найти связь между двумя узлами */
  findConnection(fromNode, toNode) {
    return this.connections.find(c =>
      c.from.node === fromNode && c.to.node === toNode
    );
  }

  /** Обновление симуляции (в Stage 2+) */
  update(dt) {
    // Будет в Stage 2
  }
}