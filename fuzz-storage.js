'use strict';
/**
 * 侧台存放区分配随机对拍：用 m^n 递归枚举每件道具的归属（受容量与可达限制），
 * 暴力取总耗时最短、同分取"各区序号组成的分配向量"字典序最小者，
 * 与 storage.js 的分层子集 DP 结果对拍。
 * 用法：node fuzz-storage.js [组数=300]
 */
const { validateStorage, solveStorage } = require('./storage');

const ITERS = Number(process.argv[2]) || 300;

let seed = 246813579;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

let okCases = 0;
for (let t = 0; t < ITERS; t++) {
  // 待执行道具 1..7 种（暴力 m^n 可承受）
  const n = 1 + ri(7);
  const props = Array.from({ length: n }, (_, i) => `道具${i}`);
  // 步骤里故意打乱出场顺序，校验"首次出现顺序"计数口径
  const seq = [];
  for (let i = 0; i < n; i++) {
    seq.push({ removed: [], added: [`道具${i}`] });
    if (rnd() < 0.6) seq.push({ removed: [`道具${ri(i + 1)}`], added: [] });
    if (rnd() < 0.5) seq.push({ removed: [], added: [`道具${ri(i + 1)}`] });
  }
  const steps = [
    { type: 'setup', phase: 'done', removed: [], added: ['旧道具'] }, // 已完成，必须被忽略
    ...seq,
  ];
  // 已完成道具的耗时允许携带（不强制、不参与）
  const knownExtra = { 旧道具: {} };

  // 存放区 1..4 个，容量 0..4
  const m = 1 + ri(4);
  const zones = Array.from({ length: m }, (_, i) => ({ name: `区${i + 1}`, capacity: 1 + ri(4) }));

  const times = {};
  for (const p of props) {
    times[p] = {};
    for (const z of zones) {
      const roll = rnd();
      times[p][z.name] = roll < 0.25 ? '不可达' : 1 + ri(9);
    }
  }
  Object.assign(times, knownExtra);

  const v = validateStorage({ steps, zones, times });
  if (v.errors.length) throw new Error('合法载荷被判错：' + v.errors.join('；'));

  // 暴力枚举：递归给每件道具选区
  const counts = v.counts;
  const costs = v.costs;
  const used = new Array(m).fill(0);
  const choice = new Array(n).fill(-1);
  let brute = null; // { total, vec }
  (function dfs(i) {
    if (i === n) {
      let total = 0;
      for (let k = 0; k < n; k++) total += costs[props[k]][zones[choice[k]].name] * counts[props[k]];
      const vec = choice.slice();
      if (!brute || total < brute.total
          || (total === brute.total && vecLess(vec, brute.vec))) {
        brute = { total, vec };
      }
      return;
    }
    for (let zi = 0; zi < m; zi++) {
      if (used[zi] >= zones[zi].capacity) continue;
      if (costs[props[i]][zones[zi].name] === null) continue;
      used[zi]++;
      choice[i] = zi;
      dfs(i + 1);
      used[zi]--;
    }
  })(0);

  const r = solveStorage(v.props, v.counts, v.zones, v.costs);
  if (!brute) {
    if (r.ok) throw new Error('暴力无解但 DP 给出了方案：' + JSON.stringify(r.assignments));
    continue;
  }
  if (!r.ok) throw new Error('暴力有解但 DP 报无解：' + r.errors.join('；'));
  if (r.totalMinutes !== brute.total) {
    throw new Error(`总耗时不符：DP ${r.totalMinutes} vs 暴力 ${brute.total}`);
  }
  const dpVec = v.props.map(p => r.assignments.find(a => a.prop === p).zoneIndex - 1);
  if (vecLess(brute.vec, dpVec) || vecLess(dpVec, brute.vec)) {
    throw new Error(`同分选择不稳定：DP [${dpVec}] vs 暴力 [${brute.vec}]`);
  }
  // 格位与归属一致性
  for (const z of r.zones) {
    if (z.used > z.capacity) throw new Error('区超容量：' + z.name);
    if (z.used !== z.props.length) throw new Error('区占用数不一致');
  }
  okCases++;
}

/** 分配向量字典序比较：a < b（按下标 0..n-1 逐个比，先小者小）。 */
function vecLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

console.log(`storage fuzz OK: ${okCases} 组有解对拍全部一致（共 ${ITERS} 组）`);
