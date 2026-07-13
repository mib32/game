import { Node } from '../core/Node.js';

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
    this.rate = 1; // запросов в секунду
    this.timer = 0;
  }
}