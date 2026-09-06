/* Module 4 Task 8: render context actions without duplicating rule-layer semantics. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.UI = Module4.UI || {};
  Module4.UI.PlayView = Module4.UI.PlayView || {};

  function locationName(world, reference) {
    var value = String(reference == null ? '' : reference).trim();
    if (!value) return '';
    var location = (world && Array.isArray(world.locations) ? world.locations : []).find(function (item) {
      return item && (String(item.id || '').trim() === value || String(item.name || '').trim() === value);
    });
    return location ? String(location.name || location.id || value).trim() : value;
  }

  function hasKnownLocation(world, reference) {
    var value = String(reference == null ? '' : reference).trim();
    return !!value && (world && Array.isArray(world.locations) ? world.locations : []).some(function (location) {
      return location && (String(location.id || '').trim() === value || String(location.name || '').trim() === value);
    });
  }

  function scheduleSummary(world, slot) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return '安排缺失';
    var parts = [locationName(world, slot.locationId || slot.location), slot.activity, slot.intent, slot.summary || slot.description].filter(function (value) {
      return String(value == null ? '' : value).trim();
    });
    return parts.length ? parts.join(' · ') : '安排缺失';
  }

  function moodLabel(value) {
    return {
      neutral: '平静',
      calm: '平静',
      happy: '愉快',
      tense: '紧张',
      sad: '低落'
    }[value] || value || '未设置';
  }

  function previewStatusLabel(value) {
    return {
      idle: '未生成',
      completed: '已生成',
      fallback: '本地备用'
    }[value] || '已生成';
  }

  function sanitizePreviewError(value) {
    return String(value == null ? '' : value)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/(\b(?:api\s*[_-]?\s*key|authorization)\b\s*["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|api[_-]?key|apikey|key|authorization)=)[^&#\s"'}]+/gi, '$1[REDACTED]')
      .replace(/(\bkey\s*=\s*["']?)[^"',}\s]+/gi, '$1[REDACTED]');
  }

  function recentFacts(world) {
    if (Module4.Facts && typeof Module4.Facts.recentFor === 'function') return Module4.Facts.recentFor(world, 'player', 6).reverse();
    if (Module4.Facts && typeof Module4.Facts.recent === 'function') return Module4.Facts.recent(world, 6).reverse();
    return (Array.isArray(world && world.facts) ? world.facts : []).filter(function (fact) {
      return !fact || (fact.visibility !== 'private' && fact.visibility !== 'restricted');
    }).slice(-6).reverse();
  }

  function recentDailyLogs(world) {
    return (Array.isArray(world && world.dailyLogs) ? world.dailyLogs : []).slice(-3).reverse();
  }

  function recentActionLogs(world) {
    return (Array.isArray(world && world.actionLogs) ? world.actionLogs : []).slice(-12).reverse();
  }

  function recentNarratives(world) {
    return (Array.isArray(world && world.narrativeEntries) ? world.narrativeEntries : []).slice(-8).reverse();
  }

  function currentEncounter(world) {
    if (!Module4.Encounter || typeof Module4.Encounter.checkNatural !== 'function') return null;
    return Module4.Encounter.checkNatural(world);
  }

  function visibleSceneObjects(world) {
    var currentLocation = String(world && world.player && world.player.location || '').trim();
    return (Array.isArray(world && world.sceneObjects) ? world.sceneObjects : []).filter(function (object) {
      if (!object || !String(object.name || '').trim()) return false;
      var location = String(object.locationId || object.location || '').trim();
      var holder = String(object.holderId || object.holder || 'world').trim();
      return (!location || location === currentLocation) && (!holder || holder === 'world' || holder === currentLocation);
    }).slice(0, 5);
  }

  function currentScene(world, location) {
    var player = world && world.player || {};
    var paragraphs = [];
    var playerName = String(player.name || '').trim();
    var playerIdentity = String(player.identity || '').trim();
    if (playerName && playerIdentity) paragraphs.push('你叫' + playerName + '，身份是' + playerIdentity + '。');
    else if (playerName) paragraphs.push('你叫' + playerName + '。');
    else if (playerIdentity) paragraphs.push('你的身份是' + playerIdentity + '。');
    if (location) {
      paragraphs.push('现在是第 ' + Number(world.clock && world.clock.day || 1) + ' 天 · ' + Module4.Clock.periodLabel(world.clock && world.clock.period) + '，你在' + location.name + '。');
      if (String(location.description || '').trim()) paragraphs.push(String(location.description).trim());
    } else {
      paragraphs.push('你还没有确定自己身处哪里。');
    }

    var encounter = currentEncounter(world);
    if (encounter && encounter.found && encounter.npcs && encounter.npcs.length) {
      paragraphs.push('此刻，' + encounter.npcs.map(function (npc) { return npc.name; }).join('、') + '也在这里。你可以走近他们，观察周围，或者直接说出你想做的事。');
    } else if (visibleSceneObjects(world).length) {
      paragraphs.push('附近有' + visibleSceneObjects(world).map(function (object) { return object.name; }).join('、') + '，值得你留意。');
    } else {
      paragraphs.push('眼前暂时没有明确的对话对象。你可以观察这里，前往别处，或者等待事情变化。');
    }
    return paragraphs;
  }

  function sceneMapHtml(world, location, escape) {
    var locations = Array.isArray(world && world.locations) ? world.locations.filter(function (item) {
      return item && String(item.name || item.id || '').trim();
    }).slice(0, 9) : [];
    var currentId = String(location && (location.id || location.name) || '').trim();
    if (!locations.length) {
      return '<div class="module4-scene-map module4-scene-map--empty"><span class="module4-map-label">位置记录</span><strong>尚未建立地点</strong><p>先在世界管理中添加地点，当前位置会出现在这里。</p></div>';
    }
    return [
      '<div class="module4-scene-map">',
      '<div class="module4-map-header"><span class="module4-map-label">世界坐标</span><span>' + escape(locations.length + ' 个地点') + '</span></div>',
      '<div class="module4-map-grid" aria-label="世界地点示意图">',
      locations.map(function (item, index) {
        var itemId = String(item.id || item.name || '').trim();
        var active = itemId === currentId;
        var left = 16 + (index % 3) * 34;
        var top = 20 + Math.floor(index / 3) * 27;
        return '<span class="module4-map-node' + (active ? ' is-current' : '') + '" style="--map-left:' + left + '%;--map-top:' + top + '%"><i aria-hidden="true"></i><b>' + escape(item.name || item.id) + '</b>' + (active ? '<em>现在</em>' : '') + '</span>';
      }).join(''),
      '</div>',
      '<p class="module4-map-note">地图只标记已知地点；真正的路线由你的行动推进。</p>',
      '</div>'
    ].join('');
  }

  function currentSceneHtml(world, location, escape) {
    return [
      '<section class="module4-current-scene module4-scene-document">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">当前场景</span><h2>' + escape(location ? location.name : '未确定的地点') + '</h2></div><span class="module4-count">正在发生</span></div>',
      '<div class="module4-current-scene__layout">',
      sceneMapHtml(world, location, escape),
      '<div class="module4-current-scene__body">',
        currentScene(world, location).map(function (paragraph) { return '<p>' + escape(paragraph) + '</p>'; }).join(''),
      '</div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function actionTime(log) {
    return '第 ' + Number(log && log.day || 1) + ' 天 · ' + Module4.Clock.periodLabel(log && log.period);
  }

  function actionOutcome(world, log) {
    var type = String(log && log.type || '').trim();
    var before = log && log.before || {};
    var after = log && log.after || {};
    var beforeLocation = locationName(world, before.location);
    var afterLocation = locationName(world, after.location);
    if (type === 'move' && afterLocation) {
      return beforeLocation && beforeLocation !== afterLocation
        ? '你从' + beforeLocation + '来到了' + afterLocation + '。'
        : '你现在在' + afterLocation + '。';
    }
    if (type === 'wait') return '你等了一段时间，现在是' + actionTime(Object.assign({}, log, after)) + '。';
    if (type === 'sleep') return '你睡到第二天，精力恢复了。';
    return String(log && log.description || '').trim() || '行动已经完成。';
  }

  function timelineEntries(world) {
    var actionLogs = Array.isArray(world && world.actionLogs) ? world.actionLogs.slice(-12) : [];
    var narratives = Array.isArray(world && world.narrativeEntries) ? world.narrativeEntries.slice(-12) : [];
    var narrativeByAction = {};
    narratives.forEach(function (entry) {
      var actionId = String(entry && entry.actionId || '').trim();
      if (!actionId) return;
      narrativeByAction[actionId] = narrativeByAction[actionId] || [];
      narrativeByAction[actionId].push(entry);
    });
    var entries = [];
    actionLogs.forEach(function (log, index) {
      var actionId = String(log && log.id || '').trim();
      var timestamp = Number(log && log.createdAt) || index;
      entries.push({ kind: 'action', log: log, createdAt: timestamp, order: index * 3 });
      var responses = narrativeByAction[actionId] || [];
      if (responses.length) {
        responses.forEach(function (entry, responseIndex) {
          entries.push({ kind: 'response', log: log, narrative: entry, createdAt: Number(entry.createdAt) || timestamp, order: index * 3 + responseIndex + 1 });
        });
      } else if (String(log && log.type || '').trim() !== 'custom') {
        entries.push({ kind: 'outcome', log: log, createdAt: timestamp, order: index * 3 + 1 });
      }
    });
    narratives.filter(function (entry) { return !String(entry && entry.actionId || '').trim() || !actionLogs.some(function (log) { return String(log && log.id || '').trim() === String(entry.actionId || '').trim(); }); }).forEach(function (entry, index) {
      entries.push({ kind: 'response', narrative: entry, createdAt: Number(entry.createdAt) || index, order: actionLogs.length * 3 + index });
    });
    return entries.sort(function (left, right) {
      return left.createdAt - right.createdAt || left.order - right.order;
    }).slice(-24);
  }

  function timelineHtml(world, escape) {
    var entries = timelineEntries(world);
    if (!entries.length) return '<p class="module4-list-empty">这是故事的开始。读完上面的现场后，告诉世界你准备怎么做。</p>';
    return entries.map(function (entry) {
      var log = entry.log || {};
      var narrative = entry.narrative;
      if (entry.kind === 'action') {
        return '<article class="module4-timeline-entry module4-timeline-entry--action"><div class="module4-timeline-entry__meta"><strong>你</strong><span>' + escape(actionTime(log)) + '</span></div><p>' + escape(log.text || '进行了一项行动。') + '</p></article>';
      }
      if (entry.kind === 'response') {
        var responseLabel = narrative && narrative.npcName ? narrative.npcName : '现场';
        var outcome = log && log.description && log.type !== 'custom' ? '<small>结果：' + escape(actionOutcome(world, log)) + '</small>' : '';
        return '<article class="module4-timeline-entry module4-timeline-entry--response"><div class="module4-timeline-entry__meta"><strong>' + escape(responseLabel) + '</strong><span>' + escape(actionTime(narrative || log)) + '</span></div><p>' + escape(narrative && narrative.text || '现场有了变化。') + '</p>' + outcome + '</article>';
      }
      return '<article class="module4-timeline-entry module4-timeline-entry--response"><div class="module4-timeline-entry__meta"><strong>现场</strong><span>' + escape(actionTime(log)) + '</span></div><p>' + escape(actionOutcome(world, log)) + '</p></article>';
    }).join('');
  }

  function previewSlot(world, item, period) {
    return item && item.schedule && typeof item.schedule === 'object' ? item.schedule[period] : null;
  }

  function previewSlotReady(world, slot) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return false;
    var hasActivity = [slot.activity, slot.intent, slot.summary, slot.description].some(function (value) {
      return String(value == null ? '' : value).trim();
    });
    if (!hasActivity) return false;
    if (!world.locations || !world.locations.length) return true;
    var reference = String(slot.locationId || slot.location || '').trim();
    return hasKnownLocation(world, reference);
  }

  function previewComplete(world, npcs, schedules) {
    if (!npcs.length) return true;
    return npcs.every(function (npc) {
      var item = schedules[npc.id];
      return Module4.Clock.PERIODS.every(function (period) {
        return previewSlotReady(world, previewSlot(world, item, period));
      });
    });
  }

  Module4.UI.PlayView.render = function (container, world, notice, viewOptions) {
    if (!container) return;
    if (!world) {
      container.innerHTML = [
        '<section class="module4-empty module4-empty--inner">',
        '<h1>选择一个世界</h1>',
        '<p>打开左侧世界，或从下方创建新的世界。</p>',
        '</section>'
      ].join('');
      return;
    }
    var escape = Module4.UI.Components.escape;
    var date = Module4.UI.Components.date;
    var freeTextValue = viewOptions && viewOptions.freeTextValue || '';
    var recommendations = Module4.Action.recommended(world).filter(function (action) {
      return ['view_status', 'view_world', 'view_log'].indexOf(action.type) < 0;
    }).slice(0, 3);
    var recommendationHtml = recommendations.map(function (action) {
      var targetNpc = action.targetNpcId || '';
      var targetLocation = action.targetLocationId || '';
      var timing = action.advancesTime ? '推进一个时段' : '不推进时间';
      return [
        '<button class="module4-recommended-action" type="button" data-module4-recommended-action',
        ' data-action-type="' + escape(action.type) + '"',
        ' data-action-npc="' + escape(targetNpc) + '"',
        ' data-action-location="' + escape(targetLocation) + '"',
        ' data-action-text="' + escape(action.text) + '">',
        '<strong>' + escape(action.text) + '</strong>',
        '<span>' + action.energyCost + ' 精力 · ' + timing + '</span>',
        '</button>'
      ].join('');
    }).join('');
    var locations = Module4.Location.list(world);
    var currentLocation = Module4.Location.get(world, world.player.location);
    var locationOptions = locations.map(function (location) {
      return '<option value="' + escape(location.id) + '"' + (location.id === world.player.location ? ' selected' : '') + '>' + escape(location.name) + '</option>';
    }).join('');
    var npcs = Module4.World.listNpcs(world);
    var npcRefs = {};
    npcs.forEach(function (npc) { npcRefs[npc.sourceRef] = true; });
    var sources = Module4.World.listSourceCharacters().filter(function (source) { return !npcRefs[source.sourceRef]; });
    var npcHtml = npcs.length ? npcs.map(function (npc) {
      var schedule = Module4.Clock.PERIODS.map(function (period) {
        return '<li><span>' + escape(Module4.Clock.periodLabel(period)) + '</span><strong>' + escape(scheduleSummary(world, npc.schedule[period])) + '</strong></li>';
      }).join('');
      return [
        '<article class="module4-npc-card">',
        '<div class="module4-npc-card__heading"><h3>' + escape(npc.name) + '</h3><span>Runtime</span></div>',
        '<div class="module4-npc-card__state"><span>心情：' + escape(moodLabel(npc.mood)) + '</span><span>关系：' + escape(npc.relation.stage) + ' · ' + npc.relation.value + '</span></div>',
        '<ul class="module4-npc-card__schedule">' + schedule + '</ul>',
        '</article>'
      ].join('');
    }).join('') : '<p class="module4-list-empty">当前世界还没有 NPC Runtime。</p>';
    var sourceForm = sources.length ? [
      '<form class="module4-npc-source-form" data-module4-npc-source-form>',
      '<label>从现有角色资料加入<select name="sourceRef" aria-label="选择角色资料">',
      sources.map(function (source) { return '<option value="' + escape(source.sourceRef) + '">' + escape(source.name) + '</option>'; }).join(''),
      '</select></label>',
      '<button class="btn btn-secondary" type="submit">加入当前世界</button>',
      '</form>'
    ].join('') : '<p class="module4-detail-note">' + (npcs.length ? '可用角色资料已全部加入当前世界。' : '尚未找到现有角色卡；请先在叙界创建或导入角色资料。') + '</p>';
    var locationPanel = locations.length ? [
      '<form class="module4-location-move-form" data-module4-move-form>',
      '<label>移动到<select name="locationId" aria-label="选择移动地点">' + locationOptions + '</select></label>',
      '<button class="btn btn-secondary" type="submit">移动</button>',
      '</form>',
      npcs.length ? [
        '<form class="module4-location-seek-form" data-module4-seek-form>',
        '<label>主动寻找<select name="npcId" aria-label="选择寻找的 NPC">',
        npcs.map(function (npc) { return '<option value="' + escape(npc.id) + '">' + escape(npc.name) + '</option>'; }).join(''),
        '</select></label>',
        '<button class="btn btn-secondary" type="submit">寻找 NPC</button>',
        '</form>'
      ].join('') : ''
    ].join('') : '<p class="module4-detail-note">当前世界还没有地点；创建世界时可按行添加地点。</p>';
    var currentDay = world.currentDay || {};
    var previewDayMatches = currentDay.previewGenerated === true && Number(currentDay.day) === Number(world.clock.day);
    var previewSchedules = currentDay.schedules && typeof currentDay.schedules === 'object' && !Array.isArray(currentDay.schedules)
      && previewDayMatches ? currentDay.schedules
      : {};
    var previewReady = previewDayMatches && Module4.AI && Module4.AI.Preview
      && typeof Module4.AI.Preview.isCurrentDayValid === 'function'
      ? Module4.AI.Preview.isCurrentDayValid(world)
      : previewDayMatches && previewComplete(world, npcs, previewSchedules);
    var previewNpcs = npcs.map(function (npc) { return previewSchedules[npc.id] || { npcId: npc.id }; });
    var previewHtml = previewNpcs.length ? previewNpcs.map(function (item) {
      var npc = npcs.find(function (candidate) { return candidate.id === item.npcId; });
      var schedule = Module4.Clock.PERIODS.map(function (period) {
        var slot = item.schedule && item.schedule[period];
        var missingClass = previewSlotReady(world, slot) ? '' : ' module4-schedule-missing';
        return '<li class="' + missingClass.trim() + '"><span>' + escape(Module4.Clock.periodLabel(period)) + '</span><strong>' + escape(scheduleSummary(world, slot)) + '</strong></li>';
      }).join('');
      return [
        '<article class="module4-preview-card">',
        '<div class="module4-preview-card__heading"><h3>' + escape(npc ? npc.name : item.npcId) + '</h3><span>' + escape(moodLabel(item.mood)) + '</span></div>',
        '<p>目标：' + escape(item.goal) + '</p>',
        '<ul class="module4-npc-card__schedule">' + schedule + '</ul>',
        '</article>'
      ].join('');
    }).join('') : '<p class="module4-list-empty">今天还没有生成 NPC 日程骨架。</p>';
    var previewAction = previewReady ? '<p class="module4-detail-note">今日安排已保存；重新进入或刷新不会重复调用模型。</p>' : [
      '<form class="module4-preview-form" data-module4-preview-form>',
      '<p>' + (previewDayMatches && currentDay.previewGenerated ? '今日安排不完整，请重新生成。' : '生成三段短日程和世界事件骨架，不生成对白或长篇剧情。') + '</p>',
      '<button class="btn btn-secondary" type="submit">生成今日预演</button>',
      '</form>'
    ].join('');
    var previewErrorText = sanitizePreviewError(currentDay.previewError);
    var previewError = currentDay.previewStatus === 'fallback' && previewErrorText.trim()
      ? '<p class="module4-detail-note">预演失败原因：' + escape(previewErrorText) + '</p>'
      : '';
    var facts = recentFacts(world);
    var dailyLogs = recentDailyLogs(world);
    var timeline = timelineHtml(world, escape);
    var timelineCount = timelineEntries(world).length;
    var factsHtml = facts.length ? facts.map(function (fact) {
      var period = Module4.Clock.periodLabel(fact.period);
      return '<li><span>第 ' + escape(fact.day) + ' 天' + escape(period) + '</span><strong>' + escape(fact.summary) + '</strong></li>';
    }).join('') : '<p class="module4-list-empty">尚无关键事实。</p>';
    var dailyLogsHtml = dailyLogs.length ? dailyLogs.map(function (log) {
      return '<li><span>第 ' + escape(log.day) + ' 天</span><strong>' + escape(log.summary) + '</strong></li>';
    }).join('') : '<p class="module4-list-empty">当天结束后会在这里留下简短记录。</p>';
    var noticeHtml = notice ? '<p class="module4-action-notice" aria-live="polite">' + escape(notice) + '</p>' : '';
    var managementOpen = !!(viewOptions && viewOptions.managementOpen);
    var managementDetails = managementOpen ? [
      '<details class="module4-secondary-panel">',
      '<summary>世界资料 <span>身份与背景</span></summary>',
      '<section class="module4-profile-panel">',
      '<dl class="module4-meta-grid">',
      '<div><dt>玩家</dt><dd>' + escape(world.player.name || '未命名') + '</dd></div>',
      '<div><dt>身份</dt><dd>' + escape(world.player.identity || '尚未填写') + '</dd></div>',
      '<div><dt>创建时间</dt><dd>' + escape(date(world.createdAt)) + '</dd></div>',
      '<div><dt>最近保存</dt><dd>' + escape(date(world.updatedAt)) + '</dd></div>',
      '</dl>',
      '</section>',
      '</details>',
      '<details class="module4-secondary-panel">',
      '<summary>地点与相遇 <span>' + locations.length + ' 个地点</span></summary>',
      '<section class="module4-location-panel">',
      '<p class="module4-npc-panel__note">需要明确移动或寻找时，可以使用这里的工具；也可以直接在下方描述行动。</p>',
      locationPanel,
      '</section>',
      '</details>',
      '<details class="module4-secondary-panel">',
      '<summary>人物状态与日程 <span>' + npcs.length + ' 人</span></summary>',
      '<section class="module4-npc-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">当前世界状态</span><h2>NPC Runtime</h2></div><span class="module4-count">' + npcs.length + '</span></div>',
      '<p class="module4-npc-panel__note">角色卡是来源资料；这里仅保存本世界的心情、关系、目标、临时状态和日程骨架。</p>',
      '<div class="module4-npc-list">' + npcHtml + '</div>',
      sourceForm,
      '</section>',
      '</details>',
      '<details class="module4-secondary-panel">',
      '<summary>今日预演 <span>' + escape(previewDayMatches ? (previewReady ? previewStatusLabel(currentDay.previewStatus) : '预演不完整') : '未生成') + '</span></summary>',
      '<section class="module4-preview-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">Day ' + world.clock.day + '</span><h2>今日预演</h2></div><span class="module4-count">' + escape(previewDayMatches ? (previewReady ? previewStatusLabel(currentDay.previewStatus) : '预演不完整') : '未生成') + '</span></div>',
      '<p class="module4-npc-panel__note">这些安排只属于当前世界。</p>',
      '<div class="module4-preview-list">' + previewHtml + '</div>',
      previewAction,
      previewError,
      '</section>',
      '</details>',
      '<details class="module4-secondary-panel">',
      '<summary>世界轨迹 <span>' + facts.length + ' 条事实</span></summary>',
      '<section class="module4-history-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">世界轨迹</span><h2>Facts 与每日记录</h2></div><span class="module4-count">' + facts.length + ' 条事实</span></div>',
      '<p class="module4-npc-panel__note">Facts 会进入后续预演；每日记录只保留当天的简短回顾。</p>',
      '<div class="module4-history-grid"><div><h3>最近 Facts</h3><ul class="module4-history-list">' + factsHtml + '</ul></div><div><h3>每日记录</h3><ul class="module4-history-list">' + dailyLogsHtml + '</ul></div></div>',
      '</section>',
      '</details>',
      '<details class="module4-debug-panel">',
      '<summary>试玩检查</summary>',
      '<div class="module4-debug-panel__body">',
      '<p class="module4-debug-panel__note">用于确认每天的 NPC 安排和玩家行动结果；不影响正常游玩。</p>',
      '<div class="module4-debug-state"><span>预演</span><strong>' + escape(previewReady ? previewStatusLabel(currentDay.previewStatus) : (previewDayMatches && currentDay.previewGenerated ? '预演不完整' : '未生成')) + '</strong><span>第 ' + escape(world.clock.day) + ' 天 · ' + escape(Module4.Clock.periodLabel(world.clock.period)) + ' · ' + escape(currentLocation ? currentLocation.name : '未选择') + ' · 精力 ' + escape(world.player.energy + ' / ' + world.player.maxEnergy) + '</span></div>',
      '<div class="module4-debug-schedules">',
      previewNpcs.map(function (item) {
        var npc = npcs.find(function (candidate) { return candidate.id === item.npcId; });
        return '<article><h3>' + escape(npc ? npc.name : item.npcId) + '</h3><ul>' + Module4.Clock.PERIODS.map(function (period) {
          var slot = item.schedule && item.schedule[period];
          var missingClass = previewSlotReady(world, slot) ? '' : ' class="module4-schedule-missing"';
          return '<li' + missingClass + '><span>' + escape(Module4.Clock.periodLabel(period)) + '</span><strong>' + escape(scheduleSummary(world, slot)) + '</strong></li>';
        }).join('') + '</ul></article>';
      }).join('') +
      '</div>',
      '<h3 class="module4-debug-panel__subheading">玩家行动</h3>',
      '<ul class="module4-debug-actions">' + (recentActionLogs(world).length ? recentActionLogs(world).map(function (log) {
        return '<li><span>第 ' + escape(log.day) + ' 天' + escape(Module4.Clock.periodLabel(log.period)) + ' · ' + escape(log.type) + '</span><strong>' + escape(log.description) + '</strong></li>';
      }).join('') : '<li class="module4-list-empty">还没有主要行动记录。</li>') + '</ul>',
      '</div>',
      '</details>'
    ].join('') : '';
    container.innerHTML = [
      '<section class="module4-world-detail module4-story-page">',
      '<div class="module4-world-detail__heading"><div><span class="module4-kicker">当前世界</span><h1>' + escape(world.title) + '</h1></div><span class="module4-saved-state">已保存</span></div>',
      '<div class="module4-clock-summary"><span>第 ' + world.clock.day + ' 天</span><span>' + escape(Module4.Clock.periodLabel(world.clock.period)) + '</span><span>当前位置：' + escape(currentLocation ? currentLocation.name : '未选择') + '</span><span>精力 ' + world.player.energy + ' / ' + world.player.maxEnergy + '</span></div>',
      '<p class="module4-world-detail__description"><span class="module4-description-mark" aria-hidden="true">✦</span>' + escape(world.description || '尚未填写世界说明') + '</p>',
      currentSceneHtml(world, currentLocation, escape),
      '<section class="module4-narrative-panel module4-story-log">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">世界记录</span><h2>刚刚发生</h2></div><span class="module4-count">' + timelineCount + ' 段</span></div>',
      '<div class="module4-timeline">' + timeline + '</div>',
      '</section>',
      '<section class="module4-main-action module4-action-dock" data-module4-action-form>',
      '<div><span class="module4-kicker">继续写下去</span><h2>接下来，你做什么？</h2></div>',
      '<p>直接写下你的行动、观察或对话。世界会把它接成下一段记录。</p>',
      '<div class="module4-recommended-actions">' + (recommendationHtml || '<p class="module4-list-empty">当前没有可推荐行动。</p>') + '</div>',
      '<form class="module4-free-input-form" data-module4-free-input-form>',
      '<label>行动<input name="freeText" type="text" maxlength="240" value="' + escape(freeTextValue) + '" placeholder="例如：我走到林雨旁边，问她今天是不是出了什么事" autocomplete="off"></label>',
      '<button class="btn btn-primary" type="submit">行动</button>',
      '</form>',
      '<div class="module4-action-progress" data-module4-action-progress role="status" aria-live="polite" hidden>',
      '<span class="module4-pending-spinner" aria-hidden="true"></span>',
      '<span data-module4-action-progress-text>世界正在生成下一段，请稍候。</span>',
      '</div>',
      noticeHtml,
      '</section>',
      managementDetails,
      '<p class="module4-detail-note">新的一天会自动准备新的安排；世界只会随玩家行动推进。</p>',
      '</section>'
    ].join('');
  };

  function persistResult(result) {
    if (!result || !result.ok || !result.changed) return result;
    var saved = Module4.State.Store.saveWorld(result.world);
    if (!saved) {
      return {
        ok: false,
        changed: false,
        reason: 'stale-world',
        world: Module4.State.Store.getCurrentWorld(),
        message: '世界刚刚有新变化，本次行动未覆盖新状态；请重试。'
      };
    }
    result.world = saved;
    return result;
  }

  function executeAction(action, onResult) {
    var current = Module4.State.Store.getCurrentWorld();
    var normalized = Module4.Action.normalize(action);
    if (Module4.AI && Module4.AI.Interaction && typeof Module4.AI.Interaction.start === 'function'
      && Module4.UI.PlayView.isNarrativeAction(normalized)) {
      Module4.AI.Interaction.start(current, action).then(function (result) {
        if (result.ok && result.changed) result = persistResult(result);
        if (typeof onResult === 'function') onResult(result);
      });
      return;
    }
    var result = Module4.Action.execute(current, action);
    result = persistResult(result);
    if (typeof onResult === 'function') onResult(result);
  }

  function setActionPending(node, pending) {
    var region = node && typeof node.matches === 'function' && node.matches('[data-module4-action-form]')
      ? node
      : node && typeof node.closest === 'function' ? node.closest('[data-module4-action-form]') : null;
    if (!region) return;
    if (region._module4PendingTimer && typeof root.clearTimeout === 'function') {
      root.clearTimeout(region._module4PendingTimer);
      region._module4PendingTimer = null;
    }
    region.classList.toggle('is-pending', !!pending);
    if (pending) {
      region.dataset.pending = 'true';
      region.setAttribute('aria-busy', 'true');
    } else {
      delete region.dataset.pending;
      region.removeAttribute('aria-busy');
    }
    Array.prototype.forEach.call(region.querySelectorAll('button, input'), function (control) {
      control.disabled = !!pending;
    });
    var submitButton = region.querySelector('.module4-free-input-form button[type="submit"]');
    if (submitButton) submitButton.textContent = pending ? '生成中…' : '行动';
    var progress = region.querySelector('[data-module4-action-progress]');
    if (!progress) return;
    progress.hidden = !pending;
    var progressText = progress.querySelector('[data-module4-action-progress-text]');
    if (progressText) progressText.textContent = '世界正在生成下一段，请稍候。';
    if (pending && progressText && typeof root.setTimeout === 'function') {
      region._module4PendingTimer = root.setTimeout(function () {
        progressText.textContent = '仍在生成，请不要重复提交。';
        region._module4PendingTimer = null;
      }, 8000);
    }
  }

  Module4.UI.PlayView.setActionPending = setActionPending;

  Module4.UI.PlayView.isNarrativeAction = function (action) {
    var type = String(action && action.type || '').trim();
    return ['view_status', 'view_world', 'view_log', 'unsupported'].indexOf(type) < 0;
  };

  Module4.UI.PlayView.bindAction = function (container, onResult) {
    if (!container || container.dataset.bound === 'true') return;
    container.addEventListener('click', function (event) {
      var button = event.target.closest('[data-module4-recommended-action]');
      if (!button || container.dataset.pending === 'true') return;
      setActionPending(container, true);
      executeAction({
        type: button.dataset.actionType,
        targetNpcId: button.dataset.actionNpc || null,
        targetLocationId: button.dataset.actionLocation || null,
        text: button.dataset.actionText || button.textContent,
        source: 'recommended'
      }, function (result) {
        setActionPending(container, false);
        if (typeof onResult === 'function') onResult(result);
      });
    });
    container.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindFreeInput = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var region = typeof form.closest === 'function' ? form.closest('[data-module4-action-form]') : null;
      if (region && region.dataset.pending === 'true') return;
      var input = form.querySelector('[name="freeText"]');
      var submittedText = input && input.value || '';
      setActionPending(form, true);
      executeAction(submittedText, function (result) {
        setActionPending(form, false);
        if (result && result.ok && input) input.value = '';
        var nextResult = result;
        if (result && !result.ok && submittedText.trim()) {
          nextResult = Object.assign({}, result, { retryText: submittedText });
        }
        if (typeof onResult === 'function') onResult(nextResult);
      });
    });
    form.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindNpc = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var select = form.querySelector('[name="sourceRef"]');
      var result = Module4.World.addNpcFromSource(Module4.State.Store.getCurrentWorld(), select && select.value);
      if (result.ok && result.changed) Module4.State.Store.saveWorld(result.world);
      if (typeof onResult === 'function') onResult(result);
    });
    form.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindMove = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var select = form.querySelector('[name="locationId"]');
      executeAction({
        type: 'move',
        targetLocationId: select && select.value,
        text: '移动到' + (select && select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : ''),
        source: 'recommended'
      }, onResult);
    });
    form.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindSeek = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var select = form.querySelector('[name="npcId"]');
      executeAction({
        type: 'seek',
        targetNpcId: select && select.value,
        text: '寻找 NPC',
        source: 'recommended'
      }, onResult);
    });
    form.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindPreview = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = form.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = true;
        button.textContent = '生成中…';
      }
      try {
        var result = await Module4.AI.Preview.startDay(Module4.State.Store.getCurrentWorld());
        if (result.ok && result.changed) Module4.State.Store.saveWorld(result.world);
        if (typeof onResult === 'function') onResult(result);
      } catch (error) {
        if (typeof onResult === 'function') onResult({ ok: false, changed: false, message: '今日预演失败，请稍后重试。' });
      }
    });
    form.dataset.bound = 'true';
  };
}(window));
