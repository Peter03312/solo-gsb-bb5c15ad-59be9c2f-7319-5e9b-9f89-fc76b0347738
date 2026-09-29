'use strict';
/**
 * 巡演备货随机对拍：枚举采购包的全部子集（每包至多买一次，≤ 14 个包），
 * 暴力筛出覆盖全部缺件的组合，按"总价升序 → 包数升序 → 下标集合字典序"
 * 取最优，与 stocking.js 的覆盖集 DP 结果对拍。
 * 用法：node fuzz-stock.js [组数=400]
 */
const { validateStocking, solveStocking } = require('./stocking');

const ITERS = Number(process.argv[2]) || 400;

let seed = 135792468;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n) { return Math.floor(rnd() * n); }

/** 包下标集合字典序比较：a、b 的最低不同位上含该位者为小（更早录入的包优先）。 */
function packMaskLess(a, b) {
  if (a === b) return false;
  const low = (a ^ b) & (-(a ^ b));
  return (a & low) !== 0;
}

let cases = 0;
for (let t = 0; t < ITERS; t++) {
  // 缺件 1..7 种（全集还可能含若干已备齐道具）
  const missN = 1 + ri(7);
  const preparedN = ri(3);
  const scenes = [{ id: 's', props: [] }];
  for (let i = 0; i < missN; i++) scenes[0].props.push(`缺${i}`);
  const prepared = [];
  for (let i = 0; i < preparedN; i++) {
    scenes[0].props.push(`齐${i}`);
    prepared.push(`齐${i}`);
  }

  // 采购包 1..14 个（≤14 以便枚举全部子集）
  const pkgN = 1 + ri(14);
  const packages = [];
  for (let i = 0; i < pkgN; i++) {
    const props = [];
    for (let j = 0; j < missN; j++) if (rnd() < 0.4) props.push(`缺${j}`);
    if (rnd() < 0.25 && preparedN) props.push(`齐${ri(preparedN)}`);
    if (!props.length) props.push(`缺${ri(missN)}`);
    packages.push({ name: `包${i + 1}`, price: 1 + ri(9), props });
  }

  const body = { scenes, prepared, packages };
  const v = validateStocking(body);
  if (v.errors.length) throw new Error('合法载荷被判错：' + v.errors.join('；'));
  const r = solveStocking(v.required, v.prepared, v.missing, v.packages);

  // 暴力枚举全部包子集
  const fullMiss = (1 << missN) - 1;
  let brute = null; // { cost, count, mask }
  for (let sel = 0; sel < (1 << pkgN); sel++) {
    let cover = 0;
    let cost = 0;
    for (let i = 0; i < pkgN; i++) {
      if (sel & (1 << i)) { cover |= v.packages[i].cover; cost += v.packages[i].price; }
    }
    if (cover !== fullMiss) continue;
    let count = 0;
    for (let m = sel; m; m &= m - 1) count++;
    const cand = { cost, count, mask: sel };
    if (!brute
      || cand.cost < brute.cost
      || (cand.cost === brute.cost && cand.count < brute.count)
      || (cand.cost === brute.cost && cand.count === brute.count && packMaskLess(cand.mask, brute.mask))) {
      brute = cand;
    }
  }

  if (!brute) {
    if (r.ok) throw new Error('暴力无解但 DP 给出了方案');
    continue;
  }
  if (!r.ok) throw new Error('暴力有解但 DP 报无解：' + r.errors.join('；'));

  // 还原 DP 选中的包掩码
  let dpMask = 0;
  r.selected.forEach(p => { dpMask |= 1 << (p.index - 1); });
  if (r.totalPrice !== brute.cost) {
    throw new Error(`总价不符：DP ${r.totalPrice} vs 暴力 ${brute.cost}`);
  }
  if (r.packageCount !== brute.count) {
    throw new Error(`包数不符：DP ${r.packageCount} vs 暴力 ${brute.count}`);
  }
  if (dpMask !== brute.mask) {
    throw new Error(`同分选择不稳定：DP ${dpMask.toString(2)} vs 暴力 ${brute.mask.toString(2)}`);
  }
  cases++;
}
console.log(`stocking fuzz OK: ${cases} 组有解对拍全部一致（共 ${ITERS} 组）`);
