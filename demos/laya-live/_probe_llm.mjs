// 探测 DeepSeek-V4.1-Flash 的请求参数：effort 是否可传、content/reasoning 的关系、延迟
const KEY = 'sk-3d2611ec9ec549809d90e687b40d7d33';
const SYS = '你在为文字冒险游戏写 NPC 的回应。角色：莉亚，圣殿骑士，真实目的是秘密追查代号「灰鸦」的人。本轮她决定做出的行为是「直接发问」：用具体的矛盾点逼问对方身份。当前关系与情绪：信任 58 尊敬 43 怀疑 33；警觉 0.46 好感 0.33。硬性规则：1) 只输出角色台词（用「」包裹）和必要的动作描写，2~4 句。2) 绝不描写角色的内心想法，只写外部可见的言行。3) 不要提到概率、判断、决策、系统这类词。4) 不替玩家说话。5) 用中文。';
const USR = '玩家：我是个行商，从北边来。带了点不太方便在城里说的事。\n\n请写出她此刻的回应。';

async function call(label, extra) {
  const body = Object.assign({
    model: 'deepseek-flash',
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: USR }],
    temperature: 1.0,
    max_tokens: 2000,
    stream: false,
  }, extra);
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const j = await r.json();
    if (!r.ok) { console.log(`\n### ${label}  HTTP ${r.status} (${ms}ms)\n`, JSON.stringify(j).slice(0, 400)); return; }
    const m = j.choices[0].message;
    const u = j.usage || {};
    console.log(`\n### ${label}  HTTP ${r.status}  ${ms}ms`);
    console.log('  usage:', JSON.stringify(u));
    console.log('  reasoning_content 长度:', (m.reasoning_content || '').length);
    console.log('  content 长度:', (m.content || '').length);
    console.log('  content:', JSON.stringify((m.content || '').slice(0, 400)));
  } catch (e) {
    console.log(`\n### ${label}  异常: ${e.message}`);
  }
}

(async () => {
  await call('A 不传 effort', {});
  await call('B effort=low', { effort: 'low' });
  await call('C effort=max', { effort: 'max' });
  await call('D reasoning_effort=low', { reasoning_effort: 'low' });
})();
