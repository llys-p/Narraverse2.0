/* Module 4 V1.5: finite event records with whitelist effects and deterministic transitions. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.Events = Module4.Events || {};

  var Events = Module4.Events;
  var PERIODS = ['morning', 'afternoon', 'evening'];
  var STATUSES = ['candidate', 'active', 'resolved', 'expired'];
  var TRIGGER_TYPES = ['action', 'enter_location', 'get_clue', 'judgment', 'time', 'deadline'];
  var inMemorySequence = 0;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 280);
  }

  function number(value, fallback) {
    var result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function normalWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    return next;
  }

  function locationExists(world, reference) {
    var value = text(reference);
    return (world && Array.isArray(world.locations) ? world.locations : []).find(function (location) {
      return location && (text(location.id) === value || text(location.name) === value);
    }) || null;
  }

  function objectById(world, objectId) {
    var objects = Array.isArray(world && world.sceneObjects) ? world.sceneObjects : [];
    return objects.find(function (object) { return object && text(object.id) === text(objectId); }) || null;
  }

  function normalizeTrigger(raw) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var type = text(source.type || source.kind);
    if (TRIGGER_TYPES.indexOf(type) < 0) return null;
    var day = Number(source.day);
    return {
      type: type,
      day: Number.isInteger(day) && day > 0 ? day : null,
      period: PERIODS.indexOf(text(source.period)) >= 0 ? text(source.period) : null,
      locationId: text(source.locationId || source.location) || null,
      objectId: text(source.objectId || source.clueId) || null,
      actionType: text(source.actionType || source.action) || null,
      outcome: text(source.outcome || source.judgmentOutcome) || null,
      factId: text(source.factId) || null
    };
  }

  function normalizeEffects(raw) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var effect = {};
    var stage = text(source.stage || source.toStage);
    var status = text(source.status);
    if (stage) effect.stage = shortText(stage, 80);
    if (STATUSES.indexOf(status) >= 0 && status !== 'candidate') effect.status = status;

    var objectId = text(source.objectId || source.targetObjectId);
    var objectPatch = source.objectPatch && typeof source.objectPatch === 'object' && !Array.isArray(source.objectPatch)
      ? source.objectPatch
      : null;
    if (objectId && objectPatch) {
      effect.objectId = objectId;
      effect.objectPatch = {};
      ['state', 'holderId', 'locationId', 'visible'].forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(objectPatch, field)) effect.objectPatch[field] = clone(objectPatch[field]);
      });
    }

    var npcChanges = Array.isArray(source.npcChanges) ? source.npcChanges : [];
    effect.npcChanges = npcChanges.map(function (change) {
      if (!change || typeof change !== 'object') return null;
      var npcId = text(change.npcId || change.id);
      if (!npcId) return null;
      var result = { npcId: npcId };
      if (text(change.mood)) result.mood = shortText(change.mood, 40);
      if (Number.isFinite(Number(change.relationDelta))) result.relationDelta = Number(change.relationDelta);
      if (text(change.relationStage)) result.relationStage = shortText(change.relationStage, 40);
      return result;
    }).filter(Boolean).slice(0, 4);

    var npcRelations = Array.isArray(source.npcRelations) ? source.npcRelations : [];
    effect.npcRelations = npcRelations.map(function (relation) {
      if (!relation || typeof relation !== 'object') return null;
      var fromNpcId = text(relation.fromNpcId || relation.from);
      var toNpcId = text(relation.toNpcId || relation.to);
      if (!fromNpcId || !toNpcId || fromNpcId === toNpcId) return null;
      return {
        fromNpcId: fromNpcId,
        toNpcId: toNpcId,
        delta: Number.isFinite(Number(relation.delta)) ? Number(relation.delta) : 0,
        stage: shortText(relation.stage, 40) || null
      };
    }).filter(Boolean).slice(0, 4);

    var knowledge = Array.isArray(source.knowledge) ? source.knowledge : [];
    effect.knowledge = knowledge.map(function (item) {
      if (!item || typeof item !== 'object') return null;
      var viewerId = text(item.viewerId || item.knownTo);
      var claim = shortText(item.claim || item.summary, 280);
      if (!viewerId || !claim) return null;
      var statusValue = text(item.epistemicStatus || item.status);
      if (['observation', 'heard', 'inference', 'belief'].indexOf(statusValue) < 0) statusValue = 'heard';
      return { viewerId: viewerId, claim: claim, epistemicStatus: statusValue };
    }).filter(Boolean).slice(0, 4);
    return effect;
  }

  function normalizeTransition(raw, eventId, index) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var trigger = normalizeTrigger(source.trigger || source.when);
    if (!trigger) return null;
    return {
      id: shortText(source.id, 120) || eventId + '-transition-' + index,
      trigger: trigger,
      summary: shortText(source.summary || source.description || source.result, 240),
      effects: normalizeEffects(source.effects || source)
    };
  }

  function normalizeEvent(raw, index, defaultStatus) {
    if (typeof raw === 'string') raw = { title: shortText(raw, 120), summary: shortText(raw, 240) };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var title = shortText(raw.title || raw.name, 120);
    var summary = shortText(raw.summary || raw.description || raw.detail, 240);
    if (!title && !summary) return null;
    inMemorySequence += 1;
    var id = shortText(raw.id, 120) || 'event-' + Date.now().toString(36) + '-' + inMemorySequence + '-' + index;
    var status = text(raw.status) || defaultStatus || 'candidate';
    if (STATUSES.indexOf(status) < 0) status = 'candidate';
    var transitions = Array.isArray(raw.transitions) ? raw.transitions : (Array.isArray(raw.branches) ? raw.branches : []);
    return {
      id: id,
      dedupeKey: shortText(raw.dedupeKey || raw.key || id, 160),
      title: title || '未命名事件',
      summary: summary || title,
      actors: Array.isArray(raw.actors) ? raw.actors.map(text).filter(Boolean).slice(0, 8) : [],
      locationId: text(raw.locationId || raw.location) || null,
      objectId: text(raw.objectId || raw.object) || null,
      stage: shortText(raw.stage, 80) || 'pending',
      status: status,
      visibility: text(raw.visibility) || 'public',
      knownTo: Array.isArray(raw.knownTo) ? raw.knownTo.map(text).filter(Boolean).slice(0, 8) : [],
      source: shortText(raw.source || raw.sourceType || 'preview', 80),
      sourceFactId: text(raw.sourceFactId) || null,
      sourceActionId: text(raw.sourceActionId) || null,
      transitions: transitions.map(function (item, transitionIndex) {
        return normalizeTransition(item, id, transitionIndex);
      }).filter(Boolean).slice(0, 6),
      appliedTransitionIds: Array.isArray(raw.appliedTransitionIds) ? raw.appliedTransitionIds.map(text).filter(Boolean).slice(-24) : [],
      lastTransitionSlot: text(raw.lastTransitionSlot) || null,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }

  function activeCount(events) {
    return events.filter(function (event) { return event && event.status === 'active'; }).length;
  }

  function transitionSlot(world, context) {
    var clock = context && context.clock ? context.clock : world.clock || {};
    return [Number(clock.day) || 1, text(clock.period) || 'morning', Number(clock.tick) || 0].join(':');
  }

  function periodReached(current, expected) {
    var currentIndex = PERIODS.indexOf(text(current.period));
    var expectedIndex = PERIODS.indexOf(text(expected));
    if (currentIndex < 0 || expectedIndex < 0) return false;
    return currentIndex >= expectedIndex;
  }

  function triggerMatches(world, event, transition, context) {
    var trigger = transition.trigger;
    var action = context && context.action || {};
    var clock = context && context.clock ? context.clock : world.clock || {};
    if (trigger.day && Number(clock.day) !== trigger.day && trigger.type !== 'deadline') return false;
    if (trigger.period && !periodReached(clock, trigger.period)) return false;
    if (trigger.locationId && text(world.player && world.player.location) !== trigger.locationId
      && !locationExists(world, trigger.locationId)) return false;
    if (trigger.type === 'action') {
      if (trigger.actionType && text(action.type) !== trigger.actionType) return false;
      if (trigger.locationId && text(world.player && world.player.location) !== trigger.locationId) return false;
      if (trigger.objectId && text(action.targetObjectId) !== trigger.objectId) return false;
      if (trigger.outcome && text(context && context.judgment && context.judgment.outcome) !== trigger.outcome) return false;
      return !!text(action.type);
    }
    if (trigger.type === 'enter_location') {
      return text(action.type) === 'move' && text(world.player && world.player.location) === trigger.locationId;
    }
    if (trigger.type === 'get_clue') {
      return text(action.type) === 'take' && (!trigger.objectId || text(action.targetObjectId) === trigger.objectId);
    }
    if (trigger.type === 'judgment') {
      return !!(context && context.judgment && context.judgment.required)
        && (!trigger.actionType || text(action.type) === trigger.actionType)
        && (!trigger.outcome || text(context.judgment.outcome) === trigger.outcome);
    }
    if (trigger.type === 'time') {
      return !!(context && (context.timeChanged || context.action && ['wait', 'sleep'].indexOf(context.action.type) >= 0));
    }
    if (trigger.type === 'deadline') {
      return Number(clock.day) >= Number(trigger.day || clock.day)
        && !!(context && (context.isSettlement || context.action && context.action.type === 'sleep'));
    }
    return false;
  }

  function updateObject(world, objectId, patch) {
    if (!objectById(world, objectId)) return false;
    world.sceneObjects = world.sceneObjects.map(function (object) {
      return object && text(object.id) === text(objectId) ? Object.assign({}, object, patch) : object;
    });
    return true;
  }

  function applyEffects(world, event, effects, context) {
    var changed = false;
    if (effects.stage) {
      event.stage = effects.stage;
      changed = true;
    }
    if (effects.status) {
      event.status = effects.status;
      changed = true;
    }
    if (effects.objectId && effects.objectPatch && updateObject(world, effects.objectId, effects.objectPatch)) changed = true;
    (effects.npcChanges || []).forEach(function (change) {
      var npc = world.npcs && world.npcs[change.npcId];
      if (!npc) return;
      if (change.mood) { npc.mood = change.mood; changed = true; }
      if (Number.isFinite(change.relationDelta)) {
        npc.relation = Object.assign({}, npc.relation || {}, { value: number(npc.relation && npc.relation.value, 0) + change.relationDelta });
        changed = true;
      }
      if (change.relationStage) { npc.relation = Object.assign({}, npc.relation || {}, { stage: change.relationStage }); changed = true; }
    });
    (effects.npcRelations || []).forEach(function (relation) {
      if (!world.npcs[relation.fromNpcId] || !world.npcs[relation.toNpcId]) return;
      var key = relation.fromNpcId + '->' + relation.toNpcId;
      var current = world.npcRelations[key] || { fromNpcId: relation.fromNpcId, toNpcId: relation.toNpcId, value: 0 };
      world.npcRelations[key] = Object.assign({}, current, {
        value: number(current.value, 0) + relation.delta,
        stage: relation.stage || current.stage || 'unknown',
        updatedAt: Date.now()
      });
      changed = true;
    });
    (effects.knowledge || []).forEach(function (item, index) {
      if (item.viewerId !== 'player' && !world.npcs[item.viewerId]) return;
      world.knowledge[item.viewerId] = Array.isArray(world.knowledge[item.viewerId]) ? world.knowledge[item.viewerId] : [];
      world.knowledge[item.viewerId].push({
        id: 'event-knowledge-' + event.id + '-' + index,
        claim: item.claim,
        epistemicStatus: item.epistemicStatus,
        sourceFactId: null,
        sourceActionId: text(context && context.action && context.action.id) || null,
        day: Number(world.clock && world.clock.day) || 1,
        period: text(world.clock && world.clock.period) || 'morning'
      });
      world.knowledge[item.viewerId] = world.knowledge[item.viewerId].slice(-40);
      changed = true;
    });
    return changed;
  }

  Events.version = 'v1.5-events-1';
  Events.normalize = function (raw, index) { return normalizeEvent(raw, index || 0, 'candidate'); };

  Events.add = function (world, raw) {
    if (!world || typeof world !== 'object') return { ok: false, changed: false, world: world, message: '缺少模块四世界。' };
    var next = normalWorld(world);
    var event = normalizeEvent(raw, next.events.length, 'candidate');
    if (!event) return { ok: false, changed: false, world: next, reason: 'invalid-event', message: '事件记录不完整。' };
    if (next.events.some(function (item) { return item.id === event.id || item.dedupeKey === event.dedupeKey; })) {
      return { ok: true, changed: false, world: next, event: clone(next.events.find(function (item) { return item.id === event.id || item.dedupeKey === event.dedupeKey; })), message: '事件已存在。' };
    }
    if (event.status === 'active' && activeCount(next.events) >= 3) {
      return { ok: false, changed: false, world: next, reason: 'active-limit', message: '当前活跃事件已达到上限。' };
    }
    if (event.locationId && !locationExists(next, event.locationId)) return { ok: false, changed: false, world: next, reason: 'unknown-location', message: '事件地点不存在。' };
    if (event.objectId && !objectById(next, event.objectId)) return { ok: false, changed: false, world: next, reason: 'unknown-object', message: '事件对象不存在。' };
    next.events.push(event);
    next.updatedAt = Date.now();
    return { ok: true, changed: true, world: next, event: clone(event), message: '事件已加入当前世界。' };
  };

  Events.ingestCandidates = function (world, candidates) {
    var next = normalWorld(world);
    var result = { ok: true, changed: false, world: next, added: [] };
    (Array.isArray(candidates) ? candidates : []).slice(0, 1).forEach(function (candidate, index) {
      var raw = candidate && typeof candidate === 'object' ? Object.assign({}, candidate, { status: 'candidate', source: 'preview' }) : candidate;
      var added = Events.add(result.world, raw);
      if (added.ok && added.changed) {
        result.world = added.world;
        result.changed = true;
        result.added.push(added.event);
      }
    });
    return result;
  };

  Events.activate = function (world, eventId) {
    var next = normalWorld(world);
    var event = next.events.find(function (item) { return item.id === text(eventId); });
    if (!event || event.status !== 'candidate') return { ok: false, changed: false, world: next, message: '候选事件不存在。' };
    if (activeCount(next.events) >= 3) return { ok: false, changed: false, world: next, reason: 'active-limit', message: '当前活跃事件已达到上限。' };
    event.status = 'active';
    event.updatedAt = Date.now();
    return { ok: true, changed: true, world: next, event: clone(event), message: '事件已开始。' };
  };

  Events.advance = function (world, context) {
    var next = normalWorld(world);
    var options = context && typeof context === 'object' ? context : {};
    var facts = [];
    var processed = 0;
    var slot = transitionSlot(next, options);
    next.events = next.events.map(function (event) {
      return event && typeof event === 'object' ? event : null;
    }).filter(Boolean);
    for (var index = 0; index < next.events.length && processed < 3; index += 1) {
      var event = next.events[index];
      if (event.status !== 'active' || event.lastTransitionSlot === slot) continue;
      var transition = event.transitions.find(function (candidate) {
        return event.appliedTransitionIds.indexOf(candidate.id + ':' + slot) < 0
          && triggerMatches(next, event, candidate, options);
      });
      if (!transition) continue;
      var changed = applyEffects(next, event, transition.effects, options);
      event.appliedTransitionIds.push(transition.id + ':' + slot);
      event.appliedTransitionIds = event.appliedTransitionIds.slice(-24);
      event.lastTransitionSlot = slot;
      event.updatedAt = Date.now();
      changed = true;
      var factResult = Module4.Facts && typeof Module4.Facts.add === 'function'
        ? Module4.Facts.add(next, {
          type: 'world_event',
          actors: event.actors,
          summary: shortText(event.title + '：' + (transition.summary || event.summary), 280),
          visibility: event.visibility,
          knownTo: event.knownTo,
          sourceFactId: event.sourceFactId,
          sourceActionId: options.action && options.action.id,
          day: Number(next.clock && next.clock.day) || 1,
          period: text(next.clock && next.clock.period) || 'morning'
        })
        : { world: next, fact: null, changed: false };
      next = factResult.world || next;
      if (factResult.fact) facts.push(factResult.fact);
      if (changed) processed += 1;
    }
    return {
      ok: true,
      changed: processed > 0,
      world: next,
      facts: clone(facts),
      processed: processed,
      message: processed ? '世界事件已推进。' : '当前没有需要推进的世界事件。'
    };
  };
}(window));
