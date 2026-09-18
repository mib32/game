/**
 * Реестр уровней.
 * Каждый уровень — объект в том же формате, что и JSON-файлы в data/levels/.
 * JSON-файлы — канонический формат для сторонних разработчиков.
 * Этот файл — для надёжной загрузки без fetch/сервера.
 * При добавлении нового уровня: создать JSON в data/levels/ и скопировать сюда.
 */

// Импорт JSON-файлов (работает в современных браузерах через import assertions,
// но для совместимости пока держим данные здесь)
// В будущем можно перейти на динамический import('./data/levels/...json', { with: { type: 'json' } })

export const levels = [
  {
    id: 'level_01_hello',
    title: 'Hello World',
    description: 'Твой первый день в роли CTO. Перед тобой Traffic Source (пользователи) и PostgreSQL (база данных). Поставь Backend между ними, чтобы запросы начали доходить.',
    hint: 'Выбери Backend в палитре слева и кликни на canvas между Source и PostgreSQL. Потом соедини их: кликни на Source, затем на Backend, затем на Backend и PostgreSQL.',
    nodes: [
      { type: 'TrafficSource', x: 150, y: 280, id: 'src' },
      { type: 'PostgreSQL', x: 550, y: 280, tier: 'XS', id: 'pg' },
    ],
    connections: [],
    availableNodes: ['Backend'],
    maxNodes: 4,
    startingUsers: 3,
    fixedUsers: true,
    settings: {
      processingMin: 300,
      processingMax: 1500,
      dbSizeCoeff: 0.0,
      networkLatency: 400,
      timeoutMs: 5000,
      sequential: true,
      dbRequestsMin: 1,
      dbRequestsMax: 3,
    },
    lockedSettings: [],
    winCondition: { type: 'apiSuccess', count: 10 },
    loseCondition: null,
  },

  {
    id: 'level_02_bottleneck',
    title: 'Узкое горло',
    description: '50 пользователей ломятся в твою PostgreSQL XS (всего 5 соединений). База захлёбывается, запросы отваливаются. Масштабируйся — или пользователи уйдут.',
    hint: 'Попробуй добавить ещё один PostgreSQL и соединить его с Backend. Каждый PostgreSQL добавляет свой пул соединений.',
    nodes: [
      { type: 'TrafficSource', x: 150, y: 250, id: 'src' },
      { type: 'Backend', x: 350, y: 250, id: 'be' },
      { type: 'PostgreSQL', x: 550, y: 250, tier: 'XS', id: 'pg' },
    ],
    connections: [
      { from: 'src', to: 'be' },
      { from: 'be', to: 'pg' },
    ],
    availableNodes: ['PostgreSQL'],
    maxNodes: 8,
    startingUsers: 50,
    fixedUsers: true,
    settings: {
      processingMin: 300,
      processingMax: 1500,
      dbSizeCoeff: 0.0,
      networkLatency: 400,
      timeoutMs: 5000,
      sequential: true,
      dbRequestsMin: 2,
      dbRequestsMax: 5,
    },
    lockedSettings: ['processingMin', 'processingMax', 'timeoutMs', 'networkLatency'],
    winCondition: { type: 'apiSuccess', count: 50 },
    loseCondition: { type: 'churn', maxLost: 5 },
  },

  {
    id: 'level_03_patience',
    title: 'Терпеливый бэкенд',
    description: 'Твоя БД отвечает медленно — SQL-запросы идут по 2-5 секунд. Но Backend настроен с таймаутом 1000ms и обрывает все запросы, не дожидаясь ответа. Настрой таймаут правильно.',
    hint: 'Таймаут Backend\'а должен быть больше максимального времени обработки SQL-запроса. Посмотри на правую панель — увеличь Timeout.',
    nodes: [
      { type: 'TrafficSource', x: 150, y: 280, id: 'src' },
      { type: 'Backend', x: 350, y: 280, id: 'be' },
      { type: 'PostgreSQL', x: 550, y: 280, tier: 'XS', id: 'pg' },
    ],
    connections: [
      { from: 'src', to: 'be' },
      { from: 'be', to: 'pg' },
    ],
    availableNodes: [],
    maxNodes: 3,
    startingUsers: 5,
    fixedUsers: true,
    settings: {
      processingMin: 2000,
      processingMax: 5000,
      dbSizeCoeff: 0.0,
      networkLatency: 400,
      timeoutMs: 1000,
      sequential: false,
      dbRequestsMin: 1,
      dbRequestsMax: 3,
    },
    lockedSettings: ['processingMin', 'processingMax', 'networkLatency', 'dbRequestsMin', 'dbRequestsMax'],
    winCondition: { type: 'apiSuccess', count: 20 },
    loseCondition: null,
  },
];

/** Получить уровень по id */
export function getLevel(id) {
  return levels.find(l => l.id === id) || null;
}

/** Получить следующий уровень после указанного (или null) */
export function getNextLevel(currentId) {
  const idx = levels.findIndex(l => l.id === currentId);
  if (idx >= 0 && idx < levels.length - 1) {
    return levels[idx + 1];
  }
  return null;
}