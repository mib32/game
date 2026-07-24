import { Node } from '../core/Node.js';
import { Particle, PARTICLE_SPEED } from '../core/Particle.js';

/**
 * PgBouncer — пулер соединений перед PostgreSQL.
 * В отличие от PostgreSQL (который дропает при превышении capacity),
 * PgBouncer ставит запросы в очередь и отдаёт их по мере освобождения слотов.
 *
 * Вход: 'sql', Выход: 'sql'
 * Настраиваемый poolSize (количество одновременных соединений к PostgreSQL).
 */
export class PgBouncer extends Node {
  /**
   * @param {number} x
   * @param {number} y
   * @param {object} [opts]
   * @param {number} [opts.poolSize] — размер пула (по умолчанию 10)
   */
  constructor(x, y, opts = {}) {
    super('PgBouncer', x, y, {
      label: 'PgBouncer',
      color: '#4a3020', // тёплый янтарно-коричневый
      inputs: [{ type: 'sql' }],
      outputs: [{ type: 'sql' }],
    });

    /** Максимальное количество одновременных соединений к PostgreSQL */
    this.poolSize = opts.poolSize || 5;

    /** Очередь ожидающих запросов (FIFO) */
    this._queue = [];

    /**
     * Активные прокси-частицы, отправленные в PostgreSQL.
     * Map<proxyParticle, originalParticle> — связь прокси → оригинал.
     */
    this._activeProxies = new Map();
  }

  /** Количество активных соединений (занятых слотов пула) */
  get activeConnections() {
    return this._activeProxies.size;
  }

  /** Длина очереди ожидания */
  get queueLength() {
    return this._queue.length;
  }

  /**
   * Принять SQL-запрос.
   * Если есть свободный слот — сразу форвардим в PostgreSQL.
   * Если нет — ставим в очередь.
   */
  receive(particle, sim) {
    // Если узел умирает — не принимаем новые запросы
    if (this._isDying) return null;

    // Если нет выходных соединений — запросу некуда идти, фейлим сразу
    if (!this._hasOutputConnection()) {
      particle.state = 'error';
      particle.x = this.x;
      particle.y = this.y;
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
      // Каскад: уведомляем Backend о провале
      if (particle._parentParticle && particle._parentParticle._parentNode) {
        particle._parentParticle._parentNode.onChildComplete(
          particle._parentParticle, false, sim
        );
      }
      return null;
    }

    if (this.activeConnections < this.poolSize) {
      // Сразу паркуем оригинал у PgBouncer (меняем состояние, чтобы не «прибывал» повторно)
      particle.state = 'queued';
      particle.x = this.x;
      particle.y = this.y;
      this._forwardToPostgres(particle, sim);
    } else {
      // Ставим в очередь ожидания
      particle.state = 'queued';
      particle.x = this.x;
      particle.y = this.y;
      this._queue.push(particle);
    }
    return null;
  }

  /** Проверить, есть ли хотя бы одно выходное соединение */
  _hasOutputConnection() {
    for (const outPort of this.outputs) {
      if (outPort.connections.length > 0) return true;
    }
    return false;
  }

  /**
   * Отправить запрос в PostgreSQL (создать прокси-частицу).
   * Настраиваем цепочку уведомлений так, чтобы PgBouncer узнал о завершении.
   * @param {import('../core/Particle.js').Particle} original — оригинальная частица из очереди
   * @param {import('../simulation.js').Simulation} sim
   */
  _forwardToPostgres(original, sim) {
    // Если нет выходных соединений — оставляем в очереди (пользователь должен подключить PostgreSQL)
    if (this.outputs.length === 0) return;

    for (const outPort of this.outputs) {
      for (const conn of outPort.connections) {
        // Не инкрементируем requests_total — запрос уже учтён на Backend
        const proxy = new Particle('sql', conn, PARTICLE_SPEED, original.baseProcessingTime);

        // Создаём объект-обёртку для перехвата _notifyParent от PostgreSQL.
        // PostgreSQL вызывает _notifyParent(proxy) → proxy._parentParticle._parentNode.onChildComplete(...)
        // Обёртка имеет _parentNode = this (PgBouncer), поэтому вызовется PgBouncer.onChildComplete.
        const wrapper = {
          _parentNode: this,
          _originalParticle: original,
          _proxy: proxy,
        };
        proxy._parentParticle = wrapper;

        this._activeProxies.set(proxy, original);
        sim.spawnParticle(proxy);
      }
    }
  }

  /**
   * Вызывается когда PostgreSQL завершает обработку прокси-частицы.
   * (через цепочку _notifyParent → _parentParticle._parentNode.onChildComplete)
   *
   * @param {object} wrapper — { _parentNode, _originalParticle, _proxy }
   * @param {boolean} success — успешно ли завершился запрос
   * @param {import('../simulation.js').Simulation} sim
   */
  onChildComplete(wrapper, success, sim) {
    const original = wrapper._originalParticle;
    const proxy = wrapper._proxy;

    // Удаляем прокси из активных (слот освобождается)
    this._activeProxies.delete(proxy);

    // Перенос serviceMs с прокси НЕ делаем — original.serviceMs уже тикал
    // всё время через PgBouncer.tick() (и в очереди, и в _activeProxies).
    // Если перенести ещё и proxy.serviceMs — будет задвоение времени.

    // Уведомляем Backend о завершении оригинальной частицы,
    // только если её ещё не убили (таймаут, каскадный kill)
    if (original && original._parentParticle && original._parentParticle._parentNode) {
      // Не перезаписываем терминальное состояние!
      if (original.state !== 'success' && original.state !== 'error') {
        original.state = success ? 'success' : 'error';
      }
      // Всё равно уведомляем Backend — он сам разберётся (проверит state)
      original._parentParticle._parentNode.onChildComplete(
        original._parentParticle,
        success && original.state === 'success',
        sim
      );
    }

    // Освобождаем слот — обрабатываем следующего из очереди
    // (только если узел не умирает — при каскадном kill очередь убивается целиком)
    if (!this._isDying) {
      this._processQueue(sim);
    }
  }

  /**
   * Достаём следующий запрос из очереди (если есть свободные слоты).
   * @param {import('../simulation.js').Simulation} sim
   */
  _processQueue(sim) {
    if (this._isDying) return;
    while (this.activeConnections < this.poolSize && this._queue.length > 0) {
      const next = this._queue.shift();
      // Пропускаем уже убитые частицы (таймаут/cascade)
      if (next.state === 'error' || next.state === 'success') continue;
      // Оставляем состояние 'queued' — оригинал остаётся у PgBouncer,
      // а в PostgreSQL идёт прокси. Рендерер покажет оранжевую пульсацию.
      this._forwardToPostgres(next, sim);
    }
  }

  /**
   * Тик — инкрементируем serviceMs для частиц в очереди.
   * Это нужно, чтобы Backend мог отследить таймаут даже пока запрос ждёт в PgBouncer.
   */
  tick(simTime, dt, sim) {
    // Вычищаем убитые частицы из очереди (таймаут/cascade)
    this._queue = this._queue.filter(p => {
      if (p.state === 'error' || p.state === 'success') {
        return false;
      }
      return true;
    });

    // Вычищаем убитые оригиналы из активных прокси
    // (собираем ключи отдельно — нельзя удалять из Map во время итерации)
    const deadProxies = [];
    for (const [proxy, original] of this._activeProxies) {
      if (original.state === 'error' || original.state === 'success') {
        deadProxies.push(proxy);
      }
    }
    for (const proxy of deadProxies) {
      this._activeProxies.delete(proxy);
    }

    // Инкрементируем время для частиц в очереди (ждут своей очереди)
    for (const p of this._queue) {
      p.serviceMs += dt;
    }

    // Инкрементируем время для активных оригиналов (прокси в PostgreSQL).
    // Это нужно, чтобы Backend мог отследить таймаут, пока прокси обрабатывается.
    // Время не задвоится: proxy.serviceMs считает чистое время в PostgreSQL,
    // а здесь мы даём оригиналу «тик» параллельно.
    for (const [, original] of this._activeProxies) {
      original.serviceMs += dt;
    }
  }

  /**
   * Очистка при удалении узла — убиваем всё с каскадом вверх.
   * 1. Прокси-частицы (в PostgreSQL) → error
   * 2. Оригиналы (у PgBouncer) → error → каскад к Backend
   * 3. Частицы в очереди → error → каскад к Backend
   * @param {import('../simulation.js').Simulation} sim
   */
  cleanup(sim) {
    super.cleanup(sim);

    // Убиваем активные прокси и каскадируем к оригиналам → Backend
    for (const [proxy, original] of this._activeProxies) {
      proxy.state = 'error';
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });

      // Каскад: уведомляем Backend через оригинал
      if (original && original._parentParticle && original._parentParticle._parentNode) {
        original.state = 'error';
        original._parentParticle._parentNode.onChildComplete(
          original._parentParticle,
          false,
          sim
        );
      }
    }
    this._activeProxies.clear();

    // Убиваем всё из очереди с каскадом к Backend
    for (const p of this._queue) {
      p.state = 'error';
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });

      if (p._parentParticle && p._parentParticle._parentNode) {
        p._parentParticle._parentNode.onChildComplete(
          p._parentParticle,
          false,
          sim
        );
      }
    }
    this._queue = [];
  }
}
