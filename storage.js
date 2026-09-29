'use strict';

/**
 * 侧台固定存放区分配：当前节目单确定后，为待执行步骤中出现的每件道具
 * 指定一个固定存放区。
 *
 * 输入（由调用方 / validateStorage 校验）：
 *  - zones：1～4 个存放区，每个含名称与正整数格位数（同一道具全程只占 1 格）；
 *  - steps：求解 / 备选 / 演出中重排结果中的步骤，phase === 'done' 的已完成
 *    步骤整体忽略；每步含 removed（撤下）与 added（摆上）两组道具；
 *  - times：每件道具在每个存放区"一次取放"所需的正整数分钟，或 "不可达"。
 *
 * 代价口径：
 *  - 道具 p 在各待执行步骤中被撤下 / 摆上的次数合计为 c_p；
 *  - 若 p 固定放在区 z，全程取放耗时 = c_p × t[p][z]；
 *  - 目标是在各区格位数与可达性限制下，使全部道具的总取放耗时最短。
 *
 * 同分稳定选择：总耗时相同时，按"道具首次出现顺序、存放区录入顺序"
 * 字典序选取——即把分配方案看成 k 进制数（首位是最早出现的道具，
 * 数位是存放区录入下标），取数值最小者。
 *
 * 待执行道具种类 n ≤ MAX_STORAGE_PROPS（14），区数 k ≤ 4。算法为按道具
 * 推进的多约束背包 DP：状态是各区已占用格位数（(d_0,…,d_{k-1})，
 * d_i ≤ min(格位数, n)），每道具向任一仍有空格且可达的区转移。
 * 可达状态数至多为"n 件分入 k 区"的弱合成数 C(n+k-1,k-1) ≤ C(17,3)=680，
 * 总转移 ≤ 680×14×4 ≈ 3.8 万次，毫秒级；每层状态保留父指针用于重构。
 */

const { normalizeProps } = require('./solver');

/** 待执行道具种类上限。 */
const MAX_STORAGE_PROPS = 14;
/** 存放区数量范围。 */
const MIN_ZONES = 1;
const MAX_ZONES = 4;
/** 可达性取值（字符串与该字符串去空白后的形式都接受）。 */
const UNREACHABLE = '不可达';

/**
 * 校验并规范化存放区分配载荷
 * { zones: [{ name, slots }], steps: Step[], times: { 道具名: [(正整数|不可达)] } }。
 * steps 中 phase === 'done' 的步骤不参与分配。
 * 返回 { errors, zones, slots, pendingSteps, props, counts, times }：
 *  - zones: 去空白、去重后的 1～4 个区名；
 *  - slots: 与 zones 对齐的正整数格位数；
 *  - props: 待执行道具（段顺序、先撤下后摆上、段内顺序去重）；
 *  - counts: 与 props 对齐的 { remove, add, total } 取放次数；
 *  - times:  与 props 对齐、每行长度为区数的矩阵，单元为正整数或 null（不可达）。
 */
function validateStorage(body) {
  const errors = [];

  // ---- 存放区 ----
  const rawZones = body && body.zones;
  const zones = [];
  const slots = [];
  if (!Array.isArray(rawZones)) {
    errors.push(`存放区必须是 ${MIN_ZONES}～${MAX_ZONES} 个 { name, slots } 组成的数组`);
  } else {
    if (rawZones.length < MIN_ZONES || rawZones.length > MAX_ZONES) {
      errors.push(`存放区需录入 ${MIN_ZONES}～${MAX_ZONES} 个（当前 ${rawZones.length} 个）`);
    }
    const nameSeen = new Set();
    rawZones.forEach((z0, i) => {
      const where = `第 ${i + 1} 个存放区`;
      const name = String((z0 && z0.name) == null ? '' : z0.name).trim();
      if (!name) {
        errors.push(`${where}的名称不能为空`);
      } else if (nameSeen.has(name)) {
        errors.push(`存放区名称重复：${name}`);
      }
      nameSeen.add(name);

      const s = Number(z0 && z0.slots);
      if (!Number.isFinite(s) || !Number.isInteger(s) || s <= 0) {
        errors.push(`${where}「${name || '未命名'}」的格位数必须是正整数`);
      }
      if (name && Number.isInteger(s) && s > 0) {
        zones.push(name);
        slots.push(s);
      }
    });
  }

  // ---- 步骤（与排班同一结构；phase === 'done' 整体忽略）----
  const rawSteps = body && body.steps;
  const pendingSteps = [];
  const allSteps = [];
  if (!Array.isArray(rawSteps)) {
    errors.push('缺少待分配的节目单步骤（steps 必须是数组）');
  } else {
    for (const s0 of rawSteps) {
      if (!s0 || typeof s0 !== 'object') continue;
      const norm = {
        type: s0.type === 'setup' ? 'setup' : 'transition',
        scene: s0.scene != null ? String(s0.scene) : null,
        from: s0.from != null ? String(s0.from) : null,
        to: s0.to != null ? String(s0.to) : null,
        fromStage: !!s0.fromStage,
        removed: normalizeProps(s0.removed),
        added: normalizeProps(s0.added),
      };
      allSteps.push(norm);
      if (s0.phase !== 'done') pendingSteps.push(norm);
    }
  }

  // ---- 待执行道具与取放次数 ----
  const props = [];
  const propSeen = new Set();
  const removeCount = new Map();
  const addCount = new Map();
  const bump = (map, p) => map.set(p, (map.get(p) || 0) + 1);
  for (const s of pendingSteps) {
    for (const p of s.removed) {
      if (!propSeen.has(p)) { propSeen.add(p); props.push(p); }
      bump(removeCount, p);
    }
    for (const p of s.added) {
      if (!propSeen.has(p)) { propSeen.add(p); props.push(p); }
      bump(addCount, p);
    }
  }
  const counts = props.map(p => {
    const remove = removeCount.get(p) || 0;
    const add = addCount.get(p) || 0;
    return { remove, add, total: remove + add };
  });

  if (props.length > MAX_STORAGE_PROPS) {
    errors.push(`待执行道具共 ${props.length} 种，超过 ${MAX_STORAGE_PROPS} 种上限，无法分配固定存放区；`
      + '请先调整节目单或推进已完成前缀');
  }

  // 已完成步骤中的道具允许出现在 times 里（前端可透传），但不参与分配
  const knownSet = new Set();
  for (const s of allSteps) {
    for (const p of [...s.removed, ...s.added]) knownSet.add(p);
  }

  // ---- 各区单次取放耗时 ----
  // 无待执行道具时按"空分配"直接成功，不强制 times（与返回空分配、0 分钟的口径一致）。
  const k = zones.length;
  const times = props.map(() => new Array(k).fill(null));
  if (props.length > 0 && k > 0) {
    const rawTimes = body && body.times;
    if (rawTimes === undefined || rawTimes === null || typeof rawTimes !== 'object'
        || Array.isArray(rawTimes)) {
      errors.push('道具取放耗时配置缺失或格式无效：应为 { 道具名: [每区正整数分钟或「不可达」] }');
    } else {
      props.forEach((p, i) => {
        const row = rawTimes[p];
        if (!Array.isArray(row) || row.length !== k) {
          errors.push(`道具「${p}」的取放耗时必须是长度 ${k} 的数组（与存放区一一对应）`);
          return;
        }
        row.forEach((v, z) => {
          if (typeof v === 'string' && v.trim() === UNREACHABLE) {
            times[i][z] = null;
            return;
          }
          const m = Number(v);
          if (!Number.isFinite(m) || !Number.isInteger(m) || m <= 0) {
            errors.push(`道具「${p}」在存放区「${zones[z]}」的一次取放耗时必须是正整数分钟，或填「不可达」`);
            return;
          }
          times[i][z] = m;
        });
      });
      for (const key of Object.keys(rawTimes)) {
        if (!propSeen.has(String(key)) && !knownSet.has(String(key))) {
          errors.push(`取放耗时配置中包含待执行步骤没有的道具：${key}`);
        }
      }
    }
  }

  return { errors, zones, slots, pendingSteps, props, counts, times };
}

/** 解析状态码 code（B+1 进制）为各区已占格位数组。 */
function decodeDigits(code, radix, k) {
  const digits = new Array(k);
  let x = code;
  for (let z = 0; z < k; z++) {
    digits[z] = x % radix;
    x = Math.floor(x / radix);
  }
  return digits;
}

/**
 * 在已校验输入上求总取放耗时最短的固定分配。
 * 返回 { ok, zones, slots, props, assignments, totalMinutes, ... }；
 * 格位总量不足或可达性导致无法完整分配时返回 { ok:false, errors }。
 */
function allocateStorage(zones, slots, props, counts, times) {
  const n = props.length;
  const k = zones.length;

  const zoneView = zones.map((name, z) => ({
    name,
    slots: slots[z],
    usedSlots: 0,
    props: [],
    removeCount: 0,
    addCount: 0,
    minutes: 0,
  }));
  if (n === 0) {
    return {
      ok: true,
      zones: zoneView,
      zoneCount: k,
      props: [],
      assignments: {},
      propCount: 0,
      totalMinutes: 0,
    };
  }

  // 任何超过道具总数的格位数都没有实际意义；截断后保证状态进制有界（B ≤ 4n ≤ 56）
  const caps = slots.map(s => Math.min(s, n));
  const totalCap = caps.reduce((a, b) => a + b, 0);
  if (totalCap < n) {
    return {
      ok: false,
      errors: [`全部存放区共 ${totalCap} 个格位，放不下 ${n} 种待执行道具（每件占 1 格），无法完整分配；请增加格位或存放区`],
    };
  }
  const stranded = [];
  props.forEach((p, i) => {
    if (!times[i].some(m => m !== null)) stranded.push(p);
  });
  if (stranded.length) {
    return {
      ok: false,
      errors: [`以下道具在所有存放区都不可达，无法分配：${stranded.join('、')}`],
    };
  }

  // 状态码：各区已占格位 d_z 以 (B+1) 进制编码，第 z 区占第 z 位（低位起）
  const radix = totalCap + 1;
  const statePow = [1];
  for (let z = 1; z < k; z++) statePow.push(statePow[z - 1] * radix);

  // 同分字典序：分配向量按 k 进制编码，第 i 件（首次出现顺序）占最高位
  const lexPow = new Array(n);
  lexPow[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) lexPow[i] = lexPow[i + 1] * k;

  // layers[i]：已放下前 i 件道具后的全部状态
  //   code -> { cost, lex, parent, zone }（parent/zone 仅用于重构）
  const layers = new Array(n + 1);
  let cur = new Map();
  cur.set(0, { cost: 0, lex: 0, parent: -1, zone: -1 });
  layers[0] = cur;

  for (let i = 0; i < n; i++) {
    const next = new Map();
    const c = counts[i].total;
    const lexShift = lexPow[i];
    for (const [code, st] of cur) {
      const digits = decodeDigits(code, radix, k);
      for (let z = 0; z < k; z++) {
        if (digits[z] >= caps[z]) continue; // 该区格位已满
        const m = times[i][z];
        if (m === null) continue; // 道具在该区不可达
        const ncode = code + statePow[z];
        const cand = {
          cost: st.cost + c * m,
          lex: st.lex + z * lexShift,
          parent: code,
          zone: z,
        };
        const old = next.get(ncode);
        // 同状态：总耗时低者胜；耗时相同取分配字典序小者（结果确定）
        if (!old || cand.cost < old.cost
            || (cand.cost === old.cost && cand.lex < old.lex)) {
          next.set(ncode, cand);
        }
      }
    }
    layers[i + 1] = next;
    cur = next;
  }

  // 终态之间再按（总耗时, 分配字典序）取全局最优
  let bestCode = -1;
  let best = null;
  for (const [code, st] of cur) {
    if (!best || st.cost < best.cost || (st.cost === best.cost && st.lex < best.lex)) {
      best = st;
      bestCode = code;
    }
  }
  if (!best) {
    return {
      ok: false,
      errors: ['在现有格位与可达限制下无法为全部道具完成完整分配，请调整格位或可达耗时'],
    };
  }

  // 沿父指针重构每件道具的存放区
  const assign = new Array(n);
  let code = bestCode;
  for (let i = n; i >= 1; i--) {
    const st = layers[i].get(code);
    assign[i - 1] = st.zone;
    code = st.parent;
  }

  const assignments = {};
  const propRows = props.map((p, i) => {
    const z = assign[i];
    const minutes = times[i][z];
    const subtotal = counts[i].total * minutes;
    assignments[p] = z;
    const zc = zoneView[z];
    zc.usedSlots += 1;
    zc.props.push(p);
    zc.removeCount += counts[i].remove;
    zc.addCount += counts[i].add;
    zc.minutes += subtotal;
    return {
      index: i + 1,
      name: p,
      handlings: counts[i].total,
      removeCount: counts[i].remove,
      addCount: counts[i].add,
      zoneIndex: z,
      zone: zones[z],
      minutesPerHandling: minutes,
      totalMinutes: subtotal,
    };
  });

  return {
    ok: true,
    zones: zoneView,
    zoneCount: k,
    props: propRows,
    assignments,
    propCount: n,
    totalMinutes: best.cost,
  };
}

module.exports = {
  validateStorage,
  allocateStorage,
  MAX_STORAGE_PROPS,
  MIN_ZONES,
  MAX_ZONES,
  UNREACHABLE,
};
