/* Module 4 V1.5: filter facts, knowledge, scene objects, and character fields before any prompt. */
(function (root) {
  'use strict';

  var Module4 = root.Module4 = root.Module4 || {};
  Module4.AI = Module4.AI || {};
  Module4.AI.Context = Module4.AI.Context || {};

  var Context = Module4.AI.Context;
  var PUBLIC_SOURCE_FIELDS = ['name', 'appearance', 'personality', 'scenario', 'relationship', 'tags'];
  var PREVIEW_SOURCE_FIELDS = ['name', 'appearance', 'personality', 'scenario', 'notes', 'relationship', 'character_note', 'tags'];
  var HIDDEN_KEYS = /(?:api[_-]?key|authorization|token|password|secret|credential)/i;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 280);
  }

  function normalWorld(world) {
    var next = clone(world);
    if (Module4.World && typeof Module4.World.normalizeWorld === 'function') Module4.World.normalizeWorld(next);
    if (Module4.Clock && typeof Module4.Clock.normalizeWorld === 'function') Module4.Clock.normalizeWorld(next);
    if (Module4.Location && typeof Module4.Location.normalizeWorld === 'function') Module4.Location.normalizeWorld(next);
    return next;
  }

  function clean(value, key, depth) {
    if (HIDDEN_KEYS.test(text(key))) return '[REDACTED]';
    if (depth > 4) return undefined;
    if (Array.isArray(value)) return value.slice(0, 20).map(function (item) { return clean(item, '', depth + 1); }).filter(function (item) { return item !== undefined; });
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce(function (result, childKey) {
        var child = clean(value[childKey], childKey, depth + 1);
        if (child !== undefined) result[childKey] = child;
        return result;
      }, {});
    }
    if (typeof value === 'string') return shortText(value, 600);
    return value;
  }

  function pick(source, fields) {
    var result = {};
    var input = source && typeof source === 'object' ? source : {};
    fields.forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) return;
      var value = clean(input[field], field, 0);
      if (value !== undefined && value !== '') result[field] = value;
    });
    return result;
  }

  function location(world, reference) {
    var value = text(reference);
    var locations = world && Array.isArray(world.locations) ? world.locations : [];
    var item = locations.find(function (candidate) {
      return candidate && (text(candidate.id) === value || text(candidate.name) === value);
    });
    return item ? {
      id: text(item.id),
      name: shortText(item.name || item.id, 120),
      description: shortText(item.description, 240)
    } : { id: value, name: value || '未选择地点', description: '' };
  }

  function visible(value, viewerId) {
    var item = value && typeof value === 'object' ? value : {};
    var knownTo = Array.isArray(item.knownTo) ? item.knownTo.map(text) : [];
    if (knownTo.indexOf(text(viewerId)) >= 0 || knownTo.indexOf('*') >= 0) return true;
    return text(item.visibility) !== 'private' && text(item.visibility) !== 'restricted';
  }

  function safeFact(fact) {
    return {
      id: text(fact && fact.id),
      day: Number(fact && fact.day) || 1,
      period: text(fact && fact.period) || 'morning',
      type: text(fact && fact.type) || 'world',
      actors: Array.isArray(fact && fact.actors) ? fact.actors.map(text).filter(Boolean).slice(0, 8) : [],
      summary: shortText(fact && fact.summary, 280),
      epistemicStatus: text(fact && fact.epistemicStatus) || null
    };
  }

  function factsFor(world, viewerId, internal) {
    var facts = internal && Module4.Facts && typeof Module4.Facts.recent === 'function'
      ? Module4.Facts.recent(world, 12)
      : Module4.Facts && typeof Module4.Facts.recentFor === 'function'
        ? Module4.Facts.recentFor(world, viewerId, 12)
        : (Array.isArray(world && world.facts) ? world.facts : []);
    return facts.filter(function (fact) { return internal || visible(fact, viewerId); }).map(safeFact);
  }

  function knowledgeFor(world, viewerId) {
    var entries = world && world.knowledge && Array.isArray(world.knowledge[viewerId])
      ? world.knowledge[viewerId]
      : [];
    return entries.slice(-12).map(function (entry) {
      return {
        id: text(entry.id),
        claim: shortText(entry.claim, 280),
        epistemicStatus: text(entry.epistemicStatus) || 'observation',
        sourceFactId: text(entry.sourceFactId) || null,
        sourceActionId: text(entry.sourceActionId) || null,
        day: Number(entry.day) || null,
        period: text(entry.period) || null
      };
    }).filter(function (entry) { return !!entry.claim; });
  }

  function safeNpc(world, npc, viewerId, internal) {
    var snapshot = Module4.World && typeof Module4.World.getNpcSourceSnapshot === 'function'
      ? Module4.World.getNpcSourceSnapshot(world, npc.sourceRef)
      : { name: npc.name };
    var result = {
      npcId: text(npc.id),
      name: shortText(npc.name, 80),
      profile: pick(snapshot, internal ? PREVIEW_SOURCE_FIELDS : PUBLIC_SOURCE_FIELDS),
      mood: text(npc.mood) || 'neutral'
    };
    if (viewerId === 'player' || viewerId === npc.id) {
      result.relation = clone(npc.relation || { stage: 'unknown', value: 0 });
    }
    if (viewerId === npc.id || internal) {
      result.goals = clone(Array.isArray(npc.goals) ? npc.goals : []).slice(0, 4);
    }
    return result;
  }

  function sceneNpcs(world, viewerId, internal) {
    var current = Module4.Encounter && typeof Module4.Encounter.checkNatural === 'function'
      ? Module4.Encounter.checkNatural(world)
      : { npcs: [] };
    var npcs = Array.isArray(current.npcs) ? current.npcs : [];
    return npcs.map(function (npc) { return safeNpc(world, npc, viewerId, internal); });
  }

  function sceneObjects(world, viewerId) {
    var currentLocation = text(world && world.player && world.player.location);
    var objects = Array.isArray(world && world.sceneObjects) ? world.sceneObjects : [];
    return objects.filter(function (object) {
      var locationId = text(object && (object.locationId || object.location));
      var holder = text(object && (object.holderId || object.holder));
      return visible(object, viewerId)
        && object && object.visible !== false
        && (!locationId || locationId === currentLocation)
        && (!holder || holder === 'world' || holder === 'player' || holder === currentLocation);
    }).map(function (object) {
      return {
        id: text(object.id),
        name: shortText(object.name || object.id, 100),
        description: shortText(object.description, 240),
        state: shortText(object.state, 80),
        affordances: Array.isArray(object.affordances) ? object.affordances.map(text).slice(0, 8) : []
      };
    });
  }

  function worldSummary(world) {
    return {
      id: text(world && world.id),
      title: shortText(world && world.title, 120),
      description: shortText(world && world.description, 600),
      day: Number(world && world.clock && world.clock.day) || 1,
      period: text(world && world.clock && world.clock.period) || 'morning',
      location: location(world, world && world.player && world.player.location)
    };
  }

  Context.version = 'v1.5-context-1';
  Context.forPlayer = function (world) {
    var next = normalWorld(world);
    return {
      view: 'player',
      viewerId: 'player',
      world: worldSummary(next),
      scene: {
        npcs: sceneNpcs(next, 'player', false),
        objects: sceneObjects(next, 'player')
      },
      facts: factsFor(next, 'player', false),
      knowledge: knowledgeFor(next, 'player')
    };
  };

  Context.forNpc = function (world, npcId) {
    var next = normalWorld(world);
    var npc = next.npcs && next.npcs[text(npcId)];
    if (!npc) return null;
    return {
      view: 'npc',
      viewerId: npc.id,
      world: worldSummary(next),
      self: safeNpc(next, npc, npc.id, false),
      scene: {
        npcs: sceneNpcs(next, npc.id, false).filter(function (item) { return item.npcId !== npc.id; }),
        objects: sceneObjects(next, npc.id)
      },
      facts: factsFor(next, npc.id, false),
      knowledge: knowledgeFor(next, npc.id)
    };
  };

  Context.forPreview = function (world) {
    var next = normalWorld(world);
    var npcs = Module4.World && typeof Module4.World.listNpcs === 'function' ? Module4.World.listNpcs(next) : [];
    return {
      view: 'preview-internal',
      world: {
        title: shortText(next.title, 120),
        description: shortText(next.description, 600),
        locations: (Array.isArray(next.locations) ? next.locations : []).slice(0, 20).map(function (item) {
          return { id: shortText(item && item.id, 80), name: shortText(item && (item.name || item.title), 120), description: shortText(item && item.description, 180) };
        })
      },
      facts: factsFor(next, 'author', true),
      knowledge: clean(next.knowledge || {}, 'knowledge', 0),
      events: (Array.isArray(next.events) ? next.events : []).slice(0, 8).map(function (event) { return clean(event, '', 0); }),
      npcs: npcs.map(function (npc) {
        var binding = Module4.World.getNpcSourceBinding(next, npc.sourceRef) || {};
        return {
          npcId: npc.id,
          sourceRef: npc.sourceRef,
          sourceVersion: binding.sourceVersion || npc.sourceRef,
          sourceSnapshot: pick(Module4.World.getNpcSourceSnapshot(next, npc.sourceRef) || { name: npc.name }, PREVIEW_SOURCE_FIELDS),
          runtime: {
            npcId: npc.id,
            name: npc.name,
            mood: npc.mood,
            relation: clone(npc.relation),
            goals: clone(npc.goals),
            schedule: clone(npc.schedule)
          }
        };
      })
    };
  };
}(window));
