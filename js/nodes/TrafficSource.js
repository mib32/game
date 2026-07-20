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
    });

    /** Запросов в секунду в автоматическом режиме (0 = только ручной) */
    this.autoRate = 0;
    this._spawnAccumulator = 0;
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

  /** Сгенерировать один API-запрос на все выходные связи */
  generateRequest(sim) {
    // Регистрируем спавн для подсчёта эффективного RPS
    sim.recordApiSpawn();

    for (const outPort of this.outputs) {
      for (const conn of outPort.connections) {
        sim.stats.inc('requests_total', { type: 'api' });
        sim.spawnParticle(new Particle('api', conn));
      }
    }
  }
}