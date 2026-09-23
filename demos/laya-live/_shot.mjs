#!/usr/bin/env node
/**
 * _shot.mjs —— 用 Edge + CDP 给动态页面截图（零依赖）
 *
 * 为什么不用 agent-browser：本机 `npm install -g` 被沙箱静默拦截（exit 1、零输出），
 * 装不上；而 Edge 本来就在本机。Node 21+ 自带全局 WebSocket，所以直接用 CDP 即可，
 * 不需要 puppeteer / playwright-core 任何依赖。
 *
 * 为什么不能只靠 `msedge --headless --screenshot`：
 *   那条路只会截「页面加载完的那一刻」，而本页要等 /decide（~20s）+ /narrate（~7s）
 *   两个异步请求回来才有内容，截到的永远是「决策中…」。
 *   而且 Edge 已有实例在跑时，--screenshot 会静默失败（退出码 0、png 不生成），
 *   必须给唯一 --user-data-dir。CDP 路线同时解决这两个问题。
 *
 * 用法：
 *   node _shot.mjs <url> <输出png> "<就绪判断的JS表达式>" [超时毫秒] [宽 高]
 * 例：
 *   node _shot.mjs "http://127.0.0.1:8130/demo?auto=7" shot.png \
 *        "!document.getElementById('pending') && document.querySelector('#panel')?.innerText.length>200" \
 *        90000 1680 1050
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [, , url, out, readyExpr, timeoutMsArg, wArg, hArg] = process.argv;
if (!url || !out) {
  console.error('用法: node _shot.mjs <url> <out.png> "<readyExpr>" [timeoutMs] [w] [h]');
  process.exit(2);
}
const timeoutMs = Number(timeoutMsArg) || 90000;
const W = Number(wArg) || 1680;
const H = Number(hArg) || 1050;
const ready = readyExpr || 'document.readyState==="complete"';
const PORT = 9222 + Math.floor(Math.random() * 300);

const profile = mkdtempSync(join(tmpdir(), 'edge-shot-'));
const child = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 端点未就绪（Edge 可能启动失败）');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP 超时: ' + method)); }
      }, 60000);
    });
}

let exitCode = 0;
try {
  const target = await targets();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
  });
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  // 只取页面可视区，避免整页超长图
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url });
  console.log(`已打开 ${url}，等待就绪条件…`);

  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(700);
    try {
      const r = await send('Runtime.evaluate', { expression: ready, returnByValue: true });
      if (r.result && r.result.value === true) { ok = true; break; }
    } catch { /* 页面还在导航中 */ }
  }
  // 就绪后多等一拍，让 CSS 过渡（进度条 width、闪烁）落定，否则截图会抓到动画中间帧
  await sleep(1500);
  console.log(ok ? `就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`
                 : `★ 超时 ${timeoutMs}ms 未满足就绪条件，仍截图（可能停在中间态）`);
  if (!ok) exitCode = 3;

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + out);
  ws.close();
} catch (e) {
  console.error('失败：' + (e && e.message));
  exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  process.exit(exitCode);
}
