/* Module 4 V1.5: narrative action feedback, filtered context, and state-safe model commit. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.AI = Module4.AI || {};
  Module4.AI.Interaction = Module4.AI.Interaction || {};

  var Interaction = Module4.AI.Interaction;
  var inFlight = {};
  var NPC_TYPES = ['chat', 'help'];
  var PASSIVE_TYPES = ['view_status', 'view_world', 'view_log'];
  var MAX_NARRATIVE_LENGTH = 1600;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 280);
  }

  function normalizedWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  function resolveNpc(world, action) {
    var npcs = Module4.World && typeof Module4.World.listNpcs === 'function' ? Module4.World.listNpcs(world) : [];
    var reference = text(action && action.targetNpcId);
    var direct = npcs.find(function (npc) { return npc.id === reference || npc.name === reference; });
    if (direct) return direct;
    var actionText = text(action && action.text);
    var named = npcs.filter(function (npc) { return npc.name && actionText.indexOf(npc.name) >= 0; });
    return named.length === 1 ? named[0] : null;
  }

  function locationSummary(world) {
    var reference = text(world && world.player && world.player.location);
    var item = Module4.Location && typeof Module4.Location.get === 'function'
      ? Module4.Location.get(world, reference)
      : null;
    return {
      id: item ? text(item.id) : reference,
      name: item ? shortText(item.name || item.id, 120) : reference,
      description: item ? shortText(item.description, 240) : ''
    };
  }

  function transition(before, after) {
    return {
      before: {
        day: Number(before && before.clock && before.clock.day) || 1,
        period: text(before && before.clock && before.clock.period) || 'morning',
        tick: Number(before && before.clock && before.clock.tick) || 0,
        energy: Number(before && before.player && before.player.energy),
        location: locationSummary(before)
      },
      after: {
        day: Number(after && after.clock && after.clock.day) || 1,
        period: text(after && after.clock && after.clock.period) || 'morning',
        tick: Number(after && after.clock && after.clock.tick) || 0,
        energy: Number(after && after.player && after.player.energy),
        location: locationSummary(after)
      }
    };
  }

  function recentActions(world) {
    return (Array.isArray(world && world.actionLogs) ? world.actionLogs : []).slice(-6).map(function (entry) {
      return {
        day: Number(entry && entry.day) || 1,
        period: text(entry && entry.period) || 'morning',
        text: shortText(entry && entry.text, 240),
        description: shortText(entry && entry.description, 280)
      };
    });
  }

  function parseResponse(response) {
    var raw = typeof response === 'string'
      ? response.trim()
      : response && response.content ? text(response.content) : '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!raw) throw new Error('empty');
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      var start = raw.indexOf('{');
      var end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('invalid-json');
      parsed = JSON.parse(raw.slice(start, end + 1));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-object');
    var narrative = shortText(parsed.narrative || parsed.text || parsed.reply, MAX_NARRATIVE_LENGTH);
    if (!narrative) throw new Error('empty-narrative');
    return {
      narrative: narrative,
      factIds: Array.isArray(parsed.factIds) ? parsed.factIds.map(text).filter(Boolean).slice(0, 6) : [],
      knowledge: Array.isArray(parsed.knowledge) ? parsed.knowledge.slice(0, 4) : []
    };
  }

  function messages(world, action, npc, actionResult) {
    var npcContext = npc && Module4.AI.Context && typeof Module4.AI.Context.forNpc === 'function'
      ? Module4.AI.Context.forNpc(world, npc.id)
      : null;
    var playerContext = Module4.AI.Context && typeof Module4.AI.Context.forPlayer === 'function'
      ? Module4.AI.Context.forPlayer(world)
      : { viewerId: 'player', world: {}, scene: {}, facts: [], knowledge: [] };
    var context = npcContext || playerContext;
    return [
      {
        role: 'system',
        content: [
          '你是模块四开放沙盒文字 RPG 的叙事引擎。把玩家的这一步行动续写成一段沉浸式正文，而不是系统提示、操作回执或建议清单。',
          '正文通常为 150 至 300 个汉字，应自然承接当前地点、时间、在场人物、可见物件和近期事实；写清动作过程、环境反应与新的现场状态，让玩家读完后愿意继续行动。',
          '只叙述本次行动能够造成的结果，不替程序决定或改写时间、精力、地点、关系、物品、判定和事件状态；这些结果必须严格服从 transition.after。',
          '不要说“无法识别意图”“请换一种说法”“行动已记录”或暴露规则、JSON、模型与程序。',
          '只输出严格 JSON，不要 Markdown、解释或代码块。格式：{"narrative":"一段连续正文","factIds":[],"knowledge":[]}',
          'narrative 最多 1600 字；factIds 只能引用上下文中已有事实 id；knowledge 只能描述本次对白中玩家实际听到的短信息。',
          '没有对白时 knowledge 必须为 []。不要泄露上下文中没有提供的秘密，不要把推测写成已确认事实。'
        ].join('')
      },
      {
        role: 'user',
        content: JSON.stringify({
          action: { type: action.type, text: shortText(action.text, 240) },
          context: context,
          recentActions: recentActions(world),
          transition: transition(world, actionResult.world),
          ruleOutcome: shortText(actionResult.message, 400)
        })
      }
    ];
  }

  function safeKnowledge(world, action, response, context) {
    var knownFacts = {};
    (context && Array.isArray(context.facts) ? context.facts : []).forEach(function (fact) { knownFacts[fact.id] = true; });
    return response.knowledge.map(function (item, index) {
      if (!item || typeof item !== 'object') return null;
      var claim = shortText(item.claim || item.text, 280);
      var sourceFactId = text(item.sourceFactId || item.factId);
      if (!claim || (sourceFactId && !knownFacts[sourceFactId])) return null;
      var status = text(item.epistemicStatus || item.status);
      if (['observation', 'heard', 'inference', 'belief'].indexOf(status) < 0) status = 'heard';
      return {
        id: 'knowledge-' + action.id + '-' + index,
        claim: claim,
        epistemicStatus: status,
        sourceFactId: sourceFactId || null,
        sourceActionId: action.id,
        day: Number(world.clock && world.clock.day) || 1,
        period: text(world.clock && world.clock.period) || 'morning'
      };
    }).filter(Boolean);
  }

  function commit(world, action, npc, response, context, actionResult) {
    var next = clone(actionResult.world);
    next.narrativeEntries = Array.isArray(next.narrativeEntries) ? next.narrativeEntries : [];
    var factIds = response.factIds.filter(function (id) {
      return context.facts.some(function (fact) { return fact.id === id; });
    });
    next.narrativeEntries.push({
      id: 'narrative-' + action.id,
      day: Number(world.clock && world.clock.day) || 1,
      period: text(world.clock && world.clock.period) || 'morning',
      npcId: npc ? npc.id : null,
      npcName: npc ? npc.name : null,
      actionId: action.id,
      text: response.narrative,
      factIds: factIds,
      createdAt: Date.now()
    });
    var knowledge = npc ? safeKnowledge(world, action, response, context) : [];
    if (knowledge.length) {
      next.knowledge = next.knowledge && typeof next.knowledge === 'object' ? next.knowledge : {};
      next.knowledge.player = Array.isArray(next.knowledge.player) ? next.knowledge.player : [];
      next.knowledge.player = next.knowledge.player.concat(knowledge).slice(-40);
    }
    next.updatedAt = Date.now();
    actionResult.world = next;
    actionResult.narrative = response.narrative;
    actionResult.narrativeEntry = clone(next.narrativeEntries[next.narrativeEntries.length - 1]);
    actionResult.knowledge = knowledge;
    return actionResult;
  }

  function failure(world, action, reason, message) {
    return { ok: false, changed: false, reason: reason, action: action, world: clone(world), message: message };
  }

  function failureMessage(error) {
    var message = text(error && error.message);
    if (/API 未配置|not configured/i.test(message)) {
      return '公共模型尚未配置，请检查 Denova 共享 Settings；时间与精力未改变。';
    }
    var status = message.match(/API 错误 \((\d{3})\)/i);
    if (status) {
      return '公共模型请求失败（HTTP ' + status[1] + '），请检查 Denova 共享 Settings 或服务状态；时间与精力未改变。';
    }
    if (/超时|timeout|abort/i.test(message)) {
      return '公共模型请求超时，请稍后重试；时间与精力未改变。';
    }
    return '公共模型请求失败，请检查 Denova 共享 Settings 后重试；时间与精力未改变。';
  }

  Interaction.version = 'v1.5-interaction-2';
  Interaction.supports = function (input) {
    var action = input && input.type ? input : Module4.Action.normalize(input);
    return !!(action && PASSIVE_TYPES.indexOf(action.type) < 0 && action.type !== 'unsupported');
  };
  Interaction.buildMessages = function (world, input) {
    var next = normalizedWorld(world);
    var action = Module4.Action.normalize(input);
    if (!Interaction.supports(action)) return [];
    var actionResult = Module4.Action.execute(next, action);
    if (!actionResult.ok) return [];
    action = actionResult.action || action;
    var npc = resolveNpc(next, action);
    return messages(next, action, npc, actionResult);
  };

  Interaction.start = function (world, input, options) {
    var next = normalizedWorld(world);
    var action = Module4.Action.normalize(input);
    if (!Interaction.supports(action)) return Promise.resolve(failure(next, action, 'unsupported-interaction', '这个操作不需要生成剧情。'));
    var npc = NPC_TYPES.indexOf(action.type) >= 0 ? resolveNpc(next, action) : null;
    if (NPC_TYPES.indexOf(action.type) >= 0 && !npc) return Promise.resolve(failure(next, action, 'target-required', '请指定当前要互动的 NPC。'));
    if (npc) action = Object.assign({}, action, { targetNpcId: npc.id });
    var actionResult = Module4.Action.execute(next, action);
    if (!actionResult.ok) return Promise.resolve(actionResult);
    action = actionResult.action || action;
    var callLLM = options && typeof options.callLLM === 'function' ? options.callLLM : root.callLLM;
    if (typeof callLLM !== 'function') return Promise.resolve(failure(next, action, 'model-unavailable', '公共模型请求能力不可用，请检查 Denova 共享 Settings；时间与精力未改变。'));
    var key = [text(next.id), Number(next.revision) || 0, action.type, npc ? npc.id : '', text(action.text)].join(':');
    if (inFlight[key]) return inFlight[key];
    var context = npc && Module4.AI.Context && typeof Module4.AI.Context.forNpc === 'function'
      ? Module4.AI.Context.forNpc(next, npc.id)
      : Module4.AI.Context && typeof Module4.AI.Context.forPlayer === 'function'
        ? Module4.AI.Context.forPlayer(next)
        : { facts: [] };
    var promise = Promise.resolve().then(function () {
      return callLLM(messages(next, action, npc, actionResult));
    }).then(function (response) {
      var parsed = parseResponse(response);
      return commit(next, action, npc, parsed, context, actionResult);
    }).catch(function (error) {
      return failure(next, action, 'interaction-failed', failureMessage(error));
    });
    inFlight[key] = promise.then(function (result) {
      delete inFlight[key];
      return result;
    }, function (error) {
      delete inFlight[key];
      throw error;
    });
    return inFlight[key];
  };
}(window));
