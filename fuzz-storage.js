'use strict';
/**
 * 侧台存放区分配随机对拍：枚举每件道具对各存放区的全部分配（k^n，
 * n ≤ 7、k ≤ 4 时至多 4^7 = 16384 种），暴力筛出满足格位与可达限制的
 * 方案，按"总耗时升序 → 分配字典序（道具首次出现顺序、区录入顺序）"
 * 取最优，与 storage.js 的多约束背包 DP 结果对拍。
 * 用法：node fuzz-storage.js [组数=400]
 */
const { validateStorage, allocateStorage } = require('./storage');

const ITERS = Number(process.argv[2]) || 400;

let seed = 246813579;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

/** 分配向量字典序：第一位分歧上区下标更小者为小。 */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

let feasible = 0;
let infeasible = 0;
for (let t = 0; t < ITERS; t++) {
  // 1～7 种道具，1～4 个区
  const n = 1 + ri(7);
  const k = 1 + ri(4);
  const props = Array.from({ length: n }, (_, i) => `p${i}`);
  const zones = Array.from({ length: k }, (_, z) => ({ name: `区${z + 1}`, slots: 1 + ri(n + 1) }));

  // 随机生成待执行步骤：先一个开场（保证每件道具至少出现一次），再 0～4 次换景
  const onStage = new Set();
  const steps = [{ type: 'setup', scene: 's0', removed: [], added: [] }];
  for (const p of props) { steps[0].added.push(p); onStage.add(p); }
  for (let s = 1; s <= 1 + ri(4); s++) {
    const removed = [];
    const added = [];
    for (const p of props) {
      const isOn = onStage.has(p);
      if (isOn && rnd() < 0.35) { removed.push(p); onStage.delete(p); }
      else if (!isOn && rnd() < 0.35) { added.push(p); onStage.add(p); }
    }
    if (!removed.length && !added.length) continue;
    steps.push({ type: 'transition', from: `s${s - 1}`, to: `s${s}`, removed, added });
  }

  // 每道具每区：正整数分钟，或约 25% 概率不可达
  const times = {};
  for (const p of props) {
    times[p] = [];
    for (let z = 0; z < k; z++) times[p].push(rnd() < 0.25 ? '不可达' : 1 + ri(9));
    // 保证至少一区可达（"全部不可达"另有专门用例）
    if (times[p].every(v => v === '不可达')) times[p][ri(k)] = 1 + ri(9);
  }

  const v = validateStorage({ zones, steps, times });
  if (v.errors.length) throw new Error('合法载荷被判错：' + v.errors.join('；'));

  const counts = v.counts.map(c => c.total);
  const tm = v.times; // number | null
  const caps = v.slots.map(s => Math.min(s, n));

  // 暴力枚举 k^n 种分配
  let brute = null; // { cost, assign }
  const assign = new Array(n).fill(0);
  const total = Math.pow(k, n);
  for (let code = 0; code < total; code++) {
    let x = code;
    // 低位对应第 0 件道具（首次出现顺序）
    for (let i = 0; i < n; i++) { assign[i] = x % k; x = Math.floor(x / k); }
    const used = new Array(k).fill(0);
    let cost = 0;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const z = assign[i];
      if (used[z] + 1 > caps[z]) { ok = false; break; }
      if (tm[i][z] === null) { ok = false; break; }
      used[z]++;
      cost += counts[i] * tm[i][z];
    }
    if (!ok) continue;
    if (!brute || cost < brute.cost || (cost === brute.cost && lexLess(assign, brute.assign))) {
      brute = { cost, assign: assign.slice() };
    }
  }

  const r = allocateStorage(v.zones, v.slots, v.props, v.counts, v.times);
  if (!brute) {
    infeasible++;
    if (r.ok) throw new Error('暴力无解但 DP 给出了方案');
    continue;
  }
  feasible++;
  if (!r.ok) throw new Error('暴力有解但 DP 报无解：' + r.errors.join('；'));
  if (r.totalMinutes !== brute.cost) {
    throw new Error(`总耗时不符：DP ${r.totalMinutes} vs 暴力 ${brute.cost}`);
  }
  const got = v.props.map(p => r.assignments[p]);
  if (!got.every((z, i) => z === brute.assign[i])) {
    throw new Error(`同分选择不稳定：DP [${got}] vs 暴力 [${brute.assign}]`);
  }
  // 区视图一致性
  let sum = 0;
  for (let z = 0; z < k; z++) {
    const zv = r.zones[z];
    assertWithin(zv.usedSlots <= v.slots[z]);
    zv.props.forEach(p => {
      assertWithin(r.assignments[p] === z);
      const i = v.props.indexOf(p);
      sum += counts[i] * tm[i][z];
    });
  }
  if (sum !== r.totalMinutes) throw new Error('分区分钟合计与总耗时不符');
}

function assertWithin(cond) { if (!cond) throw new Error('区视图违反格位或归属约束'); }

console.log(`storage fuzz OK: ${feasible} 组有解 + ${infeasible} 组无解，对拍全部一致（共 ${ITERS} 组）`);
