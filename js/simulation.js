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

    // ── Пользователи ──
    /** Количество активных пользователей. Драйвит RPS. */
    this.users = 0;

    /** Прогресс до следующего пользователя (0..userProgressTarget) */
    this.userProgress = 0;

    /** Порог прогресса для получения следующего пользователя. Растёт с каждым юзером. */
    this.userProgressTarget = 5;

    /** Всего приобретено пользователей (за всё время) */
    this.usersGained = 0;

    /** Всего потеряно пользователей из-за churn (за всё время) */
    this.usersLostToChurn = 0;

    // ── Churn ──
    /**
     * Каждый пользователь терпит 5 ошибок прежде чем разочароваться и уйти.
     * 10 секунд без ошибок — счётчик обнуляется.
     */
    this.churnProgress = 0;
    this.churnTarget = 5;

    /** Timestamp последней API-ошибки (для автосброса через 10 сек) */
    this._lastApiErrorTime = -Infinity;

    /** Timestamp'ы спавнов API-запросов для расчёта эффективного RPS */
    this._apiSpawnTimestamps = [];

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
      factory: (x, y, opts) => new Backend(x, y, opts),
    },
    PostgreSQL: {
      label: 'PostgreSQL',
      color: '#1a3a5c',
      inputs: [{ type: 'sql' }],
      outputs: [],
      factory: (x, y) => new PostgreSQL(x, y),
    },
  };

  /** Зарегистрировать спавн API-запроса (для rate-метрики) */
  recordApiSpawn() {
    this._apiSpawnTimestamps.push(this._simTime);
  }

  /**
   * Эффективный rate спавна API-запросов за последние windowMs.
   * @param {number} windowMs
   * @returns {number} запросов/сек
   */
  getApiRate(windowMs = 2000) {
    const cutoff = this._simTime - windowMs;
    while (this._apiSpawnTimestamps.length > 0 && this._apiSpawnTimestamps[0] < cutoff) {
      this._apiSpawnTimestamps.shift();
    }
    if (this._apiSpawnTimestamps.length === 0) return 0;
    const span = this._simTime - this._apiSpawnTimestamps[0];
    if (span <= 0) return 0;
    return (this._apiSpawnTimestamps.length / span) * 1000;
  }

  /** Создать узел заданного типа */
  createNode(type, x, y, opts) {
    const def = Simulation.nodeTypes[type];
    if (!def) throw new Error(`Unknown node type: ${type}`);
    const node = def.factory(x, y, opts);
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
   * 3. Тики узлов (PostgreSQL + Backend + TrafficSource)
   * 4. Очистка terminal-частиц
   * 5. Satisfaction + progress + user growth + churn
   */
  update(dt, simTime) {
    this._simTime = simTime;
    const dtSec = dt / 1000;

    // Snapshot до тика
    const prevApiSuccess = this.stats.get('requests_outcome', { type: 'api', status: 'success' });
    const prevApiError = this.stats.get('requests_outcome', { type: 'api', status: 'error' });

    const arrived = [];

    // 1. Двигаем travelling-частицы
    for (const p of this.particles) {
      if (p.state !== 'traveling') continue;

      p.progress += p.speed * dtSec;

      const from = p.connection.from.node;
      const to = p.connection.to.node;
      const t = Math.min(p.progress, 1);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;

      p.x = from.x + dx * t + perpX * p.spreadOffset;
      p.y = from.y + dy * t + perpY * p.spreadOffset + Math.sin(simTime * 0.004 + p.id * 0.5) * 3;

      if (p.progress >= 1) {
        arrived.push(p);
      }
    }

    // 2. Обработка прибывших
    for (const p of arrived) {
      p.progress = 1;
      const targetNode = p.connection.to.node;
      const result = targetNode.receive(p, this);

      if (result && result.particles) {
        for (const newP of result.particles) {
          this.spawnParticle(newP);
        }
      }
    }

    // 3. Тик узлов
    for (const node of this.nodes) {
      if (node.tick) node.tick(simTime, dt, this);
    }

    // 3.5 serviceMs
    for (const p of this.particles) {
      if (p.state === 'processing') {
        p.serviceMs += dt;
      }
    }

    // 3.5 Парковка частиц
    for (const p of this.particles) {
      if (p.state === 'traveling') continue;
      const node = p.connection.to.node;
      const angle = (p.id * 2.399963) % (Math.PI * 2);
      const radius = 15;
      p.x = node.x + Math.cos(angle) * radius;
      p.y = node.y + Math.sin(angle) * radius + Math.sin(simTime * 0.004 + p.id * 0.5) * 3;
    }

    // 4. Очистка terminal-частиц
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

    // 5. Growth + churn
    const deltaApiOk  = this.stats.get('requests_outcome', { type: 'api', status: 'success' }) - prevApiSuccess;
    const deltaApiErr = this.stats.get('requests_outcome', { type: 'api', status: 'error' }) - prevApiError;

    // Рост: API-успехи добавляют очки к следующему юзеру
    this.userProgress += deltaApiOk * 5;

    while (this.userProgress >= this.userProgressTarget) {
      this.userProgress -= this.userProgressTarget;
      this.users += 1;
      this.usersGained += 1;
      this.userProgressTarget = 5 + this.users * 2;
    }

    // Churn: каждый юзер терпит 5 ошибок прежде чем уйти
    if (deltaApiErr > 0) {
      this.churnProgress += deltaApiErr;
      this._lastApiErrorTime = simTime;
    }

    // Автосброс: 10 секунд без ошибок → churnProgress = 0
    if (simTime - this._lastApiErrorTime > 10000) {
      this.churnProgress = 0;
    }

    if (this.churnProgress >= this.churnTarget && this.users > 0) {
      this.users -= 1;
      this.usersLostToChurn += 1;
      this.churnProgress = 0;
    }

    // При нуле юзеров счётчик всегда 0 — некому разочаровываться
    if (this.users === 0) {
      this.churnProgress = 0;
    }

    // autoRate = users × 0.1 rps на пользователя с медленным шумом
    for (const node of this.nodes) {
      if (node.type === 'TrafficSource') {
        if (this.users === 0) {
          node.autoRate = 0;
          continue;
        }
        if (!node._randomFactor || Math.random() < 0.005) {
          node._randomFactor = 0.7 + Math.random() * 0.6;
        }
        node.autoRate = this.users * 0.1 * node._randomFactor;
      }
    }
  }

  generateFromSources() {
    for (const node of this.nodes) {
      if (node instanceof TrafficSource) {
        node.generateRequest(this);
      }
    }
  }
}