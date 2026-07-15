import { Node } from '../core/Node.js';

/**
 * PostgreSQL — процессит SQL-запросы. Имеет capacity (max_connections).
 * 1 вход ('sql'), нет выходов (терминальный узел).
 * At capacity: DROP (сразу ошибка).
 * Processing time: baseProcessingTime + dbSize * 10ms.
 */
export class PostgreSQL extends Node {
  constructor(x, y, tier = 'XS') {
    super('PostgreSQL', x, y, {
      label: `PostgreSQL (${tier})`,
      color: '#1a3a5c',
      inputs: [{ type: 'sql' }],
      outputs: [],
    });

    this.tier = tier;
    this.maxConnections = PostgreSQL.tierConfig[tier].maxConn;
    this.cpu = PostgreSQL.tierConfig[tier].cpu;
    this.dbSize = 0; // растёт с каждым успешным запросом
    this._activeParticles = []; // частицы в процессинге
  }

  static tierConfig = {
    XS:  { maxConn: 1,   cpu: 5 },
    S:   { maxConn: 20,  cpu: 20 },
    M:   { maxConn: 60,  cpu: 60 },
    L:   { maxConn: 120, cpu: 120 },
    XL:  { maxConn: 250, cpu: 250 },
  };

  /** Количество активных соединений */
  get activeConnections() {
    return this._activeParticles.length;
  }

  /** Установить новый tier (вызывает рестарт) */
  setTier(newTier) {
    this.tier = newTier;
    this.maxConnections = PostgreSQL.tierConfig[newTier].maxConn;
    this.cpu = PostgreSQL.tierConfig[newTier].cpu;
    this.label = `PostgreSQL (${newTier})`;
    // Рестарт: все активные запросы падают
    for (const p of this._activeParticles) {
      p.state = 'error';
    }
    this._activeParticles = [];
  }

  /**
   * Принять SQL-запрос.
   * Если есть свободный слот: начать процессинг.
   * Если нет: DROP → error.
   */
  receive(particle, sim) {
    if (this.activeConnections >= this.maxConnections) {
      // At capacity → DROP
      particle.state = 'error';
      particle.x = this.x;
      particle.y = this.y;
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
      this._notifyParent(particle, false, sim);
      return null;
    }

    // Занимаем слот
    particle.state = 'processing';
    particle.x = this.x;
    particle.y = this.y;
    particle.processingStartedAt = sim._simTime;
    particle._totalProcessingTime = this._getProcessingTime(particle); // для рендера прогресс-кольца
    this._activeParticles.push(particle);
    return null;
  }

  /**
   * Обновление процессинга: проверяем, не завершились ли запросы.
   * Вызывается из Simulation.update.
   */
  tick(simTime, sim) {
    const completed = [];

    for (const p of this._activeParticles) {
      const processingTime = this._getProcessingTime(p);
      if (simTime - p.processingStartedAt >= processingTime) {
        completed.push(p);
      }
    }

    for (const p of completed) {
      this._activeParticles = this._activeParticles.filter(x => x !== p);
      p.state = 'success';
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'success' });
      this.dbSize++;

      // Уведомляем родительский Backend о завершении ребёнка
      this._notifyParent(p, true, sim);
    }
  }

  /** Вычислить время процессинга для конкретного запроса */
  _getProcessingTime(particle) {
    const base = particle.baseProcessingTime || 500;
    // dbSize добавляет задержку: каждая 100 успешных запросов = +100ms
    const dbPenalty = Math.floor(this.dbSize / 100) * 100;
    return base + dbPenalty;
  }

  /** Уведомить родительский Backend-узел о завершении дочернего запроса */
  _notifyParent(particle, success, sim) {
    // Прямой обратный указатель (установлен в Backend.receive) — без O(n) сканирования
    const parent = particle._parentParticle;
    if (parent && parent._parentNode) {
      parent._parentNode.onChildComplete(parent, success, sim);
    }
  }
}