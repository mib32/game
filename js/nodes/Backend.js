import { Node } from '../core/Node.js';
import { Particle } from '../core/Particle.js';

/**
 * Backend — конвертор: 1 API-запрос → N SQL-запросов.
 * 1 вход ('api'), 1 выход ('sql').
 * Ожидает завершения всех дочерних запросов (wait-all).
 */
export class Backend extends Node {
  constructor(x, y) {
    super('Backend', x, y, {
      label: 'Backend',
      color: '#4a3f1a',
      inputs: [{ type: 'api' }],
      outputs: [{ type: 'sql' }],
    });
    /** @type {Array<{parent: Particle, children: Particle[], completed: number, failed: number}>} */
    this.pendingBatches = [];
    this.timeout = 5000; // ms — таймаут ожидания downstream
  }

  /**
   * Принять API-запрос, размножить в N SQL-запросов.
   * @returns {{ particles: Particle[] }}
   */
  receive(particle, sim) {
    const N = Math.floor(Math.random() * 5) + 1; // 1..5
    const children = [];

    for (let i = 0; i < N; i++) {
      for (const outPort of this.outputs) {
        for (const conn of outPort.connections) {
          sim.stats.totalDbRequests++;
          children.push(new Particle('sql', conn));
        }
      }
    }

    // Stage 4: отслеживание родитель-дети + timeout
    // this.pendingBatches.push({ parent: particle, children, completed: 0, failed: 0 });

    return { particles: children };
  }
}