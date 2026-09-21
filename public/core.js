/**
 * 碰撞解析引擎（浏览器 / Node 通用，零依赖）
 *
 * 模型：每位表演者的运动是由关键帧定义的分段直线函数 p(t)。
 * 相邻关键帧之间位置随时间线性插值；关键帧之外（全局起止之间）保持静止。
 *
 * 关键帧可携带可选安全半径 r（表现开伞、展开道具等占用范围变化）：
 *  - 未设置（缺省/null）时继承表演者当前身体半径；
 *  - 相邻关键帧之间半径与位置同步线性插值；首尾之外保持端点值。
 *
 * 对任意两人 A、B，在两人各自同一段分段线性区间内，相对位置与半径和
 * 都是时间 t 的一次函数：
 *
 *     r(t) = pA(t) - pB(t) = u + v t
 *     R(t) = RA(t) + RB(t) = c + d t          （c、d 为常数，R(t) ≥ 0）
 *
 * 碰撞条件 |r(t)| ≤ R(t) 平方后是关于 t 的一般二次不等式：
 *
 *     (|v|² - d²) t² + 2(u·v - c d) t + |u|² - c² ≤ 0
 *
 * 二次项系数可正可负（半径快速张开时为负），统一按求根公式精确求解并
 * 钳制到重叠时间窗；再合并跨段相邻区间。全程没有任何离散帧抽样——
 * 解出的就是碰撞发生的精确时间区间。
 *
 * 此外对每一对连续求"最小安全余量"及其发生时刻：
 *
 *     m(t) = |r(t)| - R(t) = sqrt(q(t)) - (c + d t)，q(t) = |u + v t|²
 *
 * sqrt(q) 是凸函数、R 是线性函数，故 m 在段内恒为凸函数：全局最小只可能
 * 落在段端点，或 |v| > |d| 时唯一的驻点
 *
 *     t* = (-u·v + d·sqrt((|u|²|v|² - (u·v)²) / (|v|² - d²))) / |v|²
 *
 * 退化情形由同一公式/分支覆盖：相对静止（v = 0）或半径变化比相对运动快
 * （|v| ≤ |d|）时 m 单调，最小在端点；相对轨迹过原点（|u×v| = 0，距离
 * 可为零）时驻点即 |r| = 0 的尖点。同样全程解析，不做任何时间采样。
 *
 * ---------- 舞台禁入矩形（obstacles） ----------
 *
 * 场景可携带若干轴对齐矩形 obstacles（{id,name,x,y,width,height}）。
 * 表演者仍视为半径 r(t) 的圆，侵入条件为圆与矩形膨胀边界相交：
 *
 *     dist(p(t), R) ≤ r(t)，
 *     dist(p,R)² = clamp(x − [X0,X1])² + clamp(y − [Y0,Y1])²
 *
 * 即圆心在内部/四条边外带状区/四个角点象限共 3×3 区域中分别表现为
 * 线性、单坐标二次、双坐标二次。对每段 p(t)=u+v t、r(t)=c+d t，
 * 按四条边界线 X0/X1/Y0/Y1 与该段的交点把时间窗切成若干子段，
 * 每个子段内最近点投影恒为同一形式（常数或一个坐标的仿射函数）：
 *
 *     qx(t) = ax·ux + bx·vx·t + cx，qy(t) 同式（ax,bx∈{0,1}，cx∈{−X1,0,−X0}）
 *
 * 于是 qx²+qy² ≤ (c+dt)² 仍是关于 t 的一般二次不等式，直接复用
 * solveQuadraticLE 精确求解（含角点相切重根 = 零长度区间）。
 * 子段区间经 mergeIntervals 合并：从矩形内部起步（t=0 即在内）得
 * 以 0 为起点的区间，跨关键帧/跨子段的相接区间自动合并。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CollisionCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;          // 数值零容差
  var MERGE_EPS = 1e-6;    // 区间合并基础间隙（秒）
  var MERGE_REL = 1e-9;    // 区间合并相对余量（跨段端点为各自钳制结果，随时间尺度放大）

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  /**
   * 规整关键帧：按 t 排序、去除重复时刻（保留后者）。
   * 可选安全半径 r：非有限值（缺省/null/NaN）归一化为 null，表示继承
   * 表演者当前半径；有限值钳为非负数。
   * baseRadius: 调用方提供的继承半径（仅做规范化，不写入缺省帧）。
   * 返回 [{t, x, y, r}, ...]（r 为非负数或 null）
   */
  function normalizeKeys(keys, baseRadius) {
    var list = (keys || [])
      .map(function (k) {
        var kr = k.r;
        var hasR = kr !== null && kr !== undefined && kr !== '' && isFinite(Number(kr));
        return {
          t: Number(k.t),
          x: Number(k.x),
          y: Number(k.y),
          r: hasR ? Math.max(0, Number(kr)) : null
        };
      })
      .filter(function (k) {
        return isFinite(k.t) && isFinite(k.x) && isFinite(k.y);
      })
      .sort(function (a, b) {
        return a.t - b.t;
      });

    var out = [];
    list.forEach(function (k) {
      if (out.length && Math.abs(out[out.length - 1].t - k.t) < EPS) {
        out[out.length - 1] = k;
      } else {
        out.push(k);
      }
    });
    return out;
  }

  /** 取关键帧在时刻 t 的生效安全半径（缺省帧继承 baseRadius，段内线性插值，首尾之外保持端点值）。 */
  function radiusAt(keys, t, baseRadius) {
    var rb = Math.max(0, Number(baseRadius) || 0);
    if (!keys.length) return rb;

    function kr(k) {
      return k.r === null || k.r === undefined ? rb : k.r;
    }

    var first = keys[0];
    var last = keys[keys.length - 1];
    if (t <= first.t) return kr(first);
    if (t >= last.t) return kr(last);
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i];
      var b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (t - a.t) / (b.t - a.t);
        return kr(a) + (kr(b) - kr(a)) * f;
      }
    }
    return kr(last);
  }

  /** 时刻 t 在已规整关键帧上的精确位置（段外保持静止）。 */
  function positionAt(keys, t) {
    if (!keys.length) return { x: 0, y: 0 };
    if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
    var last = keys[keys.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y };
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i];
      var b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (t - a.t) / (b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f
        };
      }
    }
    return { x: last.x, y: last.y };
  }

  /** 一次取得时刻 t 的位置与生效半径（避免前端重复规整关键帧）。 */
  function stateAt(keys, t, baseRadius) {
    var ks = normalizeKeys(keys, baseRadius);
    var pos = positionAt(ks, t);
    return { x: pos.x, y: pos.y, r: radiusAt(ks, t, baseRadius) };
  }

  /**
   * 把表演者在 [0, duration] 上展开为活动段。
   * 每段位置与半径都是时间的一次函数：
   *     p(t) = (x0 + vx*t, y0 + vy*t)
   *     R(t) = r0 + vr*t
   * t ∈ [t0, t1]。关键帧之外位置静止，半径保持端点值。
   * baseRadius 为表演者当前身体半径，缺省关键帧半径继承它。
   */
  function buildSegments(keys, duration, baseRadius) {
    var rb = Math.max(0, Number(baseRadius) || 0);
    var ks = normalizeKeys(keys, rb);
    var durationNum = Number(duration);
    if (!(durationNum > 0)) {
      throw new Error('duration 必须为正数');
    }
    var T = durationNum;
    var segs = [];

    function effectiveR(k) {
      return k.r === null || k.r === undefined ? rb : k.r;
    }

    function addLinear(t0, t1, p0, p1, r0v, r1v) {
      if (t1 - t0 < EPS) return;
      var dt = t1 - t0;
      var vx = (p1.x - p0.x) / dt;
      var vy = (p1.y - p0.y) / dt;
      var vr = (r1v - r0v) / dt;
      // 以绝对时刻表示 p(t) = x0 + vx*t，故 x0 是 t=0 截距（p0 - v*t0）
      segs.push({
        t0: t0,
        t1: t1,
        x0: p0.x - vx * t0,
        y0: p0.y - vy * t0,
        vx: vx,
        vy: vy,
        r0: r0v - vr * t0,
        vr: vr
      });
    }

    if (ks.length === 0) {
      addLinear(0, T, { x: 0, y: 0 }, { x: 0, y: 0 }, rb, rb);
      return segs;
    }

    var first = ks[0];
    var last = ks[ks.length - 1];

    // 首帧之前：静止在首帧位置，半径保持首帧值
    if (first.t > 0) {
      addLinear(0, Math.min(first.t, T), first, first, effectiveR(first), effectiveR(first));
    }
    // 关键帧之间：位置直线运动，半径同步线性插值
    for (var i = 0; i < ks.length - 1; i++) {
      var a = ks[i];
      var b = ks[i + 1];
      var t0 = Math.max(0, a.t);
      var t1 = Math.min(T, b.t);
      if (t1 > t0) addLinear(t0, t1, a, b, effectiveR(a), effectiveR(b));
    }
    // 末帧之后：静止在末帧位置，半径保持末帧值
    if (last.t < T) {
      addLinear(Math.max(0, last.t), T, last, last, effectiveR(last), effectiveR(last));
    }
    if (!segs.length) {
      // 只有一个关键帧且恰好在边界等退化情况
      addLinear(0, T, first, first, effectiveR(first), effectiveR(first));
    }
    return segs;
  }

  function mergeIntervals(intervals) {
    if (!intervals.length) return [];
    var sorted = intervals
      .filter(function (iv) {
        return iv[1] >= iv[0];
      })
      .sort(function (a, b) {
        return a[0] - b[0];
      });
    var out = [sorted[0].slice()];
    for (var i = 1; i < sorted.length; i++) {
      var cur = sorted[i];
      var top = out[out.length - 1];
      // 跨关键帧边界两侧各自求根/钳制，允许与时刻尺度成比例的浮点间隙
      var tol = MERGE_EPS + MERGE_REL * Math.max(Math.abs(top[1]), Math.abs(cur[0]), 1);
      if (cur[0] <= top[1] + tol) {
        top[1] = Math.max(top[1], cur[1]);
      } else {
        out.push(cur.slice());
      }
    }
    return out;
  }

  /**
   * 精确求解一般二次不等式 A t² + B t + C ≤ 0 在 [lo, hi] 内的解集。
   * A 可正可负可为零（半径快速张开时 A = |v|² - d² 可能为负）。
   * 返回零、一或两个区间（A<0 时解集向两端开口，钳制后最多两段）。
   * 相切（重根）记为零长度区间。
   */
  function solveQuadraticLE(A, B, C, lo, hi) {
    if (Math.abs(A) < EPS) {
      // 退化为一次（或常数）不等式 B t + C ≤ 0
      if (Math.abs(B) < EPS) {
        if (C <= EPS) return [[lo, hi]];
        return [];
      }
      var root = -C / B;
      if (B > 0) {
        // t ≤ root
        if (root < lo - EPS) return [];
        return [[lo, Math.min(hi, root)]];
      }
      // B < 0：t ≥ root
      if (root > hi + EPS) return [];
      return [[Math.max(lo, root), hi]];
    }

    var disc = B * B - 4 * A * C;
    if (disc < -EPS) {
      // 无实根：全程同号
      if (A < 0) return [[lo, hi]]; // 开口向下、顶点仍 < 0？由 disc<0 知恒负
      return [];                    // 开口向上，恒正
    }
    if (disc < 0) disc = 0;
    var sq = Math.sqrt(disc);
    var t1 = (-B - sq) / (2 * A);
    var t2 = (-B + sq) / (2 * A);
    if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }

    if (A > 0) {
      // 开口向上：≤0 部分在两根之间
      var l = Math.max(lo, t1);
      var h = Math.min(hi, t2);
      if (h >= l - EPS) return [[l, h]];
      return [];
    }
    // 开口向下：≤0 部分在两根之外 → 钳制后最多两段
    var out = [];
    if (lo <= t1 + EPS) out.push([lo, Math.min(hi, t1)]);
    if (hi >= t2 - EPS) out.push([Math.max(lo, t2), hi]);
    return out;
  }

  /**
   * 两人在同一时间窗 [lo, hi] 内各自线性运动、半径各自线性变化，
   * 精确求碰撞时间区间。同时更新最小几何间距、半径和极值与
   * 最小安全余量（m(t) = |r(t)| - R(t)）追踪对象。
   */
  function analyzeOverlap(sA, sB, lo, hi, minRef, rangeRef, marginRef) {
    // 相对运动 r(t) = u + v t
    var ux = sA.x0 - sB.x0;
    var uy = sA.y0 - sB.y0;
    var vx = sA.vx - sB.vx;
    var vy = sA.vy - sB.vy;

    // 半径和 R(t) = c + d t（段内插值，恒非负）
    var c = sA.r0 + sB.r0;
    var d = sA.vr + sB.vr;

    // 半径和极值（线性：在端点取极值）
    var rLo = c + d * lo;
    var rHi = c + d * hi;
    if (rLo < rangeRef.min) rangeRef.min = rLo;
    if (rHi < rangeRef.min) rangeRef.min = rHi;
    if (rLo > rangeRef.max) rangeRef.max = rLo;
    if (rHi > rangeRef.max) rangeRef.max = rHi;

    var v2 = vx * vx + vy * vy;
    var u2 = ux * ux + uy * uy;
    var uv = ux * vx + uy * vy;

    // —— 最小几何间距（抛物线 |r(t)|^2 的顶点/端点比较，与半径无关）——
    var tDist;
    if (v2 < EPS) {
      tDist = lo; // 相对静止，距离恒定，任取端点
    } else {
      var tv = -uv / v2;
      tDist = clamp(tv, lo, hi);
    }
    var dxm = ux + vx * tDist;
    var dym = uy + vy * tDist;
    var dm = Math.sqrt(dxm * dxm + dym * dym);
    if (dm < minRef.dist) {
      minRef.dist = dm;
      minRef.t = tDist;
    }

    // —— 最小安全余量 m(t) = |r(t)| - R(t)：凸函数，候选点只有端点与唯一驻点 ——
    // 驻点存在条件 |v| > |d|（否则 m 单调，端点取最小）；
    // cross2 = |u×v|² = 0 时驻点即距离为零的尖点，同一公式覆盖。
    var dd = d * d;
    var mcands = [lo, hi];
    if (v2 - dd > EPS) {
      var cross2 = u2 * v2 - uv * uv;
      if (cross2 < 0) cross2 = 0; // 浮点误差钳制（理论值 ≥ 0）
      var ts = (-uv + d * Math.sqrt(cross2 / (v2 - dd))) / v2;
      if (ts > lo && ts < hi) mcands.push(ts);
    }
    for (var ci = 0; ci < mcands.length; ci++) {
      var tm = mcands[ci];
      var mx = ux + vx * tm;
      var my = uy + vy * tm;
      var mg = Math.sqrt(mx * mx + my * my) - (c + d * tm);
      if (mg < marginRef.margin) {
        marginRef.margin = mg;
        marginRef.t = tm;
      }
    }

    // —— 碰撞区间 |r(t)| ≤ R(t) 的解析解 ——
    // |u + v t|² ≤ (c + d t)² ⇔ A t² + B t + C ≤ 0
    var A = v2 - d * d;
    var B = 2 * (uv - c * d);
    var C = u2 - c * c;

    var hits = solveQuadraticLE(A, B, C, lo, hi);
    // 钳制端点到实际窗（开口向下分支已钳制，这里统一保证精度）
    for (var i = 0; i < hits.length; i++) {
      hits[i][0] = clamp(hits[i][0], lo, hi);
      hits[i][1] = clamp(hits[i][1], lo, hi);
    }
    return hits;
  }

  /**
   * 分析一对表演者。
   * performer: { id?, name?, radius, keys:[{t,x,y,r?}...] }
   * 关键帧 r 缺省时继承表演者 radius。
   * 返回 {
   *   aId,bId,aName,bName, radiusSum, radiusSumMin, radiusSumMax,
   *   intervals:[[t0,t1],...],     // 合并后的精确碰撞区间
   *   minDistance, minDistanceT,   // 最小几何间距（与半径无关）及时刻
   *   minMargin, minMarginT,       // 最小安全余量 distance-(rA+rB) 及发生时刻
   *   firstContact,                // 首次碰撞时刻（无则 null）
   *   lastRelease
   * }
   */
  function analyzePair(pa, pb, duration) {
    var rA = Math.max(0, Number(pa.radius) || 0);
    var rB = Math.max(0, Number(pb.radius) || 0);
    var rSumBase = rA + rB;

    var segsA = buildSegments(pa.keys, duration, rA);
    var segsB = buildSegments(pb.keys, duration, rB);

    var raw = [];
    var minRef = { dist: Infinity, t: 0 };
    var rangeRef = { min: Infinity, max: -Infinity };
    var marginRef = { margin: Infinity, t: 0 };

    var i = 0;
    var j = 0;
    while (i < segsA.length && j < segsB.length) {
      var a = segsA[i];
      var b = segsB[j];
      var lo = Math.max(a.t0, b.t0);
      var hi = Math.min(a.t1, b.t1);
      if (hi - lo > EPS) {
        var found = analyzeOverlap(a, b, lo, hi, minRef, rangeRef, marginRef);
        for (var k = 0; k < found.length; k++) raw.push(found[k]);
      }
      if (a.t1 < b.t1 - EPS) i++;
      else if (b.t1 < a.t1 - EPS) j++;
      else { i++; j++; }
    }

    var intervals = mergeIntervals(raw);
    if (!isFinite(minRef.dist)) {
      minRef = { dist: 0, t: 0 };
    }
    if (!isFinite(rangeRef.min)) {
      rangeRef = { min: rSumBase, max: rSumBase };
    }
    if (!isFinite(marginRef.margin)) {
      // 不可达（buildSegments 恒覆盖 [0, duration]），兜底保持字段有限
      marginRef = { margin: -rSumBase, t: 0 };
    }

    return {
      aId: pa.id,
      bId: pb.id,
      aName: pa.name || pa.id,
      bName: pb.name || pb.id,
      radiusSum: rSumBase,
      radiusSumMin: rangeRef.min,
      radiusSumMax: rangeRef.max,
      intervals: intervals,
      minDistance: minRef.dist,
      minDistanceT: minRef.t,
      minMargin: marginRef.margin,
      minMarginT: marginRef.t,
      firstContact: intervals.length ? intervals[0][0] : null,
      lastRelease: intervals.length ? intervals[intervals.length - 1][1] : null,
      collision: intervals.length > 0
    };
  }

  /**
   * 分析整个场景：枚举全部 C(n,2) 双人组合，并对每位表演者 × 每个
   * 禁入矩形连续求侵入区间。
   * scene: { duration, performers:[performer...], obstacles?:[obstacle...] }
   * pairs 按最小安全余量升序（余量越小越危险，碰撞对自然排在安全对之前）。
   * obstacleConflicts 按首次进入时刻升序（无侵入项排在其后），
   * 另附场景级首次侵入 firstObstacleEntry 及其当事人/禁入区。
   */
  function analyzeScene(scene) {
    var duration = Number(scene.duration);
    if (!(duration > 0)) throw new Error('duration 必须为正数');
    var ps = scene.performers || [];
    var obstacles = normalizeObstacles(scene.obstacles);
    var pairs = [];
    for (var i = 0; i < ps.length; i++) {
      for (var j = i + 1; j < ps.length; j++) {
        pairs.push(analyzePair(ps[i], ps[j], duration));
      }
    }

    // 禁入矩形：每位表演者 × 每个矩形一条结果
    var obstacleConflicts = [];
    for (var oi = 0; oi < obstacles.length; oi++) {
      for (var pi = 0; pi < ps.length; pi++) {
        obstacleConflicts.push(analyzeObstacle(ps[pi], obstacles[oi], duration));
      }
    }
    var firstObstacle = null;
    obstacleConflicts.forEach(function (e) {
      if (e.conflict && (!firstObstacle || e.firstEntry < firstObstacle.firstEntry)) {
        firstObstacle = e;
      }
    });
    obstacleConflicts.sort(function (a, b) {
      if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
      if (a.conflict) {
        if (Math.abs(a.firstEntry - b.firstEntry) > EPS) return a.firstEntry - b.firstEntry;
      }
      // 同首入时刻或均无侵入：按矩形、当事人次序稳定排列
      if (a.obstacleId !== b.obstacleId) return a.obstacleId < b.obstacleId ? -1 : 1;
      if (a.performerId !== b.performerId) return a.performerId < b.performerId ? -1 : 1;
      return 0;
    });

    var collisions = pairs.filter(function (p) {
      return p.collision;
    });
    var firstPair = null;
    collisions.forEach(function (p) {
      if (!firstPair || p.firstContact < firstPair.firstContact) firstPair = p;
    });
    var closestPair = null;
    pairs.forEach(function (p) {
      if (!closestPair || p.minDistance < closestPair.minDistance) closestPair = p;
    });
    var marginPair = null;
    pairs.forEach(function (p) {
      if (!marginPair || p.minMargin < marginPair.minMargin) marginPair = p;
    });

    // 统一按最小安全余量升序返回（前端逐对列表与 /api/analyze 同一顺序）
    pairs.sort(function (a, b) {
      return a.minMargin - b.minMargin;
    });

    return {
      duration: duration,
      pairCount: pairs.length,
      pairs: pairs,
      obstacles: obstacles,
      obstacleConflicts: obstacleConflicts,
      firstObstacleEntry: firstObstacle ? firstObstacle.firstEntry : null,
      firstObstacleConflict: firstObstacle
        ? [firstObstacle.performerId, firstObstacle.obstacleId]
        : null,
      firstContact: firstPair ? firstPair.firstContact : null,
      firstContactPair: firstPair
        ? [firstPair.aId, firstPair.bId]
        : null,
      minDistance: closestPair ? closestPair.minDistance : null,
      minDistanceT: closestPair ? closestPair.minDistanceT : null,
      minDistancePair: closestPair
        ? [closestPair.aId, closestPair.bId]
        : null,
      minMargin: marginPair ? marginPair.minMargin : null,
      minMarginT: marginPair ? marginPair.minMarginT : null,
      minMarginPair: marginPair
        ? [marginPair.aId, marginPair.bId]
        : null
    };
  }

  /** 查询某表演者在时刻 t 是否处于某碰撞区间内（供画布高亮）。 */
  function isPerformerInCollision(pair, performerId, t) {
    if (!pair || !pair.collision) return false;
    if (pair.aId !== performerId && pair.bId !== performerId) return false;
    for (var i = 0; i < pair.intervals.length; i++) {
      var iv = pair.intervals[i];
      if (t + EPS >= iv[0] && t - EPS <= iv[1]) return true;
    }
    return false;
  }

  // ---------- 舞台禁入矩形 ----------

  var OBS_ID_PREFIX = 'o';

  function nextObstacleId(existing) {
    var used = {};
    (existing || []).forEach(function (o) { used[o.id] = true; });
    var id;
    do {
      id = OBS_ID_PREFIX + Math.random().toString(36).slice(2, 8);
    } while (used[id]);
    return id;
  }

  /**
   * 规整禁入矩形：坐标/尺寸解析为有限数；width、height 钳为非负
   * （允许 0 宽/高的退化矩形——分别退化为线段/点，分析器同样覆盖）。
   * 缺省 id 时按 o1、o2… 生成；缺省 name 用"禁入区 N"。
   * 返回 [{id,name,x,y,width,height}]
   */
  function normalizeObstacles(obstacles) {
    var list = Array.isArray(obstacles) ? obstacles : [];
    var out = [];
    list.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var x = Number(raw.x);
      var y = Number(raw.y);
      var w = Number(raw.width);
      var h = Number(raw.height);
      if (![x, y, w, h].every(isFinite)) return;
      var id = (raw.id === null || raw.id === undefined || raw.id === '')
        ? nextObstacleId(out)
        : String(raw.id);
      var index = out.length + 1;
      var name = (raw.name === null || raw.name === undefined || String(raw.name).trim() === '')
        ? '禁入区 ' + index
        : String(raw.name);
      out.push({
        id: id,
        name: name,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h)
      });
    });
    return out;
  }

  /**
   * 计算单个表演者对单个轴对齐禁入矩形的连续侵入时间区间。
   * performer 与 analyzePair 入参同形（关键帧 r 缺省继承 radius）。
   * 返回 {
   *   performerId, performerName, obstacleId, obstacleName,
   *   intervals:[[t0,t1],...],   // 已合并的精确侵入区间（相切为零长度点）
   *   conflict,                  // intervals 是否非空
   *   firstEntry, lastExit       // 首次进入 / 最后离开（无侵入为 null）
   * }
   */
  function analyzeObstacle(performer, obstacle, duration) {
    var durationNum = Number(duration);
    if (!(durationNum > 0)) {
      throw new Error('duration 必须为正数');
    }
    var baseR = Math.max(0, Number(performer.radius) || 0);
    var segs = buildSegments(performer.keys, durationNum, baseR);

    var X0 = obstacle.x;
    var Y0 = obstacle.y;
    var X1 = obstacle.x + obstacle.width;
    var Y1 = obstacle.y + obstacle.height;

    var raw = [];
    segs.forEach(function (s) {
      // 以四条边界线与本线段轨迹的交点切割时间窗；子段内最近点投影形式恒定
      var cuts = [s.t0, s.t1];
      var axes = [
        { u: s.x0, v: s.vx, b0: X0, b1: X1 },
        { u: s.y0, v: s.vy, b0: Y0, b1: Y1 }
      ];
      axes.forEach(function (ax) {
        if (Math.abs(ax.v) < EPS) return;
        [ax.b0, ax.b1].forEach(function (b) {
          var tc = (b - ax.u) / ax.v;
          if (tc > s.t0 + EPS && tc < s.t1 - EPS) cuts.push(tc);
        });
      });
      cuts.sort(function (a, b) { return a - b; });

      for (var ci = 0; ci < cuts.length - 1; ci++) {
        var lo = cuts[ci];
        var hi = cuts[ci + 1];
        if (hi - lo < EPS) continue;
        var mid = (lo + hi) / 2;
        var qx, qy;
        var xm = s.x0 + s.vx * mid;
        var ym = s.y0 + s.vy * mid;
        if (xm >= X0 && xm <= X1) qx = { u: 0, v: 0 };
        else qx = { u: s.x0 - (xm < X0 ? X0 : X1), v: s.vx };
        if (ym >= Y0 && ym <= Y1) qy = { u: 0, v: 0 };
        else qy = { u: s.y0 - (ym < Y0 ? Y0 : Y1), v: s.vy };

        // |最近点偏移|² = (qx.u+qx.v·t)² + (qy.u+qy.v·t)² ≤ (s.r0+s.vr·t)²
        var vx2 = qx.v * qx.v;
        var vy2 = qy.v * qy.v;
        var A = vx2 + vy2 - s.vr * s.vr;
        var B = 2 * (qx.u * qx.v + qy.u * qy.v - s.r0 * s.vr);
        var C = qx.u * qx.u + qy.u * qy.u - s.r0 * s.r0;

        var hits = solveQuadraticLE(A, B, C, lo, hi);
        for (var i = 0; i < hits.length; i++) {
          hits[i][0] = clamp(hits[i][0], lo, hi);
          hits[i][1] = clamp(hits[i][1], lo, hi);
          raw.push(hits[i]);
        }
      }
    });

    var intervals = mergeIntervals(raw);
    return {
      performerId: performer.id,
      performerName: performer.name || performer.id,
      obstacleId: obstacle.id,
      obstacleName: obstacle.name,
      intervals: intervals,
      conflict: intervals.length > 0,
      firstEntry: intervals.length ? intervals[0][0] : null,
      lastExit: intervals.length ? intervals[intervals.length - 1][1] : null
    };
  }

  /** 查询某表演者在时刻 t 是否侵入任一（或指定）禁入矩形（供画布高亮）。 */
  function isPerformerInObstacle(entry, performerId, t) {
    if (!entry || entry.performerId !== performerId || !entry.conflict) return false;
    for (var i = 0; i < entry.intervals.length; i++) {
      var iv = entry.intervals[i];
      if (t + EPS >= iv[0] && t - EPS <= iv[1]) return true;
    }
    return false;
  }

  // ---------- 方案快照：两场景对比 ----------

  var DIFF_EPS = 1e-6;   // 区间端点"时间变化"判定容差（秒）
  var DIFF_KEY_SEP = '\u0001'; // 名字配对键分隔符（正常名字中不会出现）

  function performerNameMap(performers) {
    // 同名配对：重名时以后出现者为准（UI 侧名称由用户自行区分）
    var map = {};
    (performers || []).forEach(function (p) {
      map[String(p.name || p.id)] = p;
    });
    return map;
  }

  function performerNames(performers) {
    var seen = {};
    var out = [];
    (performers || []).forEach(function (p) {
      var n = String(p.name || p.id);
      if (!seen[n]) { seen[n] = true; out.push(n); }
    });
    return out;
  }

  /**
   * 在统一时刻轴上求同一表演者两套关键帧的位置偏移模
   *     Δ(t) = |pA(t) − pB(t)|
   * 最大值。两侧位置在相邻关键帧间都是 t 的一次函数，故差值仍为一次、
   * 其模为凸函数——每段最大值必在段端点，只需考察双方关键帧时刻
   * （含 0 与两侧时长）的并集即可精确得到全局最大，不做时间采样。
   * 帧外按段外静止语义保持末帧位置（与 buildSegments 一致）。
   */
  function maxPositionOffset(pa, pb, durationA, durationB) {
    var ksA = normalizeKeys(pa.keys);
    var ksB = normalizeKeys(pb.keys);
    var T = Math.max(durationA, durationB);
    var times = [0, durationA, durationB, T];
    ksA.forEach(function (k) { if (k.t >= -EPS && k.t <= T + EPS) times.push(Math.max(0, k.t)); });
    ksB.forEach(function (k) { if (k.t >= -EPS && k.t <= T + EPS) times.push(Math.max(0, k.t)); });
    times.sort(function (a, b) { return a - b; });

    var best = -1;
    var bestT = 0;
    var prev = null;
    for (var i = 0; i < times.length; i++) {
      var t = times[i];
      if (prev !== null && t - prev < EPS) continue;
      prev = t;
      var qa = positionAt(ksA, t);
      var qb = positionAt(ksB, t);
      var off = Math.sqrt((qa.x - qb.x) * (qa.x - qb.x) + (qa.y - qb.y) * (qa.y - qb.y));
      if (off > best + EPS) { best = off; bestT = t; }
    }
    if (best < 0) best = 0;
    return { maxOffset: best, maxOffsetT: bestT };
  }

  function intervalsEqual(a, b) {
    var tol = DIFF_EPS + MERGE_REL * Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), 1);
    return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  }

  /**
   * 两组已合并区间的差分：按最大时间重叠贪心配对
   * （零长度相切区间与包含它的区间也可配对）。
   * 返回 { added:新方案独有, removed:旧方案独有,
   *        changed:[{from:[a,b], to:[a',b']}]（端点变化）}。
   */
  function diffIntervalLists(oldIv, newIv) {
    var used = oldIv.map(function () { return false; });
    var added = [];
    var changed = [];

    newIv.forEach(function (nv) {
      var bi = -1;
      var bestOv = -Infinity;
      for (var i = 0; i < oldIv.length; i++) {
        if (used[i]) continue;
        var ov = Math.min(oldIv[i][1], nv[1]) - Math.max(oldIv[i][0], nv[0]);
        // ov≥-EPS 即可配：含端点相接（零长度相切点落在另一区间上）
        if (ov >= -DIFF_EPS && ov > bestOv) { bestOv = ov; bi = i; }
      }
      if (bi < 0) {
        added.push(nv.slice());
        return;
      }
      used[bi] = true;
      if (!intervalsEqual(oldIv[bi], nv)) {
        changed.push({ from: oldIv[bi].slice(), to: nv.slice() });
      }
    });

    var removed = [];
    for (var j = 0; j < oldIv.length; j++) {
      if (!used[j]) removed.push(oldIv[j].slice());
    }
    return { added: added, removed: removed, changed: changed };
  }

  function firstIvStart(list) {
    return list && list.length ? list[0][0] : Infinity;
  }

  /**
   * 方案快照对比（浏览器/Node 通用，零依赖）。
   * sceneA 为基准方案（方案 1），sceneB 为新方案（方案 2）：
   *  - 同名表演者关键帧在统一时刻轴 [0, max(dA,dB)] 上线性插值，
   *    逐人给位置偏移最大值与发生时刻，并给全局最大；
   *  - 碰撞对按两人名字配对，分 added（仅方案 2 碰撞）/ removed
   *    （仅方案 1 碰撞）/ changed（都碰撞但区间端点变化）；
   *  - 禁入区间按 表演者名 × 矩形名 配对，分类同上；
   *  - 表演者、矩形本身的增删单列。
   * 返回：
   * { duration, durationA, durationB,
   *   performers:[{name,presentA,presentB,maxOffset,maxOffsetT}]（偏移降序），
   *   maxOffset/maxOffsetT/maxOffsetPerformer,
   *   pairs:{added,removed,changed,unchangedCount},
   *   obstacleIntrusions:{added,removed,changed,unchangedCount},
   *   addedPerformers,removedPerformers,addedObstacles,removedObstacles }
   */
  function compareScenes(sceneA, sceneB) {
    var dA = Number(sceneA && sceneA.duration);
    var dB = Number(sceneB && sceneB.duration);
    if (!(dA > 0) || !(dB > 0)) throw new Error('duration 必须为正数');
    var T = Math.max(dA, dB);

    var perfA = sceneA.performers || [];
    var perfB = sceneB.performers || [];
    var mapA = performerNameMap(perfA);
    var mapB = performerNameMap(perfB);

    var namesA = performerNames(perfA);
    var namesB = performerNames(perfB);
    var nameSetA = {}; namesA.forEach(function (n) { nameSetA[n] = true; });
    var nameSetB = {}; namesB.forEach(function (n) { nameSetB[n] = true; });
    var allNames = namesA.slice();
    namesB.forEach(function (n) { if (!nameSetA[n]) allNames.push(n); });

    var performerDiffs = [];
    allNames.forEach(function (name) {
      var inA = !!mapA[name];
      var inB = !!mapB[name];
      if (inA && inB) {
        var mo = maxPositionOffset(mapA[name], mapB[name], dA, dB);
        performerDiffs.push({
          name: name, presentA: true, presentB: true,
          maxOffset: mo.maxOffset, maxOffsetT: mo.maxOffsetT
        });
      } else {
        performerDiffs.push({
          name: name, presentA: inA, presentB: inB,
          maxOffset: null, maxOffsetT: null
        });
      }
    });
    // 双方共有者按偏移降序（并列按名字稳定），仅单侧存在者附后
    performerDiffs.sort(function (x, y) {
      if (x.maxOffset === null && y.maxOffset === null) return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
      if (x.maxOffset === null) return 1;
      if (y.maxOffset === null) return -1;
      if (Math.abs(y.maxOffset - x.maxOffset) > EPS) return y.maxOffset - x.maxOffset;
      if (Math.abs(y.maxOffsetT - x.maxOffsetT) > EPS) return x.maxOffsetT - y.maxOffsetT;
      return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
    });
    var common = performerDiffs.filter(function (d) { return d.maxOffset !== null; });
    var globalMax = common.length ? common[0] : null;

    // —— 碰撞对差分（按双方表演者名字配对）——
    var anA = analyzeScene({ duration: dA, performers: perfA, obstacles: sceneA.obstacles });
    var anB = analyzeScene({ duration: dB, performers: perfB, obstacles: sceneB.obstacles });

    function pairIndex(analysis) {
      var map = {};
      analysis.pairs.forEach(function (p) {
        var key = [p.aName, p.bName].sort().join(DIFF_KEY_SEP);
        map[key] = p;
      });
      return map;
    }

    var piA = pairIndex(anA);
    var piB = pairIndex(anB);
    var pairKeys = Object.keys(piA);
    Object.keys(piB).forEach(function (k) { if (piA[k] === undefined) pairKeys.push(k); });
    pairKeys.sort();

    var pairs = { added: [], removed: [], changed: [], unchangedCount: 0 };
    pairKeys.forEach(function (key) {
      var pa = piA[key];
      var pb = piB[key];
      if (!pa || !pb) return; // 有一方缺该表演者：随 addedPerformers 列出
      var names = key.split(DIFF_KEY_SEP);
      if (pa.collision && pb.collision) {
        var dc = diffIntervalLists(pa.intervals, pb.intervals);
        if (!dc.added.length && !dc.removed.length && !dc.changed.length) {
          pairs.unchangedCount++;
        } else {
          pairs.changed.push(Object.assign({ names: names }, dc));
        }
      } else if (pb.collision) {
        pairs.added.push({ names: names, intervals: pb.intervals.map(function (iv) { return iv.slice(); }) });
      } else if (pa.collision) {
        pairs.removed.push({ names: names, intervals: pa.intervals.map(function (iv) { return iv.slice(); }) });
      }
    });
    pairs.added.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    pairs.removed.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    pairs.changed.sort(function (a, b) {
      return firstIvStart(flatNew(a)) - firstIvStart(flatNew(b));
    });
    function flatNew(c) {
      if (c.added.length) return c.added[0];
      if (c.changed.length) return c.changed[0].to;
      return c.removed.length ? c.removed[0] : [Infinity, Infinity];
    }

    // —— 禁入区间差分（表演者名 × 矩形名）——
    function obstacleIndex(analysis) {
      var map = {};
      analysis.obstacleConflicts.forEach(function (e) {
        map[e.performerName + DIFF_KEY_SEP + e.obstacleName] = e;
      });
      return map;
    }
    var oiA = obstacleIndex(anA);
    var oiB = obstacleIndex(anB);
    var oKeys = Object.keys(oiA);
    Object.keys(oiB).forEach(function (k) { if (oiA[k] === undefined) oKeys.push(k); });
    oKeys.sort();

    var obsNamesA = {};
    normalizeObstacles(sceneA.obstacles).forEach(function (o) { obsNamesA[o.name] = true; });
    var obsNamesB = {};
    normalizeObstacles(sceneB.obstacles).forEach(function (o) { obsNamesB[o.name] = true; });

    var obsDiff = { added: [], removed: [], changed: [], unchangedCount: 0 };
    oKeys.forEach(function (key) {
      var ea = oiA[key];
      var eb = oiB[key];
      if (!ea || !eb) return; // 表演者或矩形仅单侧存在：随增删名单列出
      var parts = key.split(DIFF_KEY_SEP);
      var item = { performerName: parts[0], obstacleName: parts[1] };
      if (ea.conflict && eb.conflict) {
        var dc = diffIntervalLists(ea.intervals, eb.intervals);
        if (!dc.added.length && !dc.removed.length && !dc.changed.length) {
          obsDiff.unchangedCount++;
        } else {
          obsDiff.changed.push(Object.assign({}, item, dc));
        }
      } else if (eb.conflict) {
        obsDiff.added.push(Object.assign({}, item, { intervals: eb.intervals.map(function (iv) { return iv.slice(); }) }));
      } else if (ea.conflict) {
        obsDiff.removed.push(Object.assign({}, item, { intervals: ea.intervals.map(function (iv) { return iv.slice(); }) }));
      }
    });
    obsDiff.added.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    obsDiff.removed.sort(function (a, b) { return firstIvStart(a.intervals) - firstIvStart(b.intervals); });
    obsDiff.changed.sort(function (a, b) { return firstIvStart(flatNew(a)) - firstIvStart(flatNew(b)); });

    return {
      duration: T,
      durationA: dA,
      durationB: dB,
      performers: performerDiffs,
      maxOffset: globalMax ? globalMax.maxOffset : null,
      maxOffsetT: globalMax ? globalMax.maxOffsetT : null,
      maxOffsetPerformer: globalMax ? globalMax.name : null,
      pairs: pairs,
      obstacleIntrusions: obsDiff,
      addedPerformers: namesB.filter(function (n) { return !nameSetA[n]; }),
      removedPerformers: namesA.filter(function (n) { return !nameSetB[n]; }),
      addedObstacles: Object.keys(obsNamesB).filter(function (n) { return !obsNamesA[n]; }).sort(),
      removedObstacles: Object.keys(obsNamesA).filter(function (n) { return !obsNamesB[n]; }).sort()
    };
  }

  /**
   * 内置交叉样例（4 人，时长 12s，世界 1000×600）：
   *  - 甲（水平横穿）与乙（竖直纵穿）路径十字交叉，在 t=6 同时到达交点 -> 相撞
   *  - 丙为错峰折线，几何路径与甲/乙相交但到达时刻错开 -> 不撞；
   *    t=8 关键帧安全半径 20→60，表现到位后展开道具（占用范围线性张开），
   *    张开段与各路径仍保持安全间距
   *  - 丁起初与丙分离，约 t=2.6 起追上丙并保持贴近 -> 持续碰撞（相对静止退化段）
   *  - 中央禁入矩形覆盖十字交点：甲、乙按实时安全半径先后进入（演示禁入区分析），
   *    丙、丁错峰折线从对角掠过，不侵入
   */
  function builtinScene() {
    return {
      duration: 12,
      world: { width: 1000, height: 600 },
      obstacles: [
        { id: 'o1', name: '中央禁入区', x: 440, y: 240, width: 120, height: 120 }
      ],
      performers: [
        {
          id: 'p1',
          name: '甲·横贯',
          color: '#ef4444',
          radius: 20,
          keys: [
            { t: 0, x: 60, y: 300 },
            { t: 12, x: 940, y: 300 }
          ]
        },
        {
          id: 'p2',
          name: '乙·纵穿',
          color: '#38bdf8',
          radius: 20,
          keys: [
            { t: 0, x: 500, y: 40 },
            { t: 12, x: 500, y: 560 }
          ]
        },
        {
          id: 'p3',
          name: '丙·错峰展伞',
          color: '#22c55e',
          radius: 20,
          keys: [
            { t: 0, x: 60, y: 540 },
            { t: 4, x: 500, y: 60 },
            { t: 8, x: 940, y: 540, r: 60 }
          ]
        },
        {
          id: 'p4',
          name: '丁·跟进',
          color: '#facc15',
          radius: 20,
          keys: [
            { t: 0, x: 160, y: 540 },
            { t: 4, x: 500, y: 90 },
            { t: 8, x: 940, y: 570 }
          ]
        }
      ]
    };
  }

  return {
    EPS: EPS,
    normalizeKeys: normalizeKeys,
    positionAt: positionAt,
    radiusAt: radiusAt,
    stateAt: stateAt,
    buildSegments: buildSegments,
    solveQuadraticLE: solveQuadraticLE,
    analyzePair: analyzePair,
    analyzeScene: analyzeScene,
    isPerformerInCollision: isPerformerInCollision,
    normalizeObstacles: normalizeObstacles,
    analyzeObstacle: analyzeObstacle,
    isPerformerInObstacle: isPerformerInObstacle,
    compareScenes: compareScenes,
    builtinScene: builtinScene
  };
});
