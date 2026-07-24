import { Node } from '../core/Node.js';
import { Particle } from '../core/Particle.js';

/**
 * TrafficSource — генерирует API-запросы.
 * Нет входов, один выход типа 'api'.
 */
export class TrafficSource extends Node {
  constructor(x, y) {
    super('TrafficSource', x, y, {
      label: 'Traffic Source',
      color: '#3a3a3a',
      inputs: [],
      outputs: [{ type: 'api' }],
      allowMultipleOutgoing: true, // round-robin: может отправлять на несколько Backend
    });

    /** Запросов в секунду в автоматическом режиме (0 = только ручной) */
    this.autoRate = 0;
    this._spawnAccumulator = 0;

    /** Индекс для round-robin по выходным соединениям */
    this._rrIndex = 0;
  }

  /**
   * Автоматический спавн по rate (accumulator-паттерн).
   * Вызывается из Simulation.update каждый кадр.
   */
  tick(simTime, dt, sim) {
    if (this.autoRate <= 0) return;
    const dtSec = dt / 1000;
    this._spawnAccumulator += this.autoRate * dtSec;
    while (this._spawnAccumulator >= 1) {
      this.generateRequest(sim);
      this._spawnAccumulator -= 1;
    }
  }

  /**
   * Сгенерировать один API-запрос.
   * Отправляет на ОДНО выходное соединение по round-robin,
   * а не дублирует на все одновременно (чтобы не ломать статистику).
   */
  generateRequest(sim) {
    // Собираем все выходные соединения в плоский список
    const allConns = [];
    for (const outPort of this.outputs) {
      for (const conn of outPort.connections) {
        allConns.push(conn);
      }
    }

    if (allConns.length === 0) return;

    // Round-robin: берём следующее соединение по кругу
    const conn = allConns[this._rrIndex % allConns.length];
    this._rrIndex++;

    // Регистрируем спавн для подсчёта эффективного RPS
    sim.recordApiSpawn();
    sim.stats.inc('requests_total', { type: 'api' });
    sim.spawnParticle(new Particle('api', conn));
  }
}