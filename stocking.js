'use strict';

/**
 * 巡演备货：以当前场景道具全集为需求清单，先标记已备齐道具（缺件），
 * 再录入至多 30 个采购包（名称、正整数价格、所含道具，每包至多买一次），
 * 求覆盖全部缺件的最低总价组合。
 *
 * 约束与口径：
 *  - 需求道具由全部场景道具汇总去重（保持录入顺序：先场景序、后场景内顺序），
 *    与场景录入、巡演装箱共用同一口径（packing.collectProps）；
 *  - 缺件 = 需求清单 − 已备齐道具；缺件种类 n ≤ 14（MAX_STOCK_MISSING）；
 *  - 采购包至多 30 个（MAX_PACKAGES），名称非空且不重复，价格为正整数；
 *  - 包内道具须全部来自需求清单（允许重复覆盖、允许只含已备齐道具），每包非空；
 *  - 每个包至多购买一次。
 *
 * 目标：覆盖全部缺件（缺件允许被多个包重复覆盖）的最低总价；
 * 同价时优先购买包数少；仍相同时按包的录入顺序稳定选取
 * （取下标集合字典序更小者：最先出现分歧的录入位上，含该位包的组合优先，
 * 即尽量选用录入更早的包）。
 *
 * 算法：覆盖集 DP（0/1 背包式逐包推进，n ≤ 14 可按缺件掩码枚举）。
 * dp[mask] = 覆盖到缺件集合 mask 时的最优采购状态 { cost, count, packs }，
 * 复杂度 O(包数 · 2^n)，30 × 16384 约 49 万次，毫秒级。
 * 转移按包的录入顺序进行；新状态与旧状态按
 * （总价升序 → 包数升序 → 包下标集合字典序）比较择优，保证结果确定。
 */

const { collectProps } = require('./packing');

/** 缺件种类上限。 */
const MAX_STOCK_MISSING = 14;
/** 采购包数量上限。 */
const MAX_PACKAGES = 30;

/** 比较两个采购状态：a 是否优于 b。
 * 优先总价低；同价优先包数少；仍相同则包下标集合字典序小者优
 * （a、b 的最低不同位上，含该位（更早录入的包）的一方为小）。 */
function betterState(a, b) {
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.count !== b.count) return a.count < b.count;
  if (a.packMask === b.packMask) return false;
  const diff = a.packMask ^ b.packMask;
  const low = diff & (-diff);
  return (a.packMask & low) !== 0;
}

/**
 * 校验并规范化备货载荷
 * { scenes, prepared?: string[], packages?: [{ name, price, props }] }。
 * 返回 { errors, required, prepared, missing, packages }：
 *  - required: 需求清单（场景道具汇总去重，录入顺序）
 *  - prepared: 已备齐道具（需求清单的子集，按需求清单顺序）
 *  - missing:  缺件（需求清单 − 已备齐，录入顺序）
 *  - packages: [{ name, price, props, cover }]（cover 为该包覆盖的缺件位掩码）
 */
function validateStocking(body) {
  const errors = [];

  const rawScenes = body && body.scenes;
  if (!Array.isArray(rawScenes)) errors.push('场景数据缺失，无法汇总需求道具');
  const required = collectProps(Array.isArray(rawScenes) ? rawScenes : []);
  const itemSet = new Set(required);
  if (Array.isArray(rawScenes) && required.length === 0) {
    errors.push('场景中还没有任何道具，请先在场景道具里录入至少一件需求道具');
  }

  // 已备齐道具：去空白、去重；不在需求清单内的道具视为口径错误
  const rawPrepared = body && body.prepared;
  const prepared = [];
  if (rawPrepared !== undefined && rawPrepared !== null) {
    if (!Array.isArray(rawPrepared)) {
      errors.push('已备齐道具格式无效：应为道具名数组');
    } else {
      const seen = new Set();
      for (const p of rawPrepared) {
        const name = String(p).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (!itemSet.has(name)) {
          errors.push(`已备齐道具「${name}」不在需求清单中`);
          continue;
        }
        prepared.push(name);
      }
    }
  }
  const preparedSet = new Set(prepared);
  const missing = required.filter(name => !preparedSet.has(name));
  if (missing.length > MAX_STOCK_MISSING) {
    errors.push(`缺件共 ${missing.length} 种，超过 ${MAX_STOCK_MISSING} 种上限，请先备齐部分道具或减少道具种类`);
  }

  // 采购包：数量、名称（非空且不重复）、价格（正整数）、道具（非空且全部在需求清单内）
  const rawPackages = body && body.packages;
  const packages = [];
  if (rawPackages !== undefined && rawPackages !== null && !Array.isArray(rawPackages)) {
    errors.push('采购包配置格式无效：应为数组');
  }
  const list = Array.isArray(rawPackages) ? rawPackages : [];
  if (list.length > MAX_PACKAGES) {
    errors.push(`采购包最多录入 ${MAX_PACKAGES} 个，当前 ${list.length} 个`);
  }
  const nameSeen = new Set();
  list.forEach((pkg, i) => {
    const where = `第 ${i + 1} 个采购包`;
    const name = String((pkg && pkg.name) ?? '').trim();
    if (!name) {
      errors.push(`${where}缺少名称`);
    } else if (nameSeen.has(name)) {
      errors.push(`采购包名称重复：${name}`);
    }
    nameSeen.add(name);

    const price = Number(pkg && pkg.price);
    if (!Number.isInteger(price) || price <= 0) {
      errors.push(`${where}「${name || '未命名'}」的价格必须是正整数`);
    }

    const rawProps = pkg && pkg.props;
    if (!Array.isArray(rawProps)) {
      errors.push(`${where}「${name || '未命名'}」的道具必须是数组`);
      return;
    }
    const props = [];
    const pSeen = new Set();
    for (const p of rawProps) {
      const pname = String(p).trim();
      if (!pname || pSeen.has(pname)) continue; // 包内重复道具按一件计
      pSeen.add(pname);
      if (!itemSet.has(pname)) {
        errors.push(`${where}「${name || '未命名'}」包含需求清单之外的道具：${pname}`);
        continue;
      }
      props.push(pname);
    }
    if (props.length === 0) {
      errors.push(`${where}「${name || '未命名'}」至少要包含 1 件需求清单中的道具`);
    }
    packages.push({ name, price: Number.isInteger(price) && price > 0 ? price : 0, props });
  });

  // 预计算每个包覆盖的缺件位掩码
  const missIndex = new Map(missing.map((name, i) => [name, i]));
  for (const pkg of packages) {
    let cover = 0;
    for (const p of pkg.props) {
      const bit = missIndex.get(p);
      if (bit !== undefined) cover |= 1 << bit;
    }
    pkg.cover = cover;
  }

  return { errors, required, prepared, missing, packages };
}

/**
 * 求覆盖全部缺件的最低总价采购组合。入参须先经 validateStocking 校验。
 * 返回 { ok, required, prepared, missing, packages, selected, packageCount, totalPrice }；
 * 无缺件时返回空组合、总价 0；缺件无法被任何包组合覆盖时返回 { ok:false, errors, uncovered }。
 */
function solveStocking(required, prepared, missing, packages) {
  const baseResult = {
    required: required.slice(),
    prepared: prepared.slice(),
    missing: missing.slice(),
    packages: packages.map(p => ({
      name: p.name,
      price: p.price,
      props: p.props.slice(),
      coversMissing: missing.filter(m => p.props.includes(m)),
    })),
  };

  if (missing.length === 0) {
    return { ...baseResult, ok: true, selected: [], packageCount: 0, totalPrice: 0 };
  }

  // 先判定可覆盖性：任一缺件都至少要出现在某个包中
  const reachable = new Array(missing.length).fill(false);
  for (const p of packages) {
    for (let i = 0; i < missing.length; i++) if (p.cover & (1 << i)) reachable[i] = true;
  }
  const uncovered = missing.filter((_, i) => !reachable[i]);
  if (uncovered.length) {
    return {
      ...baseResult,
      ok: false,
      errors: [`以下缺件没有任何采购包包含，无法备齐：${uncovered.join('、')}`],
      uncovered,
    };
  }

  // 覆盖集 DP：按录入顺序逐包做 0/1 推进
  const size = 1 << missing.length;
  const dp = new Array(size).fill(null);
  dp[0] = { cost: 0, count: 0, packMask: 0 };
  packages.forEach((pkg, idx) => {
    for (let mask = size - 1; mask >= 0; mask--) {
      const cur = dp[mask];
      if (!cur) continue;
      const nextMask = mask | pkg.cover;
      const cand = { cost: cur.cost + pkg.price, count: cur.count + 1, packMask: cur.packMask | (1 << idx) };
      if (!dp[nextMask] || betterState(cand, dp[nextMask])) dp[nextMask] = cand;
    }
  });

  const full = size - 1;
  const best = dp[full];
  if (!best) {
    // 单件可达但组合仍无法全覆盖（理论上与上面的单件检查等价时不会到达，防御性返回）
    return {
      ...baseResult,
      ok: false,
      errors: ['现有采购包无法覆盖全部缺件，请补充采购包'],
      uncovered: missing.slice(),
    };
  }

  // 选中的包按录入顺序稳定展示
  const selected = [];
  for (let idx = 0; idx < packages.length; idx++) {
    if (best.packMask & (1 << idx)) {
      const p = packages[idx];
      selected.push({
        index: idx + 1,
        name: p.name,
        price: p.price,
        props: p.props.slice(),
        coversMissing: missing.filter(m => p.props.includes(m)),
      });
    }
  }

  return { ...baseResult, ok: true, selected, packageCount: selected.length, totalPrice: best.cost };
}

module.exports = { validateStocking, solveStocking, MAX_STOCK_MISSING, MAX_PACKAGES };
