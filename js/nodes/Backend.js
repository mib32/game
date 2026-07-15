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

    /** @type {Set<Particle>} — отслеживаем только свои pending-частицы */
    this._pending = new Set();

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
    particle.processingStartedAt = sim._simTime;

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
          const child = new Particle('sql', conn, PARTICLE_SPEED, baseTime);
          child._parentParticle = particle;  // прямой обратный указатель
          children.push(child);
        }
      }
    }

    this.pendingParents++;
    this._pending.add(particle);
    particle._children = children;
    particle._parentNode = this;
    particle._childrenServiceMs = 0;  // кеш для tick

    return { particles: children };
  }

  /**
   * Тик — проверка таймаутов.
   * Итерирует ТОЛЬКО свои pending-частицы, а не все sim.particles.
   */
  tick(simTime, sim) {
    if (this.timeoutMs <= 0 || this._pending.size === 0) return;

    for (const p of this._pending) {
      // Инкрементально считаем children serviceMs (без reduce каждый кадр)
      let childTotal = p._childrenServiceMs;
      if (p._children) {
        for (let i = 0; i < p._children.length; i++) {
          childTotal += p._children[i].serviceMs;
        }
      }
      const serviceTime = p.serviceMs + childTotal;

      if (serviceTime < this.timeoutMs) continue;

      // Таймаут!
      p.state = 'error';
      this._pending.delete(p);
      this.pendingParents--;
      sim.stats.inc('requests_outcome', { type: 'api', status: 'error' });

      if (this.onTimeout === 'abort' && p._children) {
        for (const child of p._children) {
          if (child.state === 'traveling' || child.state === 'processing') {
            child.state = 'error';
            sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
          }
        }
      }
    }
  }

  /**
   * Вызывается когда дочерний запрос завершился.
   */
  onChildComplete(parentParticle, childSuccess, sim) {
    if (!parentParticle._children) return;
    if (parentParticle.state !== 'pending') return;

    parentParticle._completedChildren = (parentParticle._completedChildren || 0) + 1;
    if (!childSuccess) {
      parentParticle._anyChildFailed = true;
    }

    if (parentParticle._completedChildren >= parentParticle._children.length) {
      this._pending.delete(parentParticle);
      this.pendingParents--;

      // Суммируем children serviceMs (один раз, без reduce)
      let total = 0;
      for (let i = 0; i < parentParticle._children.length; i++) {
        total += parentParticle._children[i].serviceMs;
      }
      parentParticle.serviceMs += total;

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