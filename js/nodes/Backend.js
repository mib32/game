import { Node } from '../core/Node.js';
import { Particle, PARTICLE_SPEED } from '../core/Particle.js';

/**
 * Backend — конвертор: 1 API-запрос → N SQL-запросов.
 * 1 вход ('api'), 1 выход ('sql').
 * Ожидает завершения всех дочерних запросов (wait-all).
 * Назначает каждому дочернему запросу случайный baseProcessingTime.
 */
export class Backend extends Node {
  constructor(x, y) {
    super('Backend', x, y, {
      label: 'Backend',
      color: '#4a3f1a',
      inputs: [{ type: 'api' }],
      outputs: [{ type: 'sql' }],
    });

    /** Количество одновременно ожидающих родительских запросов */
    this.pendingParents = 0;

    // Диапазон случайного baseProcessingTime (ms) для SQL-запросов
    this.minProcessingTime = 300;
    this.maxProcessingTime = 1500;
  }

  /**
   * Принять API-запрос, размножить в N SQL-запросов.
   * Родитель остаётся в состоянии 'pending' на узле Backend.
   * @returns {{ particles: Particle[] }}
   */
  receive(particle, sim) {
    // Родительский запрос «застревает» на Backend
    particle.state = 'pending';
    // Перемещаем на позицию Backend
    particle.x = this.x;
    particle.y = this.y;
    particle.processingStartedAt = sim._simTime; // для таймаута (Stage 4)

    // const N = Math.floor(Math.random() * 5) + 1; // 1..5
    const N = 1;
    const children = [];

    for (let i = 0; i < N; i++) {
      // Случайный baseProcessingTime для каждого дочернего запроса
      let baseTime = this.minProcessingTime +
        Math.random() * (this.maxProcessingTime - this.minProcessingTime);
      baseTime = baseTime * 10;

      for (const outPort of this.outputs) {
        for (const conn of outPort.connections) {
          sim.stats.totalDbRequests++;
          children.push(new Particle('sql', conn, PARTICLE_SPEED, baseTime));
        }
      }
    }

    this.pendingParents++;

    // Сохраняем связку родитель-дети для отслеживания (Stage 4)
    particle._children = children;
    particle._parentNode = this;

    return { particles: children };
  }

  /**
   * Вызывается когда дочерний запрос завершился.
   * Если все дети отстрелялись — родитель success/error.
   */
  onChildComplete(parentParticle, childSuccess, sim) {
    if (!parentParticle._children) return;

    parentParticle._completedChildren = (parentParticle._completedChildren || 0) + 1;
    if (!childSuccess) {
      parentParticle._anyChildFailed = true;
    }

    if (parentParticle._completedChildren >= parentParticle._children.length) {
      this.pendingParents--;
      if (parentParticle._anyChildFailed) {
        parentParticle.state = 'error';
      } else {
        parentParticle.state = 'success';
      }
      parentParticle.stateChangedAt = null; // сброс для вспышки
    }
  }
}