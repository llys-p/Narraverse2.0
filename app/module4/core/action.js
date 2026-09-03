/* Module 4 Task 9: one action pipeline, facts, and a single settlement boundary. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Action = Module4.Action || {};

  var Action = Module4.Action;
  var sequence = 0;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function clockCosts() {
    return Module4.Clock && Module4.Clock.ENERGY_COSTS ? Module4.Clock.ENERGY_COSTS : {};
  }

  function clockCost(type) {
    var value = Number(clockCosts()[type]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  var DEFINITIONS = {
    view_world: { label: '查看世界', energyCost: 0, advancesTime: false, clockType: null },
    view_status: { label: '查看状态', energyCost: 0, advancesTime: false, clockType: null },
    view_log: { label: '查看日志', energyCost: 0, advancesTime: false, clockType: null },
    move: { label: '移动', energyCost: clockCost('move'), advancesTime: true, clockType: 'move' },
    chat: { label: '闲聊', energyCost: clockCost('chat'), advancesTime: true, clockType: 'chat' },
    study: { label: '学习', energyCost: clockCost('study'), advancesTime: true, clockType: 'study' },
    help: { label: '帮忙', energyCost: clockCost('help'), advancesTime: true, clockType: 'help' },
    invite: { label: '邀请', energyCost: clockCost('help'), advancesTime: true, clockType: 'help' },
    persuade: { label: '说服', energyCost: clockCost('help'), advancesTime: true, clockType: 'help' },
    request_help: { label: '请求帮助', energyCost: clockCost('help'), advancesTime: true, clockType: 'help' },
    explore: { label: '探索', energyCost: clockCost('explore'), advancesTime: true, clockType: 'explore' },
    train: { label: '训练', energyCost: clockCost('train'), advancesTime: true, clockType: 'train' },
    intensive: { label: '高强度活动', energyCost: clockCost('intensive'), advancesTime: true, clockType: 'intensive' },
    seek: { label: '寻找 NPC', energyCost: clockCost('chat'), advancesTime: true, clockType: 'chat' },
    custom: { label: '自定义行动', energyCost: 0, advancesTime: false, clockType: null }
  };

  var TYPE_ALIASES = {
    talk: 'chat',
    greet: 'chat',
    status: 'view_status',
    world: 'view_world',
    log: 'view_log',
    search: 'seek'
  };
  var PRESENT_TARGET_TYPES = ['chat', 'help', 'invite', 'persuade', 'request_help'];
  var JUDGMENT_INTERPERSONAL_TYPES = ['invite', 'persuade', 'request_help'];
  var SCHEDULE_PERIOD_ALIASES = {
    '早上': 'morning',
    '上午': 'morning',
    '早晨': 'morning',
    '中午': 'afternoon',
    '下午': 'afternoon',
    '傍晚': 'evening',
    '晚上': 'evening',
    '晚间': 'evening'
  };

  function definition(type) {
    return DEFINITIONS[type] || DEFINITIONS.custom;
  }

  function makeId() {
    sequence += 1;
    return 'action-' + Date.now().toString(36) + '-' + sequence.toString(36);
  }

  function customInput(raw) {
    return { type: 'custom', text: raw };
  }

  function scheduleChangeFromText(raw) {
    var periodMatch = raw.match(/(早上|上午|早晨|中午|下午|傍晚|晚上|晚间)/);
    var locationMatch = raw.match(/(?:去|到|前往)\s*([^，。！？!?]+)/);
    var period = periodMatch ? SCHEDULE_PERIOD_ALIASES[periodMatch[1]] : '';
    var location = locationMatch ? text(locationMatch[1]) : '';
    return period && location ? { period: period, location: location } : null;
  }

  function parseFreeText(input) {
    var raw = text(input);
    if (!raw) return customInput(raw);

    var match = raw.match(/^(?:去|前往|到|移动到)\s*(.+)$/);
    if (match) return { type: 'move', targetLocationId: text(match[1]), text: raw };

    match = raw.match(/^(?:找|寻找|主动寻找)\s*(.+)$/);
    if (match) return { type: 'seek', targetNpcId: text(match[1]), text: raw };

    if (/^(?:查看|看看|打开)?\s*(?:状态|当前状态)$/.test(raw)) return { type: 'view_status', text: raw };
    if (/^(?:查看|看看|打开)?\s*(?:世界|地图|地点)$/.test(raw)) return { type: 'view_world', text: raw };
    if (/^(?:查看|看看|打开)?\s*(?:日志|记录)$/.test(raw)) return { type: 'view_log', text: raw };
    if (/(?:邀请|邀约|约)/.test(raw)) return { type: 'invite', text: raw, scheduleChange: scheduleChangeFromText(raw) };
    if (/说服/.test(raw)) return { type: 'persuade', text: raw, scheduleChange: scheduleChangeFromText(raw) };
    if (/(?:请求|拜托|请).*(?:帮助|帮忙|帮)/.test(raw)) return { type: 'request_help', text: raw };
    if (/(?:高风险|危险|冒险).*(?:训练)|(?:训练).*(?:高风险|危险|冒险)/.test(raw)) return { type: 'intensive', text: raw };
    if (/(?:聊天|闲聊|打招呼|聊聊)/.test(raw)) return { type: 'chat', text: raw };
    if (/(?:帮忙|帮助|帮)/.test(raw)) return { type: 'help', text: raw };
    if (/学习/.test(raw)) return { type: 'study', text: raw };
    if (/训练/.test(raw)) return { type: 'train', text: raw };
    if (/探索/.test(raw)) return { type: 'explore', text: raw };

    return customInput(raw);
  }

  function normalizeWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    if (Module4.Location && typeof Module4.Location.normalizeWorld === 'function') Module4.Location.normalizeWorld(next);
    return next;
  }

  function normalizedInput(input) {
    if (typeof input === 'string') return parseFreeText(input);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : customInput('');
  }

  function normalizedType(value) {
    var raw = text(value).toLowerCase();
    return TYPE_ALIASES[raw] || raw;
  }

  function normalizeScheduleChange(raw) {
    var source = raw && raw.scheduleChange && typeof raw.scheduleChange === 'object' && !Array.isArray(raw.scheduleChange)
      ? raw.scheduleChange
      : {};
    var day = Number(source.day);
    var period = text(source.period || raw.schedulePeriod);
    var locationId = text(source.locationId || source.location || source.targetLocationId || raw.scheduleLocationId || raw.scheduleLocation);
    if (!period || !locationId) return null;
    return {
      day: Number.isInteger(day) && day > 0 ? day : null,
      period: period,
      locationId: locationId,
      activity: text(source.activity || raw.scheduleActivity)
    };
  }

  function normalize(input) {
    var raw = normalizedInput(input);
    var type = normalizedType(raw.type);
    if (!DEFINITIONS[type]) type = 'custom';
    var actionDefinition = definition(type);
    var source = raw.source === 'recommended' ? 'recommended' : 'free_input';
    var actionText = text(raw.text || raw.rawText || raw.label) || actionDefinition.label;
    return {
      id: text(raw.id) || makeId(),
      type: type,
      actorId: 'player',
      targetNpcId: text(raw.targetNpcId || raw.npcId) || null,
      targetLocationId: text(raw.targetLocationId || raw.locationId || raw.target) || null,
      text: actionText,
      source: source,
      energyCost: actionDefinition.energyCost,
      advancesTime: actionDefinition.advancesTime,
      scheduleChange: normalizeScheduleChange(raw)
    };
  }

  function listNpcs(world) {
    return Module4.World && typeof Module4.World.listNpcs === 'function'
      ? Module4.World.listNpcs(world)
      : [];
  }

  function findNpc(world, reference) {
    var value = text(reference);
    if (!value) return null;
    var npcs = listNpcs(world);
    var idMatches = npcs.filter(function (npc) { return npc.id === value; });
    if (idMatches.length === 1) return idMatches[0];
    var nameMatches = npcs.filter(function (npc) { return npc.name === value; });
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  function currentEncounter(world) {
    return Module4.Encounter && typeof Module4.Encounter.checkNatural === 'function'
      ? Module4.Encounter.checkNatural(world)
      : { found: false, npcs: [] };
  }

  function resolveActionNpc(world, action) {
    var direct = findNpc(world, action && action.targetNpcId);
    if (direct) return direct;
    var actionText = text(action && action.text);
    var named = listNpcs(world).filter(function (npc) {
      return npc.name && actionText.indexOf(npc.name) >= 0;
    });
    if (named.length === 1) return named[0];
    return null;
  }

  function requiresPresentTarget(action, resolvedNpc) {
    var type = text(action && action.type);
    if (PRESENT_TARGET_TYPES.indexOf(type) < 0) return false;
    if (JUDGMENT_INTERPERSONAL_TYPES.indexOf(type) >= 0) return true;
    return !!(resolvedNpc || text(action && action.targetNpcId));
  }

  function isEncounteredNpc(encounter, npcId) {
    return !!(encounter && encounter.found && Array.isArray(encounter.npcs) && encounter.npcs.some(function (npc) {
      return npc && npc.id === npcId;
    }));
  }

  function interpersonalFailure(action, world, reason, encounter) {
    var result = failure(
      action,
      world,
      reason === 'target-required' ? '请指定要互动的 NPC。' : '目标 NPC 当前不在场。'
    );
    result.reason = reason;
    result.encounter = encounter || null;
    return result;
  }

  function evaluateJudgment(world, action) {
    return Module4.Judgment && typeof Module4.Judgment.evaluate === 'function'
      ? Module4.Judgment.evaluate(world, action)
      : { required: false, outcome: null, score: null, factors: [], consequences: [], message: '' };
  }

  function applyJudgment(world, judgment) {
    return Module4.Judgment && typeof Module4.Judgment.apply === 'function'
      ? Module4.Judgment.apply(world, judgment)
      : { world: world, changed: false, consequences: [] };
  }

  function canRewriteSchedule(action) {
    var type = text(action && action.type);
    return (type === 'invite' || type === 'persuade') && !!(action && action.scheduleChange);
  }

  function resolveScheduleChange(world, action) {
    var requested = action && action.scheduleChange;
    if (!requested || !Module4.Location || typeof Module4.Location.get !== 'function') return null;
    var location = Module4.Location.get(world, requested.locationId);
    if (!location) return null;
    var day = Number(requested.day);
    return {
      day: Number.isInteger(day) && day > 0 ? day : Number(world.clock && world.clock.day),
      period: text(requested.period),
      locationId: location.id,
      activity: text(requested.activity) || '与玩家同行'
    };
  }

  function applyScheduleRewrite(world, action, judgment) {
    if (!canRewriteSchedule(action) || !judgment || !judgment.required) return null;
    if (judgment.outcome !== 'success') {
      return {
        ok: true,
        changed: false,
        world: world,
        rewrite: null,
        reason: 'outcome-not-rewriteable',
        message: '本次判定结果不会改写后续日程。'
      };
    }
    var change = resolveScheduleChange(world, action);
    if (!change) {
      return {
        ok: false,
        changed: false,
        world: world,
        rewrite: null,
        reason: 'invalid-schedule-location',
        message: '改期地点不存在，未改写日程。'
      };
    }
    if (!Module4.Schedule || typeof Module4.Schedule.applyRewrite !== 'function') {
      return {
        ok: false,
        changed: false,
        world: world,
        rewrite: null,
        reason: 'schedule-unavailable',
        message: '日程规则尚未加载。'
      };
    }
    return Module4.Schedule.applyRewrite(world, {
      npcId: action.targetNpcId,
      day: change.day,
      period: change.period,
      replacementSlot: { locationId: change.locationId, activity: change.activity },
      reason: action.text,
      sourceActionId: action.id,
      sourceOutcome: judgment.outcome
    });
  }

  function recordFacts(world, action, judgment, scheduleRewrite) {
    return Module4.Facts && typeof Module4.Facts.recordAction === 'function'
      ? Module4.Facts.recordAction(world, action, judgment, scheduleRewrite)
      : { ok: true, changed: false, world: world, facts: [] };
  }

  function settleDay(world) {
    if (!Module4.Settlement || typeof Module4.Settlement.settle !== 'function') {
      return { ok: false, changed: false, world: world, reason: 'settlement-unavailable', message: '日结算规则尚未加载。' };
    }
    return Module4.Settlement.settle(world);
  }

  function addRecommendation(list, input) {
    list.push(normalize(Object.assign({}, input, { source: 'recommended' })));
  }

  function recommendationText(type, name) {
    return definition(type).label + (name ? ' · ' + name : '');
  }

  function failure(action, world, message, clockResult, judgment, scheduleRewrite) {
    return {
      ok: false,
      changed: false,
      kind: 'action',
      action: action,
      world: clockResult && clockResult.world ? clockResult.world : world,
      clock: clockResult || null,
      encounter: null,
      judgment: judgment || null,
      scheduleRewrite: scheduleRewrite || null,
      facts: [],
      settlement: null,
      message: message
    };
  }

  function finish(action, world, clockResult, encounter, extraMessage, judgment, scheduleRewrite, factResult, settlement) {
    var messages = [];
    if (extraMessage) messages.push(extraMessage);
    if (judgment && judgment.required && judgment.message) messages.push(judgment.message);
    if (scheduleRewrite && scheduleRewrite.message) messages.push(scheduleRewrite.message);
    if (clockResult && clockResult.message) messages.push(clockResult.message);
    if (settlement && settlement.message) messages.push(settlement.message);
    if (encounter && encounter.message) messages.push(encounter.message);
    return {
      ok: true,
      changed: !!(clockResult && clockResult.changed) || !!(factResult && factResult.changed) || !!(settlement && settlement.changed),
      kind: 'action',
      action: action,
      world: world,
      clock: clockResult || null,
      encounter: encounter || null,
      judgment: judgment || null,
      scheduleRewrite: scheduleRewrite || null,
      facts: factResult && Array.isArray(factResult.facts) ? factResult.facts : [],
      settlement: settlement || null,
      message: messages.join(' ')
    };
  }

  function shouldLogAction(action) {
    return !!(action && ['view_status', 'view_world', 'view_log'].indexOf(action.type) < 0);
  }

  function appendActionLog(result, beforeWorld) {
    if (!result || !result.ok || !shouldLogAction(result.action) || !result.world) return result;
    var next = clone(result.world);
    var beforeClock = beforeWorld && beforeWorld.clock || {};
    var afterClock = next.clock || {};
    next.actionLogs = Array.isArray(next.actionLogs) ? next.actionLogs : [];
    next.actionLogs.push({
      id: text(result.action.id) || ('action-log-' + Date.now().toString(36)),
      day: Number(beforeClock.day) || Number(afterClock.day) || 1,
      period: text(beforeClock.period) || text(afterClock.period) || 'morning',
      type: text(result.action.type) || 'custom',
      source: text(result.action.source) || 'free_input',
      text: text(result.action.text),
      description: text(result.message) || '行动已完成。',
      before: {
        day: Number(beforeClock.day) || 1,
        period: text(beforeClock.period) || 'morning',
        location: text(beforeWorld && beforeWorld.player && beforeWorld.player.location),
        energy: Number(beforeWorld && beforeWorld.player && beforeWorld.player.energy)
      },
      after: {
        day: Number(afterClock.day) || 1,
        period: text(afterClock.period) || 'morning',
        location: text(next.player && next.player.location),
        energy: Number(next.player && next.player.energy)
      },
      createdAt: Date.now()
    });
    next.actionLogs = next.actionLogs.slice(-100);
    next.updatedAt = Date.now();
    result.world = next;
    result.changed = true;
    return result;
  }

  Action.version = 'task9-action-pipeline';
  Action.definitions = clone(DEFINITIONS);
  Action.parseFreeText = parseFreeText;
  Action.normalize = normalize;

  Action.recommended = function (world) {
    var next = normalizeWorld(world);
    var recommendations = [];
    var encounter = currentEncounter(next);
    var firstNpc = encounter.found && encounter.npcs && encounter.npcs[0]
      ? encounter.npcs[0]
      : listNpcs(next)[0];

    if (encounter.found && firstNpc) {
      addRecommendation(recommendations, {
        type: 'chat',
        targetNpcId: firstNpc.id,
        text: recommendationText('chat', firstNpc.name)
      });
      addRecommendation(recommendations, {
        type: 'help',
        targetNpcId: firstNpc.id,
        text: recommendationText('help', firstNpc.name)
      });
      addRecommendation(recommendations, {
        type: 'invite',
        targetNpcId: firstNpc.id,
        text: recommendationText('invite', firstNpc.name)
      });
    } else if (Module4.Location && typeof Module4.Location.list === 'function') {
      Module4.Location.list(next).filter(function (location) {
        return location.id !== text(next.player && next.player.location);
      }).slice(0, 2).forEach(function (location) {
        addRecommendation(recommendations, {
          type: 'move',
          targetLocationId: location.id,
          text: recommendationText('move', location.name)
        });
      });
    }

    if (firstNpc && !encounter.found) {
      addRecommendation(recommendations, {
        type: 'seek',
        targetNpcId: firstNpc.id,
        text: recommendationText('seek', firstNpc.name)
      });
    }

    addRecommendation(recommendations, { type: 'view_status', text: recommendationText('view_status') });
    addRecommendation(recommendations, { type: 'view_world', text: recommendationText('view_world') });
    return recommendations.slice(0, 5);
  };

  Action.execute = function (world, input) {
    if (!world || typeof world !== 'object') {
      return failure(normalize(input), world, '缺少模块四世界。');
    }

    var action = normalize(input);
    var next = normalizeWorld(world);
    var beforeWorld = clone(next);
    var actionDefinition = definition(action.type);
    if (action.type === 'move') {
      var target = Module4.Location && typeof Module4.Location.get === 'function'
        ? Module4.Location.get(next, action.targetLocationId)
        : null;
      if (!target) return failure(action, next, '目标地点不存在。');
      action = Object.assign({}, action, { targetLocationId: target.id });
    }

    var resolvedNpc = resolveActionNpc(next, action);
    if (requiresPresentTarget(action, resolvedNpc)) {
      if (!resolvedNpc) return interpersonalFailure(action, next, 'target-required');
      var naturalEncounter = currentEncounter(next);
      if (!isEncounteredNpc(naturalEncounter, resolvedNpc.id)) {
        return interpersonalFailure(action, next, 'target-not-present', naturalEncounter);
      }
    }
    if (resolvedNpc) action = Object.assign({}, action, { targetNpcId: resolvedNpc.id });
    var resolvedChange = resolveScheduleChange(next, action);
    if (resolvedChange) action = Object.assign({}, action, { scheduleChange: resolvedChange });
    var judgment = evaluateJudgment(next, action);
    if (action.type === 'custom' && judgment.required) {
      action = Object.assign({}, action, {
        energyCost: clockCost('help'),
        advancesTime: true
      });
      actionDefinition = { advancesTime: true, clockType: 'help' };
    }
    var clockType = actionDefinition.clockType || action.type;

    if (actionDefinition.advancesTime && (!Module4.Clock || typeof Module4.Clock.applyAction !== 'function')) {
      return failure(action, next, '时间规则尚未加载。', null, judgment);
    }

    if (actionDefinition.advancesTime && !Module4.Clock.canAfford(next, clockType)) {
      var blocked = Module4.Clock.applyAction(next, clockType);
      return failure(action, next, blocked.message, blocked, judgment);
    }

    var scheduleRewrite = null;
    if (judgment.required) {
      var applied = applyJudgment(next, judgment);
      next = applied.world;
      judgment = Object.assign({}, judgment, { consequences: applied.consequences });
      scheduleRewrite = applyScheduleRewrite(next, action, judgment);
      if (scheduleRewrite && scheduleRewrite.changed) next = scheduleRewrite.world;
    }

    if (action.type === 'custom' && !judgment.required) {
      return appendActionLog({
        ok: true,
        changed: false,
        kind: 'action',
        action: action,
        world: next,
        clock: null,
        encounter: null,
        judgment: judgment,
        scheduleRewrite: scheduleRewrite,
        facts: [],
        settlement: null,
        message: '已记录自定义行动；当前阶段不自动执行判定。'
      }, beforeWorld);
    }

    if (!actionDefinition.advancesTime) {
      var passiveFacts = recordFacts(next, action, judgment, scheduleRewrite);
      return appendActionLog({
        ok: true,
        changed: !!passiveFacts.changed,
        kind: 'action',
        action: action,
        world: passiveFacts.world,
        clock: null,
        encounter: null,
        judgment: judgment,
        scheduleRewrite: scheduleRewrite,
        facts: passiveFacts.facts || [],
        settlement: null,
        message: judgment.required ? judgment.message + ' 已应用最小状态后果。' : '查看信息不会推进时间。'
      }, beforeWorld);
    }

    var encounter = null;
    if (action.type === 'seek') {
      var targetNpc = resolvedNpc || findNpc(next, action.targetNpcId);
      var seekNpcId = targetNpc ? targetNpc.id : action.targetNpcId;
      action = Object.assign({}, action, { targetNpcId: targetNpc ? targetNpc.id : seekNpcId || null });
      encounter = Module4.Encounter && typeof Module4.Encounter.seekNpc === 'function'
        ? Module4.Encounter.seekNpc(next, seekNpcId)
        : null;
    } else if (action.type !== 'move') {
      encounter = currentEncounter(next);
    }

    var clockResult = Module4.Clock.applyAction(next, clockType);
    if (!clockResult.ok) return failure(action, next, clockResult.message, clockResult, judgment, scheduleRewrite);

    var completedWorld = clockResult.world;
    if (action.type === 'move') {
      var moved = Module4.Location.movePlayer(completedWorld, action.targetLocationId);
      if (!moved.ok) return failure(action, next, moved.message, null, judgment, scheduleRewrite);
      encounter = Module4.Encounter && typeof Module4.Encounter.checkNatural === 'function'
        ? Module4.Encounter.checkNatural(moved.world)
        : null;
      completedWorld = moved.world;
    }

    var factResult = recordFacts(completedWorld, action, judgment, scheduleRewrite);
    completedWorld = factResult.world;
    var settlement = null;
    if (clockResult.requiresSettlement) {
      settlement = settleDay(completedWorld);
      if (!settlement.ok) {
        var settlementFailure = failure(action, completedWorld, settlement.message, clockResult, judgment, scheduleRewrite);
        settlementFailure.facts = factResult.facts || [];
        settlementFailure.settlement = settlement;
        return settlementFailure;
      }
      completedWorld = settlement.world;
    }
    return appendActionLog(finish(
      action,
      completedWorld,
      clockResult,
      encounter,
      action.type === 'move' && moved ? moved.message : '',
      judgment,
      scheduleRewrite,
      factResult,
      settlement
    ), beforeWorld);
  };
}(window));
