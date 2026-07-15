import { TrafficSource } from './nodes/TrafficSource.js';
import { Backend } from './nodes/Backend.js';
import { PostgreSQL } from './nodes/PostgreSQL.js';
import { Connection } from './core/Connection.js';
import { Particle } from './core/Particle.js';
import { StatsCollector } from './core/StatsCollector.js';

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

    this._simTime = 0;

    /** @type {StatsCollector} */
    this.stats = new StatsCollector();
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
    const toRemove = [];
    for (const port of [...node.inputs, ...node.outputs]) {
      for (const conn of port.connections) {
        toRemove.push(conn);
      }
    }
    for (const conn of toRemove) {
      this.removeConnection(conn);
    }
    // Удаляем pending-частицы на узле
    this.particles = this.particles.filter(p => {
      if (p.state === 'pending' && p._parentNode === node) return false;
      if (p.state === 'processing' && node._activeParticles && node._activeParticles.includes(p)) return false;
      return true;
    });
    this.nodes = this.nodes.filter(n => n !== node);
  }

  /** Создать связь между двумя узлами (если возможна) */
  createConnection(fromNode, toNode) {
    for (const outPort of fromNode.outputs) {
      for (const inPort of toNode.inputs) {
        if (outPort.canConnectTo(inPort)) {
          const conn = new Connection(outPort, inPort);
          this.connections.push(conn);
          return conn;
        }
      }
    }
    return null;
  }

  /** Разорвать связь */
  removeConnection(conn) {
    this.particles = this.particles.filter(p => p.connection !== conn);
    conn.destroy();
    this.connections = this.connections.filter(c => c !== conn);
  }

  /** Создать частицу и добавить в симуляцию */
  spawnParticle(particle) {
    particle.createdAt = this._simTime;
    this.particles.push(particle);
    particle.connection.particles.push(particle);
  }

  /**
   * Обновление симуляции:
   * 1. Движение travelling-частиц
   * 2. Прибытие → вызов node.receive()
   * 3. PostgreSQL.tick() — проверка процессинга
   * 4. Очистка terminal-частиц (success/error)
   */
  update(dt, simTime) {
    this._simTime = simTime;
    const dtSec = dt / 1000;
    const arrived = [];

    // 1. Двигаем travelling-частицы
    for (const p of this.particles) {
      if (p.state !== 'traveling') continue;

      p.progress += p.speed * dtSec;

      const from = p.connection.from.node;
      const to = p.connection.to.node;
      const t = Math.min(p.progress, 1);

      // Base position along the connection line
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;

      // Perpendicular unit vector for axial spread
      const perpX = -dy / len;
      const perpY = dx / len;

      p.x = from.x + dx * t + perpX * p.spreadOffset;
      p.y = from.y + dy * t + perpY * p.spreadOffset + Math.sin(simTime * 0.004 + p.id * 0.5) * 3;

      if (p.progress >= 1) {
        arrived.push(p);
      }
    }

    // 2. Обработка прибывших (единожды — меняем state сразу)
    for (const p of arrived) {
      p.progress = 1;
      const targetNode = p.connection.to.node;
      const result = targetNode.receive(p, this);

      // receive() сам меняет state: 'pending', 'processing', 'success', 'error'
      // поэтому частица больше не попадёт в travelling-фильтр выше

      if (result && result.particles) {
        for (const newP of result.particles) {
          this.spawnParticle(newP);
        }
      }
    }

    // 3. Тик PostgreSQL (проверка завершения процессинга)
    for (const node of this.nodes) {
      if (node instanceof PostgreSQL) {
        node.tick(simTime, this);
      }
    }

    // 3.5 Разносим parked-частицы по окружности вокруг их target-узла
    for (const p of this.particles) {
      if (p.state === 'traveling') continue;
      const node = p.connection.to.node;
      const angle = (p.id * 2.399963) % (Math.PI * 2); // golden-angle spread
      const radius = 15;
      p.x = node.x + Math.cos(angle) * radius;
      p.y = node.y + Math.sin(angle) * radius + Math.sin(simTime * 0.004 + p.id * 0.5) * 3;
    }

    // 4. Очистка terminal-частиц после вспышки
    const FLASH_DURATION = 400;
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

  /** Сгенерировать один запрос из каждого TrafficSource */
  generateFromSources() {
    for (const node of this.nodes) {
      if (node instanceof TrafficSource) {
        node.generateRequest(this);
      }
    }
  }
}