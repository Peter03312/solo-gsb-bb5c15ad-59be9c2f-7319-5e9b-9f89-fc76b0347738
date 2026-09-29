'use strict';

/**
 * 侧台存放区分配：节目单确定后，侧台为待执行步骤里的换景道具分配固定存放区。
 *
 * 输入（均由调用方校验）：
 *  - steps：求解 / 备选 / 演出中重排结果中的步骤，每步含 removed（撤下）与
 *    added（摆上）两组道具；phase === 'done' 的已完成步骤整体忽略；
 *  - zones：1～4 个固定存放区 { name, capacity }，名称非空且互不重复，
 *    capacity 为正整数格位数（每件道具全程固定占一个格位）；
 *  - times：每件待执行道具在每个区"一次取放"的正整数分钟，或"不可达"
 *    （null，或字符串 不可达 / unreachable / x / -）。
 *
 * 目标：在格位容量与可达限制下，把每件待执行道具恰好分到一个区，
 * 使全场总取放耗时最短。道具 p 分到区 z 的耗时 =
 *   各待执行步骤里 p 的撤下 / 摆上累计次数 × 单次取放分钟。
 * 同总耗时时稳定选取：先按道具首次出现顺序（段顺序、先撤下后摆上、段内顺序），
 * 再按存放区录入顺序——即取"各区序号组成的分配向量"字典序最小者
 * （最早出现的道具尽量放进录入更早的区）。
 *
 * 待执行道具种类 n ≤ MAX_STORAGE_PROPS（14）。
 *
 * 算法：按"录入顺序的区"分层的子集 DP。
 *  - 先按低位递推每个区对每个道具子集的可行性（格位不超且全部可达）与耗时和；
 *  - dp[j][mask] = 前 j 个区恰好放下 mask 时的最小耗时，
 *    转移枚举"放入第 j 个区的子集" s ⊆ full\\mask；
 *  - 同分用 4 进制编码的分配向量做字典序 tie-break（n ≤ 14 时编码 < 4^14，
 *    远小于 2^53，可直接按整数比较）；
 *  - 总转移约 m·3^n（m ≤ 4、n = 14 时约 1900 万次），毫秒～百毫秒级，
 *    沿 parent 指针重构出每件道具的归属。
 */

const { normalizeProps } = require('./solver');

/** 待存放道具种类上限。 */
const MAX_STORAGE_PROPS = 14;
/** 存放区数量范围。 */
const MIN_ZONES = 1;
const MAX_ZONES = 4;

/**
 * 解析单个"每件道具在某区的一次取放耗时"单元格。
 * 正整数分钟返回 { value }；null 或 不可达 / unreachable / x / - 视为不可达；
 * 其余（0、负数、小数、任意其他字符串）返回 null 表示非法。
 */
function parseCell(raw) {
  if (raw === null || raw === undefined) return { unreachable: true };
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? { value: raw } : null;
  }
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === '不可达' || t === 'unreachable' || t === 'x' || t === '-') {
      return { unreachable: true };
    }
  }
  return null;
}

/**
 * 校验并规范化存放区分配载荷
 * { steps: Step[], zones: [{ name, capacity }], times: { 道具: { 区名: 正整数|null } } }。
 * steps 中 phase === 'done' 的步骤不参与分配。
 * 返回 { errors, zones, props, counts, costs }：
 *  - zones: [{ name, capacity }]（按录入顺序）
 *  - props: 待执行道具（首次出现顺序）
 *  - counts: { 道具: 撤下/摆上累计次数 }
 *  - costs:  { 道具: { 区名: 正整数分钟 | null（不可达） } }
 */
function validateStorage(body) {
  const errors = [];

  // ---- 步骤：与排班同一口径（phase !== 'done' 为待执行）----
  const rawSteps = body && body.steps;
  const allSteps = [];
  const pendingSteps = [];
  if (!Array.isArray(rawSteps)) {
    errors.push('缺少待分配的节目单步骤（steps 必须是数组）');
  } else {
    for (const s0 of rawSteps) {
      if (!s0 || typeof s0 !== 'object') continue;
      const norm = {
        removed: normalizeProps(s0.removed),
        added: normalizeProps(s0.added),
      };
      allSteps.push(norm);
      if (s0.phase !== 'done') pendingSteps.push(norm);
    }
  }

  // ---- 待执行道具：首次出现顺序 + 撤下/摆上次数 ----
  const props = [];
  const seen = new Set();
  const counts = {};
  for (const s of pendingSteps) {
    for (const p of [...s.removed, ...s.added]) {
      if (!seen.has(p)) { seen.add(p); props.push(p); counts[p] = 0; }
      counts[p]++;
    }
  }
  if (props.length > MAX_STORAGE_PROPS) {
    errors.push(`待存放道具共 ${props.length} 种，超过 ${MAX_STORAGE_PROPS} 种上限，`
      + '无法分配固定存放区，请调整节目单或减少道具种类');
  }
  // 已完成步骤里出现的道具允许携带耗时（前端透传全部 steps），只是不强制、也不参与分配
  const knownSet = new Set();
  for (const s of allSteps) {
    for (const p of [...s.removed, ...s.added]) knownSet.add(p);
  }

  // ---- 存放区：1～4 个，名称非空不重复，格位数为正整数 ----
  const rawZones = body && body.zones;
  const zones = [];
  if (!Array.isArray(rawZones)) {
    errors.push('存放区配置缺失：zones 必须是 1～4 个 { name, capacity } 对象组成的数组');
  } else {
    if (rawZones.length < MIN_ZONES || rawZones.length > MAX_ZONES) {
      errors.push(`存放区需录入 ${MIN_ZONES}～${MAX_ZONES} 个（当前 ${rawZones.length} 个）`);
    }
    const nameSeen = new Set();
    rawZones.forEach((z0, i) => {
      const where = `第 ${i + 1} 个存放区`;
      const name = String((z0 && z0.name) ?? '').trim();
      if (!name) {
        errors.push(`${where}缺少名称`);
      } else if (nameSeen.has(name)) {
        errors.push(`存放区名称重复：${name}`);
      }
      nameSeen.add(name);
      const capacity = Number(z0 && z0.capacity);
      if (!Number.isInteger(capacity) || capacity <= 0) {
        errors.push(`${where}「${name || '未命名'}」的格位数必须是正整数`);
      }
      zones.push({ name, capacity: Number.isInteger(capacity) ? capacity : 0 });
    });
  }

  // ---- 逐道具 × 逐区取放耗时：正整数分钟或"不可达" ----
  const costs = {};
  for (const p of props) costs[p] = {};

  const rawTimes = body && body.times;
  if (rawTimes === undefined || rawTimes === null || typeof rawTimes !== 'object'
      || Array.isArray(rawTimes)) {
    if (props.length) errors.push('道具取放耗时配置缺失或格式无效：应为 { 道具名: { 存放区名: 正整数分钟 | 不可达 } }');
  } else {
    for (const key of Object.keys(rawTimes)) {
      if (!knownSet.has(String(key))) {
        errors.push(`取放耗时配置中包含待执行步骤没有的道具：${key}`);
      }
    }
    for (const p of props) {
      const cell = rawTimes[p];
      if (cell === undefined || cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
        errors.push(`缺少道具「${p}」在各存放区的取放耗时配置（正整数分钟或"不可达"）`);
        for (const z of zones) costs[p][z.name] = null;
        continue;
      }
      for (const key of Object.keys(cell)) {
        if (!zones.some(z => z.name === key)) {
          errors.push(`道具「${p}」的耗时配置引用了不存在的存放区：${key}`);
        }
      }
      for (const z of zones) {
        if (!(z.name in cell)) {
          errors.push(`缺少道具「${p}」在存放区「${z.name}」的取放耗时（正整数分钟或"不可达"）`);
          costs[p][z.name] = null;
          continue;
        }
        const parsed = parseCell(cell[z.name]);
        if (!parsed) {
          errors.push(`道具「${p}」在存放区「${z.name}」的取放耗时必须是正整数分钟，或填"不可达"`);
          costs[p][z.name] = null;
        } else {
          costs[p][z.name] = parsed.unreachable ? null : parsed.value;
        }
      }
    }
  }

  return { errors, zones, props, counts, costs };
}

/** 对同 (j, mask) 的两个状态做字典序 tie-break：分配向量字典序小者优。 */
function encodeWeight(n) {
  // 4 进制权重：首次出现最早的道具占最高位 → 整数大小即分配向量字典序
  const weight = new Float64Array(n);
  let w = 1;
  for (let i = n - 1; i >= 0; i--) { weight[i] = w; w *= 4; }
  return weight;
}

/**
 * 求容量与可达限制下总取放耗时最短的完整分配。入参须先经 validateStorage 校验。
 * 返回 {
 *   ok, zones: [{ index, name, capacity, used, props: [{ prop, moves, minutesPerMove, minutes }] }],
 *   assignments: [{ index, prop, zone, zoneIndex, moves, minutesPerMove, minutes }],
 *   propCount, zoneCount, totalMinutes
 * }；无待执行道具时返回空分配、总耗时 0；无法完整分配时 { ok:false, errors }。
 */
function solveStorage(props, counts, zones, costs) {
  const n = props.length;
  const m = zones.length;

  const baseZones = zones.map((z, i) => ({
    index: i + 1,
    name: z.name,
    capacity: z.capacity,
    used: 0,
    props: [],
  }));
  const baseResult = {
    zones: baseZones,
    assignments: [],
    propCount: n,
    zoneCount: m,
    totalMinutes: 0,
  };

  if (n === 0) return { ok: true, ...baseResult };

  // ---- 针对性预检，给出具体错误 ----
  const unreachableProps = props.filter(p => zones.every(z => costs[p][z.name] === null));
  if (unreachableProps.length) {
    return {
      ok: false,
      errors: [`以下道具对所有存放区都不可达，无法分配：${unreachableProps.join('、')}`],
    };
  }
  const totalCapacity = zones.reduce((a, z) => a + z.capacity, 0);
  if (totalCapacity < n) {
    return {
      ok: false,
      errors: [`存放区总格位 ${totalCapacity} 个，少于待存放道具 ${n} 种（每种固定占 1 格），无法完整分配；请增加格位`],
    };
  }

  const size = 1 << n;
  const full = size - 1;

  const popcnt = new Uint8Array(size);
  for (let mask = 1; mask < size; mask++) popcnt[mask] = popcnt[mask & (mask - 1)] + 1;

  // c[zi][i]：道具 i 在区 zi 的单次取放分钟（null=不可达）
  const c = zones.map(z => props.map(p => costs[p][z.name]));

  // 每区的可行子集（格位不超容量且子集内道具全部可达本区）与子集耗时和，均按低位递推
  const feasible = zones.map((z, zi) => {
    const arr = new Uint8Array(size);
    arr[0] = 1;
    for (let mask = 1; mask < size; mask++) {
      const low = mask & (-mask);
      const bit = 31 - Math.clz32(low);
      arr[mask] = (arr[mask ^ low] && popcnt[mask] <= z.capacity && c[zi][bit] !== null) ? 1 : 0;
    }
    return arr;
  });
  const zoneCost = zones.map((z, zi) => {
    const arr = new Float64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & (-mask);
      const bit = 31 - Math.clz32(low);
      arr[mask] = arr[mask ^ low] + c[zi][bit] * counts[props[bit]];
    }
    return arr;
  });

  // 分层 DP：cost/key 为"前 zi 个区放下 mask"的最优状态（滚动一行）
  const weight4 = encodeWeight(n);
  const keyAdd = zones.map((z, zi) => {
    // 子集 sub 分到本区时，字典序编码的增量（本区录入序号 zi 写入对应道具位）
    const arr = new Float64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & (-mask);
      const bit = 31 - Math.clz32(low);
      arr[mask] = arr[mask ^ low] + zi * weight4[bit];
    }
    return arr;
  });

  const INF = Infinity;
  let cost = new Float64Array(size).fill(INF);
  let key = new Float64Array(size).fill(0);
  cost[0] = 0;
  const parentPrev = new Array(m); // parentPrev[zi][mask]：进入区 zi 前的 mask
  const parentSub = new Array(m);  // parentSub[zi][mask]：区 zi 分到的子集

  for (let zi = 0; zi < m; zi++) {
    const nextCost = new Float64Array(size).fill(INF);
    const nextKey = new Float64Array(size).fill(0);
    const prev = new Int32Array(size).fill(-1);
    const subArr = new Int32Array(size).fill(-1);
    for (let mask = 0; mask < size; mask++) {
      if (cost[mask] === INF) continue;
      const rest = full ^ mask;
      for (let sub = rest; ; sub = (sub - 1) & rest) {
        if (feasible[zi][sub]) {
          const nm = mask | sub;
          const tc = cost[mask] + zoneCost[zi][sub];
          const tk = key[mask] + keyAdd[zi][sub];
          // 严格按（总耗时升序，分配向量字典序升序）取优
          if (tc < nextCost[nm] || (tc === nextCost[nm] && tk < nextKey[nm])) {
            nextCost[nm] = tc;
            nextKey[nm] = tk;
            prev[nm] = mask;
            subArr[nm] = sub;
          }
        }
        if (sub === 0) break;
      }
    }
    cost = nextCost;
    key = nextKey;
    parentPrev[zi] = prev;
    parentSub[zi] = subArr;
  }

  if (cost[full] === INF) {
    // 单件可达、总格位充足但组合上仍放不下（可达性 + 容量耦合）
    return {
      ok: false,
      errors: ['在现有格位容量与可达限制下无法为全部道具完整分配存放区；请增加格位或调整"不可达"配置'],
    };
  }

  // ---- 沿 parent 链重构：从最后一个区向前切分 ----
  const zoneOf = new Int8Array(n).fill(-1);
  let mask = full;
  for (let zi = m - 1; zi >= 0; zi--) {
    const sub = parentSub[zi][mask];
    for (let x = sub; x; x &= x - 1) {
      zoneOf[31 - Math.clz32(x & (-x))] = zi;
    }
    mask = parentPrev[zi][mask];
  }

  const zonesOut = zones.map((z, zi) => ({
    index: zi + 1,
    name: z.name,
    capacity: z.capacity,
    used: 0,
    props: [],
  }));
  const assignments = [];
  let total = 0;
  props.forEach((p, i) => {
    const zi = zoneOf[i];
    const per = c[zi][i];
    const minutes = per * counts[p];
    total += minutes;
    assignments.push({
      index: i + 1,
      prop: p,
      zone: zones[zi].name,
      zoneIndex: zi + 1,
      moves: counts[p],
      minutesPerMove: per,
      minutes,
    });
    zonesOut[zi].props.push({ prop: p, moves: counts[p], minutesPerMove: per, minutes });
    zonesOut[zi].used++;
  });

  return {
    ok: true,
    zones: zonesOut,
    assignments,
    propCount: n,
    zoneCount: m,
    totalMinutes: total,
  };
}

module.exports = {
  validateStorage,
  solveStorage,
  parseCell,
  MAX_STORAGE_PROPS,
  MIN_ZONES,
  MAX_ZONES,
};
