/**
 * Particle — запрос, движущийся вдоль связи между узлами.
 * Имеет тип (api/sql), состояние и позицию на connection.
 */
export class Particle {
  static _nextId = 1;

  /**
   * @param {string} type - 'api' | 'sql'
   * @param {import('./Connection.js').Connection} connection
   * @param {number} speed - скорость (progress/сек)
   */
  constructor(type, connection, speed = 0.35) {
    this.id = Particle._nextId++;
    this.type = type;
    this.state = 'traveling'; // 'traveling' | 'processing' | 'success' | 'error'
    this.connection = connection;
    this.progress = 0;
    this.speed = speed;

    // Текущая позиция (обновляется в simulation.update)
    const from = connection.from.node;
    this.x = from.x;
    this.y = from.y;
  }
}