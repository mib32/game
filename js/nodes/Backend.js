import { Node } from '../core/Node.js';
import { Particle, PARTICLE_SPEED } from '../core/Particle.js';

/**
 * Backend — конвертор: 1 API-запрос → N SQL-запросов.
 * Поддерживает таймаут, настраиваемый диапазон N и processing time.
 */
export class Backend extends Node {
  /**
   * @param {number} x
   * @param {number} y
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]      - таймаут API-запроса (ms), 0 = без таймаута
   * @param {string} [opts.onTimeout]      - 'abort' | 'detach'
   * @param {number} [opts.dbRequestsMin]  - мин. число SQL-запросов
   * @param {number} [opts.dbRequestsMax]  - макс. число SQL-запросов
   * @param {number} [opts.processingMin]  - мин. baseProcessingTime (ms)
   * @param {number} [opts.processingMax]  - макс. baseProcessingTime (ms)
   */
  constructor(x, y, opts = {}) {
    super('Backend', x, y, {
      label: 'Backend',
      color: '#4a3f1a',
      inputs: [{ type: 'api' }],
      outputs: [{ type: 'sql' }],
    });

    this.pendingParents = 0;

    // Настройки (с дефолтами)
    this.timeoutMs        = opts.timeoutMs ?? 5000;
    this.onTimeout        = opts.onTimeout ?? 'abort';
    this.dbRequestsMin    = opts.dbRequestsMin ?? 1;
    this.dbRequestsMax    = opts.dbRequestsMax ?? 5;
    this.minProcessingTime = opts.processingMin ?? 300;
    this.maxProcessingTime = opts.processingMax ?? 1500;
  }

  /** Применить новые настройки (из слайдеров) */
  applySettings(opts) {
    if (opts.timeoutMs !== undefined)        this.timeoutMs = opts.timeoutMs;
    if (opts.onTimeout !== undefined)        this.onTimeout = opts.onTimeout;
    if (opts.dbRequestsMin !== undefined)    this.dbRequestsMin = opts.dbRequestsMin;
    if (opts.dbRequestsMax !== undefined)    this.dbRequestsMax = opts.dbRequestsMax;
    if (opts.processingMin !== undefined)    this.minProcessingTime = opts.processingMin;
    if (opts.processingMax !== undefined)    this.maxProcessingTime = opts.processingMax;
  }

  /**
   * Принять API-запрос, размножить в N SQL-запросов.
   */
  receive(particle, sim) {
    particle.state = 'pending';
    particle.x = this.x;
    particle.y = this.y;
    particle.processingStartedAt = sim._simTime; // для таймаута

    const N = this.dbRequestsMin === this.dbRequestsMax
      ? this.dbRequestsMin
      : Math.floor(Math.random() * (this.dbRequestsMax - this.dbRequestsMin + 1)) + this.dbRequestsMin;

    const children = [];
    for (let i = 0; i < N; i++) {
      const baseTime = this.minProcessingTime +
        Math.random() * (this.maxProcessingTime - this.minProcessingTime);

      for (const outPort of this.outputs) {
        for (const conn of outPort.connections) {
          sim.stats.inc('requests_total', { type: 'sql' });
          children.push(new Particle('sql', conn, PARTICLE_SPEED, baseTime));
        }
      }
    }

    this.pendingParents++;
    particle._children = children;
    particle._parentNode = this;

    return { particles: children };
  }

  /**
   * Тик — проверка таймаутов по serviceMs (исключает wire-time).
   * Вызывается из Simulation.update.
   */
  tick(simTime, sim) {
    if (this.timeoutMs <= 0) return;

    for (const p of sim.particles) {
      if (p.state !== 'pending' || p._parentNode !== this) continue;

      // Service time = own + sum of children's (excludes arbitrary wire fly-time)
      const serviceTime = p.serviceMs + (p._children
        ? p._children.reduce((s, c) => s + c.serviceMs, 0)
        : 0);

      if (serviceTime < this.timeoutMs) continue;

      // Таймаут!
      p.state = 'error';
      sim.stats.inc('requests_outcome', { type: 'api', status: 'error' });

      if (this.onTimeout === 'abort' && p._children) {
        for (const child of p._children) {
          if (child.state === 'traveling' || child.state === 'processing') {
            child.state = 'error';
            sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
          }
        }
      }

      this.pendingParents--;
    }
  }

  /**
   * Вызывается когда дочерний запрос завершился.
   */
  onChildComplete(parentParticle, childSuccess, sim) {
    if (!parentParticle._children) return;
    // Игнорируем, если родитель уже свалился по таймауту
    if (parentParticle.state !== 'pending') return;

    parentParticle._completedChildren = (parentParticle._completedChildren || 0) + 1;
    if (!childSuccess) {
      parentParticle._anyChildFailed = true;
    }

    if (parentParticle._completedChildren >= parentParticle._children.length) {
      this.pendingParents--;
      parentParticle.serviceMs += parentParticle._children.reduce((s, c) => s + c.serviceMs, 0);
      if (parentParticle._anyChildFailed) {
        parentParticle.state = 'error';
        sim.stats.inc('requests_outcome', { type: 'api', status: 'error' });
      } else {
        parentParticle.state = 'success';
        sim.stats.inc('requests_outcome', { type: 'api', status: 'success' });
      }
      parentParticle.stateChangedAt = null;
    }
  }
}