/* Module 4 Task 9: clock and energy; Settlement owns the cross-day transition. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Clock = Module4.Clock || {};

  var Clock = Module4.Clock;
  var PERIODS = ['morning', 'afternoon', 'evening'];
  var PERIOD_LABELS = { morning: '早', afternoon: '中', evening: '晚' };
  var FREE_ACTIONS = ['view_world', 'view_status', 'view_log'];
  var MAIN_ACTIONS = {
    chat: { label: '闲聊', energy: 5 },
    move: { label: '短移动', energy: 5 },
    study: { label: '学习', energy: 10 },
    help: { label: '帮忙', energy: 10 },
    explore: { label: '探索', energy: 15 },
    train: { label: '训练', energy: 20 },
    intensive: { label: '高强度活动', energy: 25 }
  };
  var DEFAULT_MAX_ENERGY = 100;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function finitePositive(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizePeriod(value) {
    return PERIODS.indexOf(value) >= 0 ? value : 'morning';
  }

  Clock.version = 'task9-clock-energy';
  Clock.PERIODS = PERIODS.slice();
  Clock.PERIOD_LABELS = Object.assign({}, PERIOD_LABELS);
  Clock.DEFAULT_MAX_ENERGY = DEFAULT_MAX_ENERGY;
  Clock.FREE_ACTIONS = FREE_ACTIONS.slice();
  Clock.ENERGY_COSTS = Object.keys(MAIN_ACTIONS).reduce(function (result, type) {
    result[type] = MAIN_ACTIONS[type].energy;
    return result;
  }, {});

  Clock.createInitialState = function () {
    return {
      clock: { day: 1, period: 'morning' },
      player: { energy: DEFAULT_MAX_ENERGY, maxEnergy: DEFAULT_MAX_ENERGY }
    };
  };

  Clock.normalizeWorld = function (world) {
    if (!world || typeof world !== 'object') return world;
    var initial = Clock.createInitialState();
    var player = world.player && typeof world.player === 'object' ? world.player : {};
    var maxEnergy = finitePositive(player.maxEnergy, initial.player.maxEnergy);
    var energy = Number(player.energy);
    if (!Number.isFinite(energy)) energy = maxEnergy;
    world.player = Object.assign({}, player, {
      energy: Math.max(0, Math.min(maxEnergy, energy)),
      maxEnergy: maxEnergy
    });
    var clock = world.clock && typeof world.clock === 'object' ? world.clock : {};
    var day = Number(clock.day);
    world.clock = Object.assign({}, clock, {
      day: Number.isInteger(day) && day > 0 ? day : initial.clock.day,
      period: normalizePeriod(clock.period)
    });
    return world;
  };

  Clock.periodLabel = function (period) { return PERIOD_LABELS[period] || PERIOD_LABELS.morning; };
  Clock.mainActions = function () {
    return Object.keys(MAIN_ACTIONS).map(function (type) {
      return { type: type, label: MAIN_ACTIONS[type].label, energy: MAIN_ACTIONS[type].energy };
    });
  };
  Clock.isFreeAction = function (type) { return FREE_ACTIONS.indexOf(String(type || '')) >= 0; };
  Clock.canAfford = function (world, type) {
    Clock.normalizeWorld(world);
    var action = MAIN_ACTIONS[String(type || '')];
    return !!action && world.player.energy >= action.energy;
  };

  Clock.applyAction = function (world, type) {
    if (!world || typeof world !== 'object') throw new Error('缺少模块四世界');
    var next = clone(world);
    Clock.normalizeWorld(next);
    var actionType = String(type || '');
    if (Clock.isFreeAction(actionType)) {
      return { ok: true, changed: false, kind: 'free', actionType: actionType, world: next, message: '查看信息不会推进时间。' };
    }
    var action = MAIN_ACTIONS[actionType];
    if (!action) return { ok: false, changed: false, kind: 'main', world: next, message: '这不是可执行的主要行动。' };
    if (next.player.energy < action.energy) {
      return {
        ok: false,
        changed: false,
        kind: 'main',
        actionType: actionType,
        energyCost: action.energy,
        world: next,
        message: '精力不足：' + action.label + '需要 ' + action.energy + ' 点，当前剩余 ' + next.player.energy + ' 点。'
      };
    }

    var previous = { day: next.clock.day, period: next.clock.period };
    next.player.energy -= action.energy;
    var periodIndex = PERIODS.indexOf(next.clock.period);
    var requiresSettlement = periodIndex === PERIODS.length - 1;
    if (!requiresSettlement) {
      next.clock.period = PERIODS[periodIndex + 1];
    }
    next.updatedAt = Date.now();
    return {
      ok: true,
      changed: true,
      kind: 'main',
      actionType: actionType,
      energyCost: action.energy,
      previous: previous,
      requiresSettlement: requiresSettlement,
      world: next,
      message: requiresSettlement
        ? '晚间行动完成，正在进行日结算。'
        : '行动完成。现在是第 ' + next.clock.day + ' 天' + Clock.periodLabel(next.clock.period) + '。'
    };
  };
}(window));
