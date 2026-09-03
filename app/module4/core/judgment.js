/* Module 4 Task 7: deterministic action judgment and minimal consequences. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Judgment = Module4.Judgment || {};

  var Judgment = Module4.Judgment;
  var REQUIRED_TYPES = ['invite', 'persuade', 'request_help', 'explore', 'intensive'];
  var SCORE_MIN = 0;
  var SCORE_MAX = 100;
  var BASE_SCORE = 60;
  var DIFFICULTY = {
    invite: 10,
    persuade: 15,
    request_help: 8,
    explore: 10,
    intensive: 18,
    custom: 12
  };
  var MOOD_FACTORS = {
    happy: 8,
    calm: 4,
    neutral: 0,
    tense: -8,
    sad: -6
  };
  var ATTRIBUTE_KEYS = {
    invite: ['charm', 'persuasion', 'empathy'],
    persuade: ['persuasion', 'charm', 'empathy'],
    request_help: ['empathy', 'charm'],
    explore: ['courage', 'perception'],
    intensive: ['courage', 'discipline'],
    custom: ['courage', 'empathy']
  };
  var OUTCOME_LABELS = {
    success: '成功',
    costly_success: '代价成功',
    failure: '失败',
    critical_failure: '严重失败'
  };
  var OUTCOME_EFFECTS = {
    success: { relationDelta: 2, mood: 'happy' },
    costly_success: { relationDelta: 1, mood: 'tense' },
    failure: { relationDelta: -1, mood: 'tense' },
    critical_failure: { relationDelta: -2, mood: 'tense' }
  };
  var RISK_TEXT = /强行|闯入|危险|冒险|赌|偷|潜入|威胁|强迫/;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function actionNeedsJudgment(action) {
    var type = text(action && action.type);
    return REQUIRED_TYPES.indexOf(type) >= 0
      || (type === 'custom' && RISK_TEXT.test(text(action && action.text)));
  }

  function targetNpc(world, action) {
    var npcId = text(action && action.targetNpcId);
    return npcId && world && world.npcs ? world.npcs[npcId] || null : null;
  }

  function currentSchedule(world, npc) {
    if (!npc || !Module4.Schedule || typeof Module4.Schedule.getEffectiveSlot !== 'function') return null;
    return Module4.Schedule.getEffectiveSlot(world, npc.id, world.clock && world.clock.period);
  }

  function goalText(goals) {
    return (Array.isArray(goals) ? goals : []).map(function (goal) {
      if (goal && typeof goal === 'object') return text(goal.text || goal.title || goal.name);
      return text(goal);
    }).filter(Boolean);
  }

  function factor(factors, key, label, delta) {
    if (!delta) return;
    factors.push({ key: key, label: label, delta: delta });
  }

  function relationFactor(npc) {
    return npc ? Math.round(clamp(number(npc.relation && npc.relation.value, 0) / 2, -15, 15)) : 0;
  }

  function moodFactor(npc) {
    return npc ? (MOOD_FACTORS[text(npc.mood)] || 0) : 0;
  }

  function scheduleFactor(slot) {
    if (!slot || typeof slot !== 'object') return 0;
    var availability = text(slot.availability).toLowerCase();
    var activity = text(slot.activity);
    if (/可接触|空闲|有空|available/.test(availability)) return 5;
    if (/不可|忙|busy|unavailable/.test(availability)) return -7;
    return /上课|会议|训练|工作/.test(activity) ? -3 : 0;
  }

  function goalFactor(action, npc) {
    var actionText = text(action && action.text);
    if (!actionText || !npc) return 0;
    return goalText(npc.goals).some(function (goal) {
      return goal && (actionText.indexOf(goal) >= 0 || goal.indexOf(actionText) >= 0);
    }) ? 5 : 0;
  }

  function energyFactor(player) {
    var maxEnergy = number(player && player.maxEnergy, 0);
    var energy = number(player && player.energy, 0);
    if (!maxEnergy) return 0;
    var ratio = energy / maxEnergy;
    if (ratio <= 0.25) return -8;
    if (ratio <= 0.5) return -4;
    return ratio >= 0.8 ? 2 : 0;
  }

  function attributeFactor(action, player) {
    var attributes = player && player.attributes && typeof player.attributes === 'object'
      ? player.attributes
      : {};
    var total = ATTRIBUTE_KEYS[text(action && action.type)] || [];
    var score = total.reduce(function (sum, key) {
      return sum + clamp(number(attributes[key], 0), -5, 5);
    }, 0);
    return clamp(Math.round(score), -8, 8);
  }

  function periodFactor(action, period) {
    return text(action && action.type) === 'intensive' && period === 'evening' ? -3 : 0;
  }

  function outcomeFor(score) {
    if (score >= 70) return 'success';
    if (score >= 55) return 'costly_success';
    if (score >= 40) return 'failure';
    return 'critical_failure';
  }

  function buildConsequences(context, outcome) {
    var effect = OUTCOME_EFFECTS[outcome];
    var state = {
      type: 'judgment',
      actionId: context.action.id,
      actionType: context.action.type,
      outcome: outcome,
      day: context.day,
      period: context.period
    };
    if (!context.targetNpcId) {
      return [{ target: 'player', kind: 'temporary_state', state: state }];
    }
    return [
      { target: 'npc', npcId: context.targetNpcId, kind: 'relation', delta: effect.relationDelta },
      { target: 'npc', npcId: context.targetNpcId, kind: 'mood', value: effect.mood },
      { target: 'npc', npcId: context.targetNpcId, kind: 'temporary_state', state: state }
    ];
  }

  function normalWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  Judgment.version = 'task7-deterministic-judgment';
  Judgment.OUTCOMES = Object.keys(OUTCOME_LABELS);
  Judgment.outcomeLabel = function (outcome) { return OUTCOME_LABELS[outcome] || ''; };
  Judgment.requires = actionNeedsJudgment;

  Judgment.buildContext = function (world, action) {
    var next = normalWorld(world);
    var npc = targetNpc(next, action);
    var slot = currentSchedule(next, npc);
    var player = next.player || {};
    return {
      action: clone(action),
      required: actionNeedsJudgment(action),
      day: number(next.clock && next.clock.day, 1),
      period: text(next.clock && next.clock.period) || 'morning',
      targetNpcId: npc ? npc.id : null,
      npc: npc ? {
        id: npc.id,
        name: npc.name,
        relation: clone(npc.relation),
        mood: npc.mood,
        goals: goalText(npc.goals),
        temporaryState: clone(npc.temporaryState || [])
      } : null,
      schedule: slot ? clone(slot) : null,
      player: {
        energy: number(player.energy, 0),
        maxEnergy: number(player.maxEnergy, 0),
        attributes: clone(player.attributes || {})
      },
      difficulty: DIFFICULTY[text(action && action.type)] || 0
    };
  };

  Judgment.evaluate = function (world, action) {
    var context = Judgment.buildContext(world, action);
    if (!context.required) {
      return {
        required: false,
        outcome: null,
        score: null,
        factors: [],
        consequences: [],
        context: context,
        message: ''
      };
    }

    var factors = [{ key: 'base', label: '基础条件', delta: BASE_SCORE }];
    var score = BASE_SCORE;
    var difficulty = -context.difficulty;
    score += difficulty;
    factor(factors, 'difficulty', '行动难度', difficulty);

    var relation = relationFactor(context.npc);
    score += relation;
    factor(factors, 'relation', 'NPC 关系', relation);

    var mood = moodFactor(context.npc);
    score += mood;
    factor(factors, 'mood', 'NPC 心情', mood);

    var schedule = scheduleFactor(context.schedule);
    score += schedule;
    factor(factors, 'schedule', '当前安排', schedule);

    var goal = goalFactor(action, context.npc);
    score += goal;
    factor(factors, 'goal', '目标契合', goal);

    var energy = energyFactor(context.player);
    score += energy;
    factor(factors, 'energy', '当前精力', energy);

    var attributes = attributeFactor(action, context.player);
    score += attributes;
    factor(factors, 'attributes', '玩家属性', attributes);

    var period = periodFactor(action, context.period);
    score += period;
    factor(factors, 'period', '当前时段', period);

    score = Math.round(clamp(score, SCORE_MIN, SCORE_MAX));
    var outcome = outcomeFor(score);
    return {
      required: true,
      outcome: outcome,
      score: score,
      factors: factors,
      consequences: buildConsequences(context, outcome),
      context: context,
      message: '判定：' + OUTCOME_LABELS[outcome] + '。'
    };
  };

  Judgment.apply = function (world, result) {
    if (!world || typeof world !== 'object' || !result || !result.required) {
      return { world: world, changed: false, consequences: [] };
    }
    var next = normalWorld(world);
    var applied = [];
    (Array.isArray(result.consequences) ? result.consequences : []).forEach(function (consequence) {
      if (consequence.target === 'npc') {
        var npc = next.npcs && next.npcs[consequence.npcId];
        if (!npc) return;
        if (consequence.kind === 'relation') {
          var relation = npc.relation && typeof npc.relation === 'object' ? npc.relation : {};
          npc.relation = Object.assign({}, relation, {
            value: clamp(number(relation.value, 0) + number(consequence.delta, 0), -100, 100)
          });
          applied.push(clone(consequence));
        }
        if (consequence.kind === 'mood') {
          npc.mood = text(consequence.value) || npc.mood;
          applied.push(clone(consequence));
        }
        if (consequence.kind === 'temporary_state') {
          npc.temporaryState = Array.isArray(npc.temporaryState) ? clone(npc.temporaryState) : [];
          npc.temporaryState.push(clone(consequence.state));
          applied.push(clone(consequence));
        }
      }
      if (consequence.target === 'player' && consequence.kind === 'temporary_state') {
        next.player.temporaryState = Array.isArray(next.player.temporaryState) ? clone(next.player.temporaryState) : [];
        next.player.temporaryState.push(clone(consequence.state));
        applied.push(clone(consequence));
      }
    });
    if (applied.length) next.updatedAt = Date.now();
    return { world: next, changed: applied.length > 0, consequences: applied };
  };
}(window));
