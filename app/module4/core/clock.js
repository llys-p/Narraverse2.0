/* Module 4 V1.5: clock ticks and energy; Settlement owns the cross-day transition. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Clock = Module4.Clock || {};

  var Clock = Module4.Clock;
  var PERIODS = ['morning', 'afternoon', 'evening'];
  var PERIOD_LABELS = { morning: '早', afternoon: '中', evening: '晚' };
  var FREE_ACTIONS = ['view_world', 'view_status', 'view_log'];
  var TICKS_PER_PERIOD = 3;
  var MAIN_ACTIONS = {
    chat: { label: '闲聊', energy: 5, ticks: 1 },
    move: { label: '短移动', energy: 5, ticks: 1 },
    inspect: { label: '观察调查', energy: 10, ticks: 1 },
    study: { label: '学习', energy: 10, ticks: 2 },
    help: { label: '帮忙', energy: 10, ticks: 1 },
    explore: { label: '探索', energy: 15, ticks: 2 },
    train: { label: '训练', energy: 20, ticks: 2 },
    intensive: { label: '高强度活动', energy: 25, ticks: 2 }
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

  function isV15(world) {
    return !!(world && world.rulesVersion === 'v1.5');
  }

  function actionDefinition(type) {
    return MAIN_ACTIONS[String(type || '')] || null;
  }

  function clampTick(value) {
    var tick = Number(value);
    if (!Number.isInteger(tick)) return 0;
    return Math.max(0, Math.min(TICKS_PER_PERIOD - 1, tick));
  }

  Clock.version = 'v1.5-clock-ticks';
  Clock.PERIODS = PERIODS.slice();
  Clock.PERIOD_LABELS = Object.assign({}, PERIOD_LABELS);
  Clock.DEFAULT_MAX_ENERGY = DEFAULT_MAX_ENERGY;
  Clock.TICKS_PER_PERIOD = TICKS_PER_PERIOD;
  Clock.FREE_ACTIONS = FREE_ACTIONS.slice();
  Clock.ACTIONS = Object.keys(MAIN_ACTIONS).reduce(function (result, type) {
    result[type] = Object.assign({}, MAIN_ACTIONS[type]);
    return result;
  }, {});
  Clock.ENERGY_COSTS = Object.keys(MAIN_ACTIONS).reduce(function (result, type) {
    result[type] = MAIN_ACTIONS[type].energy;
    return result;
  }, {});

  Clock.isV15 = isV15;
  Clock.createInitialState = function (rulesVersion) {
    var clock = { day: 1, period: 'morning' };
    if (rulesVersion === 'v1.5') clock.tick = 0;
    return {
      clock: clock,
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
    var normalizedClock = Object.assign({}, clock, {
      day: Number.isInteger(day) && day > 0 ? day : initial.clock.day,
      period: normalizePeriod(clock.period)
    });
    if (isV15(world)) normalizedClock.tick = clampTick(clock.tick);
    world.clock = normalizedClock;
    return world;
  };

  Clock.periodLabel = function (period) { return PERIOD_LABELS[period] || PERIOD_LABELS.morning; };
  Clock.mainActions = function () {
    return Object.keys(MAIN_ACTIONS).map(function (type) {
      return {
        type: type,
        label: MAIN_ACTIONS[type].label,
        energy: MAIN_ACTIONS[type].energy,
        ticks: MAIN_ACTIONS[type].ticks
      };
    });
  };
  Clock.isFreeAction = function (type) { return FREE_ACTIONS.indexOf(String(type || '')) >= 0; };
  Clock.actionDefinition = function (type) {
    var action = actionDefinition(type);
    return action ? Object.assign({}, action) : null;
  };
  Clock.actionTicks = function (world, type) {
    if (Clock.isFreeAction(type)) return 0;
    var action = actionDefinition(type);
    if (!action) return 0;
    return isV15(world) ? action.ticks : 1;
  };
  Clock.canAfford = function (world, type) {
    Clock.normalizeWorld(world);
    var action = actionDefinition(type);
    return !!action && world.player.energy >= action.energy;
  };

  function advanceTicks(world, ticks) {
    var next = world;
    var remaining = Math.max(0, Number(ticks) || 0);
    var periodIndex = PERIODS.indexOf(next.clock.period);
    var requiresSettlement = false;
    while (remaining > 0) {
      var available = TICKS_PER_PERIOD - clampTick(next.clock.tick);
      if (remaining < available) {
        next.clock.tick += remaining;
        remaining = 0;
        break;
      }
      remaining -= available;
      next.clock.tick = 0;
      if (periodIndex === PERIODS.length - 1) {
        next.clock.tick = TICKS_PER_PERIOD - 1;
        requiresSettlement = true;
        break;
      }
      periodIndex += 1;
      next.clock.period = PERIODS[periodIndex];
    }
    return requiresSettlement;
  }

  Clock.waitUntil = function (world, targetPeriod) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, message: '缺少模块四世界。' };
    var next = clone(world);
    Clock.normalizeWorld(next);
    if (!isV15(next)) return { ok: false, changed: false, world: next, message: '旧世界暂不支持指定时段等待。' };
    var target = normalizePeriod(targetPeriod);
    var currentIndex = PERIODS.indexOf(next.clock.period);
    var targetIndex = PERIODS.indexOf(target);
    if (targetIndex <= currentIndex) {
      return { ok: true, changed: false, requiresSettlement: false, world: next, message: '已经到了这个时段。' };
    }
    next.clock.period = target;
    next.clock.tick = 0;
    next.updatedAt = Date.now();
    return { ok: true, changed: true, requiresSettlement: false, world: next, message: '时间已推进到第 ' + next.clock.day + ' 天' + Clock.periodLabel(target) + '。' };
  };

  Clock.sleep = function (world) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, message: '缺少模块四世界。' };
    var next = clone(world);
    Clock.normalizeWorld(next);
    if (!isV15(next)) {
      next.clock.period = 'evening';
      return { ok: true, changed: true, requiresSettlement: true, world: next, message: '准备进入日结算。' };
    }
    next.clock.period = 'evening';
    next.clock.tick = TICKS_PER_PERIOD - 1;
    next.updatedAt = Date.now();
    return { ok: true, changed: true, requiresSettlement: true, world: next, message: '你准备睡到明天。' };
  };

  Clock.applyAction = function (world, type) {
    if (!world || typeof world !== 'object') throw new Error('缺少模块四世界');
    var next = clone(world);
    Clock.normalizeWorld(next);
    var actionType = String(type || '');
    if (Clock.isFreeAction(actionType)) {
      return { ok: true, changed: false, kind: 'free', actionType: actionType, world: next, message: '查看信息不会推进时间。' };
    }
    var action = actionDefinition(actionType);
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

    var previous = { day: next.clock.day, period: next.clock.period, tick: next.clock.tick };
    next.player.energy -= action.energy;
    var requiresSettlement = false;
    if (isV15(next)) {
      requiresSettlement = advanceTicks(next, action.ticks);
    } else if (PERIODS.indexOf(next.clock.period) < PERIODS.length - 1) {
      next.clock.period = PERIODS[PERIODS.indexOf(next.clock.period) + 1];
      requiresSettlement = false;
    } else {
      requiresSettlement = true;
    }
    next.updatedAt = Date.now();
    return {
      ok: true,
      changed: true,
      kind: 'main',
      actionType: actionType,
      energyCost: action.energy,
      ticks: isV15(next) ? action.ticks : 1,
      previous: previous,
      requiresSettlement: requiresSettlement,
      world: next,
      message: requiresSettlement
        ? '晚间行动完成，正在进行日结算。'
        : '行动完成。现在是第 ' + next.clock.day + ' 天' + Clock.periodLabel(next.clock.period) + (isV15(next) ? '（' + next.clock.tick + '/' + TICKS_PER_PERIOD + '）' : '') + '。'
    };
  };
}(window));
