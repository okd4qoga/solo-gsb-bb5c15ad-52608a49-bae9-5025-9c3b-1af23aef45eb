'use strict';

/* global CollisionCore */

(function () {
  var Core = CollisionCore;
  var WORLD_W = 1000;
  var WORLD_H = 600;
  var COLORS = ['#ef4444', '#38bdf8', '#22c55e', '#facc15', '#a78bfa', '#fb923c', '#f472b6', '#2dd4bf'];
  var KEY_HIT_PX = 9;      // 走位点命中半径（屏幕像素）
  var TICK_HIT_PX = 7;     // 时间轴时刻柄命中半径
  var NEW_OBS_SIZE = 120;  // 单击画布新增禁入矩形的默认边长

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var tooltip = document.getElementById('tooltip');

  // ---------- 全局状态 ----------
  var state = {
    duration: 12,
    performers: [],
    obstacles: [],
    selectedPid: null,
    selectedKey: null,      // {pid, index}
    selectedObstacleId: null,
    addObstacleMode: false, // 下一次在画布拖出/单击投放禁入矩形
    time: 0,
    playing: false,
    speed: 1,
    analysis: null,
    activePairKey: null,    // 结果面板选中的双人对
    drag: null              // 画布/时间轴拖拽上下文
  };

  function uid() {
    return 'p' + Math.random().toString(36).slice(2, 8);
  }

  function getPerformer(pid) {
    return state.performers.find(function (p) { return p.id === pid; }) || null;
  }

  function getObstacle(oid) {
    return state.obstacles.find(function (o) { return o.id === oid; }) || null;
  }

  // ---------- 场景装载 ----------
  function loadScene(scene, opts) {
    opts = opts || {};
    state.duration = Number(scene.duration) || 12;
    state.performers = (scene.performers || []).map(function (p, i) {
      return {
        id: p.id || uid(),
        name: p.name || '表演者' + (i + 1),
        color: p.color || COLORS[i % COLORS.length],
        radius: clampRadius(Number(p.radius)),
        keys: (p.keys || []).map(function (k) {
          var hasR = k.r !== undefined && k.r !== null && k.r !== '' && isFinite(Number(k.r));
          return {
            t: Number(k.t),
            x: Number(k.x),
            y: Number(k.y),
            // 缺省安全半径：null 表示继承表演者当前半径
            r: hasR ? clampRadius(Number(k.r)) : null
          };
        })
      };
    });
    // 禁入矩形经引擎同一规整（坐标/尺寸钳制、缺省 id/name 补全）
    state.obstacles = Core.normalizeObstacles(scene.obstacles).map(function (o) {
      o.x = Math.round(o.x);
      o.y = Math.round(o.y);
      o.width = Math.round(o.width);
      o.height = Math.round(o.height);
      return o;
    });
    state.selectedPid = state.performers[0] ? state.performers[0].id : null;
    state.selectedKey = null;
    state.selectedObstacleId = null;
    state.activePairKey = null;
    setAddObstacleMode(false);
    state.time = opts.keepTime ? Math.min(state.time, state.duration) : 0;
    state.playing = false;
    document.getElementById('duration-input').value = state.duration;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function clampRadius(r) {
    if (!isFinite(r) || r < 0) return 20;
    return Math.min(150, Math.round(r * 10) / 10);
  }

  // 关键帧生效安全半径：缺省（null）继承表演者当前半径
  function keyRadius(p, k) {
    return k && k.r !== null && k.r !== undefined ? k.r : p.radius;
  }

  // 取得当前选中关键帧对象（拖动/删帧可能使索引失效）
  function getSelectedKey() {
    if (!state.selectedKey) return null;
    var p = getPerformer(state.selectedKey.pid);
    if (!p) return null;
    var k = p.keys[state.selectedKey.index];
    return k ? { p: p, k: k, index: state.selectedKey.index } : null;
  }

  // ---------- 重算（拖动后立即调用） ----------
  function recompute() {
    state.analysis = Core.analyzeScene({
      duration: state.duration,
      performers: state.performers,
      obstacles: state.obstacles
    });
    renderSummary();
    renderPairs();
    renderObstacleResults();
    renderTimelineDanger();
    updatePlayhead();
  }

  // ---------- 坐标换算 ----------
  function view() {
    var rect = canvas.getBoundingClientRect();
    return {
      sx: rect.width / WORLD_W,
      sy: rect.height / WORLD_H,
      rect: rect
    };
  }
  function toWorld(clientX, clientY) {
    var v = view();
    return {
      x: (clientX - v.rect.left) / v.sx,
      y: (clientY - v.rect.top) / v.sy
    };
  }

  // ---------- 命中检测 ----------
  function hitTestObstacle(wx, wy) {
    // 后画的（列表末尾）在上层，优先命中
    for (var i = state.obstacles.length - 1; i >= 0; i--) {
      var o = state.obstacles[i];
      if (wx >= o.x && wx <= o.x + o.width && wy >= o.y && wy <= o.y + o.height) {
        return o;
      }
    }
    return null;
  }

  function hitTestKey(wx, wy) {
    var v = view();
    var tolX = KEY_HIT_PX / v.sx;
    var tolY = KEY_HIT_PX / v.sy;
    // 先选中的人优先，其余从上层往下
    var order = state.performers.slice().reverse();
    if (state.selectedPid) {
      order.sort(function (a, b) {
        return (b.id === state.selectedPid ? 1 : 0) - (a.id === state.selectedPid ? 1 : 0);
      });
    }
    for (var pi = 0; pi < order.length; pi++) {
      var p = order[pi];
      for (var i = p.keys.length - 1; i >= 0; i--) {
        var k = p.keys[i];
        if (Math.abs(k.x - wx) <= tolX && Math.abs(k.y - wy) <= tolY) {
          return { pid: p.id, index: i };
        }
      }
    }
    return null;
  }

  // ---------- 画布交互 ----------
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var w = toWorld(e.clientX, e.clientY);

    // 禁入区新增模式：拖出矩形（单击则投放默认尺寸）
    if (state.addObstacleMode) {
      state.drag = {
        type: 'obs-new',
        x0: w.x,
        y0: w.y,
        x1: w.x,
        y1: w.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    var hitObs = hitTestObstacle(w.x, w.y);
    if (hitObs) {
      state.selectedObstacleId = hitObs.id;
      state.selectedKey = null;
      state.drag = {
        type: 'obstacle',
        oid: hitObs.id,
        offX: w.x - hitObs.x,
        offY: w.y - hitObs.y,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      renderPerformers();
      draw();
      return;
    }

    var hit = hitTestKey(w.x, w.y);
    if (hit) {
      state.selectedPid = hit.pid;
      state.selectedKey = { pid: hit.pid, index: hit.index };
      state.selectedObstacleId = null;
      var p = getPerformer(hit.pid);
      state.drag = {
        type: 'key',
        pid: hit.pid,
        index: hit.index,
        moved: false,
        startKey: Object.assign({}, p.keys[hit.index])
      };
      canvas.setPointerCapture(e.pointerId);
      renderPerformers();
      draw();
    } else if (state.selectedPid) {
      // 空白按下：准备新增走位点（pointerup 未移动则加入）
      state.selectedObstacleId = null;
      state.drag = { type: 'new', x: w.x, y: w.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      draw();
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    var w = toWorld(e.clientX, e.clientY);
    var v = view();

    if (state.drag && state.drag.type === 'obs-new') {
      if (Math.abs(w.x - state.drag.x0) * v.sx > 4 || Math.abs(w.y - state.drag.y0) * v.sy > 4) {
        state.drag.moved = true;
      }
      state.drag.x1 = w.x;
      state.drag.y1 = w.y;
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'obstacle') {
      var o = getObstacle(state.drag.oid);
      if (!o) return;
      state.drag.moved = true;
      o.x = clamp(Math.round(w.x - state.drag.offX), 0, Math.max(0, WORLD_W - o.width));
      o.y = clamp(Math.round(w.y - state.drag.offY), 0, Math.max(0, WORLD_H - o.height));
      recompute();
      draw();
      return;
    }

    if (state.drag && state.drag.type === 'key') {
      state.drag.moved = true;
      var perf = getPerformer(state.drag.pid);
      var key = perf.keys[state.drag.index];
      key.x = clamp(Math.round(w.x), 0, WORLD_W);
      key.y = clamp(Math.round(w.y), 0, WORLD_H);
      recompute();
      draw();
      showTooltip(e, perf, key);
      return;
    }

    if (state.drag && state.drag.type === 'new') {
      if (Math.abs(w.x - state.drag.x) * v.sx > 4 || Math.abs(w.y - state.drag.y) * v.sy > 4) {
        state.drag.moved = true;
      }
      return;
    }

    // 悬停命中提示
    if (state.addObstacleMode) {
      canvas.style.cursor = 'crosshair';
      tooltip.hidden = true;
      return;
    }
    var hoverObs = hitTestObstacle(w.x, w.y);
    var hover = hitTestKey(w.x, w.y);
    if (hoverObs) {
      canvas.style.cursor = 'move';
      var intruders = currentObstacleIntruders(state.time)[hoverObs.id];
      tooltip.hidden = false;
      tooltip.textContent = hoverObs.name + ' · 禁入矩形 (' + Math.round(hoverObs.x) + ', ' +
        Math.round(hoverObs.y) + ') ' + Math.round(hoverObs.width) + '×' + Math.round(hoverObs.height) +
        (intruders ? ' · 当前侵入 ' + intruders : ' · 拖动移位 · 右键删除');
      positionTooltip(e);
    } else if (hover) {
      canvas.style.cursor = 'grab';
      var hp = getPerformer(hover.pid);
      var hk = hp.keys[hover.index];
      showTooltip(e, hp, hk);
    } else {
      canvas.style.cursor = state.selectedPid ? 'crosshair' : 'default';
      tooltip.hidden = true;
    }
  });

  function positionTooltip(e) {
    var wrapRect = canvas.parentElement.getBoundingClientRect();
    tooltip.style.left = (e.clientX - wrapRect.left) + 'px';
    tooltip.style.top = (e.clientY - wrapRect.top) + 'px';
  }

  canvas.addEventListener('pointerup', function (e) {
    if (!state.drag) return;
    var drag = state.drag;
    if (drag.type === 'obs-new') {
      var w2 = toWorld(e.clientX, e.clientY);
      if (drag.moved) {
        addObstacleRect(drag.x0, drag.y0, w2.x, w2.y);
      } else {
        // 单击：以落点附近为左上角投放默认尺寸矩形（自动收回画布内）
        addObstacleRect(w2.x, w2.y, w2.x + NEW_OBS_SIZE, w2.y + NEW_OBS_SIZE);
      }
    } else if (drag.type === 'new' && !drag.moved && state.selectedPid) {
      var w3 = toWorld(e.clientX, e.clientY);
      addKey(state.selectedPid, state.time, w3.x, w3.y);
    }
    if (drag.type === 'key') {
      tooltip.hidden = true;
    }
    state.drag = null;
    renderTimelineStatic();
    draw();
  });

  canvas.addEventListener('pointerleave', function () {
    if (!state.drag) tooltip.hidden = true;
  });

  // 双击空白：在当前播放时刻为选中者加帧（与单击新增并存，双击更直观）
  canvas.addEventListener('dblclick', function (e) {
    if (state.addObstacleMode || !state.selectedPid) return;
    var w = toWorld(e.clientX, e.clientY);
    if (hitTestObstacle(w.x, w.y)) return;
    if (hitTestKey(w.x, w.y)) return;
    addKey(state.selectedPid, state.time, w.x, w.y);
  });

  // 右键圆点：删除该走位点（每人保留至少 1 帧）；右键禁入矩形：删除该矩形
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var w = toWorld(e.clientX, e.clientY);
    var hitObs = hitTestObstacle(w.x, w.y);
    if (hitObs) {
      removeObstacle(hitObs.id);
      return;
    }
    var hit = hitTestKey(w.x, w.y);
    if (hit) {
      removeKey(hit.pid, hit.index);
    }
  });

  function showTooltip(e, p, k) {
    tooltip.hidden = false;
    var custom = k.r !== null && k.r !== undefined;
    tooltip.textContent = p.name + ' · t=' + k.t.toFixed(1) + 's · (' +
      Math.round(k.x) + ', ' + Math.round(k.y) + ') · 安全半径 ' + keyRadius(p, k) +
      (custom ? '（关键帧）' : '（继承 ' + p.radius + '）');
    positionTooltip(e);
  }

  function addKey(pid, t, x, y) {
    var p = getPerformer(pid);
    if (!p) return;
    var tt = clamp(Math.round(t * 10) / 10, 0, state.duration);
    var xx = clamp(Math.round(x), 0, WORLD_W);
    var yy = clamp(Math.round(y), 0, WORLD_H);

    // 同时刻已存在则移动该帧（保留其安全半径设置）
    var existing = p.keys.findIndex(function (k) { return Math.abs(k.t - tt) < 1e-6; });
    if (existing >= 0) {
      p.keys[existing].x = xx;
      p.keys[existing].y = yy;
      state.selectedKey = { pid: pid, index: existing };
    } else {
      p.keys.push({ t: tt, x: xx, y: yy, r: null });
      p.keys.sort(function (a, b) { return a.t - b.t; });
      state.selectedKey = { pid: pid, index: p.keys.findIndex(function (k) { return Math.abs(k.t - tt) < 1e-6; }) };
    }
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removeKey(pid, index) {
    var p = getPerformer(pid);
    if (!p || p.keys.length <= 1) return;
    p.keys.splice(index, 1);
    state.selectedKey = null;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  // ---------- 选中关键帧：安全半径编辑 ----------
  var keyEditorEl = document.getElementById('key-editor');
  var keInfoEl = document.getElementById('ke-info');
  var keRadiusInput = document.getElementById('ke-radius');
  var keHintEl = document.getElementById('ke-hint');
  var keClearBtn = document.getElementById('ke-clear');

  // 每次重绘同步编辑面板（输入聚焦时不覆盖正在键入的数值）
  function renderKeyEditor() {
    var sel = getSelectedKey();
    if (!sel) {
      keyEditorEl.hidden = true;
      return;
    }
    keyEditorEl.hidden = false;
    var p = sel.p;
    var k = sel.k;
    keInfoEl.textContent = p.name + ' · t=' + k.t.toFixed(1) +
      's · (' + Math.round(k.x) + ', ' + Math.round(k.y) + ')';
    var custom = k.r !== null && k.r !== undefined;
    if (document.activeElement !== keRadiusInput) {
      keRadiusInput.value = custom ? k.r : '';
    }
    keRadiusInput.placeholder = String(p.radius);
    keHintEl.textContent = custom
      ? '本帧占用范围，与相邻关键帧线性插值'
      : '留空 = 继承表演者当前半径 ' + p.radius;
    keClearBtn.disabled = !custom;
  }

  function afterKeyRadiusEdit() {
    recompute();          // 立即刷新碰撞区间
    renderTimelineStatic();
    draw();               // 画布实时呈现新范围
  }

  function commitKeyRadius(live) {
    var sel = getSelectedKey();
    if (!sel) return;
    var raw = String(keRadiusInput.value).trim();
    if (raw === '') {
      // 实时输入时空串不打断键入；失焦提交时恢复继承
      if (!live) {
        sel.k.r = null;
        afterKeyRadiusEdit();
      }
      return;
    }
    var v = Number(raw);
    if (isFinite(v) && v >= 0) {
      sel.k.r = clampRadius(v);
      afterKeyRadiusEdit();
    }
  }

  keRadiusInput.addEventListener('input', function () { commitKeyRadius(true); });
  keRadiusInput.addEventListener('change', function () {
    commitKeyRadius(false);
    var sel = getSelectedKey();
    if (sel && sel.k.r !== null && sel.k.r !== undefined) keRadiusInput.value = sel.k.r;
  });
  keClearBtn.addEventListener('click', function () {
    var sel = getSelectedKey();
    if (!sel) return;
    sel.k.r = null;
    afterKeyRadiusEdit();
  });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---------- 禁入矩形：新增 / 删除 / 编辑 ----------
  var btnObstacle = document.getElementById('btn-obstacle');
  var obstacleEditorEl = document.getElementById('obstacle-editor');
  var oeInfoEl = document.getElementById('oe-info');
  var oeNameInput = document.getElementById('oe-name');
  var oeWidthInput = document.getElementById('oe-width');
  var oeHeightInput = document.getElementById('oe-height');
  var oeDeleteBtn = document.getElementById('oe-delete');

  function setAddObstacleMode(on) {
    state.addObstacleMode = !!on;
    btnObstacle.classList.toggle('active', state.addObstacleMode);
    btnObstacle.textContent = state.addObstacleMode ? '✕ 取消禁入区' : '＋ 禁入区';
    canvas.style.cursor = state.addObstacleMode ? 'crosshair' : '';
  }

  btnObstacle.addEventListener('click', function () {
    setAddObstacleMode(!state.addObstacleMode);
  });

  function addObstacleRect(x0, y0, x1, y1) {
    var x = clamp(Math.round(Math.min(x0, x1)), 0, WORLD_W);
    var y = clamp(Math.round(Math.min(y0, y1)), 0, WORLD_H);
    var right = clamp(Math.round(Math.max(x0, x1)), 0, WORLD_W);
    var bottom = clamp(Math.round(Math.max(y0, y1)), 0, WORLD_H);
    var width = right - x;
    var height = bottom - y;
    // 单击或极小拖框：视为默认尺寸，以落点为中心收回画布内
    if (width < 4 || height < 4) {
      width = NEW_OBS_SIZE;
      height = NEW_OBS_SIZE;
      x = clamp(x - Math.round(NEW_OBS_SIZE / 2), 0, WORLD_W - width);
      y = clamp(y - Math.round(NEW_OBS_SIZE / 2), 0, WORLD_H - height);
    }
    var normalized = Core.normalizeObstacles([{ x: x, y: y, width: width, height: height }])[0];
    state.obstacles.push(normalized);
    state.selectedObstacleId = normalized.id;
    state.selectedKey = null;
    setAddObstacleMode(false);
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removeObstacle(oid) {
    state.obstacles = state.obstacles.filter(function (o) { return o.id !== oid; });
    if (state.selectedObstacleId === oid) state.selectedObstacleId = null;
    recompute();
    renderTimelineStatic();
    draw();
  }

  function getSelectedObstacle() {
    if (!state.selectedObstacleId) return null;
    return getObstacle(state.selectedObstacleId);
  }

  function renderObstacleEditor() {
    var o = getSelectedObstacle();
    if (!o) {
      obstacleEditorEl.hidden = true;
      return;
    }
    obstacleEditorEl.hidden = false;
    oeInfoEl.textContent = o.name + ' · (' + Math.round(o.x) + ', ' + Math.round(o.y) + ')';
    if (document.activeElement !== oeNameInput) oeNameInput.value = o.name;
    if (document.activeElement !== oeWidthInput) oeWidthInput.value = Math.round(o.width);
    if (document.activeElement !== oeHeightInput) oeHeightInput.value = Math.round(o.height);
  }

  oeNameInput.addEventListener('change', function () {
    var o = getSelectedObstacle();
    if (!o) return;
    o.name = oeNameInput.value.trim() || o.name;
    recompute();
    draw();
  });
  oeNameInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

  function commitObstacleSize() {
    var o = getSelectedObstacle();
    if (!o) return;
    var w = Number(oeWidthInput.value);
    var h = Number(oeHeightInput.value);
    // 只提交正在编辑的那一维；留空/非法的一维保持原值
    if (isFinite(w) && w >= 0 && oeWidthInput.value !== '') {
      o.width = clamp(Math.round(w), 0, WORLD_W);
    }
    if (isFinite(h) && h >= 0 && oeHeightInput.value !== '') {
      o.height = clamp(Math.round(h), 0, WORLD_H);
    }
    o.x = clamp(o.x, 0, Math.max(0, WORLD_W - o.width));
    o.y = clamp(o.y, 0, Math.max(0, WORLD_H - o.height));
    recompute();
    draw();
  }
  oeWidthInput.addEventListener('change', commitObstacleSize);
  oeHeightInput.addEventListener('change', commitObstacleSize);
  oeDeleteBtn.addEventListener('click', function () {
    if (state.selectedObstacleId) removeObstacle(state.selectedObstacleId);
  });

  // ---------- 画布绘制 ----------
  function draw() {
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    drawGrid();

    var t = state.time;
    var dangerIds = currentDangerIds(t);
    var obsIntrude = currentObstacleIntruders(t);
    Object.keys(obsIntrude).forEach(function (oid) {
      obsIntrude[oid].forEach(function (pid) { dangerIds[pid] = true; });
    });

    // 路径折线
    state.performers.forEach(function (p) {
      drawPath(p, dangerIds[p.id]);
    });

    // 选中者各关键帧的安全半径盘（开伞/道具占用范围）
    state.performers.forEach(function (p) {
      if (p.id === state.selectedPid) drawKeyRadii(p);
    });

    // 危险区间内：先画碰撞连线与红色半径盘
    drawCollisionLinks(t);

    // 禁入矩形（在关键帧圆点之下、身体盘之下）
    state.obstacles.forEach(function (o) {
      drawObstacle(o, obsIntrude[o.id]);
    });
    drawObstacleDraft();

    // 关键帧圆点
    state.performers.forEach(function (p) {
      drawKeys(p);
    });

    // 当前身体位置（半径为关键帧半径线性插值后的实时安全半径）
    state.performers.forEach(function (p) {
      var st = Core.stateAt(p.keys, t, p.radius);
      drawBody(p, st, dangerIds[p.id]);
    });

    renderKeyEditor();
    renderObstacleEditor();
    updateObstacleResultActive(t);
  }

  function drawGrid() {
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= WORLD_W; x += 50) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, WORLD_H);
    }
    for (var y = 0; y <= WORLD_H; y += 50) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(WORLD_W, y + 0.5);
    }
    ctx.stroke();

    // 舞台边框
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, WORLD_W - 2, WORLD_H - 2);
  }

  function dim(color, alpha) {
    // #rrggbb -> rgba
    var n = parseInt(color.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function drawPath(p, danger) {
    if (p.keys.length === 0) return;
    var ks = Core.normalizeKeys(p.keys);
    var isSel = p.id === state.selectedPid;
    ctx.strokeStyle = dim(p.color, isSel ? 0.95 : 0.5);
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.setLineDash(isSel ? [] : [7, 6]);
    ctx.beginPath();
    ks.forEach(function (k, i) {
      if (i === 0) ctx.moveTo(k.x, k.y);
      else ctx.lineTo(k.x, k.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // 已经走过的轨迹加亮
    if (ks.length >= 2) {
      ctx.strokeStyle = dim(p.color, 0.28);
      ctx.lineWidth = isSel ? 7 : 5;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < ks.length - 1; i++) {
        var a = ks[i], b = ks[i + 1];
        if (t_between(state.time, a.t, b.t)) {
          var cur = Core.positionAt(ks, state.time);
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          ctx.lineTo(cur.x, cur.y);
        } else if (b.t <= state.time) {
          if (!started) { ctx.moveTo(a.x, a.y); started = true; }
          ctx.lineTo(b.x, b.y);
        }
      }
      ctx.stroke();
    }
    if (danger) {
      ctx.strokeStyle = 'rgba(248,81,73,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ks.forEach(function (k, i) {
        if (i === 0) ctx.moveTo(k.x, k.y);
        else ctx.lineTo(k.x, k.y);
      });
      ctx.stroke();
    }
  }

  function t_between(t, a, b) {
    return t >= a && t <= b;
  }

  // 选中表演者各关键帧的安全半径盘：自定义半径实线标注，继承半径虚线淡显
  function drawKeyRadii(p) {
    p.keys.forEach(function (k, i) {
      var custom = k.r !== null && k.r !== undefined;
      var rr = keyRadius(p, k);
      var selected = state.selectedKey &&
        state.selectedKey.pid === p.id && state.selectedKey.index === i;
      ctx.beginPath();
      ctx.arc(k.x, k.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = dim(p.color, custom ? (selected ? 0.14 : 0.08) : 0.04);
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = custom
        ? dim(p.color, selected ? 0.95 : 0.6)
        : 'rgba(255,255,255,0.18)';
      ctx.setLineDash(custom ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  function drawKeys(p) {
    var isSel = p.id === state.selectedPid;
    p.keys.forEach(function (k, i) {
      var selected = state.selectedKey &&
        state.selectedKey.pid === p.id && state.selectedKey.index === i;
      ctx.beginPath();
      ctx.arc(k.x, k.y, selected ? 8 : (isSel ? 6.5 : 5), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.7)';
      ctx.stroke();

      // 时刻标签（选中者）；自定义安全半径附加标注
      if (isSel) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(230,237,243,0.85)';
        var label = k.t.toFixed(1) + 's';
        if (k.r !== null && k.r !== undefined) label += ' r' + k.r;
        ctx.fillText(label, k.x + 9, k.y - 8);
      }
    });
  }

  function drawBody(p, st, danger) {
    var r = st.r;
    // 身体安全半径盘（播放时随关键帧半径线性张开/收拢）
    ctx.beginPath();
    ctx.arc(st.x, st.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim(p.color, danger ? 0.32 : 0.16);
    ctx.fill();
    ctx.lineWidth = danger ? 3 : 2;
    ctx.strokeStyle = danger ? '#f85149' : dim(p.color, 0.9);
    ctx.stroke();

    // 圆心
    ctx.beginPath();
    ctx.arc(st.x, st.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 名牌
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = danger ? '#ff8f8a' : 'rgba(230,237,243,0.95)';
    ctx.fillText(p.name, st.x + r + 6, st.y - r - 4);
  }

  function currentDangerIds(t) {
    var map = {};
    if (!state.analysis) return map;
    state.analysis.pairs.forEach(function (pair) {
      if (!pair.collision) return;
      if (Core.isPerformerInCollision(pair, pair.aId, t)) {
        map[pair.aId] = true;
        map[pair.bId] = true;
      }
    });
    return map;
  }

  // 时刻 t 各禁入矩形的当前侵入者：{ obstacleId: [performerId...] }
  function currentObstacleIntruders(t) {
    var map = {};
    if (!state.analysis) return map;
    state.analysis.obstacleConflicts.forEach(function (entry) {
      if (Core.isPerformerInObstacle(entry, entry.performerId, t)) {
        (map[entry.obstacleId] = map[entry.obstacleId] || []).push(entry.performerId);
      }
    });
    return map;
  }

  // ---------- 禁入矩形绘制 ----------
  function drawObstacle(o, intruderIds) {
    var intruding = intruderIds && intruderIds.length > 0;
    var selected = o.id === state.selectedObstacleId;
    ctx.save();
    ctx.fillStyle = intruding ? 'rgba(248,81,73,0.20)' : 'rgba(139,152,165,0.13)';
    ctx.fillRect(o.x, o.y, o.width, o.height);

    // 斜纹（禁入语义）
    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, o.width, o.height);
    ctx.clip();
    ctx.strokeStyle = intruding ? 'rgba(248,81,73,0.28)' : 'rgba(139,152,165,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    for (var d = -o.height; d < o.width; d += 16) {
      ctx.beginPath();
      ctx.moveTo(o.x + d, o.y);
      ctx.lineTo(o.x + d + o.height, o.y + o.height);
      ctx.stroke();
    }
    ctx.restore();

    ctx.setLineDash(intruding ? [] : [8, 5]);
    ctx.lineWidth = intruding ? 3 : (selected ? 2.5 : 2);
    ctx.strokeStyle = intruding ? '#f85149' : (selected ? '#58a6ff' : 'rgba(190,200,212,0.75)');
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, Math.max(0, o.width - 1), Math.max(0, o.height - 1));
    ctx.setLineDash([]);

    // 名称与当前侵入标注
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = intruding ? '#ff8f8a' : 'rgba(230,237,243,0.9)';
    var label = o.name;
    ctx.fillText(label, o.x + 8, o.y + 18);
    if (intruding) {
      var names = intruderIds.map(function (pid) {
        var p = getPerformer(pid);
        return p ? p.name : pid;
      }).join('、');
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#ffb3ae';
      ctx.fillText('⚠ 侵入：' + names, o.x + 8, o.y + o.height - 8);
    }
    ctx.restore();
  }

  // 新增禁入区拖框预览
  function drawObstacleDraft() {
    if (!state.drag || state.drag.type !== 'obs-new') return;
    var d = state.drag;
    var x = Math.min(d.x0, d.x1);
    var y = Math.min(d.y0, d.y1);
    var w = Math.abs(d.x1 - d.x0);
    var h = Math.abs(d.y1 - d.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(88,166,255,0.14)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawCollisionLinks(t) {
    if (!state.analysis) return;
    state.analysis.pairs.forEach(function (pair) {
      if (!Core.isPerformerInCollision(pair, pair.aId, t)) return;
      var pa = getPerformer(pair.aId);
      var pb = getPerformer(pair.bId);
      if (!pa || !pb) return;
      var paSt = Core.stateAt(pa.keys, t, pa.radius);
      var pbSt = Core.stateAt(pb.keys, t, pb.radius);
      ctx.beginPath();
      ctx.moveTo(paSt.x, paSt.y);
      ctx.lineTo(pbSt.x, pbSt.y);
      ctx.strokeStyle = 'rgba(248,81,73,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      var d = Math.hypot(paSt.x - pbSt.x, paSt.y - pbSt.y);
      var gap = d - paSt.r - pbSt.r;
      var mx = (paSt.x + pbSt.x) / 2;
      var my = (paSt.y + pbSt.y) / 2;
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillStyle = '#ff8f8a';
      ctx.fillText('间距 ' + d.toFixed(1) + ' / 半径和 ' + (paSt.r + pbSt.r).toFixed(0) +
        '（侵入 ' + Math.max(0, -gap).toFixed(1) + '）', mx + 6, my - 6);
    });
  }

  // ---------- 表演者侧栏 ----------
  function renderPerformers() {
    var box = document.getElementById('performers');
    box.innerHTML = '';
    state.performers.forEach(function (p, idx) {
      var row = document.createElement('div');
      row.className = 'performer-item' + (p.id === state.selectedPid ? ' selected' : '');

      var dot = document.createElement('span');
      dot.className = 'performer-dot';
      dot.style.background = p.color;

      var name = document.createElement('input');
      name.className = 'performer-name';
      name.value = p.name;
      name.addEventListener('change', function () {
        p.name = name.value.trim() || ('表演者' + (idx + 1));
        recompute();
        renderPairs();
      });
      name.addEventListener('click', function (e) { e.stopPropagation(); });
      name.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

      var radiusWrap = document.createElement('span');
      radiusWrap.style.display = 'flex';
      radiusWrap.style.alignItems = 'center';
      radiusWrap.style.gap = '3px';
      var rInput = document.createElement('input');
      rInput.className = 'performer-radius';
      rInput.type = 'number';
      rInput.min = '0';
      rInput.max = '150';
      rInput.step = '1';
      rInput.value = p.radius;
      rInput.title = '身体半径（世界单位）';
      rInput.addEventListener('change', function () {
        p.radius = clampRadius(Number(rInput.value));
        rInput.value = p.radius;
        recompute();
        renderTimelineStatic();
        draw();
      });
      rInput.addEventListener('click', function (e) { e.stopPropagation(); });
      rInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      radiusWrap.appendChild(rInput);

      var del = document.createElement('button');
      del.className = 'performer-del';
      del.textContent = '✕';
      del.title = '删除该表演者（至少保留 2 人）';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removePerformer(p.id);
      });

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(radiusWrap);
      row.appendChild(del);
      row.addEventListener('click', function () {
        state.selectedPid = p.id;
        state.selectedKey = null;
        renderPerformers();
        renderTimelineStatic();
        draw();
      });
      box.appendChild(row);
    });

    document.getElementById('btn-add').disabled = state.performers.length >= 8;
  }

  function addPerformer() {
    if (state.performers.length >= 8) return;
    var idx = state.performers.length;
    var np = {
      id: uid(),
      name: '表演者' + (idx + 1),
      color: COLORS[idx % COLORS.length],
      radius: 20,
      keys: [
        { t: 0, x: 80 + idx * 60, y: 80 + idx * 40, r: null },
        { t: state.duration, x: WORLD_W - 80 - idx * 40, y: WORLD_H - 80 - idx * 30, r: null }
      ]
    };
    state.performers.push(np);
    state.selectedPid = np.id;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  function removePerformer(pid) {
    if (state.performers.length <= 2) return;
    state.performers = state.performers.filter(function (p) { return p.id !== pid; });
    if (state.selectedPid === pid) {
      state.selectedPid = state.performers[0].id;
      state.selectedKey = null;
    }
    state.activePairKey = null;
    recompute();
    renderPerformers();
    renderTimelineStatic();
    draw();
  }

  // ---------- 摘要与逐对结果 ----------
  function fmt(v, d) {
    return (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d);
  }

  function pairKey(pair) {
    return pair.aId + '|' + pair.bId;
  }

  function renderSummary() {
    var a = state.analysis;
    var firstEl = document.getElementById('sum-first');
    var firstWho = document.getElementById('sum-first-who');
    var minEl = document.getElementById('sum-min');
    var minWho = document.getElementById('sum-min-who');
    var marginEl = document.getElementById('sum-margin');
    var marginWho = document.getElementById('sum-margin-who');

    if (a.firstContact === null) {
      firstEl.textContent = '无碰撞';
      firstEl.className = 'ok';
      firstWho.textContent = '—';
    } else {
      firstEl.textContent = fmt(a.firstContact) + ' s';
      firstEl.className = 'danger';
      var fp = a.pairs.find(function (p) {
        return p.aId === a.firstContactPair[0] && p.bId === a.firstContactPair[1];
      });
      firstWho.textContent = fp ? fp.aName + ' × ' + fp.bName : '—';
      firstWho.style.color = 'var(--danger)';
    }

    minEl.textContent = fmt(a.minDistance) + ' 单位';
    minEl.className = a.firstContact !== null ? 'danger' : 'ok';
    var cp = a.pairs.find(function (p) {
      return p.aId === a.minDistancePair[0] && p.bId === a.minDistancePair[1];
    });
    minWho.textContent = (cp ? cp.aName + ' × ' + cp.bName + ' @ ' + fmt(a.minDistanceT) + 's' : '—');

    // 全局最小安全余量：distance(t) - (rA+rB) 的连续最小值（≤0 即存在碰撞）
    marginEl.textContent = fmt(a.minMargin) + ' 单位';
    marginEl.className = a.minMargin !== null && a.minMargin <= 0 ? 'danger' : 'ok';
    var mp = a.minMarginPair && a.pairs.find(function (p) {
      return p.aId === a.minMarginPair[0] && p.bId === a.minMarginPair[1];
    });
    marginWho.textContent = mp ? mp.aName + ' × ' + mp.bName + ' @ ' + fmt(a.minMarginT) + 's' : '—';
    marginWho.style.color = a.minMargin !== null && a.minMargin <= 0 ? 'var(--danger)' : '';
  }

  function renderPairs() {
    var box = document.getElementById('pairs');
    box.innerHTML = '';
    if (!state.analysis) return;

    // 与核心引擎 / /api/analyze 同一顺序：按最小安全余量升序（越小越危险）
    var ordered = state.analysis.pairs.slice().sort(function (a, b) {
      return a.minMargin - b.minMargin;
    });

    function radiusSumText(pair) {
      if (Math.abs(pair.radiusSumMax - pair.radiusSumMin) < 1e-6) {
        return '半径和 ' + fmt(pair.radiusSum, 0);
      }
      return '半径和 ' + fmt(pair.radiusSumMin, 0) + '～' + fmt(pair.radiusSumMax, 0);
    }

    // 最小安全余量 + 可点击的发生时刻（点击跳转播放头）
    function marginHtml(pair) {
      return '最小余量 <b>' + fmt(pair.minMargin) + '</b> @ ' +
        '<span class="t-jump" data-t="' + pair.minMarginT + '" title="点击跳转播放头到该时刻">' +
        fmt(pair.minMarginT) + ' s</span>';
    }

    ordered.forEach(function (pair) {
      var pa = getPerformer(pair.aId);
      var pb = getPerformer(pair.bId);
      var row = document.createElement('div');
      row.className = 'pair-row' + (pair.collision ? ' danger' : ' safe');
      if (state.activePairKey === pairKey(pair)) row.classList.add('selected');

      var badge = document.createElement('div');
      badge.className = 'pair-badge';
      badge.innerHTML =
        '<span class="mini-dot" style="background:' + pa.color + '"></span>' +
        escapeHtml(pa.name) +
        '<span style="color:var(--text-dim)">×</span>' +
        '<span class="mini-dot" style="background:' + pb.color + '"></span>' +
        escapeHtml(pb.name);

      var status = document.createElement('div');
      status.className = 'pair-status';
      if (pair.collision) {
        var chips = pair.intervals.map(function (iv) {
          return '<span class="iv-chip">' + fmt(iv[0]) + ' – ' + fmt(iv[1]) + ' s</span>';
        }).join('');
        status.innerHTML =
          '<b>碰撞</b> · 首碰 <b>' + fmt(pair.firstContact) + '</b> s · 共 ' +
          pair.intervals.length + ' 段' +
          '<div class="interval-chips">' + chips + '</div>' +
          marginHtml(pair) +
          ' · 最小间距 <b>' + fmt(pair.minDistance) + '</b> @ ' + fmt(pair.minDistanceT) + 's · ' + radiusSumText(pair);
      } else {
        status.innerHTML =
          '<b>安全</b> · ' + marginHtml(pair) +
          ' · 最小间距 <b>' + fmt(pair.minDistance) + '</b> @ ' +
          fmt(pair.minDistanceT) + 's（' + radiusSumText(pair) + '）';
      }

      row.appendChild(badge);
      row.appendChild(status);
      // 点击最小余量时刻：播放头跳转到该时刻并刷新画布
      Array.prototype.forEach.call(row.querySelectorAll('.t-jump'), function (el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          seek(Number(el.getAttribute('data-t')));
        });
      });
      row.addEventListener('click', function () {
        state.activePairKey = state.activePairKey === pairKey(pair) ? null : pairKey(pair);
        renderPairs();
      });
      box.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 禁入区侵入结果 ----------
  function renderObstacleResults() {
    var panel = document.getElementById('panel-obstacles');
    var box = document.getElementById('obstacle-results');
    box.innerHTML = '';
    if (!state.analysis || !state.obstacles.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;

    state.analysis.obstacleConflicts.forEach(function (entry) {
      var p = getPerformer(entry.performerId);
      var row = document.createElement('div');
      row.className = 'obs-row ' + (entry.conflict ? 'danger' : 'safe');
      row.dataset.pid = entry.performerId;
      row.dataset.oid = entry.obstacleId;

      var badge = document.createElement('div');
      badge.className = 'pair-badge';
      badge.innerHTML =
        '<span class="mini-dot" style="background:' + (p ? p.color : '#888') + '"></span>' +
        escapeHtml(entry.performerName) +
        '<span style="color:var(--text-dim)">▣</span>' +
        '<span class="obs-name">' + escapeHtml(entry.obstacleName) + '</span>';

      var status = document.createElement('div');
      status.className = 'pair-status';
      if (entry.conflict) {
        var chips = entry.intervals.map(function (iv) {
          return '<span class="iv-chip obs-chip t-jump" data-t="' + iv[0] +
            '" title="点击跳到进入时刻 ' + fmt(iv[0]) + 's">' +
            fmt(iv[0]) + ' – ' + fmt(iv[1]) + ' s</span>';
        }).join('');
        status.innerHTML =
          '<b>侵入</b> · 首次进入 <span class="t-jump" data-t="' + entry.firstEntry +
          '" title="点击跳到进入时刻"><b>' + fmt(entry.firstEntry) + '</b> s</span> · 共 ' +
          entry.intervals.length + ' 段' +
          '<div class="interval-chips">' + chips + '</div>';
      } else {
        status.innerHTML = '<b>安全</b> · 轨迹与实时半径全程不进入该禁入区';
      }

      row.appendChild(badge);
      row.appendChild(status);
      // 点击整行（含区间/首入时刻）跳到首次进入时刻
      if (entry.conflict) {
        row.addEventListener('click', function () {
          seek(entry.firstEntry);
        });
      }
      box.appendChild(row);
    });
    updateObstacleResultActive(state.time);
  }

  // 播放头移动时高亮当前正在侵入的结果行
  function updateObstacleResultActive(t) {
    if (!state.analysis) return;
    var box = document.getElementById('obstacle-results');
    state.analysis.obstacleConflicts.forEach(function (entry) {
      var row = box.querySelector(
        '.obs-row[data-pid="' + entry.performerId + '"][data-oid="' + entry.obstacleId + '"]');
      if (!row) return;
      row.classList.toggle('active-now', Core.isPerformerInObstacle(entry, entry.performerId, t));
    });
  }

  // ---------- 时间轴 ----------
  var timelineEl = document.getElementById('timeline');
  var lanesEl = document.getElementById('timeline-lanes');
  var rulerEl = document.getElementById('timeline-ruler');
  var playheadEl = document.getElementById('playhead');

  function tToX(t, laneWidth) {
    return (t / state.duration) * laneWidth;
  }
  function xToT(x, laneWidth) {
    return clamp(x / laneWidth * state.duration, 0, state.duration);
  }
  function laneWidth() {
    return lanesEl.clientWidth || 1;
  }

  function renderTimelineStatic() {
    // 刻度
    rulerEl.innerHTML = '';
    var step = state.duration <= 15 ? 1 : state.duration <= 30 ? 2 : state.duration <= 60 ? 5 : 10;
    for (var tt = 0; tt <= state.duration + 1e-6; tt += step) {
      (function (t) {
        var tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = t;
        tick.style.left = (t / state.duration * 100) + '%';
        rulerEl.appendChild(tick);
      })(Math.round(tt * 10) / 10);
    }

    // 每人一条泳道（关键帧时刻柄）
    lanesEl.innerHTML = '';
    state.performers.forEach(function (p) {
      var lane = document.createElement('div');
      lane.className = 'tl-lane';
      lane.dataset.pid = p.id;

      p.keys.forEach(function (k, i) {
        var dot = document.createElement('div');
        dot.className = 'tl-key';
        if (k.r !== null && k.r !== undefined) dot.classList.add('custom');
        dot.style.background = p.color;
        dot.style.left = (k.t / state.duration * 100) + '%';
        if (state.selectedKey && state.selectedKey.pid === p.id && state.selectedKey.index === i) {
          dot.classList.add('selected');
        }
        var custom = k.r !== null && k.r !== undefined;
        dot.title = p.name + ' t=' + k.t.toFixed(1) + 's（拖动改时刻）' +
          (custom ? ' · 安全半径 ' + k.r : ' · 半径继承 ' + p.radius);
        dot.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
          state.selectedPid = p.id;
          state.selectedKey = { pid: p.id, index: i };
          renderPerformers();
          draw();
          state.drag = {
            type: 'tick',
            pid: p.id,
            index: i,
            moved: false
          };
          dot.setPointerCapture(e.pointerId);
        });
        lane.appendChild(dot);
      });
      lanesEl.appendChild(lane);
    });

    renderTimelineDanger();
    updatePlayhead();
  }

  function renderTimelineDanger() {
    // 移除旧危险条再按分析结果重绘
    Array.prototype.forEach.call(lanesEl.querySelectorAll('.tl-danger'), function (el) {
      el.remove();
    });
    if (!state.analysis) return;
    var lw = laneWidth();

    state.analysis.pairs.forEach(function (pair) {
      if (!pair.collision) return;
      var laneA = lanesEl.querySelector('.tl-lane[data-pid="' + pair.aId + '"]');
      var laneB = lanesEl.querySelector('.tl-lane[data-pid="' + pair.bId + '"]');
      [laneA, laneB].forEach(function (lane) {
        if (!lane) return;
        pair.intervals.forEach(function (iv) {
          var bar = document.createElement('div');
          bar.className = 'tl-danger';
          bar.style.left = tToX(iv[0], lw) + 'px';
          bar.style.width = Math.max(2, tToX(iv[1] - iv[0], lw)) + 'px';
          bar.title = pair.aName + ' × ' + pair.bName + ' 碰撞 ' + iv[0].toFixed(2) + '–' + iv[1].toFixed(2) + 's';
          lane.appendChild(bar);
        });
      });
    });

    // 禁入矩形侵入：当事人泳道叠加琥珀色条（点击跳到进入时刻）
    state.analysis.obstacleConflicts.forEach(function (entry) {
      if (!entry.conflict) return;
      var lane = lanesEl.querySelector('.tl-lane[data-pid="' + entry.performerId + '"]');
      if (!lane) return;
      entry.intervals.forEach(function (iv) {
        var bar = document.createElement('div');
        bar.className = 'tl-danger tl-obstacle t-jump';
        bar.style.left = tToX(iv[0], lw) + 'px';
        bar.style.width = Math.max(2, tToX(iv[1] - iv[0], lw)) + 'px';
        bar.title = entry.performerName + ' 侵入「' + entry.obstacleName + '」' +
          iv[0].toFixed(2) + '–' + iv[1].toFixed(2) + 's（点击跳到进入时刻）';
        bar.addEventListener('click', function (e) {
          e.stopPropagation();
          seek(iv[0]);
        });
        lane.appendChild(bar);
      });
    });
  }

  // 时间轴：拖动时刻柄 / 点击定位播放头
  timelineEl.addEventListener('pointermove', function (e) {
    if (!state.drag || state.drag.type !== 'tick') return;
    var rect = lanesEl.getBoundingClientRect();
    var t = xToT(e.clientX - rect.left, laneWidth());
    var p = getPerformer(state.drag.pid);
    var key = p.keys[state.drag.index];
    var newT = clamp(Math.round(t * 10) / 10, 0, state.duration);
    // 不允许与同表演者另一帧同时刻（交换会乱序）
    var clash = p.keys.some(function (k, i) {
      return i !== state.drag.index && Math.abs(k.t - newT) < 1e-6;
    });
    if (!clash && newT !== key.t) {
      key.t = newT;
      p.keys.sort(function (a, b) { return a.t - b.t; });
      state.drag.index = p.keys.indexOf(key);
      state.selectedKey = { pid: p.id, index: state.drag.index };
      state.drag.moved = true;
      recompute();
      renderTimelineStatic();
    }
  });

  document.addEventListener('pointerup', function (e) {
    if (state.drag && state.drag.type === 'tick') {
      state.drag = null;
    }
  });

  timelineEl.addEventListener('click', function (e) {
    // 点在时刻柄上不处理（它已 stopPropagation）
    var rect = lanesEl.getBoundingClientRect();
    if (e.clientY < rect.top - 22 || e.clientY > rect.bottom + 4) return;
    var t = xToT(e.clientX - rect.left, laneWidth());
    seek(t);
  });

  function updatePlayhead() {
    var lw = laneWidth();
    var tlRect = timelineEl.getBoundingClientRect();
    var laneRect = lanesEl.getBoundingClientRect();
    var xInLane = tToX(state.time, lw);
    playheadEl.style.left = (laneRect.left - tlRect.left + xInLane) + 'px';
    document.getElementById('time-input').value = Math.round(state.time * 100) / 100;
  }

  // ---------- 播放 ----------
  var playBtn = document.getElementById('btn-play');
  var rafId = null;
  var lastTs = 0;

  function setPlaying(v) {
    state.playing = v;
    playBtn.textContent = v ? '⏸ 暂停' : '▶ 播放';
    if (v) {
      if (state.time >= state.duration - 1e-6) state.time = 0;
      lastTs = 0;
      rafId = requestAnimationFrame(tick);
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function tick(ts) {
    if (!state.playing) return;
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    state.time += dt * state.speed;
    if (state.time >= state.duration) {
      state.time = state.duration;
      updatePlayhead();
      draw();
      setPlaying(false);
      return;
    }
    updatePlayhead();
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function seek(t) {
    state.time = clamp(Number(t), 0, state.duration);
    updatePlayhead();
    draw();
  }

  playBtn.addEventListener('click', function () {
    setPlaying(!state.playing);
  });
  document.getElementById('btn-stop').addEventListener('click', function () {
    setPlaying(false);
    seek(0);
  });
  document.getElementById('time-input').addEventListener('change', function () {
    setPlaying(false);
    seek(Number(this.value) || 0);
  });

  // 摘要"最小安全余量"行：点击跳转播放头到全局最小余量发生时刻
  document.getElementById('sum-margin-row').addEventListener('click', function () {
    if (state.analysis && state.analysis.minMarginT !== null && state.analysis.minMarginT !== undefined) {
      seek(state.analysis.minMarginT);
    }
  });

  document.querySelectorAll('.speed-group .btn-mini').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.speed = Number(btn.dataset.speed);
      document.querySelectorAll('.speed-group .btn-mini').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
    });
  });

  // ---------- 顶部 / 侧栏按钮 ----------
  document.getElementById('btn-add').addEventListener('click', addPerformer);

  document.getElementById('btn-sample').addEventListener('click', function () {
    fetchSample();
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    state.performers.forEach(function (p) {
      p.keys = [{ t: 0, x: p.keys[0] ? p.keys[0].x : 100, y: p.keys[0] ? p.keys[0].y : 100, r: null }];
    });
    state.time = 0;
    state.activePairKey = null;
    recompute();
    renderTimelineStatic();
    draw();
  });

  document.getElementById('duration-input').addEventListener('change', function () {
    var d = Number(this.value);
    if (!(d > 0) || d > 120) {
      this.value = state.duration;
      return;
    }
    state.duration = d;
    // 截断越界关键帧
    state.performers.forEach(function (p) {
      p.keys = p.keys.filter(function (k) { return k.t <= d; });
      if (!p.keys.length) p.keys = [{ t: 0, x: 100, y: 100, r: null }];
      // 保证每人末帧覆盖新时长（静态延长）
    });
    state.time = Math.min(state.time, d);
    document.getElementById('duration-readout').textContent = d.toFixed(1);
    recompute();
    renderTimelineStatic();
    draw();
  });

  // 键盘：空格播放/暂停，Delete 删选中帧/禁入矩形，Esc 退出新增禁入区
  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.code === 'Escape' && state.addObstacleMode) {
      setAddObstacleMode(false);
      state.drag = null;
      draw();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.selectedObstacleId) {
      removeObstacle(state.selectedObstacleId);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && state.selectedKey) {
      removeKey(state.selectedKey.pid, state.selectedKey.index);
    }
  });

  // 尺寸变化时重绘危险条与播放头
  window.addEventListener('resize', function () {
    renderTimelineDanger();
    updatePlayhead();
    draw();
  });

  // ---------- 启动 ----------
  function fetchSample() {
    fetch('/api/sample')
      .then(function (r) { return r.json(); })
      .then(function (scene) {
        loadScene(scene);
      })
      .catch(function () {
        // 离线打开 file:// 等情况：直接用内置同一份样例
        loadScene(Core.builtinScene());
      });
  }

  document.getElementById('duration-readout').textContent = state.duration.toFixed(1);
  fetchSample();
})();
