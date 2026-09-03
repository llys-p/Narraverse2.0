/* =========================================================
 * 设定包：无限流·诸天轮回（第一套离线冒险）
 * 单局制：随机天赋 / 随机金手指 / 随机事件，多结局
 * ========================================================= */
window.GAME_PACKS = window.GAME_PACKS || {};
window.GAME_PACKS.limitless = {
  id: 'limitless',
  title: '诸天轮回',
  subtitle: '无限流 · 单局制离线冒险',
  intro: '你死了——被一辆失控的卡车撞飞。再睁眼时，你躺在纯白空间，冰冷的电子音响起：『欢迎来到轮回空间。你将穿越一个又一个副本世界，完成任务换取力量。失败，即抹杀。』',
  characters: {
    'player': { name: '轮回者', color: '#e8e8e8', scale: 1 },
    'ghost': { name: '白衣女鬼', color: '#a8c8ff', scale: 1, alpha: 0.85 },
    '宅主': { name: '怨灵宅主', color: '#b08a6a', scale: 1.18 },
    '青锋子': { name: '青锋子', color: '#7ed0a0', scale: 1.08 },
    '舰长': { name: '异变舰长', color: '#e07a5a', scale: 1.3 },
    '零': { name: '空间管理员·零', color: '#ffffff', scale: 1.12 },
    '黑衣人': { name: '黑衣轮回者', color: '#8a90a8', scale: 1 },
    '队友': { name: '队友', color: '#6fd0a8', scale: 0.92 },
    '商人': { name: '黑市商人', color: '#e0c878', scale: 1.02 },
  },
  player: { hp: 100, mp: 50, gold: 100, items: ['复活币'] },
  attrs: {
    '力量': { base: 10, name: '力量' },
    '敏捷': { base: 10, name: '敏捷' },
    '智力': { base: 10, name: '智力' },
    '精神': { base: 10, name: '精神' },
    '幸运': { base: 10, name: '幸运' },
  },
  talents: [
    { id: 'lucky', name: '幸运儿', desc: '气运加身，幸运 +3', attrs: { '幸运': 3 } },
    { id: 'berserker', name: '狂战士', desc: '力量敏捷提升，HP +20', attrs: { '力量': 2, '敏捷': 1 }, hp: 20 },
    { id: 'schemer', name: '老阴比', desc: '深谋远虑，智力 +3', attrs: { '智力': 3 } },
    { id: 'medic', name: '医者', desc: '精神 +2，每回合回复 3 HP', attrs: { '精神': 2 }, healPerEvent: 3 },
  ],
  goldenFingers: [
    {
      id: 'panel', name: '主神面板', desc: '一切数据化。你的每一次选择都在优化属性，面板可随经验升级推演能力。',
      levels: [
        { xp: 0, desc: '基础数据化：智力 / 精神 +1', bonus: { '智力': 1, '精神': 1 } },
        { xp: 100, desc: '解锁「推演」：战斗与抉择的收益分析更精准，智力 / 精神 +2', bonus: { '智力': 2, '精神': 2 } },
        { xp: 250, desc: '解锁「超频」：短时间内属性全面突破，智力 / 精神 +3', bonus: { '智力': 3, '精神': 3 } },
        { xp: 500, desc: '面板与灵魂深度融合，智力 / 精神 +4', bonus: { '智力': 4, '精神': 4 } },
      ],
    },
    {
      id: 'time', name: '时空行者', desc: '你能瞥见时间的缝隙，在关键时刻永远快人一步。',
      levels: [
        { xp: 0, desc: '反应加速：敏捷 / 幸运 +1', bonus: { '敏捷': 1, '幸运': 1 } },
        { xp: 100, desc: '时间感知：可短暂预判对手动作，敏捷 / 幸运 +2', bonus: { '敏捷': 2, '幸运': 2 } },
        { xp: 250, desc: '子弹时间：危险时刻世界变慢，敏捷 / 幸运 +3', bonus: { '敏捷': 3, '幸运': 3 } },
        { xp: 500, desc: '时间静止：你已成为时间本身，敏捷 / 幸运 +4', bonus: { '敏捷': 4, '幸运': 4 } },
      ],
    },
    {
      id: 'plunder', name: '掠夺之手', desc: '击败强敌时，你能掠夺对方的一丝本质化为己用。',
      levels: [
        { xp: 0, desc: '掠夺本能：力量 / 幸运 +1', bonus: { '力量': 1, '幸运': 1 } },
        { xp: 100, desc: '掠夺强化：从敌人身上夺取属性碎片，力量 / 幸运 +2', bonus: { '力量': 2, '幸运': 2 } },
        { xp: 250, desc: '本质吞噬：击败 BOSS 额外获得属性成长，力量 / 幸运 +3', bonus: { '力量': 3, '幸运': 3 } },
        { xp: 500, desc: '万物皆可掠夺：连规则都能啃下一角，力量 / 幸运 +4', bonus: { '力量': 4, '幸运': 4 } },
      ],
    },
  ],
  items: [
    { id: 'revive', name: '复活币', desc: '死亡时自动复活一次（HP 恢复一半）' },
    { id: 'blade', name: '精钢短剑', desc: '削铁如泥的短剑，力量 +1', attrs: { '力量': 1 } },
    { id: 'amulet', name: '护身符', desc: '刻着安神符文的木符，幸运 +1', attrs: { '幸运': 1 } },
    { id: 'scroll', name: '情报卷轴', desc: '记载关键情报的卷轴，智力 +1', attrs: { '智力': 1 } },
  ],
  stages: [
    {
      id: 's1', name: '新手试炼 · 怨宅',
      intro: '轮回面板弹出第一个任务：【新手试炼 · 怨宅】——在一栋闹鬼的宅邸中存活到天亮。难度 C，奖励 200 积分。',
      events: ['e00_intro', 'e01_mission', 'e02_hall', 'e03_corridor', 'e04_ghost'],
    },
    {
      id: 's2', name: '武侠 · 藏经阁',
      intro: '你刚松了口气，面板再次闪烁：【主线任务 · 武侠】——潜入青峰派藏经阁盗取《九阳残卷》，或正大光明拜入门派。时间：三天。',
      events: ['e10_feast', 'e11_library', 'e12_chase', 'e13_master'],
    },
    {
      id: 's3', name: '科幻 · 生化星舰',
      intro: '第三副本【生化 · 星舰“诺亚号”】：深空殖民舰感染异变病毒，舰员化为怪物。你的任务：在舰桥自毁程序启动前，夺取解药样本。',
      events: ['e20_alarm', 'e21_quarantine', 'e22_lab', 'e23_captain'],
    },
    {
      id: 's4', name: '终极试炼 · 主神空间',
      intro: '你通关三个副本，站在主神空间的中央祭坛前。轮回面板发出从未有过的光芒：【终极试炼开启。真相，就在你眼前。】',
      events: ['e30_truth'],
    },
  ],
  events: {
    /* ---------- 第 1 幕 ---------- */
    e00_intro: {
      title: '死亡与轮回',
      text: '冰冷的电子音再次响起：「轮回者编号 0427 已登记。初始试炼即将开始。记住：在这里，死亡是唯一的失败。」',
      choices: [
        { text: '接受命运', next: '@next' },
      ],
    },
    e01_mission: {
      title: '第一份任务',
      text: '轮回面板弹出任务简报：【新手试炼 · 怨宅】——城郊一栋废弃宅邸，曾是一家七口的葬身之地。存活到天亮即算通关。',
      choices: [
        { text: '查看属性与装备', next: '@next' },
        { text: '立刻出发（金手指经验 +10）', effect: { gfXp: 10 }, next: '@next' },
      ],
    },
    e02_hall: {
      title: '怨宅玄关',
      text: '你站在怨宅玄关。月光透过积尘的窗户洒落，楼梯深处传来细微的哭声。墙角的储物柜微微晃动，仿佛有什么东西在里面。',
      choices: [
        {
          text: '搜索储物柜', check: { attr: '幸运', dc: 12 },
          result: { text: '柜子里是一本褪色的日记，记载了宅邸的诅咒真相——家主为了续命，将全家献祭。', effect: { gfXp: 20, addItem: '情报卷轴' }, next: '@next' },
          fail: { text: '柜门猛地合上，夹得你手指生疼，指甲缝渗出血珠。', effect: { hp: -5 }, next: '@next' },
        },
        {
          text: '直接上楼', check: { attr: '敏捷', dc: 12 },
          result: { text: '你灵巧地避开吱呀作响的楼梯板，悄无声息抵达二楼。', effect: { gfXp: 10 }, next: '@next' },
          fail: { text: '木板突然断裂，你摔下楼梯，后脑磕在石阶上。', effect: { hp: -10 }, next: '@next' },
        },
        { text: '原地戒备，等天亮（触发随机事件）', effect: { mp: 10 }, next: '@random:e03_corridor' },
      ],
    },
    e03_corridor: {
      title: '走廊尽头的白衣',
      text: '二楼走廊尽头，一个白衣女鬼背对你站着，长发无风自动。她的脖颈缓缓扭过 180 度，惨白的脸上没有五官——只有一张咧到耳根的嘴。',
      show: ['ghost'],
      choices: [
        {
          text: '冷静对峙', check: { attr: '精神', dc: 13 },
          result: { text: '你稳住心神，念出轮回空间传授的驱邪口诀。女鬼发出刺耳尖啸，遁入墙壁消散。', effect: { gfXp: 20 }, next: '@next' },
          fail: { text: '恐惧攫住你的心脏，女鬼扑来撕咬你的肩膀，血溅走廊。', effect: { hp: -15 }, next: '@next' },
        },
        {
          text: '夺路狂奔', check: { attr: '敏捷', dc: 13 },
          result: { text: '你发足狂奔，女鬼的指甲擦过你的后颈，留下一道血痕，但你逃出了她的范围。', effect: { hp: -5, gfXp: 10 }, next: '@next' },
          fail: { text: '走廊像被无限拉长，你无论怎么跑都在原地。女鬼从背后抱住了你。', effect: { hp: -20 }, next: '@next' },
        },
        {
          text: '与她交谈', check: { attr: '智力', dc: 13 },
          result: { text: '你发现她似乎在传达什么——她是被家主献祭的牺牲者。她留下一个线索：地下室藏着一切的答案。', effect: { gfXp: 30 }, next: '@next' },
          fail: { text: '她听不懂人话，只发出哭泣般的笑声，声音越来越近。', effect: { mp: -10 }, next: '@next' },
        },
      ],
    },
    e04_ghost: {
      title: '怨灵宅主',
      text: '天色将明，怨宅的主人终于现身——一具穿着寿衣的干尸，生前便是献祭全家续命的宅主。他咆哮着朝你扑来，阴风灌满走廊。',
      show: ['宅主'],
      choices: [
        {
          text: '⚔ 迎战怨灵（精神判定）',
          combat: {
            enemy: '怨灵宅主', enemyKey: '宅主', enemyHp: 3, rounds: 4, attr: '精神', dc: 13, dmg: 10,
            winEffect: { gfXp: 40, gold: 80 }, winNext: '@stage',
            loseEffect: { hp: -15, gfXp: 15 }, loseNext: '@stage',
          },
        },
      ],
    },
    /* ---------- 第 2 幕 ---------- */
    e10_feast: {
      title: '青峰派寿宴',
      text: '你扮作远道而来的江湖散人，混入青峰派掌门寿宴。席间觥筹交错，一位锦袍老者——掌门青锋子——似乎多看了你两眼。',
      show: ['青锋子'],
      choices: [
        { text: '低调吃喝，养精蓄锐', effect: { mp: 10 }, next: '@next' },
        {
          text: '打探消息', check: { attr: '智力', dc: 12 },
          result: { text: '你从醉酒的弟子口中套出藏经阁的换班时辰，以及暗格的传闻。', effect: { gfXp: 15 }, next: '@next' },
          fail: { text: '你问得太刻意，被警惕的执事记下了面容。', effect: {}, next: '@next' },
        },
        {
          text: '偷一壶百年陈酿', check: { attr: '幸运', dc: 12 },
          result: { text: '你顺手牵羊得手，转头在黑市卖了 30 金币。', effect: { gold: 30 }, next: '@next' },
          fail: { text: '被家丁当场撞见，赔了 20 金币才了事。', effect: { gold: -20 }, next: '@next' },
        },
      ],
    },
    e11_library: {
      title: '深夜藏经阁',
      text: '深夜，藏经阁三楼。古籍层层叠叠，《九阳残卷》据说就藏在某个暗格里。巡夜弟子的脚步声在楼下有节奏地回荡。',
      choices: [
        {
          text: '破解暗格机关', check: { attr: '智力', dc: 13 },
          result: { text: '你按《机关要术》的规律转动书架，暗格无声弹开，残卷到手。', effect: { gfXp: 25, addItem: '情报卷轴' }, next: '@next' },
          fail: { text: '机关触发警报，你只来得及抓起一本《入门剑谱》从窗台跳下。', effect: { gold: 10 }, next: '@next' },
        },
        {
          text: '武力破门强抢', check: { attr: '力量', dc: 13 },
          result: { text: '你一拳轰碎暗格木门，残卷到手，但整栋楼都被惊动了。', effect: { gfXp: 20 }, next: '@next' },
          fail: { text: '木门比想象中结实，你撞得眼冒金星，声响引来了巡逻弟子。', effect: { hp: -10 }, next: '@next' },
        },
        { text: '贿赂守夜弟子（花 50 金币，触发随机事件）', effect: { gold: -50, gfXp: 15 }, next: '@random:e12_chase' },
      ],
    },
    e12_chase: {
      title: '漫山追捕',
      text: '盗卷之事败露，青峰派弟子举着火把漫山搜捕你。山道崎岖，前方是断崖，身后追兵渐近。',
      choices: [
        {
          text: '跳崖搏命', check: { attr: '幸运', dc: 14 },
          result: { text: '崖下竟是深潭！你被激流冲走，却因此甩掉了所有追兵。', effect: { hp: -10, gfXp: 20 }, next: '@next' },
          fail: { text: '你撞上崖壁，眼前一黑昏了过去，被追兵拖回山上。', effect: { hp: -25 }, next: '@next' },
        },
        {
          text: '反身迎战', check: { attr: '力量', dc: 13 },
          result: { text: '你且战且退，放倒三个弟子后钻进密林，消失在夜色里。', effect: { hp: -8, gfXp: 15 }, next: '@next' },
          fail: { text: '双拳难敌四手，你被乱棍打翻在地。', effect: { hp: -20 }, next: '@next' },
        },
        {
          text: '念残卷内容诱惑追兵', check: { attr: '智力', dc: 13 },
          result: { text: '你高声念出残卷开篇，引得弟子们争抢，自己趁乱遁走。', effect: { gfXp: 30 }, next: '@next' },
          fail: { text: '他们不为所动，围得更紧了。', effect: { hp: -10 }, next: '@next' },
        },
      ],
    },
    e13_master: {
      title: '掌门拦路',
      text: '青峰派掌门青锋子御剑追至。他负手立于树梢，声如洪钟：「小辈，把残卷留下，或把命留下。」',
      show: ['青锋子'],
      choices: [
        {
          text: '⚔ 与掌门一战（力量判定）',
          combat: {
            enemy: '青锋子', enemyKey: '青锋子', enemyHp: 4, rounds: 4, attr: '力量', dc: 13, dmg: 12,
            winEffect: { gfXp: 40, gold: 100 }, winNext: '@stage',
            loseEffect: { hp: -15, gfXp: 15 }, loseNext: '@stage',
          },
        },
      ],
    },
    /* ---------- 第 3 幕 ---------- */
    e20_alarm: {
      title: '诺亚号警报',
      text: '你醒来时，诺亚号正发出刺耳的红色警报。走廊里回荡着撕咬与惨叫，舷窗外星光依旧，仿佛这艘船上的地狱与宇宙无关。',
      choices: [
        {
          text: '直冲舰桥', check: { attr: '敏捷', dc: 13 },
          result: { text: '你绕过三波异变体，抵达舰桥入口。', effect: { gfXp: 15 }, next: '@next' },
          fail: { text: '你撞上一只异变体，被它的触须抽飞。', effect: { hp: -15 }, next: '@next' },
        },
        {
          text: '先找医疗室', check: { attr: '精神', dc: 12 },
          result: { text: '你压制住恐惧，在医疗室找到了还能说话的医生。', effect: { gfXp: 10 }, next: '@next' },
          fail: { text: '医疗室的门被血肉糊住，你推门时被涌出的怪物咬了一口。', effect: { hp: -10 }, next: '@next' },
        },
        { text: '搜刮船员室', effect: { gold: 40 }, next: '@next' },
      ],
    },
    e21_quarantine: {
      title: '隔离区医生',
      text: '医疗室隔离区里，一个只剩半边脸的医生隔着玻璃对你喊：「解药……在培养箱里……但钥匙……被舰长拿走了。」',
      choices: [
        {
          text: '砸开培养箱', check: { attr: '力量', dc: 13 },
          result: { text: '你抡起消防斧砸碎强化玻璃，取出绿色解药样本。', effect: { gfXp: 20, hp: -5 }, next: '@next' },
          fail: { text: '玻璃纹丝不动，警报声反而更响。', effect: {}, next: '@next' },
        },
        {
          text: '黑进医疗系统', check: { attr: '智力', dc: 13 },
          result: { text: '你用医生终端解除了培养箱权限，顺手拷贝了一份舰船结构图。', effect: { gfXp: 25, addItem: '情报卷轴' }, next: '@next' },
          fail: { text: '系统在关键时刻断电，你被锁在医疗室里。', effect: { hp: -10 }, next: '@next' },
        },
        { text: '观察四周再动手（触发随机事件）', effect: {}, next: '@random:e22_lab' },
      ],
    },
    e22_lab: {
      title: '研究室的异变体',
      text: '研究室内，培养箱里的绿色解药泛着微光。但墙壁破洞处，一只两米高的异变体正缓缓爬出，黏液滴落在地板上嗤嗤冒烟。',
      choices: [
        {
          text: '抢药就跑', check: { attr: '敏捷', dc: 13 },
          result: { text: '你在异变体扑下的前一秒抓起解药，翻滚出门。', effect: { gfXp: 20, hp: -8 }, next: '@next' },
          fail: { text: '它抓住你的脚踝，你挣扎着拖出实验室，鞋都没了。', effect: { hp: -18 }, next: '@next' },
        },
        {
          text: '正面搏斗', check: { attr: '力量', dc: 13 },
          result: { text: '你抄起实验台挡下一击，反手砸碎它的头骨。', effect: { gfXp: 15, hp: -10 }, next: '@next' },
          fail: { text: '它力大无穷，把你抡在墙上。', effect: { hp: -20 }, next: '@next' },
        },
        {
          text: '精神压制', check: { attr: '精神', dc: 14 },
          result: { text: '你集中精神令它短暂僵直，从容取走解药。', effect: { gfXp: 30 }, next: '@next' },
          fail: { text: '它的精神污染反而侵蚀了你，你头痛欲裂。', effect: { mp: -15 }, next: '@next' },
        },
      ],
    },
    e23_captain: {
      title: '异变舰长',
      text: '舰桥上，舰长已被病毒完全吞噬——半边身体是钢铁义体，半边是蠕动的血肉触须。「把解药……交给我……就放你走……」',
      show: ['舰长'],
      choices: [
        {
          text: '⚔ 击杀舰长（精神判定）',
          combat: {
            enemy: '异变舰长', enemyKey: '舰长', enemyHp: 4, rounds: 4, attr: '精神', dc: 14, dmg: 12,
            winEffect: { gfXp: 50, gold: 120 }, winNext: '@stage',
            loseEffect: { hp: -20, gfXp: 20 }, loseNext: '@stage',
          },
        },
      ],
    },
    /* ---------- 第 4 幕 ---------- */
    e30_truth: {
      title: '真相',
      text: '空间管理员「零」现身——一个戴面具的白衣人。「你猜到了吧。轮回空间不是神迹，是上一代主神留下的囚笼。十名轮回者通关后，必须有一人接过主神之位，维持囚笼运转。」他递出三个选项。',
      show: ['零'],
      choices: [
        { text: '接过权柄，成为新主神', next: 'end:fall' },
        {
          text: '尝试打破囚笼，回归现实', check: { attr: '幸运', dc: 16 },
          result: { text: '你触摸到规则的一线缝隙，用尽所有力量撕开它……', effect: { gfXp: 50 }, next: 'end:win_graduate' },
          fail: { text: '囚笼纹丝不动。零叹了口气：「看来，你走不了了。」', effect: {}, next: 'end:fall' },
        },
        {
          text: '⚔ 挑战管理员，弑神（精神判定）',
          combat: {
            enemy: '空间管理员·零', enemyKey: '零', enemyHp: 5, rounds: 8, attr: '精神', dc: 12, dmg: 8,
            winEffect: { gfXp: 80, gold: 300 }, winNext: 'end:win_god',
            loseEffect: { hp: -30 }, loseNext: 'end:fall',
          },
        },
      ],
    },
  },
  randomEvents: [
    {
      id: 'r1', title: '隐藏任务',
      text: '轮回面板弹出隐藏任务：【收集记忆碎片】。你脚下的地板恰好有一枚发光碎片。',
      choices: [
        { text: '触碰碎片', effect: { gfXp: 40, hp: -5 } },
        { text: '无视它', effect: {} },
      ],
    },
    {
      id: 'r2', title: '轮回者拦路',
      text: '一名黑衣轮回者挡在你面前：「把你身上的好东西交出来，我可以不动手。」',
      show: ['黑衣人'],
      choices: [
        { text: '交出 30 金币', effect: { gold: -30 } },
        {
          text: '拒绝并反击', check: { attr: '力量', dc: 13 },
          result: { text: '你一拳打在他的鼻梁上，他灰溜溜跑了。', effect: { gfXp: 15, hp: -5 } },
          fail: { text: '他早有防备，你挨了一脚。', effect: { hp: -12, gold: -10 } },
        },
        {
          text: '花言巧语蒙混', check: { attr: '智力', dc: 12 },
          result: { text: '你编了个凄惨的身世，他居然信了，还给了你 10 金币。', effect: { gold: 10, gfXp: 10 } },
          fail: { text: '他看穿了你，抢走了你 20 金币。', effect: { gold: -20 } },
        },
      ],
    },
    {
      id: 'r3', title: '兑换折扣',
      text: '兑换大厅今日限时折扣：100 金币，全属性 +1。',
      choices: [
        { text: '购买', effect: { gold: -100, attrs: { '力量': 1, '敏捷': 1, '智力': 1, '精神': 1, '幸运': 1 } } },
        { text: '不买', effect: {} },
      ],
    },
    {
      id: 'r4', title: '空间公告',
      text: '冰冷的公告响彻空间：「全体轮回者强制扣除 15 MP 作为空间维护费。」',
      choices: [
        { text: '接受', effect: { mp: -15 } },
      ],
    },
    {
      id: 'r5', title: '队友求救',
      text: '通讯器传来队友的求救信号：「救我！我在 3 号通道！快！」',
      show: ['队友'],
      choices: [
        {
          text: '前往救援', check: { attr: '敏捷', dc: 13 },
          result: { text: '你及时赶到，队友赠你一枚护身符表示感谢。', effect: { addItem: '护身符', gfXp: 15 } },
          fail: { text: '你赶到时只看到一滩血迹和拖痕。', effect: { hp: -10 } },
        },
        { text: '假装没听见', effect: {} },
      ],
    },
    {
      id: 'r6', title: '黑市商人',
      text: '黑市商人拦住你：「精钢短剑，削铁如泥，只要 50 金币。」',
      show: ['商人'],
      choices: [
        { text: '买下', effect: { gold: -50, addItem: '精钢短剑' } },
        {
          text: '砍价', check: { attr: '智力', dc: 12 },
          result: { text: '你成功砍到 30 金币，商人苦着脸成交。', effect: { gold: -30, addItem: '精钢短剑' } },
          fail: { text: '商人冷笑一声，一分不让。', effect: { gold: -50, addItem: '精钢短剑' } },
        },
        { text: '离开', effect: {} },
      ],
    },
  ],
  endings: {
    death: { title: '抹杀', kind: 'death', text: '轮回空间冰冷地宣告：任务失败。你的意识被从虚空中抹去，仿佛从未存在过。' },
    win_graduate: { title: '毕业 · 回归现实', kind: 'win', text: '你抓住规则的缝隙，撕开囚笼。刺目的白光后，你再次睁开眼——躺在自己公寓的床上，手机显示凌晨 3:00。窗外没有轮回空间，没有怪物，只有如常的万家灯火。你成功了。' },
    win_god: { title: '弑神 · 新主神', kind: 'win', text: '你击败了空间管理员，摘下那顶面具。无数轮回者的数据流涌入你的意识。你做出选择——打开囚笼，放他们回家，自己留下维持这个世界的运转。从此，你是轮回空间新的主神。' },
    fall: { title: '堕落 · 新的囚笼', kind: 'neutral', text: '你接过权柄，成为主神。岁月流转，你渐渐忘记自己曾是轮回者。当新一批轮回者质疑空间的真相时，你微笑着，重新戴上管理员的面具。' },
  },
};
