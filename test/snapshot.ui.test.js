'use strict';

/**
 * 方案快照界面冒烟（jsdom）：
 *  - 保存命名快照（localStorage 持久化）、列表与 A/B 槽位自动填充
 *  - 8 个上限提示、删除、覆盖
 *  - 载入快照还原舞台
 *  - A=快照 / B=当前场景：编辑场景后差异立即刷新（新增/消失碰撞）
 *  - 差异结果中的时刻点击跳转播放头
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const core = require('../public/core.js');

const PUBLIC = path.join(__dirname, '..', 'public');

function makeCtx() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      switch (prop) {
        case 'createLinearGradient': return () => gradient;
        case 'measureText': return () => ({ width: 10 });
        default:
          if (prop in t) return t[prop];
          return typeof prop === 'string' ? noop : undefined;
      }
    },
    set(t, prop, val) { t[prop] = val; return true; }
  });
}

async function boot() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
  window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0
  });
  window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.setPointerCapture = () => {};

  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve(core.builtinScene()) });

  const origGet = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'timeline-lanes') {
      return { left: 14, top: 40, width: 972, height: 88, right: 986, bottom: 128, x: 14, y: 40 };
    }
    if (this.id === 'timeline') {
      return { left: 0, top: 0, width: 1000, height: 140, right: 1000, bottom: 140, x: 0, y: 0 };
    }
    if (this.tagName === 'CANVAS') {
      return { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0 };
    }
    return origGet.call(this);
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.id === 'timeline-lanes' ? 972 : 100; }
  });

  window.eval(fs.readFileSync(path.join(PUBLIC, 'core.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'));
  await new Promise((r) => setTimeout(r, 40));
  return dom;
}

function saveSnapshot(doc, name) {
  const input = doc.getElementById('snap-name');
  input.value = name;
  doc.getElementById('btn-snap-save').click();
}

test('快照：保存后出现在列表/localStorage，前两个自动填入 A、B 槽位', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  // 初始无快照
  assert.equal(doc.querySelectorAll('.snap-row').length, 0);
  assert.equal(doc.getElementById('snap-slot-a').value, '__live__');
  assert.equal(doc.getElementById('snap-slot-b').value, '__live__');

  saveSnapshot(doc, '初排');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 1);
  assert.match(doc.querySelector('.snap-row .snap-name').textContent, /初排/);
  assert.notEqual(doc.getElementById('snap-slot-a').value, '__live__', 'A 自动选首个快照');

  // localStorage 持久化：可读回且场景为 4 人 12s
  const raw = JSON.parse(window.localStorage.getItem('trajectory-stage:snapshots:v1'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, '初排');
  assert.equal(raw[0].scene.performers.length, 4);
  assert.equal(raw[0].scene.duration, 12);

  // 修改当前场景（清空走位）后再存第二个 → B 自动选它
  doc.getElementById('btn-clear').click();
  saveSnapshot(doc, '清空版');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 2);
  assert.notEqual(doc.getElementById('snap-slot-b').value, '__live__', 'B 自动选第二个快照');
  dom.window.close();
});

test('快照：A=初排 B=当前场景，编辑后碰撞对"消失"立即刷新', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  saveSnapshot(doc, '初排');
  await new Promise((r) => setTimeout(r, 5));
  // 当前 B 槽为"当前场景"，与快照相同 → 差异区无消失/新增行
  doc.getElementById('btn-clear').click();
  await new Promise((r) => setTimeout(r, 5));

  const diff = doc.getElementById('snap-diff');
  assert.equal(diff.hidden, false, '差异面板渲染');
  // 清空版所有人都退到各自首帧附近静止；快照中 丙×丁 持续碰撞在当前场景消失
  const removedRows = [...diff.querySelectorAll('.diff-row')]
    .filter((r) => r.querySelector('.diff-kd.removed'));
  assert.ok(removedRows.length >= 1, '至少一个碰撞对/侵入标记为消失');
  const removedText = removedRows.map((r) => r.textContent).join('\n');
  assert.match(removedText, /丙[\s\S]*丁|丁[\s\S]*丙/, '丙×丁 碰撞应在消失列表');
  // 摘要展示统一时刻轴与方案身份
  assert.match(diff.querySelector('.diff-summary').textContent, /统一时刻轴/);
  assert.match(diff.querySelector('.diff-summary').textContent, /初排[\s\S]*当前场景/);
  dom.window.close();
});

test('快照：保存第二个后改场景 → B 槽仍指向快照（不实时变），切回"当前场景"才刷新', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  saveSnapshot(doc, 's1');
  doc.getElementById('btn-clear').click();
  saveSnapshot(doc, 's2');
  await new Promise((r) => setTimeout(r, 5));
  const bId = doc.getElementById('snap-slot-b').value;
  assert.notEqual(bId, '__live__');

  // 继续编辑当前场景：B 槽是固定快照，差异摘要身份不变
  doc.getElementById('btn-clear').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.getElementById('snap-slot-b').value, bId, '槽位保持快照选择');
  assert.match(doc.getElementById('snap-diff').querySelector('.diff-summary').textContent, /s2/);
  dom.window.close();
});

test('快照：差异结果时刻可点击跳转播放头', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;
  const canvas = doc.getElementById('stage');

  saveSnapshot(doc, '原始');
  await new Promise((r) => setTimeout(r, 5));
  // B = 当前场景；把乙两帧移到 x=300（消除甲乙碰撞，制造位置偏移）
  function pointer(type, x, y) {
    canvas.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
  }
  pointer('pointerdown', 500, 40);
  pointer('pointermove', 300, 40);
  pointer('pointerup', 300, 40);
  pointer('pointerdown', 500, 560);
  pointer('pointermove', 300, 560);
  pointer('pointerup', 300, 560);
  await new Promise((r) => setTimeout(r, 10));

  const diff = doc.getElementById('snap-diff');
  // 同名乙最大偏移：两帧各偏移 200 → 200 单位，发生在 t=0/12
  const offsetRows = [...diff.querySelectorAll('.diff-row')].filter((r) =>
    /最大偏移/.test(r.textContent) && /乙/.test(r.textContent));
  assert.ok(offsetRows.length, '列出乙的位置偏移');
  assert.match(offsetRows[0].textContent, /200\.0/);

  // 点击乙偏移时刻（t=0）→ 播放头跳到 0
  const chip = offsetRows[0].querySelector('.t-jump[data-t]');
  doc.getElementById('time-input').value = '7';
  doc.getElementById('time-input').dispatchEvent(new window.Event('change', { bubbles: true }));
  chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tv = Number(doc.getElementById('time-input').value);
  assert.ok(Math.abs(tv - Number(chip.getAttribute('data-t'))) < 0.01,
    `播放头应跳到 ${chip.getAttribute('data-t')}，实际 ${tv}`);
  dom.window.close();
});

test('快照：删除快照后槽位回退"当前场景"，列表与差异更新', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  saveSnapshot(doc, '将删除');
  await new Promise((r) => setTimeout(r, 5));
  const delBtn = doc.querySelector('.snap-row .snap-del');
  delBtn.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 0);
  assert.equal(doc.getElementById('snap-slot-a').value, '__live__');
  assert.equal(doc.getElementById('snap-slot-b').value, '__live__');
  const raw = JSON.parse(window.localStorage.getItem('trajectory-stage:snapshots:v1'));
  assert.deepEqual(raw, []);
  // A=B=当前场景：差异为零偏移、无变化（面板仍可见）
  assert.equal(doc.getElementById('snap-diff').hidden, false);
  dom.window.close();
});

test('快照：最多 8 个，第 9 次保存被拦截并提示', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  for (let i = 1; i <= 8; i++) saveSnapshot(doc, '方案' + i);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 8);

  // 按钮在满 8 且名称非空时仍可提交（可能是同名覆盖）；这里用新名称按回车
  const input = doc.getElementById('snap-name');
  input.value = '第九个';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 8, '仍为 8 个');
  const msg = doc.getElementById('snap-msg');
  assert.equal(msg.hidden, false);
  assert.match(msg.textContent, /最多/);

  // 同名保存 = 覆盖，不增加数量
  input.value = '方案1';
  doc.getElementById('btn-snap-save').click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.snap-row').length, 8);
  const raw = JSON.parse(window.localStorage.getItem('trajectory-stage:snapshots:v1'));
  assert.equal(raw.length, 8);
  dom.window.close();
});

test('快照：覆盖按钮用当前场景替换快照内容', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  saveSnapshot(doc, 'v1');
  await new Promise((r) => setTimeout(r, 5));
  let raw = JSON.parse(window.localStorage.getItem('trajectory-stage:snapshots:v1'));
  assert.equal(raw[0].scene.obstacles.length, 1, '原样例有 1 个禁入区');

  // 删除中央禁入区（右键矩形中心），再点该行"覆盖"
  const canvas = doc.getElementById('stage');
  canvas.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 500, clientY: 300, button: 2
  }));
  await new Promise((r) => setTimeout(r, 5));
  doc.querySelector('.snap-row .snap-ops button:nth-child(2)').click(); // 覆盖
  await new Promise((r) => setTimeout(r, 5));
  raw = JSON.parse(window.localStorage.getItem('trajectory-stage:snapshots:v1'));
  assert.equal(raw[0].scene.obstacles.length, 0, '覆盖后快照记录禁入区已删除');
  assert.equal(doc.querySelectorAll('.snap-row').length, 1, '覆盖不新增快照');
  dom.window.close();
});

test('快照：载入按钮把快照场景还原到舞台', async () => {
  const dom = await boot();
  const { window } = dom;
  const doc = window.document;

  saveSnapshot(doc, '留档');
  await new Promise((r) => setTimeout(r, 5));
  // 清空当前舞台（仅保留每人首帧，时间轴时刻柄从 10 降到 4）
  doc.getElementById('btn-clear').click();
  assert.equal(doc.querySelectorAll('.tl-key').length, 4, '清空后每人 1 帧');

  doc.querySelector('.snap-row .snap-ops button:nth-child(1)').click(); // 载入
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(doc.querySelectorAll('.tl-key').length, 10, '载入恢复为原样例 10 帧');
  assert.equal(doc.querySelectorAll('.performer-item').length, 4);
  assert.equal(doc.querySelectorAll('.pair-row').length, 6);
  dom.window.close();
});
