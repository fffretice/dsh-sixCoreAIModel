// 用本机 Chrome headless + DevTools 协议截网页。
// 不走 --screenshot：那个会等所有广告/统计脚本加载完，game8 会卡到 60s+。
// 这里自己控制节奏：navigate → 最多等 8s 加载事件 → 停 1.2s → 截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFetchUrl } from './safe-fetch.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  throw new Error('没找到 Chrome（可设 CHROME_PATH）');
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openWs(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('连 DevTools 超时')); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连 DevTools 失败')); };
  });
}

function cdpClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
      else resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  return { send, events };
}

/**
 * 截一张网页图，返回 PNG buffer。
 * @param {string} url
 * @param {{width?:number,height?:number,fullPage?:boolean,timeoutMs?:number}} opts
 */
export async function capturePage(url, opts = {}) {
  const checked = await validateFetchUrl(String(url));
  const target = checked.url.toString();
  const width = clamp(opts.width, 640, 1600, 1280);
  let height = clamp(opts.height, 800, 5000, 1800);
  const timeoutMs = clamp(opts.timeoutMs, 10000, 90000, 45000);
  const chrome = findChrome();
  const id = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const profile = path.join(os.tmpdir(), `surfshot-${id}`);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });

  let child;
  let ws;
  try {
    child = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error('等 Chrome DevTools 端口超时')), 15000);
      child.stderr.on('data', (b) => {
        err += String(b);
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(err);
        if (m) { clearTimeout(timer); resolve(m[1]); }
        if (err.length > 12000) err = err.slice(-6000);
      });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`启动 Chrome 失败：${e.message}`)); });
      child.on('close', (code) => { if (code !== null) { clearTimeout(timer); reject(new Error(`Chrome 提前退出（exit ${code}）：${err.slice(-200)}`)); } });
    });

    ws = await openWs(wsUrl, 10000);
    const cdp = cdpClient(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => cdp.send(method, params, sessionId);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // 只认 navigate 之后的新事件；否则会把 about:blank 的 load 当成页面加载完，截出白屏。
    const eventStart = cdp.events.length;
    await send('Page.navigate', { url: target });

    // 等加载事件，最多 8 秒；广告/统计继续跑也不管，页面主体已经在了。
    const loadDeadline = Date.now() + Math.min(8000, timeoutMs - 6000);
    while (Date.now() < loadDeadline) {
      if (cdp.events.slice(eventStart).some((e) => e.method === 'Page.loadEventFired' || e.method === 'Page.frameStoppedLoading')) break;
      await sleep(150);
    }
    // 再等 body 真正有内容；有的站 load 事件到了但首屏还是空的。
    const paintDeadline = Date.now() + 4000;
    while (Date.now() < paintDeadline) {
      try {
        const r = await send('Runtime.evaluate', { expression: 'document.readyState + "|" + ((document.body && document.body.innerText) ? document.body.innerText.length : 0)', returnByValue: true });
        const v = String(r?.result?.value || '');
        const [state, n] = v.split('|');
        if (state === 'complete' && Number(n) > 20) break;
      } catch {}
      await sleep(200);
    }
    await sleep(1500);

    if (opts.fullPage) {
      try {
        const metrics = await send('Page.getLayoutMetrics');
        const contentH = Math.ceil(Number(metrics?.cssContentSize?.height || metrics?.contentSize?.height || 0));
        if (contentH > height) {
          height = Math.min(5000, Math.max(height, contentH));
          await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await sleep(400);
        }
      } catch {}
    }

    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(String(shot.data || ''), 'base64');
    if (!buffer.length) throw new Error('截图是空的');
    if (buffer.length > 12 * 1024 * 1024) throw new Error('截图超过 12MB');
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error('截图不是 PNG');
    }
    return { buffer, url: target, width, height };
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
