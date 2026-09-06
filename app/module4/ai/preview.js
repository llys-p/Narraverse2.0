/* Module 4 Task 4: structured, retryable and idempotent Daily Preview. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.AI = Module4.AI || {};
  Module4.AI.Preview = Module4.AI.Preview || {};

  var Preview = Module4.AI.Preview;
  var FALLBACK_PERIODS = ['morning', 'afternoon', 'evening'];
  var inFlight = {};

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function periods() {
    return Module4.AI.Prompts && Array.isArray(Module4.AI.Prompts.dailyPreviewPeriods)
      ? Module4.AI.Prompts.dailyPreviewPeriods
      : FALLBACK_PERIODS;
  }

  function responseText(response) {
    if (typeof response === 'string') return response;
    if (!response || typeof response !== 'object') return '';
    if (typeof response.content === 'string') return response.content;
    if (response.message && typeof response.message.content === 'string') return response.message.content;
    if (typeof response.text === 'string') return response.text;
    return '';
  }

  function parseJson(response) {
    var raw = responseText(response).trim();
    if (!raw) throw new Error('模型没有返回内容');
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(raw);
    } catch (error) {
      var start = raw.indexOf('{');
      var end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
      throw new Error('Daily Preview 不是有效 JSON');
    }
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 240);
  }

  function knownLocation(world, reference) {
    var value = text(reference);
    var locations = world && Array.isArray(world.locations) ? world.locations : [];
    return locations.find(function (location) {
      return location && (text(location.id) === value || text(location.name) === value);
    }) || null;
  }

  function fallbackLocation(world, npc) {
    var locations = world && Array.isArray(world.locations) ? world.locations : [];
    if (!locations.length) return null;
    var npcLocation = npc && npc.schedule && npc.schedule.morning && (npc.schedule.morning.locationId || npc.schedule.morning.location);
    return knownLocation(world, npcLocation)
      || knownLocation(world, world && world.player && world.player.location)
      || locations[0];
  }

  function normalizeSlot(raw, npcId, period, world, npc) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      raw = {};
    }
    var slot = clone(raw);
    ['locationId', 'location', 'activity', 'intent', 'mood', 'availability'].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(slot, field)) slot[field] = shortText(slot[field]);
    });
    if (world && world.rulesVersion === 'v1.5') {
      var reference = text(slot.locationId || slot.location);
      if (reference) {
        var location = knownLocation(world, reference);
        if (!location) throw new Error('Daily Preview 包含未知地点');
        slot.locationId = location.id;
        delete slot.location;
      } else {
        var fallback = fallbackLocation(world, npc);
        if (fallback) slot.locationId = text(fallback.id);
      }
      if (!slotActivity(slot)) slot.activity = shortText(npc && npc.dailyGoal || npc && npc.goals && npc.goals[0] || '处理当天事务', 160);
      if (!text(slot.intent)) slot.intent = '本地补齐';
    }
    return slot;
  }

  function slotActivity(slot) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return '';
    return text(slot.activity || slot.intent || slot.summary || slot.description);
  }

  function normalizeEvent(raw) {
    if (typeof raw === 'string') {
      var summary = shortText(raw);
      return summary ? { summary: summary } : null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var event = clone(raw);
    var title = shortText(event.title || event.name);
    var summaryText = shortText(event.summary || event.description || event.detail);
    if (!title && !summaryText) return null;
    event.title = title;
    event.summary = summaryText;
    delete event.description;
    delete event.detail;
    return event;
  }

  function normalizePreview(raw, world) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Daily Preview 根对象无效');
    if (!Array.isArray(raw.npcs)) throw new Error('Daily Preview 缺少 npcs 数组');
    var currentNpcs = Module4.World.listNpcs(world);
    var expected = {};
    currentNpcs.forEach(function (npc) { expected[npc.id] = npc; });
    var seen = {};
    var resultNpcs = raw.npcs.map(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('NPC 预演项无效');
      var npcId = text(item.npcId || item.id);
      if (!npcId || !expected[npcId]) throw new Error('Daily Preview 包含未知 NPC');
      if (seen[npcId]) throw new Error('Daily Preview 重复 NPC');
      seen[npcId] = true;
      var mood = shortText(item.mood, 80);
      var goal = shortText(item.goal, 240);
      if (!mood || !goal) throw new Error('NPC ' + npcId + ' 缺少 mood 或 goal');
      var rawSchedule = item.schedule;
      if (!rawSchedule || typeof rawSchedule !== 'object' || Array.isArray(rawSchedule)) rawSchedule = {};
      var schedule = {};
      var scheduleNpc = Object.assign({}, expected[npcId], { dailyGoal: goal });
      periods().forEach(function (period) {
        schedule[period] = normalizeSlot(rawSchedule[period], npcId, period, world, scheduleNpc);
      });
      return { npcId: npcId, mood: mood, goal: goal, schedule: schedule };
    });
    if (resultNpcs.length !== currentNpcs.length) throw new Error('Daily Preview 未覆盖全部当前 NPC');
    var events = Array.isArray(raw.worldEvents) ? raw.worldEvents.map(normalizeEvent).filter(Boolean).slice(0, 8) : [];
    return { npcs: resultNpcs, worldEvents: events };
  }

  function fallbackPreview(world) {
    return {
      npcs: Module4.World.listNpcs(world).map(function (npc, npcIndex) {
        var locations = world && Array.isArray(world.locations) ? world.locations : [];
        var goal = text(npc.goals && npc.goals[0]) || '处理当天事务';
        var schedule = {};
        periods().forEach(function (period, periodIndex) {
          var source = npc.schedule && npc.schedule[period];
          var slot = source && typeof source === 'object' && !Array.isArray(source) ? clone(source) : {};
          var currentLocation = text(slot.locationId || slot.location);
          var knownLocation = locations.find(function (location) {
            return location && typeof location === 'object'
              && (text(location.id) === currentLocation || text(location.name) === currentLocation);
          });
          if (locations.length && !knownLocation) {
            knownLocation = locations[(npcIndex + periodIndex) % locations.length];
            slot.locationId = text(knownLocation && knownLocation.id);
          }
          if (!slotActivity(slot)) slot.activity = goal;
          if (!text(slot.intent)) slot.intent = '继续推进当前目标';
          schedule[period] = slot;
        });
        return {
          npcId: npc.id,
          mood: npc.mood || 'neutral',
          goal: text(npc.dailyGoal) || text(npc.goals && npc.goals[0]) || '保持当前状态',
          schedule: schedule
        };
      }),
      worldEvents: []
    };
  }

  function applyPreview(world, preview, status, errorMessage) {
    var next = clone(world);
    Module4.World.normalizeWorld(next);
    preview.npcs.forEach(function (item) {
      var npc = next.npcs[item.npcId];
      if (!npc) return;
      next.npcs[item.npcId] = Object.assign({}, npc, {
        mood: item.mood,
        dailyGoal: item.goal || text(npc.dailyGoal) || '',
        schedule: clone(item.schedule)
      });
    });
    next.currentDay = Object.assign({}, next.currentDay, {
      day: Number(next.clock && next.clock.day) || 1,
      previewGenerated: true,
      previewStatus: status,
      previewGeneratedAt: Date.now(),
      previewError: shortText(errorMessage, 160),
      schedules: preview.npcs.reduce(function (result, item) {
        result[item.npcId] = clone(item);
        return result;
      }, {}),
      events: clone(preview.worldEvents),
      interactedNpcIds: []
    });
    if (next.rulesVersion === 'v1.5' && Module4.Events && typeof Module4.Events.ingestCandidates === 'function') {
      var eventResult = Module4.Events.ingestCandidates(next, preview.worldEvents);
      if (eventResult.ok && eventResult.changed) next = eventResult.world;
    }
    next.updatedAt = Date.now();
    return next;
  }

  function dayOf(world) {
    return Number(world && world.clock && world.clock.day) || 1;
  }

  Preview.isCurrentDayValid = function (world) {
    var currentDay = world && world.currentDay;
    if (!currentDay || currentDay.previewGenerated !== true || Number(currentDay.day) !== dayOf(world)) return false;
    var npcs = Module4.World.listNpcs(world);
    if (!npcs.length) return true;
    var schedules = currentDay.schedules && typeof currentDay.schedules === 'object' && !Array.isArray(currentDay.schedules)
      ? currentDay.schedules
      : {};
    return npcs.every(function (npc) {
      var item = schedules[npc.id];
      return !!(item && item.schedule && typeof item.schedule === 'object' && !Array.isArray(item.schedule)
        && periods().every(function (period) {
          var slot = item.schedule[period];
          if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
          if (world && world.rulesVersion === 'v1.5') {
            var location = text(slot.locationId || slot.location);
            var validLocation = !world.locations || !world.locations.length || !!knownLocation(world, location);
            return validLocation && !!slotActivity(slot);
          }
          return true;
        }));
    });
  };

  Preview.isComplete = Preview.isCurrentDayValid;

  function run(world, options) {
    var day = dayOf(world);
    if (Preview.isCurrentDayValid(world)) {
      return Promise.resolve({
        ok: true,
        changed: false,
        idempotent: true,
        status: (world.currentDay && world.currentDay.previewStatus) || 'completed',
        world: clone(world),
        message: '今日预演已存在，未重复生成。'
      });
    }

    var currentNpcs = Module4.World.listNpcs(world);
    if (!currentNpcs.length) {
      var emptyWorld = applyPreview(world, fallbackPreview(world), 'completed', '当前世界没有重要 NPC。');
      return Promise.resolve({ ok: true, changed: true, status: 'completed', world: emptyWorld, attempts: 0, message: '当前世界暂无 NPC，已保存空白日预演。' });
    }

    var callLLM = options && typeof options.callLLM === 'function' ? options.callLLM : root.callLLM;
    var maxAttempts = Number(options && options.maxAttempts) || 2;
    maxAttempts = Math.max(1, Math.min(3, maxAttempts));
    if (!Module4.AI.Prompts || typeof Module4.AI.Prompts.buildDailyPreviewMessages !== 'function' || typeof callLLM !== 'function') {
      var unavailableWorld = applyPreview(world, fallbackPreview(world), 'fallback', '公共模型请求能力不可用。');
      return Promise.resolve({ ok: true, changed: true, status: 'fallback', world: unavailableWorld, attempts: 0, message: '模型暂不可用，已使用本地日程 fallback。' });
    }

    var messages = Module4.AI.Prompts.buildDailyPreviewMessages(world);
    var lastError = '';
    var attempt = 0;

    function requestNext() {
      attempt += 1;
      return Promise.resolve().then(function () {
        return callLLM(messages);
      }).then(function (response) {
        var parsed = normalizePreview(parseJson(response), world);
        var next = applyPreview(world, parsed, 'completed', '');
        return { ok: true, changed: true, status: 'completed', world: next, attempts: attempt, message: '今日预演已生成并保存。' };
      }).catch(function (error) {
        lastError = text(error && error.message) || 'Daily Preview 解析失败';
        if (attempt < maxAttempts) return requestNext();
        var fallbackWorld = applyPreview(world, fallbackPreview(world), 'fallback', lastError);
        return { ok: true, changed: true, status: 'fallback', world: fallbackWorld, attempts: attempt, message: '预演解析失败，已使用本地 fallback。' };
      });
    }

    return requestNext();
  }

  Preview.startDay = function (world, options) {
    if (!world || typeof world !== 'object') return Promise.resolve({ ok: false, changed: false, world: world, message: '缺少模块四世界。' });
    var normalized = clone(world);
    Module4.World.normalizeWorld(normalized);
    var key = text(normalized.id) + ':' + dayOf(normalized);
    if (inFlight[key]) return inFlight[key];
    var promise = run(normalized, options || {});
    inFlight[key] = promise.then(function (result) {
      delete inFlight[key];
      return result;
    }, function (error) {
      delete inFlight[key];
      throw error;
    });
    return inFlight[key];
  };

  Preview.ensureDayReady = function (world, options) {
    if (!world || world.rulesVersion !== 'v1.5') {
      return Promise.resolve({ ok: true, changed: false, skipped: true, world: clone(world), message: '旧世界保留原有预演入口。' });
    }
    return Preview.startDay(world, options || {});
  };

  Preview.parse = function (response, world) {
    return normalizePreview(parseJson(response), world);
  };
}(window));
