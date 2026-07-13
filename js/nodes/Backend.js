import { Node } from '../core/Node.js';

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
}