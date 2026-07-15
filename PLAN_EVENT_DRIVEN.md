# План перехода на event-driven архитектуру

## Мотивация

Текущий код имитирует **наблюдаемые эффекты** (состояния частиц, ручной учёт времени, сканирование parent-child связей), вместо того чтобы реализовывать **поведение** узлов напрямую.

Проблемы:
- Множество `if`-фильтров по состояниям частиц в 5+ файлах
- Хрупкий parent-child tracking через `_children`, `_parentNode`, `_notifyParent`
- `Simulation.update()` — god-функция на ~65 строк с 10+ ветвлениями
- Каждый новый тип узла добавляет новые флаги состояний и проверки
- Поллинг каждый кадр: `tick()` проверяет «а не пора ли?», вместо того чтобы запланировать завершение

Решение: **Scheduler + event log** — каждое действие планируется явно в виртуальном времени и логируется. Узлы становятся обработчиками запросов, а не конечными автоматами.

---

## Ключевой выигрыш: Event Log

Каждое действие становится записью с таймстемпом. Больше никаких «а что сейчас происходит?»:

```
[   0ms] TrafficSource#1  →  GENERATE  api-request → particle #1
[   0ms] Particle#1       →  FLYING    TrafficSource#1 → Backend#2 (wire 1333ms)
[1333ms] Particle#1       →  ARRIVED   at Backend#2
[1333ms] Backend#2        →  FANOUT    1 api → 3 sql (dbReq:1200,900,1450ms)
[1333ms] Particle#2       →  FLYING    Backend#2 → PostgreSQL#3 (wire 1333ms)
[1333ms] Particle#3       →  FLYING    Backend#2 → PostgreSQL#3
[1333ms] Particle#4       →  FLYING    Backend#2 → PostgreSQL#3
[1333ms] Backend#2        →  SCHEDULE  timeout in 5000ms (fires at 6333ms)
[2666ms] Particle#2       →  ARRIVED   at PostgreSQL#3
[2666ms] PostgreSQL#3     →  PROCESS   SQL (1200ms), slots: 1/2
[2666ms] Particle#3       →  ARRIVED   at PostgreSQL#3
[2666ms] PostgreSQL#3     →  PROCESS   SQL (900ms), slots: 2/2
[2666ms] Particle#4       →  ARRIVED   at PostgreSQL#3
[2666ms] PostgreSQL#3     →  DROP      at capacity (2/2)
[2666ms] Particle#4       →  ERROR     (DROP)
[3566ms] Particle#3       →  SUCCESS   SQL completed (900ms)
[3866ms] Particle#2       →  SUCCESS   SQL completed (1200ms)
[3866ms] Backend#2        →  GATHER    2/3 children done (1 failed)
[3866ms] Backend#2        →  CANCEL    timeout event (no longer needed)
[3866ms] Particle#1       →  ERROR     API failed (child error)
```

---

## План по шагам

### Шаг 1: Создать `SimScheduler` (`js/core/Scheduler.js`)

Приоритетная очередь событий + лог. ~50 строк.

```js
class SimScheduler {
  constructor() {
    this._now = 0;
    this._queue = [];        // сортировано по time: [{time, callback, label, id}]
    this._log = [];          // [{time, text}]
    this._nextId = 1;
  }

  now() { return this._now; }

  /** Запланировать callback через delay мс виртуального времени */
  after(delay, callback, label = '') {
    const id = this._nextId++;
    const event = { time: this._now + delay, callback, label, id };
    this._log.push({ time: this._now, text: `SCHEDULE  "${label}" in ${delay}ms (fires at ${event.time}ms)` });
    // вставка с сохранением сортировки
    const idx = this._queue.findIndex(e => e.time > event.time);
    if (idx === -1) this._queue.push(event);
    else this._queue.splice(idx, 0, event);
    return id;
  }

  /** Отменить запланированное событие по id */
  cancel(id) {
    const idx = this._queue.findIndex(e => e.id === id);
    if (idx !== -1) {
      const e = this._queue[idx];
      this._log.push({ time: this._now, text: `CANCEL    "${e.label}"` });
      this._queue.splice(idx, 1);
    }
  }

  /** Продвинуть время на dt, выполнить все наступившие события */
  update(dt) {
    this._now += dt;
    while (this._queue.length > 0 && this._queue[0].time <= this._now) {
      const event = this._queue.shift();
      this._log.push({ time: event.time, text: `FIRE      "${event.label}"` });
      event.callback();
    }
  }

  /** Полный лог для UI */
  getLog(since = 0) { return this._log.slice(since); }
}
```

### Шаг 2: Заменить ручные проверки в `tick()` на `sim.after()`

**В `Backend.js` — логика таймаутов:**

Было (поллинг каждый кадр):
```js
tick(simTime, sim) {
  if (this.timeoutMs <= 0) return;
  for (const p of sim.particles) {
    if (p.state !== 'pending' || p._parentNode !== this) continue;
    const serviceTime = p.serviceMs + (p._children ? p._children.reduce(...) : 0);
    if (serviceTime < this.timeoutMs) continue;
    // ... обработка таймаута ...
  }
}
```

Стало (планируем один раз):
```js
receive(particle, sim) {
  // ... fan out children ...

  if (this.timeoutMs > 0) {
    particle._timeoutEvent = sim.after(this.timeoutMs, () => {
      sim.log(particle, 'TIMEOUT', `exceeded ${this.timeoutMs}ms`);
      this._handleTimeout(particle, sim);
    }, `timeout:particle#${particle.id}`);
  }
}
```

Метод `tick()` **исчезает полностью**.

**В `PostgreSQL.js` — завершение процессинга:**

Было (поллинг каждый кадр):
```js
tick(simTime, sim) {
  for (const p of this._activeParticles) {
    if (simTime - p.processingStartedAt >= this._getProcessingTime(p)) {
      // ... complete ...
    }
  }
}
```

Стало (планируем один раз на запрос):
```js
receive(particle, sim) {
  if (this.activeConnections >= this.maxConnections) {
    particle.fail('DROP');
    particle.onComplete?.(false);
    return;
  }
  this.activeConnections++;
  const processingTime = this._getProcessingTime(particle);

  sim.after(processingTime, () => {
    this.activeConnections--;
    this.dbSize++;
    particle.succeed();
    particle.onComplete?.(true);
    sim.log(particle, 'SUCCESS', `SQL done in ${processingTime}ms, dbSize: ${this.dbSize}`);
  }, `pg:complete:particle#${particle.id}`);
}
```

Массивы `tick()`, `_activeParticles[]` и `_notifyParent()` **исчезают**. Остаётся только счётчик `activeConnections`.

### Шаг 3: Перемещение между узлами тоже через планировщик

Было: `Simulation.update()` двигает каждую частицу попиксельно, проверяет `progress >= 1`.

Стало: `sim.send()` планирует прибытие.

```js
// Simulation.send()
send(connection, particle) {
  particle.startFlying(connection);
  this.particles.push(particle);
  const wireMs = (1 / PARTICLE_SPEED) * 1000;

  sim.after(wireMs, () => {
    particle.arrive();
    sim.log(particle, 'ARRIVED', `at ${connection.to.node.label}`);
    connection.to.node.receive(particle, this);
  }, `travel:particle#${particle.id}:${connection.from.node.label}→${connection.to.node.label}`);
}
```

### Шаг 4: `Simulation.update()` становится тривиальным

Было (~65 строк проверок состояний):
```js
update(dt, simTime) {
  // 1. Move traveling particles
  // 2. Check arrivals, call receive()
  // 3. Tick PostgreSQL
  // 4. Tick Backend (timeouts)
  // 5. Accumulate serviceMs for processing
  // 6. Position parked particles
  // 7. Cleanup terminal particles
}
```

Стало (~15 строк):
```js
update(dt) {
  this._scheduler.update(dt);

  // Только визуальная интерполяция для flying-частиц
  for (const p of this.particles) {
    if (p.isFlying()) p.interpolatePosition(this._scheduler.now());
  }

  // Очистка завершённых частиц после flash-анимации
  this.particles = this.particles.filter(p => p.isAlive(this._scheduler.now()));
}
```

### Шаг 5: Particle упрощается до view-model

Было (10+ мутабельных полей): `state`, `progress`, `_children`, `_parentNode`, `processingStartedAt`, `_completedChildren`, `_anyChildFailed`, `serviceMs`, `stateChangedAt`, `_totalProcessingTime`, `baseProcessingTime`

Стало:
```js
class Particle {
  constructor(type, connection, options = {}) {
    this.id = Particle._nextId++;
    this.type = type;
    this.visualState = 'flying';  // 'flying' | 'waiting' | 'processing' | 'success' | 'error'
    this.departureTime = null;
    this.arrivalTime = null;
    this.completionTime = null;
    this.x, this.y;
    this.spreadOffset;
    this.errorReason = null;      // 'timeout' | 'DROP' | null
    this.onComplete = null;       // callback для parent node
  }

  startFlying(conn)    { this.visualState = 'flying'; this.departureTime = sim.now(); }
  arrive()             { this.visualState = 'waiting'; this.arrivalTime = sim.now(); }
  startProcessing()    { this.visualState = 'processing'; }
  succeed()            { this.visualState = 'success'; this.completionTime = sim.now(); }
  fail(reason)         { this.visualState = 'error'; this.completionTime = sim.now(); this.errorReason = reason; }
  serviceMs()          { return (this.completionTime || sim.now()) - (this.arrivalTime || this.departureTime); }
}
```

Particle — чистая view-model. Никакой логики, только данные для рендера.

### Шаг 6: Рефакторинг узлов (на примере Backend)

```js
class Backend extends Node {
  receive(particle, sim) {
    sim.log(particle, 'RECEIVED', `Backend#${this.id}`);
    particle.arrive();

    const N = this.pickRequestCount();
    const children = [];
    let completed = 0, failed = 0;
    let isDone = false;

    // Fan out
    for (const conn of this.outputs[0].connections) {
      for (let i = 0; i < N; i++) {
        const child = new Particle('sql');
        sim.send(conn, child);
        children.push(child);

        child.onComplete = (success) => {
          completed++;
          if (!success) failed++;
          if (completed === children.length && !isDone) {
            isDone = true;
            sim.cancel(timeoutEvent);
            this._finishParent(particle, failed === 0, sim);
          }
        };
      }
    }

    // Timeout
    const timeoutEvent = sim.after(this.timeoutMs, () => {
      if (!isDone) {
        isDone = true;
        sim.log(particle, 'TIMEOUT');
        if (this.onTimeout === 'abort') sim.cancelAll(children);
        this._finishParent(particle, false, sim);
      }
    }, `timeout:particle#${particle.id}`);
  }

  _finishParent(particle, success, sim) {
    particle[success ? 'succeed' : 'fail'](success ? null : 'child_error');
    sim.stats.inc('requests_outcome', { type: 'api', status: success ? 'success' : 'error' });
  }
}
```

Никаких `tick()`, `onChildComplete()`, сканирования `_children`, `_parentNode`, `_completedChildren` — только коллбеки, запланированные в нужное время.

### Шаг 7: PostgreSQL становится ещё проще

```js
class PostgreSQL extends Node {
  receive(particle, sim) {
    if (this.activeConnections >= this.maxConnections) {
      sim.log(particle, 'DROP', `at capacity ${this.activeConnections}/${this.maxConnections}`);
      particle.fail('DROP');
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'error' });
      particle.onComplete?.(false);
      return;
    }

    this.activeConnections++;
    particle.startProcessing();
    const time = this.computeProcessingTime(particle);
    sim.log(particle, 'PROCESS', `${time}ms, slots: ${this.activeConnections}/${this.maxConnections}`);

    sim.after(time, () => {
      this.activeConnections--;
      this.dbSize++;
      particle.succeed();
      sim.stats.inc('requests_outcome', { type: 'sql', status: 'success' });
      particle.onComplete?.(true);
      sim.log(particle, 'SUCCESS', `done in ${time}ms, dbSize: ${this.dbSize}`);
    }, `pg:complete:particle#${particle.id}`);
  }
}
```

### Шаг 8: Добавить Event Log в UI

Панель или вкладка с отформатированным логом:

```html
<div id="event-log">
  <div class="log-entry"><span class="log-time">[1333ms]</span> Backend#2 → FANOUT 1→3</div>
  <div class="log-entry"><span class="log-time">[2666ms]</span> PostgreSQL#3 → DROP at capacity</div>
  <div class="log-entry error"><span class="log-time">[3866ms]</span> Particle#1 → ERROR timeout</div>
</div>
```

- Auto-scroll
- Фильтр по частице / узлу
- Копирование в буфер для дебага

---

## Сводка изменений по файлам

| Файл | Действие | Что меняется |
|---|---|---|
| `js/core/Scheduler.js` | **НОВЫЙ** | ~50 строк, очередь событий + лог |
| `js/core/Particle.js` | **Переписать** | 10+ полей → 5 полей, 0 логики |
| `js/nodes/Backend.js` | **Переписать** | Убрать `tick()`, `onChildComplete()`, `_children`-сканирование |
| `js/nodes/PostgreSQL.js` | **Переписать** | Убрать `tick()`, `_activeParticles[]`, `_notifyParent()` |
| `js/nodes/TrafficSource.js` | **Минимум** | Использовать `sim.send()` вместо `spawnParticle()` |
| `js/simulation.js` | **Упростить** | `update()` с 65 → 15 строк, убрать цикл поллинга состояний |
| `js/renderer.js` | **Минимум** | Читать `particle.visualState` вместо `particle.state` |
| `js/main.js` | **Добавить** | Рендеринг event log в UI |
| `index.html` | **Добавить** | Панель event log |
| `css/style.css` | **Добавить** | Стили для панели лога |

---

## Почему это лучше

1. **Дебаг**: event log показывает всё, что произошло, в хронологическом порядке. Не нужно гадать.
2. **Нет поллинга**: `if (state === 'X')` в 5 файлах → ноль. Коллбеки срабатывают в нужное время.
3. **Нет хрупкого parent tracking**: дети уведомляют родителя через `onComplete` коллбек, а не через сканирование массивов.
4. **Новые узлы trivial**: новый тип (Redis, Kafka, LoadBalancer) — это ~30 строк вызовов `sim.after()` + `sim.send()`. Никаких новых флагов состояний.
5. **Отмена явная**: `sim.cancel(eventId)` вместо ручной установки `child.state = 'error'`.
6. **Время единое**: `sim.now()` — single source of truth. Никакого threading `simTime` параметра.