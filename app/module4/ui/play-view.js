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
    if (Module4.Facts && typeof Module4.Facts.recent === 'function') return Module4.Facts.recent(world, 6).reverse();
    return (Array.isArray(world && world.facts) ? world.facts : []).slice(-6).reverse();
  }

  function recentDailyLogs(world) {
    return (Array.isArray(world && world.dailyLogs) ? world.dailyLogs : []).slice(-3).reverse();
  }

  function recentActionLogs(world) {
    return (Array.isArray(world && world.actionLogs) ? world.actionLogs : []).slice(-12).reverse();
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

  Module4.UI.PlayView.render = function (container, world, notice) {
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
    var recommendations = Module4.Action.recommended(world);
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
    var factsHtml = facts.length ? facts.map(function (fact) {
      var period = Module4.Clock.periodLabel(fact.period);
      return '<li><span>第 ' + escape(fact.day) + ' 天' + escape(period) + '</span><strong>' + escape(fact.summary) + '</strong></li>';
    }).join('') : '<p class="module4-list-empty">尚无关键事实。</p>';
    var dailyLogsHtml = dailyLogs.length ? dailyLogs.map(function (log) {
      return '<li><span>第 ' + escape(log.day) + ' 天</span><strong>' + escape(log.summary) + '</strong></li>';
    }).join('') : '<p class="module4-list-empty">当天结束后会在这里留下简短记录。</p>';
    var noticeHtml = notice ? '<p class="module4-action-notice" aria-live="polite">' + escape(notice) + '</p>' : '';
    container.innerHTML = [
      '<section class="module4-world-detail">',
      '<div class="module4-world-detail__heading"><div><span class="module4-kicker">当前世界</span><h1>' + escape(world.title) + '</h1></div><span class="module4-saved-state">已保存</span></div>',
      '<div class="module4-clock-summary"><span>第 ' + world.clock.day + ' 天</span><span>' + escape(Module4.Clock.periodLabel(world.clock.period)) + '</span><span>当前位置：' + escape(currentLocation ? currentLocation.name : '未选择') + '</span><span>精力 ' + world.player.energy + ' / ' + world.player.maxEnergy + '</span></div>',
      '<p class="module4-world-detail__description">' + escape(world.description || '尚未填写世界说明') + '</p>',
      '<dl class="module4-meta-grid">',
      '<div><dt>玩家</dt><dd>' + escape(world.player.name || '未命名') + '</dd></div>',
      '<div><dt>身份</dt><dd>' + escape(world.player.identity || '尚未填写') + '</dd></div>',
      '<div><dt>创建时间</dt><dd>' + escape(date(world.createdAt)) + '</dd></div>',
      '<div><dt>最近保存</dt><dd>' + escape(date(world.updatedAt)) + '</dd></div>',
      '</dl>',
      '<section class="module4-location-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">探索</span><h2>地点与相遇</h2></div><span class="module4-count">' + locations.length + ' 个地点</span></div>',
      '<p class="module4-npc-panel__note">所有玩家行动统一经过 Action 管线；移动会消耗精力并推进一个时段，相遇严格读取当时有效日程。</p>',
      locationPanel,
      '</section>',
      '<section class="module4-npc-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">当前世界状态</span><h2>NPC Runtime</h2></div><span class="module4-count">' + npcs.length + '</span></div>',
      '<p class="module4-npc-panel__note">角色卡是来源资料；这里仅保存本世界的心情、关系、目标、临时状态和日程骨架。</p>',
      '<div class="module4-npc-list">' + npcHtml + '</div>',
      sourceForm,
      '</section>',
      '<section class="module4-preview-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">Day ' + world.clock.day + '</span><h2>今日预演</h2></div><span class="module4-count">' + escape(previewDayMatches ? (previewReady ? previewStatusLabel(currentDay.previewStatus) : '预演不完整') : '未生成') + '</span></div>',
      '<p class="module4-npc-panel__note">这些安排只属于当前世界。</p>',
      '<div class="module4-preview-list">' + previewHtml + '</div>',
      previewAction,
      previewError,
      '</section>',
      '<section class="module4-history-panel">',
      '<div class="module4-section-heading"><div><span class="module4-kicker">世界轨迹</span><h2>Facts 与每日记录</h2></div><span class="module4-count">' + facts.length + ' 条事实</span></div>',
      '<p class="module4-npc-panel__note">Facts 会进入后续预演；每日记录只保留当天的简短回顾。</p>',
      '<div class="module4-history-grid"><div><h3>最近 Facts</h3><ul class="module4-history-list">' + factsHtml + '</ul></div><div><h3>每日记录</h3><ul class="module4-history-list">' + dailyLogsHtml + '</ul></div></div>',
      '</section>',
      '<section class="module4-main-action" data-module4-action-form>',
      '<div><span class="module4-kicker">主要行动</span><h2>推进这一段时间</h2></div>',
      '<p>推荐行动和自由输入都会进入同一执行管线；查看信息不会推进时间。</p>',
      '<div class="module4-recommended-actions">' + (recommendationHtml || '<p class="module4-list-empty">当前没有可推荐行动。</p>') + '</div>',
      '<form class="module4-free-input-form" data-module4-free-input-form>',
      '<label>自由输入<input name="freeText" type="text" maxlength="240" placeholder="例如：邀请艾琳下午去公园" autocomplete="off"></label>',
      '<button class="btn btn-primary" type="submit">执行输入</button>',
      '</form>',
      noticeHtml,
      '</section>',
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
      '</details>',
      '<p class="module4-detail-note">下一天从“生成今日预演”开始，不会在结算时自动调用模型。</p>',
      '</section>'
    ].join('');
  };

  function executeAction(action, onResult) {
    var result = Module4.Action.execute(Module4.State.Store.getCurrentWorld(), action);
    if (result.ok && result.changed) Module4.State.Store.saveWorld(result.world);
    if (typeof onResult === 'function') onResult(result);
  }

  Module4.UI.PlayView.bindAction = function (container, onResult) {
    if (!container || container.dataset.bound === 'true') return;
    container.addEventListener('click', function (event) {
      var button = event.target.closest('[data-module4-recommended-action]');
      if (!button) return;
      executeAction({
        type: button.dataset.actionType,
        targetNpcId: button.dataset.actionNpc || null,
        targetLocationId: button.dataset.actionLocation || null,
        text: button.dataset.actionText || button.textContent,
        source: 'recommended'
      }, onResult);
    });
    container.dataset.bound = 'true';
  };

  Module4.UI.PlayView.bindFreeInput = function (form, onResult) {
    if (!form || form.dataset.bound === 'true') return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.querySelector('[name="freeText"]');
      executeAction(input && input.value, onResult);
      if (input) input.value = '';
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
