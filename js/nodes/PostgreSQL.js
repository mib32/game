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
    this.dbSizeCoeff = 1.0; // коэффициент влияния DB size на время запроса (0.0 – 1.0)
    this._activeParticles = []; // частицы в процессинге
  }

  static tierConfig = {
    XS:  { maxConn: 5,   cpu: 5 },
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

  /** Применить глобальные настройки (из слайдеров) */
  applySettings(opts) {
    if (opts.dbSizeCoeff !== undefined) this.dbSizeCoeff = opts.dbSizeCoeff;
  }

  /**
   * Принять SQL-запрос.
   * Если есть свободный слот: начать процессинг.
   * Если нет: DROP → error.
   */
  receive(particle, sim) {
    // Если узел умирает — не принимаем новые запросы
    if (this._isDying) return null;

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
  tick(simTime, dt, sim) {
    const completed = [];

    for (const p of this._activeParticles) {
      // Если частицу уже убили каскадным kill — просто вычищаем
      if (p.state !== 'processing') {
        completed.push(p);
        continue;
      }
      const processingTime = this._getProcessingTime(p);
      if (simTime - p.processingStartedAt >= processingTime) {
        completed.push(p);
      }
    }

    for (const p of completed) {
      this._activeParticles = this._activeParticles.filter(x => x !== p);
      // Не перезаписываем состояние, если частица уже в терминальном состоянии
      if (p.state === 'processing') {
        p.state = 'success';
        sim.stats.inc('requests_outcome', { type: 'sql', status: 'success' });
        this.dbSize++;
        // Уведомляем родительский Backend о завершении ребёнка
        this._notifyParent(p, true, sim);
      }
    }
  }

  /** Вычислить время процессинга для конкретного запроса */
  _getProcessingTime(particle) {
    const base = particle.baseProcessingTime || 500;
    // Штраф за размер БД: каждые 100 успешных запросов добавляют (100 * dbSizeCoeff)ms
    // При coeff=1.0 — стандартное поведение (+100ms/100 запросов)
    // При coeff=0.0 — размер БД не влияет на время запроса
    const dbPenalty = Math.floor(this.dbSize / 100) * Math.round(100 * this.dbSizeCoeff);
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

  /**
   * Очистка при удалении узла — убиваем все активные запросы с каскадом вверх.
   * Как sudo pkill: все дочерние запросы падают, родители узнают об ошибке.
   */
  cleanup(sim) {
    super.cleanup(sim);

    // Убиваем все запросы в процессинге
    for (const p of this._activeParticles) {
      p.state = 'error';
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
      // Каскад: уведомляем родителя о провале
      this._notifyParent(p, false, sim);
    }
    this._activeParticles = [];
  }
}