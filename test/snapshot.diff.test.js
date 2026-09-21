'use strict';

/**
 * 方案快照对比引擎 diffScenes 用例：
 *  - 统一时刻轴（取两场景 duration 最大值）
 *  - 同名表演者关键帧分段线性插值的精确最大位置偏移
 *  - 碰撞对的新增 / 消失 / 时刻变化 / 无变化配对
 *  - 禁入区侵入区间的同类配对与禁入区整体仅一侧存在
 *  - 仅一侧存在的表演者 / 禁入区名单
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

function approx(actual, expected, tol = 1e-6, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function mover(id, name, radius, x0, x1) {
  return {
    id, name, radius,
    keys: [
      { t: 0, x: x0, y: 0 },
      { t: 10, x: x1, y: 0 }
    ]
  };
}

function staticP(id, name, x, y, radius) {
  return { id, name, radius: radius == null ? 10 : radius, keys: [{ t: 0, x, y }] };
}

test('maxPositionOffset：差向量分段线性，最大值在关键帧时刻并集端点', () => {
  // A 匀速 0→120；B 0→200（t=6）再回 120（t=12）。
  // 断点 {0,6,12}：偏移 0 / 140 / 0 → 最大 140 @ t=6（不是端点 0/12）
  const keysA = [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }];
  const keysB = [
    { t: 0, x: 0, y: 0 },
    { t: 6, x: 200, y: 0 },
    { t: 12, x: 120, y: 0 }
  ];
  const r = core.maxPositionOffset(keysA, keysB, 12);
  approx(r.offset, 140, 1e-9, '最大偏移');
  approx(r.t, 6, 1e-9, '发生时刻');
});

test('maxPositionOffset：同向不同速，最大偏移在统一时刻轴末端', () => {
  const r = core.maxPositionOffset(
    [{ t: 0, x: 0, y: 0 }, { t: 12, x: 120, y: 0 }],
    [{ t: 0, x: 0, y: 0 }, { t: 12, x: 60, y: 0 }],
    12
  );
  approx(r.offset, 60, 1e-9);
  approx(r.t, 12, 1e-9);

  // 完全相同轨迹：偏移恒 0
  const same = core.maxPositionOffset(
    [{ t: 0, x: 5, y: 8 }, { t: 12, x: 9, y: 3 }],
    [{ t: 0, x: 5, y: 8 }, { t: 12, x: 9, y: 3 }],
    12
  );
  approx(same.offset, 0, 1e-12);
});

test('diffScenes：统一时刻轴取 max(duration)，同名偏移按降序', () => {
  const sceneA = {
    duration: 10,
    performers: [mover('a', '甲', 0, 0, 100), staticP('b', '乙', 500, 0, 0)]
  };
  const sceneB = {
    duration: 14,
    performers: [mover('a', '甲', 0, 0, 100), staticP('b', '乙', 500, 0, 0)]
  };
  const d = core.diffScenes(sceneA, sceneB);
  assert.equal(d.T, 14);
  assert.equal(d.durationA, 10);
  assert.equal(d.durationB, 14);
  assert.equal(d.matchedPerformers.length, 2);
  // 两人轨迹相同（t>10 后 A 在末帧静止，B 至 t=14 也静止）→ 偏移全 0
  d.matchedPerformers.forEach(function (mp) {
    approx(mp.maxOffset, 0, 1e-9);
  });
});

function pairChange(d, n1, n2) {
  return d.pairChanges.find(function (c) {
    return (c.nameA === n1 && c.nameB === n2) || (c.nameA === n2 && c.nameB === n1);
  });
}

test('diffScenes：B 新增碰撞对（A 安全 → B 正面相撞）', () => {
  const sceneA = {
    duration: 12,
    performers: [staticP('a', '甲', 0, 0, 10), staticP('b', '乙', 500, 0, 10)]
  };
  const sceneB = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  };
  const d = core.diffScenes(sceneA, sceneB);
  const ch = pairChange(d, '甲', '乙');
  assert.ok(ch, '应输出甲乙配对');
  assert.equal(ch.kind, 'added');
  assert.equal(ch.intervalsA.length, 0);
  assert.ok(ch.intervalsB.length >= 1);
  approx(ch.firstB, 4, 1e-6, 'B 首碰 4s');
  assert.equal(ch.firstA, null);
});

test('diffScenes：碰撞对消失（A 碰撞 → B 静止远离）', () => {
  const sceneA = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  };
  const sceneB = {
    duration: 12,
    performers: [staticP('a', '甲', 0, 0, 10), staticP('b', '乙', 500, 0, 10)]
  };
  const d = core.diffScenes(sceneA, sceneB);
  const ch = d.pairChanges[0];
  assert.equal(ch.kind, 'removed');
  assert.ok(ch.intervalsA.length >= 1);
  assert.equal(ch.intervalsB.length, 0);
  approx(ch.firstA, 4, 1e-6);
  assert.equal(ch.firstB, null);
});

test('diffScenes：双方都碰撞但时刻不同 → changed，保留两侧区间', () => {
  function sceneWithRadius(r) {
    return {
      duration: 12,
      performers: [
        { id: 'a', name: '甲', radius: r, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
        { id: 'b', name: '乙', radius: r, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
      ]
    };
  }
  // 半径和 20 → [4,6]；半径和 10 → [4.5,5.5]
  const d = core.diffScenes(sceneWithRadius(10), sceneWithRadius(5));
  const ch = d.pairChanges[0];
  assert.equal(ch.kind, 'changed');
  approx(ch.intervalsA[0][0], 4, 1e-6);
  approx(ch.intervalsA[0][1], 6, 1e-6);
  approx(ch.intervalsB[0][0], 4.5, 1e-6);
  approx(ch.intervalsB[0][1], 5.5, 1e-6);
});

test('diffScenes：两场景完全一致 → 碰撞对 unchanged，位置偏移为 0', () => {
  const scene = {
    duration: 12,
    performers: [
      { id: 'a', name: '甲', radius: 10, keys: [{ t: 0, x: 0, y: 0 }, { t: 10, x: 100, y: 0 }] },
      { id: 'b', name: '乙', radius: 10, keys: [{ t: 0, x: 100, y: 0 }, { t: 10, x: 0, y: 0 }] }
    ]
  };
  const d = core.diffScenes(scene, JSON.parse(JSON.stringify(scene)));
  assert.equal(d.pairChanges.length, 1);
  assert.equal(d.pairChanges[0].kind, 'unchanged');
  assert.equal(d.obstacleChanges.length, 0); // 双方均无侵入的组合不输出
  d.matchedPerformers.forEach(function (mp) {
    assert.equal(mp.maxOffset, 0);
  });
});

test('diffScenes：禁入区侵入新增（B 才放置中央禁入区），禁入区进入仅 B 名单', () => {
  const performers = [
    {
      id: 'p1', name: '甲', radius: 20,
      keys: [{ t: 0, x: 300, y: 300 }, { t: 12, x: 700, y: 300 }]
    },
    staticP('p2', '乙', 900, 40, 20)
  ];
  const sceneA = { duration: 12, performers: performers, obstacles: [] };
  const sceneB = {
    duration: 12,
    performers: JSON.parse(JSON.stringify(performers)),
    obstacles: [{ id: 'o1', name: '中央禁入区', x: 440, y: 240, width: 120, height: 120 }]
  };
  const d = core.diffScenes(sceneA, sceneB);
  assert.deepEqual(d.obstaclesOnlyA, []);
  assert.deepEqual(d.obstaclesOnlyB, ['中央禁入区']);
  const ch = d.obstacleChanges.filter(function (c) {
    return c.performerName === '甲';
  });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, 'added');
  assert.equal(ch[0].intervalsA.length, 0);
  assert.ok(ch[0].intervalsB.length === 1, '横穿矩形得到一段侵入');
  // x=300+33.33t，膨胀边界进入 x=420 → t=3.6；离开 x=580 → t=8.4
  approx(ch[0].intervalsB[0][0], 3.6, 1e-6);
  approx(ch[0].intervalsB[0][1], 8.4, 1e-6);
});

test('diffScenes：表演者仅一侧存在时进入对应名单，不参与配对', () => {
  const sceneA = {
    duration: 12,
    performers: [staticP('a', '甲', 0, 0, 0), staticP('b', '乙', 500, 0, 0)]
  };
  const sceneB = {
    duration: 12,
    performers: [staticP('a', '甲', 0, 0, 0), staticP('c', '丙', 100, 100, 0)]
  };
  const d = core.diffScenes(sceneA, sceneB);
  assert.deepEqual(d.matchedPerformers.map(function (m) { return m.name; }), ['甲']);
  assert.deepEqual(d.performersOnlyA, ['乙']);
  assert.deepEqual(d.performersOnlyB, ['丙']);
  // 没有任何一对在双方都有同名组合 → 无碰撞变化输出
  assert.equal(d.pairChanges.length, 0);
});

test('diffScenes：场景内重名按首个配对（稳定不抛错）', () => {
  const sceneA = {
    duration: 12,
    performers: [staticP('a', '甲', 0, 0, 0), staticP('a2', '甲', 800, 800, 0)]
  };
  const sceneB = {
    duration: 12,
    performers: [staticP('a', '甲', 100, 0, 0)]
  };
  const d = core.diffScenes(sceneA, sceneB);
  assert.equal(d.matchedPerformers.length, 1);
  approx(d.matchedPerformers[0].maxOffset, 100, 1e-9, '取首个甲：偏移 100');
});

test('diffScenes：非法 duration 抛错', () => {
  assert.throws(function () {
    core.diffScenes(
      { duration: 0, performers: [] },
      { duration: 12, performers: [] }
    );
  }, /duration/);
});
