import { Node } from '../core/Node.js';

/**
 * PostgreSQL — процессит SQL-запросы. Имеет capacity (max_connections).
 * 1 вход ('sql'), нет выходов (терминальный узел).
 * At capacity: DROP (сразу ошибка).
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
    this.activeRequests = 0;
    this.dbSize = 0; // растёт с каждым успешным запросом
    this.baseProcessingTime = 500; // ms — базовая задержка процессинга
  }

  static tierConfig = {
    XS:  { maxConn: 5,   cpu: 5 },
    S:   { maxConn: 20,  cpu: 20 },
    M:   { maxConn: 60,  cpu: 60 },
    L:   { maxConn: 120, cpu: 120 },
    XL:  { maxConn: 250, cpu: 250 },
  };

  /** Установить новый tier (вызывает рестарт) */
  setTier(newTier) {
    this.tier = newTier;
    this.maxConnections = PostgreSQL.tierConfig[newTier].maxConn;
    this.cpu = PostgreSQL.tierConfig[newTier].cpu;
    this.label = `PostgreSQL (${newTier})`;
    // Рестарт: все активные запросы падают
    this.activeRequests = 0;
  }

  /**
   * Принять SQL-запрос.
   * Stage 2: просто поглощаем и считаем success.
   * Stage 3: добавится capacity + processing time.
   */
  receive(particle, sim) {
    particle.state = 'success';
    sim.stats.success++;
    return null;
  }
}