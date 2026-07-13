/**
 * Connection — направленная связь между выходным портом одного узла
 * и входным портом другого.
 */
export class Connection {
  /**
   * @param {import('./Port.js').Port} fromPort
   * @param {import('./Port.js').Port} toPort
   */
  constructor(fromPort, toPort) {
    this.from = fromPort;
    this.to = toPort;
    /** @type {import('./Particle.js').Particle[]} */
    this.particles = [];

    // Зарегистрироваться в портах
    fromPort.connections.push(this);
    toPort.connections.push(this);
  }

  /** Разорвать связь */
  destroy() {
    this.from.connections = this.from.connections.filter(c => c !== this);
    this.to.connections = this.to.connections.filter(c => c !== this);
  }
}