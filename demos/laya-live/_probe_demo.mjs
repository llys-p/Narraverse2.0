#!/usr/bin/env node
/**
 * _probe_demo.mjs —— 打开 /demo?auto=N，等一轮跑完，把页面里的文字读出来。
 *
 * 为什么不用截图读：面板很窄，`选中` 徽标落在哪一行、门限提示有没有出现，
 * 在像素上基本看不清（字号 ~9px）。innerText 是唯一不会读错的来源。
 *
 * 用法: node _probe_demo.mjs "<url>" "<超时ms>"
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2] || 'http://127.0.0.1:8130/demo?auto=7';
const timeoutMs = Number(process.argv[3]) || 120000;
const PORT = 9600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'edge-probe-'));

const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=2000,1200', '--no-first-run',
  '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

let code = 0;
try {
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 失败')));
  });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pend.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); reject(new Error('超时 ' + method)); } }, 60000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(800);
    try {
      const r = await send('Runtime.evaluate', {
        expression: "!document.getElementById('pending') && (document.querySelector('#panel')?.innerText||'').length>200",
        returnByValue: true,
      });
      if (r.result?.value === true) break;
    } catch { /* 导航中 */ }
  }
  const out = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      panel: document.querySelector('#panel')?.innerText || '',
      lastMsg: [...document.querySelectorAll('#chat .msg')].slice(-2).map(e=>e.innerText).join('\\n---\\n'),
      top: document.querySelector('#stLat')?.parentElement?.innerText || ''
    })`,
    returnByValue: true,
  });
  const j = JSON.parse(out.result.value);
  console.log('===== 右栏 DECISION ENGINE =====');
  console.log(j.panel);
  console.log('\n===== 对话区最后两条 =====');
  console.log(j.lastMsg);
  ws.close();
} catch (e) {
  console.error('失败：' + e.message);
  code = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  process.exit(code);
}
