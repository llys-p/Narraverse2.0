/* =========================================================
 * 文字 → 火柴人动作 推断引擎（离线规则优先，零 API 调用）
 * 目标：把任意中文/英文叙事句子映射成「大致动作」，可解释、可扩展、可编排成序列。
 * 用法：
 *   StickmanActions.infer('他拔剑冲向敌人')            → {action:'charge', prop:'sword', ...}
 *   StickmanActions.sequence('他推开门，抽剑砍向守卫。') → [{action:'open'},{action:'attack'}...]
 *   StickmanActions.explain(text)                       → 命中说明（UI 上标来源）
 * 设计约束：
 * - 规则带权重与优先级，命中越多/越具体者胜出；否定前缀（没有/并未/不敢）会把该动作降权
 * - 任何模块可 register() 追加自己的领域词表，不改动内核
 * - 从不抛异常：无命中时回落 idle，并给出 source:'none'
 * ========================================================= */
window.StickmanActions = (function () {
  'use strict';

  /* ---------------- 动作元数据（UI 分组与中文名） ---------------- */
  var META = {
    idle: { zh: '待机', group: '站立' },
    breathe: { zh: '呼吸', group: '站立' },
    think: { zh: '思考', group: '站立' },
    listen: { zh: '倾听', group: '站立' },
    pray: { zh: '祈祷', group: '站立' },
    shrug: { zh: '耸肩', group: '社交' },
    walk: { zh: '行走', group: '移动' },
    run: { zh: '奔跑', group: '移动' },
    sneak: { zh: '潜行', group: '移动' },
    climb: { zh: '攀爬', group: '移动' },
    swim: { zh: '游泳', group: '移动' },
    jump: { zh: '跳跃', group: '移动' },
    land: { zh: '落地', group: '移动' },
    push: { zh: '推', group: '操作' },
    carry: { zh: '搬运', group: '操作' },
    dig: { zh: '挖掘', group: '操作' },
    throw: { zh: '投掷', group: '操作' },
    attack: { zh: '挥砍', group: '战斗' },
    thrust: { zh: '突刺', group: '战斗' },
    shoot: { zh: '射击', group: '战斗' },
    block: { zh: '格挡', group: '战斗' },
    guard: { zh: '戒备', group: '战斗' },
    charge: { zh: '蓄力', group: '战斗' },
    dodge: { zh: '闪避', group: '战斗' },
    hit: { zh: '受击', group: '战斗' },
    fall: { zh: '倒地', group: '状态' },
    knockdown: { zh: '击倒', group: '状态' },
    getup: { zh: '起身', group: '状态' },
    sleep: { zh: '睡卧', group: '状态' },
    sit: { zh: '坐下', group: '状态' },
    kneel: { zh: '跪下', group: '状态' },
    stretch: { zh: '伸展', group: '状态' },
    cast: { zh: '施法', group: '法术' },
    heal: { zh: '治疗', group: '法术' },
    victory: { zh: '胜利', group: '社交' },
    win: { zh: '欢呼', group: '社交' },
    cheer: { zh: '喝彩', group: '社交' },
    talk: { zh: '交谈', group: '社交' },
    wave: { zh: '招手', group: '社交' },
    point: { zh: '指向', group: '社交' },
    bow: { zh: '鞠躬', group: '社交' },
    cry: { zh: '悲泣', group: '社交' },
    search: { zh: '搜寻', group: '操作' },
    read: { zh: '阅读', group: '操作' },
    write: { zh: '书写', group: '操作' },
    drink: { zh: '饮用', group: '操作' },
    open: { zh: '开启', group: '操作' },
    pick: { zh: '撬锁', group: '操作' },
    craft: { zh: '锻造', group: '操作' },
    custom: { zh: '自定义', group: '站立' },
  };

  /* ---------------- 规则表（越靠前、权重越高者优先；同分看具体度） ---------------- */
  /* 字段：a=动作，re=匹配，w=权重，p=建议道具，stop=命中即可直接采纳 */
  var RULES = [
    /* 状态类要优先：倒地/死亡/昏迷不能被后面的攻击词覆盖 */
    { a: 'knockdown', w: 92, re: /击倒|打倒|扑倒|撞倒|掀倒|撂倒|放倒|撂在|砸倒|绊倒|摔倒|跌倒在|倒在地上|趴在地上|被掀翻/ },
    { a: 'fall', w: 90, re: /倒下|倒地|跌倒|坠落|跌落|栽倒|失去知觉|昏|晕|不省人事|死亡|殒命|毙命|咽气|牺牲|坠地|跌进/ },
    { a: 'getup', w: 88, re: /爬起来|撑起身|挣扎着起|站起身|爬起|起身|站起|重新站/ },
    { a: 'sleep', w: 86, re: /睡着|入睡|沉睡|熟睡|酣睡|躺下睡|和衣而卧|睡去|躺下/ },
    { a: 'dodge', w: 84, re: /翻滚|闪开|闪避|躲开|避开|侧身让|侧身一闪|脱身|向后一跃|堪堪躲|闪过/ },
    { a: 'hit', w: 82, re: /被.*击中|被.*打中|挨了|受了伤|中拳|中箭|被掀|被甩|剧痛|闷哼|吐血|负伤|被打飞|挨了一/ },

    /* 战斗 */
    { a: 'charge', w: 80, re: /蓄力|蓄势|沉肩|握紧.*剑|拔剑|拔出|抽出|亮出兵器|举起.*刀|凝神聚|拉满|上了弦|握刀|持刀|举刀/ },
    { a: 'shoot', w: 79, re: /射箭|放箭|一箭|弯弓|搭箭|射击|开枪|扣动扳机|投石索|弩|弓弦/ },
    { a: 'block', w: 77, re: /格挡|挡住|架住|招架|举盾|挡下|硬接|架开|挡开|用刀背挡/ },
    { a: 'guard', w: 72, re: /戒备|严阵|不敢动|蓄势以待|防御姿态|不敢上前|对峙|屏息以待/ },
    { a: 'thrust', w: 74, re: /刺|突刺|戳|扎|捅|直刺|一剑穿|穿胸/ },
    { a: 'attack', w: 70, re: /砍|劈|斩|挥|攻击|进攻|搏斗|厮杀|击杀|强攻|砸|一拳|踢|扑上去|开战|出手|撕咬|一击|战斗|冲上来|抡起/ },
    { a: 'throw', w: 68, re: /扔|掷|投出|抛出|甩出|丢出/ },

    /* 法术 */
    { a: 'heal', w: 76, re: /治疗|治愈|上药|包扎|护体|恢复术|圣光|缝合伤口|施救|敷药|止血/ },
    { a: 'cast', w: 74, re: /施法|念咒|咒语|吟唱|法术|符文|法阵|召唤|元素|魔力|灵气|指尖.*光|光芒|释放.*术|结印|咏唱/ },
    { a: 'pray', w: 70, re: /祈祷|祷告|跪拜|膜拜|向上天|祈求|阿门|诵经|念了句佛/ },

    /* 移动 */
    { a: 'sneak', w: 73, re: /潜行|蹑手蹑脚|悄悄|压低身子|猫着腰|屏住呼吸|摸黑|悄无声息|贴着墙|放轻脚步/ },
    { a: 'climb', w: 72, re: /攀爬|攀登|爬上|翻上|攀着|顺着.*爬|攀住|翻过墙|爬上去/ },
    { a: 'swim', w: 72, re: /游泳|游去|游过|游向|游了游|潜入水|下水|划水|凫水|泅|泡在|跳入河|跳入湖/ },
    { a: 'jump', w: 70, re: /跳起|跳跃|纵身|腾身|一跃|蹦|翻越|跳过|腾空|跃下|跃过|跳下/ },
    { a: 'land', w: 69, re: /落地|落回|双脚着地|稳稳落下|坠落在|摔落/ },
    { a: 'run', w: 64, re: /跑|奔|冲刺|飞奔|疾驰|逃|追|狂奔|拔腿|飞跑|escape|sprint|run\b|flee|chase/i },
    { a: 'walk', w: 50, re: /走|踱步|迈步|前行|漫步|散步|走近|离开|走过|步行|walk|stroll/i },

    /* 操作 */
    { a: 'search', w: 66, re: /搜索|搜查|翻找|搜寻|翻检|检视|查看|调查|打量|细看|摸索|寻找|四处找|scaveng/i },
    { a: 'pick', w: 67, re: /撬锁|开锁|拨弄锁|铁丝.*锁|撬开|解开封|拆.*机关|捅.*锁眼/ },
    { a: 'craft', w: 78, re: /锻造|敲打|锤|铁砧|烧红|打造|铆|錾|打磨|装订|淬火|抡起.*锤|制.*器具|缝补/ },
    { a: 'dig', w: 65, re: /挖|掘|刨|铲|翻开土|掘开|挖掘/ },
    { a: 'read', w: 66, re: /阅读|看书|翻阅|翻.*书|展卷|浏览|读.*信|端详.*卷轴|披阅|旧书|卷宗|read|peruse/i },
    { a: 'write', w: 64, re: /写下|记下|题字|抄录|批注|奋笔|书写|记录|涂写|journal|write/i },
    { a: 'drink', w: 63, re: /喝|饮|灌下|抿了口|吞服|饮酒|吃药|举杯|一口闷/ },
    { a: 'open', w: 62, re: /推开门|拉开|打开|推开|翻开|开启|拧开|掀开|揭开|撬开.*门|推.*门|拔开|open/i },
    { a: 'push', w: 60, re: /推动|推开.*石|用力推|顶住|推搡|搬动|挪动|push/i },
    { a: 'carry', w: 60, re: /扛起|抱起|提着|搬运|背着|拎着|拖着|担着|carry/i },
    { a: 'sit', w: 60, re: /坐下|坐了|坐在|落座|盘膝|坐了下来|坐到|坐于|坐回/ },
    { a: 'kneel', w: 61, re: /跪下|跪倒|跪在|单膝|屈膝|跪了|跪倒在地/ },
    { a: 'stretch', w: 58, re: /伸懒腰|舒展|活动筋骨|拉伸|抻了抻/ },

    /* 社交 */
    { a: 'wave', w: 66, re: /挥手|招手|致意|招了招|挥了挥|打招呼|抬起手|举起了手|hello|wave/i },
    { a: 'bow', w: 66, re: /鞠躬|作揖|行礼|施礼|拜了拜|欠身|拱手|躬身/ },
    { a: 'point', w: 64, re: /指向|指着|手指.*方向|一比|示意方向|point/i },
    { a: 'cheer', w: 64, re: /欢呼|喝彩|叫好|振臂|万岁|人群沸腾/ },
    { a: 'victory', w: 63, re: /胜利|获胜|赢了|战胜|击败.*后|凯旋|拿下|告捷|win\b|victory/i },
    { a: 'cry', w: 62, re: /哭|流泪|抽泣|哽咽|呜咽|泣不成声|落泪|tears/i },
    { a: 'shrug', w: 60, re: /耸肩|无可奈何地摊|摊手| shrugged/i },
    { a: 'think', w: 55, re: /思索|思考|沉思|琢磨|沉吟|想了想|冥思|考虑|盘算|ponder|think/i },
    { a: 'listen', w: 55, re: /倾听|细听|贴着门听|动静|听了听|侧耳|屏息听/ },
    { a: 'talk', w: 48, re: /说道|说：|说道|开口|交谈|对话|询问|搭话|谈判|劝说|交涉|回答|喊道|低声道|闲聊|讲道|talk|say|ask/i },
    { a: 'breathe', w: 34, re: /深呼吸|深吸一口|缓了口气|喘气|喘息|调息|平复呼吸|长出一口气|吐出一口气/ },
  ];

  /* 道具建议：动作 + 文本关键词 */
  var PROP_HINTS = [
    { re: /弓|箭|弩/, p: 'bow' },
    { re: /法杖|权杖|长杖|杖/, p: 'staff' },
    { re: /匕首|短刀|小刀|锥/, p: 'dagger' },
    { re: /盾/, p: 'shield' },
    { re: /书|卷|册|典|信|纸/, p: 'book' },
    { re: /锤|砧|铁/, p: 'hammer' },
    { re: /铲|锹|镐/, p: 'shovel' },
    { re: /剑|刀|斧|枪|矛/, p: 'sword' },
    { re: /杯|壶|瓶|碗|酒/, p: 'cup' },
    { re: /箱|筐|袋|桶|包裹/, p: 'crate' },
    { re: /笔|墨|羽毛/, p: 'quill' },
    { re: /锁|铁丝|撬/, p: 'pick' },
  ];

  var NEG_RE = /(没有|并未|不曾|没能|无法|不能|不会|不要|未曾|不敢|无从|没|未|别|莫)/;
  var INTENSIFY = /(猛然|骤然|狠狠|全力|拼尽|死命|竭尽|疯狂|暴起|狂|拼了命)/;
  var CALM = /(轻轻|缓缓|慢慢|微微|淡淡|悄悄|小心翼翼)/;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- 单句推断 ---------------- */
  function infer(text, opts) {
    opts = opts || {};
    var raw = String(text == null ? '' : text);
    var clean = raw.replace(/<[^>]+>/g, ' ');
    var res = {
      action: 'idle', prop: null, source: 'none', score: 0,
      hits: [], reason: '无关键词命中 → idle',
    };
    if (!clean.trim()) return res;

    var best = null;
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      var m = clean.match(r.re);
      if (!m) continue;
      var w = r.w;
      /* 命中位置越靠前（句子主语先说）略微加分，符合中文「先动作后修饰」 */
      var idx = clean.indexOf(m[0]);
      if (idx >= 0) w += clamp(6 - idx / 40, 0, 6);
      /* 否定：命中词前 6 个字里出现否定词 → 大幅降权 */
      if (idx > 0) {
        var before = clean.slice(Math.max(0, idx - 6), idx);
        if (NEG_RE.test(before)) w *= 0.25;
      }
      if (INTENSIFY.test(clean)) w *= (r.a === 'attack' || r.a === 'charge' || r.a === 'hit') ? 1.12 : 1.0;
      if (CALM.test(clean) && (r.a === 'run' || r.a === 'attack')) w *= 0.8;
      if (opts.prefer && opts.prefer[r.a]) w += opts.prefer[r.a];
      if (opts.block && opts.block.indexOf(r.a) >= 0) continue;
      res.hits.push({ action: r.a, kw: m[0], w: Math.round(w) });
      if (!best || w > best.w) best = { a: r.a, w: w, kw: m[0] };
    }
    res.hits.sort(function (x, y) { return y.w - x.w; });
    if (best) {
      res.action = best.a;
      res.source = 'rule';
      res.score = Math.round(best.w);
      res.reason = '规则命中「' + best.kw + '」→ ' + best.a + '（权重 ' + Math.round(best.w) + '）';
    }
    /* 道具 */
    for (var j = 0; j < PROP_HINTS.length; j++) {
      if (PROP_HINTS[j].re.test(clean)) { res.prop = PROP_HINTS[j].p; break; }
    }
    if (!res.prop) {
      var def = window.Stickman && window.Stickman.actions[res.action];
      if (def && def.weaponDefault) res.prop = def.weaponDefault;
    }
    res.label = (META[res.action] && META[res.action].zh) || res.action;
    return res;
  }

  /* ---------------- 段落 → 动作序列 ---------------- */
  function splitSentences(text) {
    return String(text == null ? '' : text)
      .replace(/\r/g, '')
      .split(/(?<=[。！？；…])/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 1; });
  }
  /* 动画节拍：逗号/顿号也切，切出的是「一个动作一帧」的粒度 */
  function clauses(text) {
    return String(text == null ? '' : text)
      .replace(/\r/g, '')
      .replace(/<[^>]+>/g, ' ')
      .split(/(?<=[。！？；…，、,])/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 1; });
  }

  function sequence(text, opts) {
    opts = opts || {};
    var parts = opts.bySentence ? splitSentences(text) : clauses(text);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var r = infer(parts[i], opts);
      if (opts.skipIdle !== false && r.action === 'idle') continue;
      if (out.length && out[out.length - 1].action === r.action && r.action !== 'idle') {
        out[out.length - 1].span += parts[i];
        continue;
      }
      out.push({
        action: r.action, prop: r.prop, label: r.label, source: r.source,
        score: r.score, reason: r.reason, text: parts[i], span: parts[i],
      });
    }
    if (!out.length) out.push({ action: 'idle', prop: null, label: '待机', source: 'none', score: 0, reason: '整段无动作词', text: '', span: '' });
    if (opts.max && out.length > opts.max) out = out.slice(0, opts.max);
    return out;
  }

  /* ---------------- 可解释性输出（UI 标来源用） ---------------- */
  function explain(text, opts) {
    var r = infer(text, opts);
    var top = r.hits.slice(0, 3).map(function (h) { return h.action + '(' + h.kw + '·' + h.w + ')'; });
    return r.action + ' ← ' + (top.length ? top.join('、') : '无命中');
  }

  /* ---------------- 扩展点 ---------------- */
  function register(rules) {
    (rules || []).forEach(function (r) {
      if (!r || !r.a || !r.re) return;
      RULES.unshift(r);
    });
  }
  function list() { return RULES.map(function (r) { return { action: r.a, w: r.w, source: String(r.re) }; }); }
  function meta(name) { return META[name] || { zh: name, group: '其它' }; }
  function groups(available) {
    var g = {};
    var names = available || (window.Stickman ? window.Stickman.listActions() : Object.keys(META));
    names.forEach(function (n) {
      var m = META[n] || { zh: n, group: '其它' };
      (g[m.group] || (g[m.group] = [])).push({ name: n, zh: m.zh });
    });
    return g;
  }

  /* ---------------- 可选：AI 推断（只有显式调用才发请求） ---------------- */
  var AI_SYS = '你是动作编排器。读用户给的叙事文本，只输出一个 JSON：' +
    '{"action":"动作名","prop":"武器或道具或空","actors":1}' +
    '。action 只能取给定列表中的一个；无法判断时输出 idle。不要解释。';
  function aiInfer(text, callLLM, allowed) {
    if (typeof callLLM !== 'function') return Promise.reject(new Error('no callLLM'));
    var names = allowed || (window.Stickman ? window.Stickman.listActions() : Object.keys(META));
    var user = '可选动作：' + names.join('/') + '\n文本：' + String(text).slice(0, 600);
    return callLLM([
      { role: 'system', content: AI_SYS },
      { role: 'user', content: user },
    ]).then(function (raw) {
      var s = String(raw || '');
      var m = s.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('bad json');
      var j = JSON.parse(m[0]);
      if (names.indexOf(j.action) < 0) j.action = 'idle';
      return { action: j.action, prop: j.prop || null, source: 'ai', score: 100, reason: 'AI 给出：' + j.action };
    });
  }

  return {
    infer: infer, sequence: sequence, explain: explain,
    register: register, list: list, meta: meta, groups: groups,
    aiInfer: aiInfer, splitSentences: splitSentences, clauses: clauses,
    RULES: RULES, META: META,
  };
})();
