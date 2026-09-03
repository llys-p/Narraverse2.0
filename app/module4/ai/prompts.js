/* Module 4 Task 4: compact Daily Preview prompt, independent from Module 3 protocol. */
(function (root) {
  var Module4 = root.Module4 = root.Module4 || {};
  Module4.AI = Module4.AI || {};
  Module4.AI.Prompts = Module4.AI.Prompts || {};

  var Prompts = Module4.AI.Prompts;
  var PERIODS = ['morning', 'afternoon', 'evening'];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function shortText(value, maxLength) {
    return text(value).slice(0, maxLength || 240);
  }

  function worldInput(world) {
    var result = {
      title: shortText(world && world.title, 120),
      description: shortText(world && world.description, 600)
    };
    if (world && Array.isArray(world.locations) && world.locations.length) {
      result.locations = world.locations.slice(0, 20).map(function (location) {
        if (!location || typeof location !== 'object') return { name: shortText(location, 120) };
        return {
          id: shortText(location.id, 80),
          name: shortText(location.name || location.title, 120),
          description: shortText(location.description, 180)
        };
      });
    }
    return result;
  }

  function runtimeInput(npc) {
    return {
      npcId: npc.id,
      name: npc.name,
      mood: npc.mood,
      relation: clone(npc.relation),
      goals: clone(npc.goals),
      schedule: clone(npc.schedule)
    };
  }

  function recentFactsInput(world) {
    if (Module4.Facts && typeof Module4.Facts.recent === 'function') {
      return Module4.Facts.recent(world, 12).map(function (fact) {
        return {
          day: fact.day,
          period: fact.period,
          type: fact.type,
          actors: clone(fact.actors),
          summary: shortText(fact.summary, 240)
        };
      });
    }
    return (world && Array.isArray(world.facts) ? world.facts : []).slice(-12).map(function (fact) {
      return {
        day: fact.day,
        period: fact.period,
        type: fact.type,
        actors: clone(fact.actors),
        summary: shortText(fact.summary, 240)
      };
    });
  }

  Prompts.buildDailyPreviewMessages = function (world) {
    var npcs = Module4.World.listNpcs(world);
    var boundNpcs = npcs.map(function (npc) {
      return {
        npcId: npc.id,
        sourceRef: npc.sourceRef,
        sourceVersion: (Module4.World.getNpcSourceBinding(world, npc.sourceRef) || {}).sourceVersion || npc.sourceRef,
        sourceSnapshot: Module4.World.getNpcSourceSnapshot(world, npc.sourceRef) || { name: npc.name },
        runtime: runtimeInput(npc)
      };
    });
    var input = {
      day: world && world.clock ? world.clock.day : 1,
      periods: PERIODS,
      world: worldInput(world),
      recentFacts: recentFactsInput(world),
      npcs: boundNpcs
    };
    return [
      {
        role: 'system',
        content: [
          '你是模块四开放沙盒文字 RPG 的 Daily Preview 生成器。',
          '最终只输出严格 JSON，不要 Markdown、解释、代码块、对白、长篇剧情或任何额外文本。',
          '必须为输入中的每一个 NPC 且只为每一个 NPC 返回一个对应项。',
          '每个 NPC 项必须包含 npcId、非空短字符串 mood、非空短字符串 goal 和 schedule。',
          'schedule 必须完整包含 morning、afternoon、evening；三者的值都必须是 JSON 对象，不能缺省、不能为 null、不能是字符串。',
          'npcId 必须严格复用输入中的原始 npcId，不得修改、新增或复制示例中的占位值。',
          '没有世界事件时必须输出 worldEvents 数组 []。',
          '输出结构示例（仅说明字段，npcId 必须替换为输入中的对应原始值）：{"npcs":[{"npcId":"输入中的原始 npcId","mood":"平静","goal":"今天要完成的短目标","schedule":{"morning":{},"afternoon":{},"evening":{}}}],"worldEvents":[]}',
          '为输入中的每个 NPC 生成当天 morning、afternoon、evening 三段短日程骨架。',
          '只能使用输入中的 npcId，不得新增角色；每段 schedule 必须是对象。',
          'recentFacts 是已发生的关键事实，需保持一致但不要复述成长篇剧情。',
          'goal 是短目标，worldEvents 是简短结构化事件数组。'
        ].join('')
      },
      {
        role: 'user',
        content: JSON.stringify(input)
      }
    ];
  };

  Prompts.dailyPreviewPeriods = PERIODS.slice();
}(window));
