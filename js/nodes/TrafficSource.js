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
    this.rate = 1; // запросов в секунду (для Stage 4)
    this.timer = 0;
  }

  /** Сгенерировать один API-запрос на все выходные связи */
  generateRequest(sim) {
    for (const outPort of this.outputs) {
      for (const conn of outPort.connections) {
        sim.stats.totalApiRequests++;
        sim.spawnParticle(new Particle('api', conn));
      }
    }
  }
}