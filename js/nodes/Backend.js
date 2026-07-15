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
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.onTimeout]      - 'abort' | 'detach'
   * @param {boolean} [opts.sequential]     - send DB requests one-by-one (default true)
   * @param {number} [opts.dbRequestsMin]
   * @param {number} [opts.dbRequestsMax]
   * @param {number} [opts.processingMin]
   * @param {number} [opts.processingMax]
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
    this.sequential       = opts.sequential ?? true;
    this.dbRequestsMin    = opts.dbRequestsMin ?? 1;
    this.dbRequestsMax    = opts.dbRequestsMax ?? 5;
    this.minProcessingTime = opts.processingMin ?? 300;
    this.maxProcessingTime = opts.processingMax ?? 1500;
  }

  /** Применить новые настройки (из слайдеров) */
  applySettings(opts) {
    if (opts.timeoutMs !== undefined)        this.timeoutMs = opts.timeoutMs;
    if (opts.onTimeout !== undefined)        this.onTimeout = opts.onTimeout;
    if (opts.sequential !== undefined)       this.sequential = opts.sequential;
    if (opts.dbRequestsMin !== undefined)    this.dbRequestsMin = opts.dbRequestsMin;
    if (opts.dbRequestsMax !== undefined)    this.dbRequestsMax = opts.dbRequestsMax;
    if (opts.processingMin !== undefined)    this.minProcessingTime = opts.processingMin;
    if (opts.processingMax !== undefined)    this.maxProcessingTime = opts.processingMax;
  }

  /**
   * Принять API-запрос.
   * Параллельный режим: сразу spawn N детей.
   * Последовательный режим: spawn первого, остальные — по завершению.
   */
  receive(particle, sim) {
    particle.state = 'pending';
    particle.x = this.x;
    particle.y = this.y;
    particle.processingStartedAt = sim._simTime;

    const total = this.dbRequestsMin === this.dbRequestsMax
      ? this.dbRequestsMin
      : Math.floor(Math.random() * (this.dbRequestsMax - this.dbRequestsMin + 1)) + this.dbRequestsMin;

    this.pendingParents++;
    this._pending.add(particle);
    particle._children = [];
    particle._parentNode = this;
    particle._childrenServiceMs = 0;
    particle._totalExpected = total;

    if (this.sequential) {
      // Отправить первого, остальные — по мере завершения
      this._spawnOneChild(particle, sim);
    } else {
      // Параллельно: все сразу
      for (let i = 0; i < total; i++) {
        this._spawnOneChild(particle, sim);
      }
    }

    return { particles: particle._children };
  }

  /** Создать и отправить одного SQL-ребёнка */
  _spawnOneChild(parentParticle, sim) {
    const baseTime = this.minProcessingTime +
      Math.random() * (this.maxProcessingTime - this.minProcessingTime);

    const spawned = [];
    for (const outPort of this.outputs) {
      for (const conn of outPort.connections) {
        sim.stats.inc('requests_total', { type: 'sql' });
        const child = new Particle('sql', conn, PARTICLE_SPEED, baseTime);
        child._parentParticle = parentParticle;
        spawned.push(child);
      }
    }
    parentParticle._children.push(...spawned);
    return spawned;
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

    // В последовательном режиме: ошибка ребёнка = немедленный фейл родителя
    if (this.sequential && !childSuccess) {
      parentParticle._anyChildFailed = true;
      this._finishParent(parentParticle, sim);
      return;
    }

    parentParticle._completedChildren = (parentParticle._completedChildren || 0) + 1;
    if (!childSuccess) {
      parentParticle._anyChildFailed = true;
    }

    // Последовательный режим: отправить следующего, если ещё есть
    if (this.sequential) {
      if (parentParticle._children.length < parentParticle._totalExpected) {
        const spawned = this._spawnOneChild(parentParticle, sim);
        for (const child of spawned) sim.spawnParticle(child);
        return;
      }
      // Все отправлены — ждём завершения последнего
      if (parentParticle._completedChildren < parentParticle._totalExpected) return;
      this._finishParent(parentParticle, sim);
      return;
    }

    // Параллельный режим: все дети уже отправлены, ждём всех
    if (parentParticle._completedChildren >= parentParticle._children.length) {
      this._finishParent(parentParticle, sim);
    }
  }

  _finishParent(parentParticle, sim) {
    this._pending.delete(parentParticle);
    this.pendingParents--;

    // Суммируем children serviceMs
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