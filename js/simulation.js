import { TrafficSource } from './nodes/TrafficSource.js';
import { Backend } from './nodes/Backend.js';
import { PostgreSQL } from './nodes/PostgreSQL.js';
import { Connection } from './core/Connection.js';
import { Particle } from './core/Particle.js';

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
    // Удаляем частицы на этой связи
    this.particles = this.particles.filter(p => p.connection !== conn);
    conn.destroy();
    this.connections = this.connections.filter(c => c !== conn);
  }

  /** Найти связь между двумя узлами */
  findConnection(fromNode, toNode) {
    return this.connections.find(c =>
      c.from.node === fromNode && c.to.node === toNode
    );
  }

  /** Создать частицу и добавить в симуляцию */
  spawnParticle(particle) {
    this.particles.push(particle);
    particle.connection.particles.push(particle);
  }

  /** Обновление симуляции: движение частиц, прибытие, очистка */
  update(dt, simTime) {
    const dtSec = dt / 1000;
    const arrived = [];

    for (const p of this.particles) {
      if (p.state === 'traveling') {
        p.progress += p.speed * dtSec;

        // Обновляем позицию вдоль связи
        const from = p.connection.from.node;
        const to = p.connection.to.node;
        p.x = from.x + (to.x - from.x) * Math.min(p.progress, 1);
        p.y = from.y + (to.y - from.y) * Math.min(p.progress, 1);

        if (p.progress >= 1) {
          arrived.push(p);
        }
      }
    }

    // Обработка прибывших частиц
    for (const p of arrived) {
      const targetNode = p.connection.to.node;
      const result = targetNode.receive(p, this);

      if (result && result.particles) {
        for (const newP of result.particles) {
          this.spawnParticle(newP);
        }
      }
      // Частица остаётся в sim.particles с новым состоянием (success/error)
      // для краткой визуальной вспышки
    }

    // Удаляем success/error частицы после короткой задержки
    const FLASH_DURATION = 400; // ms
    this.particles = this.particles.filter(p => {
      if (p.state === 'success' || p.state === 'error') {
        if (p.stateChangedAt == null) {
          p.stateChangedAt = simTime;
          return true;
        }
        if (simTime - p.stateChangedAt > FLASH_DURATION) {
          p.connection.particles = p.connection.particles.filter(x => x !== p);
          return false;
        }
        return true;
      }
      return true;
    });
  }

  /** Удалить частицу из симуляции */
  _removeParticle(p) {
    this.particles = this.particles.filter(x => x !== p);
    p.connection.particles = p.connection.particles.filter(x => x !== p);
  }

  /** Сгенерировать один запрос из каждого TrafficSource */
  generateFromSources() {
    for (const node of this.nodes) {
      if (node instanceof TrafficSource) {
        node.generateRequest(this);
      }
    }
  }
}