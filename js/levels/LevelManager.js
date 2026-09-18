import { levels, getNextLevel } from './levels.js';

/**
 * LevelManager — управляет загрузкой уровней, проверкой условий победы/поражения.
 * Не зависит от UI. Чистая логика.
 */
export class LevelManager {
  /**
   * @param {import('../simulation.js').Simulation} sim
   */
  constructor(sim) {
    this.sim = sim;
    /** @type {object|null} — текущий загруженный уровень */
    this.currentLevel = null;
    /** @type {object|null} — объект с текущими настройками уровня */
    this.levelSettings = null;
    /** @type {Set<string>} — какие настройки заблокированы */
    this.lockedSettings = new Set();
    /** @type {string[]} — какие типы нод доступны в палитре */
    this.availableNodes = [];
    /** @type {number} — максимальное количество нод */
    this.maxNodes = Infinity;
    /** @type {boolean} — активен ли режим уровня */
    this.active = false;

    // Таймер уровня (через симуляционное время)
    this._startTime = 0;

    // Снапшот счётчиков на старте уровня (для подсчёта прогресса)
    this._startStats = null;

    // Колбэки
    this.onWin = null;
    this.onLose = null;
    this.onProgress = null;

    // Флаг чтобы не слать повторные события
    this._finished = false;
  }

  /** Список всех доступных уровней */
  getLevels() {
    return levels;
  }

  /** Загрузить уровень по id */
  loadLevel(levelId) {
    const level = levels.find(l => l.id === levelId);
    if (!level) {
      console.error(`Level not found: ${levelId}`);
      return false;
    }

    this.currentLevel = level;
    this._finished = false;
    this.active = true;

    // Сбрасываем симуляцию
    this.sim.reset();
    // Подавляем автосохранение графа во время загрузки уровня
    this.sim._suppressNotify = true;

    // Применяем настройки уровня
    this.levelSettings = { ...level.settings };
    this.lockedSettings = new Set(level.lockedSettings || []);
    this.availableNodes = [...(level.availableNodes || [])];
    this.maxNodes = level.maxNodes ?? Infinity;

    // Настройки симуляции (фиксированные пользователи и т.д.)
    this.sim._levelMode = true;
    if (level.fixedUsers) {
      this.sim.fixedUsers = true;
      this.sim.users = level.startingUsers || 0;
    }

    // Создаём ноды уровня (используем ID из уровня для соединений)
    /** @type {Map<string, import('../core/Node.js').Node>} */
    const nodeMap = new Map();
    for (const nd of level.nodes) {
      const node = this.sim.createNode(nd.type, nd.x, nd.y, this.levelSettings);
      if (nd.tier && typeof node.setTier === 'function') {
        node.setTier(nd.tier);
      }
      if (nd.id) {
        nodeMap.set(nd.id, node);
      }
    }

    // Создаём соединения
    for (const c of (level.connections || [])) {
      const fromNode = nodeMap.get(c.from);
      const toNode = nodeMap.get(c.to);
      if (fromNode && toNode) {
        this.sim.createConnection(fromNode, toNode);
      }
    }

    // Снапшотим начальные счётчики для прогресса
    this._startStats = {
      apiSuccess: this.sim.stats.get('requests_outcome', { type: 'api', status: 'success' }),
      apiError: this.sim.stats.get('requests_outcome', { type: 'api', status: 'error' }),
    };

    this._startTime = 0; // _simTime уже сброшен в reset()

    // Разрешаем onChange обратно
    this.sim._suppressNotify = false;

    // Уведомляем UI
    if (this.onProgress) {
      this.onProgress(this.getProgress());
    }

    return true;
  }

  /**
   * Проверить условия победы/поражения.
   * Вызывается каждый кадр из main.js.
   * @returns {{ win: boolean, lose: boolean } | null}
   */
  checkConditions() {
    if (!this.active || !this.currentLevel || this._finished) return null;

    const level = this.currentLevel;
    const result = { win: false, lose: false };

    // Проверка победы
    if (level.winCondition) {
      if (level.winCondition.type === 'apiSuccess') {
        const apiOk = this.sim.stats.get('requests_outcome', { type: 'api', status: 'success' });
        // Вычитаем стартовое значение (если уровень начался не с нуля)
        const sinceStart = apiOk - (this._startStats?.apiSuccess || 0);
        if (sinceStart >= level.winCondition.count) {
          result.win = true;
        }
      }
    }

    // Проверка поражения
    if (level.loseCondition) {
      if (level.loseCondition.type === 'churn') {
        if (this.sim.usersLostToChurn >= level.loseCondition.maxLost) {
          result.lose = true;
        }
      } else if (level.loseCondition.type === 'usersBelow') {
        if (this.sim.users < level.loseCondition.threshold) {
          result.lose = true;
        }
      }
    }

    // Отправляем события
    if (result.win) {
      this._finished = true;
      if (this.onWin) this.onWin(level);
    } else if (result.lose) {
      this._finished = true;
      if (this.onLose) this.onLose(level);
    }

    // Обновляем прогресс для UI
    if (this.onProgress && !this._finished) {
      this.onProgress(this.getProgress());
    }

    return result;
  }

  /** Получить текущий прогресс для UI */
  getProgress() {
    if (!this.active || !this.currentLevel) return null;

    const level = this.currentLevel;
    const prog = {
      title: level.title,
      description: level.description,
      hint: level.hint,
      current: 0,
      target: 0,
      label: '',
      time: this.sim._simTime,
    };

    if (level.winCondition?.type === 'apiSuccess') {
      const apiOk = this.sim.stats.get('requests_outcome', { type: 'api', status: 'success' });
      const sinceStart = apiOk - (this._startStats?.apiSuccess || 0);
      prog.current = Math.min(sinceStart, level.winCondition.count);
      prog.target = level.winCondition.count;
      prog.label = 'успешных API-запросов';
    }

    return prog;
  }

  /** Проверить, заблокирована ли настройка на текущем уровне */
  isSettingLocked(settingKey) {
    return this.active && this.lockedSettings.has(settingKey);
  }

  /** Проверить, можно ли добавить ещё одну ноду */
  canAddNode() {
    if (!this.active) return true;
    return this.sim.nodes.length < this.maxNodes;
  }

  /** Проверить, доступен ли тип ноды в палитре */
  isNodeAvailable(nodeType) {
    if (!this.active) return true;
    return this.availableNodes.includes(nodeType);
  }

  /** Выйти из режима уровня (вернуться в песочницу) */
  exitLevel() {
    this.active = false;
    this.currentLevel = null;
    this.levelSettings = null;
    this.lockedSettings = new Set();
    this.availableNodes = [];
    this.maxNodes = Infinity;
    this._finished = false;
    this.sim._levelMode = false;
    this.sim.fixedUsers = false;
  }

  /** Ретрай текущего уровня */
  retryLevel() {
    if (!this.currentLevel) return;
    this.loadLevel(this.currentLevel.id);
  }

  /** Перейти к следующему уровню */
  nextLevel() {
    if (!this.currentLevel) return;
    const next = getNextLevel(this.currentLevel.id);
    if (next) {
      this.loadLevel(next.id);
      return true;
    }
    return false;
  }
}