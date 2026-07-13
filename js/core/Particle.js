/**
 * Particle — запрос, движущийся вдоль связи между узлами.
 * State machine: traveling → arrived → processing → success/error
 *   (или traveling → arrived → success/error — для мгновенных операций)
 */
export class Particle {
  static _nextId = 1;

  /**
   * @param {string} type - 'api' | 'sql'
   * @param {import('./Connection.js').Connection} connection
   * @param {number} speed - скорость (progress/сек)
   * @param {number} [baseProcessingTime] - базовое время обработки (назначается на Backend для SQL-запросов)
   */
  constructor(type, connection, speed = 0.35, baseProcessingTime = null) {
    this.id = Particle._nextId++;
    this.type = type;
    this.state = 'traveling';
    this.connection = connection;
    this.progress = 0;
    this.speed = speed;

    // Атрибуты запроса
    this.baseProcessingTime = baseProcessingTime; // задаётся на Backend для SQL-запросов
    this.processingStartedAt = null; // timestamp когда начался процессинг на PostgreSQL

    // Текущая позиция (обновляется в simulation.update)
    const from = connection.from.node;
    this.x = from.x;
    this.y = from.y;
  }
}