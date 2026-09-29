'use strict';

const assert = require('assert');
const {
  validateStorage,
  allocateStorage,
  MAX_STORAGE_PROPS,
  MIN_ZONES,
  MAX_ZONES,
} = require('../storage');

/** 校验并分配的快捷函数；校验不通过时抛错（错误在专门用例里逐条检查）。 */
function run(body) {
  const v = validateStorage(body);
  assert.deepStrictEqual(v.errors, []);
  const r = allocateStorage(v.zones, v.slots, v.props, v.counts, v.times);
  assert.ok(r.ok, r.errors);
  return r;
}

/** 简单构造：1 个开场 + 若干换景；steps 形如 [['撤下…'], ['摆上…']] 成对。 */
function stepsFrom(pairs, opts = {}) {
  const steps = [];
  pairs.forEach(([removed, added], i) => {
    if (i === 0 && !opts.noSetup) {
      steps.push({ type: 'setup', scene: `s${i}`, removed: [], added });
    } else {
      steps.push({ type: 'transition', from: `s${i - 1}`, to: `s${i}`, removed, added });
    }
  });
  if (opts.done) steps.forEach(s => { s.phase = 'done'; });
  return steps;
}

/** 等耗时矩阵（每区每道具相同分钟）。 */
function flatTimes(props, zones, m, unreachable = []) {
  const t = {};
  for (const p of props) {
    t[p] = zones.map((_, z) => (unreachable.some(([pp, zz]) => pp === p && zz === z) ? '不可达' : m));
  }
  return t;
}

/* 1. 存放区数量 / 名称 / 格位数校验 */
for (const badZones of [
  undefined, null, [],
  [{ name: 'A', slots: 1 }, { name: 'B', slots: 1 }, { name: 'C', slots: 1 },
   { name: 'D', slots: 1 }, { name: 'E', slots: 1 }],
  [{ name: '  ', slots: 1 }],
  [{ name: 'A', slots: 1 }, { name: 'A', slots: 1 }],
  [{ name: 'A', slots: 0 }],
  [{ name: 'A', slots: -2 }],
  [{ name: 'A', slots: 1.5 }],
  [{ name: 'A' }],
]) {
  const v = validateStorage({ zones: badZones, steps: [], times: {} });
  assert.ok(v.errors.some(e => e.includes('存放区') || e.includes('格位')),
    `应拒绝存放区配置：${JSON.stringify(badZones)}；实际：${v.errors.join('|')}`);
}

/* 2. steps 缺失 / 非数组 */
{
  const v = validateStorage({
    zones: [{ name: 'A', slots: 2 }],
    times: {},
  });
  assert.ok(v.errors.some(e => e.includes('steps')));
}

/* 3. 无待执行道具（无步骤 / 全部 done）→ 空分配、0 分钟 */
{
  const v1 = validateStorage({ zones: [{ name: 'A', slots: 2 }], steps: [], times: {} });
  assert.deepStrictEqual(v1.errors, []);
  const r1 = allocateStorage(v1.zones, v1.slots, v1.props, v1.counts, v1.times);
  assert.ok(r1.ok);
  assert.strictEqual(r1.totalMinutes, 0);
  assert.strictEqual(r1.propCount, 0);
  assert.deepStrictEqual(r1.assignments, {});
  assert.deepStrictEqual(r1.props, []);
  assert.strictEqual(r1.zones.length, 1);
  assert.strictEqual(r1.zones[0].usedSlots, 0);

  const v2 = validateStorage({
    zones: [{ name: 'A', slots: 2 }],
    steps: stepsFrom([[[], ['灯']]], { done: true }),
    times: { 灯: [3] },
  });
  assert.deepStrictEqual(v2.errors, []);
  const r2 = allocateStorage(v2.zones, v2.slots, v2.props, v2.counts, v2.times);
  assert.ok(r2.ok);
  assert.strictEqual(r2.propCount, 0);
  assert.strictEqual(r2.totalMinutes, 0);
}

/* 4. times 校验：缺失、长度不符、非正整数、非法字符串、多余道具 */
{
  const steps = stepsFrom([[[], ['灯', '椅']], [['灯'], ['桌']]]);
  const zones = [{ name: 'A', slots: 3 }, { name: 'B', slots: 3 }];
  assert.ok(validateStorage({ zones, steps, times: null }).errors.some(e => e.includes('耗时')));
  assert.ok(validateStorage({ zones, steps, times: { 灯: [1] } })
    .errors.some(e => e.includes('「灯」') && e.includes('长度 2')));
  assert.ok(validateStorage({ zones, steps, times: { 灯: [1, 0], 椅: [1, 1], 桌: [1, 1] } })
    .errors.some(e => e.includes('「灯」') && e.includes('B')));
  assert.ok(validateStorage({ zones, steps, times: { 灯: [1, '到不了'], 椅: [1, 1], 桌: [1, 1] } })
    .errors.some(e => e.includes('「灯」') && e.includes('不可达')));
  assert.ok(validateStorage({
    zones, steps,
    times: { 灯: [1, 1], 椅: [1, 1], 桌: [1, 1], 多余: [1, 1] },
  }).errors.some(e => e.includes('多余')));
  // 已完成步骤中的道具允许携带耗时，不报错
  const v = validateStorage({
    zones,
    steps: [
      { type: 'setup', scene: 'x', phase: 'done', removed: [], added: ['旧'] },
      { type: 'transition', from: 'x', to: 'y', removed: [], added: ['灯'] },
    ],
    times: { 灯: [1, 1], 旧: [2, 2] },
  });
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.props, ['灯']);
}

/* 5. 取放次数统计：撤下与摆上分别累计，首次出现顺序为段序、先撤后摆 */
{
  const v = validateStorage({
    zones: [{ name: 'A', slots: 4 }],
    steps: [
      { type: 'setup', scene: 's0', removed: [], added: ['甲', '乙'] },
      { type: 'transition', from: 's0', to: 's1', removed: ['甲'], added: ['丙'] },
      { type: 'transition', from: 's1', to: 's2', removed: ['乙', '丙'], added: ['甲'] },
    ],
    times: flatTimes(['甲', '乙', '丙'], ['A'], 1),
  });
  assert.deepStrictEqual(v.props, ['甲', '乙', '丙']);
  assert.deepStrictEqual(v.counts, [
    { remove: 1, add: 2, total: 3 },
    { remove: 1, add: 1, total: 2 },
    { remove: 1, add: 1, total: 2 },
  ]);
}

/* 6. 基础最优：高频道具应放到单位耗时更低的区（受格位限制） */
{
  // 甲 3 次、乙 1 次；A 区 1 格且每次 1 分钟，B 区 1 格每次 10 分钟 → 甲占 A
  const steps = [
    { type: 'setup', scene: 's0', removed: [], added: ['甲', '乙'] },
    { type: 'transition', from: 's0', to: 's1', removed: ['甲'], added: [] },
    { type: 'transition', from: 's1', to: 's2', removed: [], added: ['甲'] },
  ];
  const r = run({
    zones: [{ name: 'A', slots: 1 }, { name: 'B', slots: 1 }],
    steps,
    times: { 甲: [1, 10], 乙: [1, 10] },
  });
  assert.strictEqual(r.assignments['甲'], 0);
  assert.strictEqual(r.assignments['乙'], 1);
  // 甲 3 次 ×1 + 乙 1 次 ×10 = 13
  assert.strictEqual(r.totalMinutes, 13);
  assert.strictEqual(r.zones[0].usedSlots, 1);
  assert.strictEqual(r.zones[1].usedSlots, 1);
  assert.strictEqual(r.zones[0].minutes, 3);
  assert.strictEqual(r.zones[1].minutes, 10);
}

/* 7. 同分稳定选择：同耗时按道具首次出现顺序、区录入顺序（字典序最小） */
{
  const steps = stepsFrom([[[], ['甲', '乙']]]);
  // 两区等价（各 2 格、各道具两区都 1 分钟）→ 所有道具都应落在录入最早的 A 区
  const r = run({
    zones: [{ name: 'A', slots: 2 }, { name: 'B', slots: 2 }],
    steps,
    times: { 甲: [1, 1], 乙: [1, 1] },
  });
  assert.strictEqual(r.assignments['甲'], 0);
  assert.strictEqual(r.assignments['乙'], 0);
  assert.deepStrictEqual(r.zones[0].props, ['甲', '乙']);

  // 容量迫使分箱且两方案同耗时：甲必须在 0 号位或 1 号位时，甲（更早出现）取小编号区
  const r2 = run({
    zones: [{ name: 'A', slots: 1 }, { name: 'B', slots: 1 }],
    steps,
    times: { 甲: [5, 5], 乙: [5, 5] },
  });
  assert.strictEqual(r2.assignments['甲'], 0);
  assert.strictEqual(r2.assignments['乙'], 1);
  assert.strictEqual(r2.totalMinutes, 10);
}

/* 8. 不可达：字符串「不可达」与去空白形式均可识别，并参与约束 */
{
  const steps = stepsFrom([[[], ['灯', '椅']]]);
  const r = run({
    zones: [{ name: '近台', slots: 1 }, { name: '后台', slots: 1 }],
    steps,
    times: { 灯: [2, '不可达'], 椅: [' 不可达 ', 3] },
  });
  assert.strictEqual(r.assignments['灯'], 0);
  assert.strictEqual(r.assignments['椅'], 1);
  assert.strictEqual(r.totalMinutes, 5);
}

/* 9. 全部不可达 → 报错且无方案 */
{
  const v = validateStorage({
    zones: [{ name: 'A', slots: 2 }],
    steps: stepsFrom([[[], ['灯']]]),
    times: { 灯: ['不可达'] },
  });
  assert.deepStrictEqual(v.errors, []);
  const r = allocateStorage(v.zones, v.slots, v.props, v.counts, v.times);
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('不可达') && e.includes('灯')));
}

/* 10. 格位不足：总量不够 / 单区可达性导致装不下 */
{
  const v = validateStorage({
    zones: [{ name: 'A', slots: 1 }],
    steps: stepsFrom([[[], ['灯', '椅']]]),
    times: flatTimes(['灯', '椅'], ['A'], 1),
  });
  const r = allocateStorage(v.zones, v.slots, v.props, v.counts, v.times);
  assert.ok(!r.ok);
  assert.ok(r.errors[0].includes('格位'));

  // 总量够，但灯只能放 A、椅只能放 A，A 只有 1 格 → DP 判定无法完整分配
  const v2 = validateStorage({
    zones: [{ name: 'A', slots: 1 }, { name: 'B', slots: 1 }],
    steps: stepsFrom([[[], ['灯', '椅']]]),
    times: { 灯: [1, '不可达'], 椅: [1, '不可达'] },
  });
  const r2 = allocateStorage(v2.zones, v2.slots, v2.props, v2.counts, v2.times);
  assert.ok(!r2.ok);
  assert.ok(r2.errors[0].includes('无法'));
}

/* 11. 道具超过 14 种 → 校验拦截 */
{
  const props = Array.from({ length: MAX_STORAGE_PROPS + 1 }, (_, i) => `p${i}`);
  const v = validateStorage({
    zones: [{ name: 'A', slots: 20 }],
    steps: [{ type: 'setup', scene: 's', removed: [], added: props }],
    times: flatTimes(props, ['A'], 1),
  });
  assert.ok(v.errors.some(e => e.includes(`${MAX_STORAGE_PROPS}`) && e.includes('上限')));
}

/* 12. phase:'done' 步骤整体忽略（含其中只在 done 出现的道具） */
{
  const v = validateStorage({
    zones: [{ name: 'A', slots: 2 }],
    steps: [
      { type: 'setup', scene: 's0', phase: 'done', removed: [], added: ['旧1', '旧2'] },
      { type: 'transition', phase: 'done', from: 's0', to: 's1', removed: ['旧1'], added: [] },
      { type: 'transition', from: 's1', to: 's2', removed: ['旧2'], added: ['新'] },
    ],
    times: { 旧2: [3], 新: [4] },
  });
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.props, ['旧2', '新']);
  assert.deepStrictEqual(v.counts, [
    { remove: 1, add: 0, total: 1 },
    { remove: 0, add: 1, total: 1 },
  ]);
  const r = allocateStorage(v.zones, v.slots, v.props, v.counts, v.times);
  assert.strictEqual(r.totalMinutes, 7);
}

/* 13. 结果结构：区视图、道具行字段齐全且一致 */
{
  const r = run({
    zones: [{ name: 'A', slots: 3 }, { name: 'B', slots: 3 }],
    steps: stepsFrom([[[], ['灯', '椅', '桌']], [['灯'], ['灯']]]),
    times: { 灯: [2, 5], 椅: [2, 5], 桌: [2, 5] },
  });
  assert.strictEqual(r.zoneCount, 2);
  assert.strictEqual(r.propCount, 3);
  // 灯有 2 次取放，应抢入 A；椅、桌各 1 次也在 A（3 格刚好）
  assert.deepStrictEqual(r.assignments, { 灯: 0, 椅: 0, 桌: 0 });
  assert.strictEqual(r.zones[0].usedSlots, 3);
  assert.strictEqual(r.zones[1].usedSlots, 0);
  // 灯：摆1 + 撤1 + 摆1 = 3 次
  const lamp = r.props.find(p => p.name === '灯');
  assert.deepStrictEqual(
    [lamp.handlings, lamp.removeCount, lamp.addCount, lamp.minutesPerHandling, lamp.totalMinutes],
    [3, 1, 2, 2, 6],
  );
  // 各区分钟合计 = 总耗时
  assert.strictEqual(r.zones.reduce((a, z) => a + z.minutes, 0), r.totalMinutes);
  assert.strictEqual(r.totalMinutes, 10); // 3×2 + 2 + 2
  // props 按首次出现顺序返回
  assert.deepStrictEqual(r.props.map(p => p.name), ['灯', '椅', '桌']);
}

/* 14. 容量上限边界：14 件、4 区可正常求解；格位远大于件数时按 n 截断不影响结果 */
{
  const props = Array.from({ length: 14 }, (_, i) => `p${i}`);
  const r = run({
    zones: [{ name: 'A', slots: 100 }, { name: 'B', slots: 100 },
            { name: 'C', slots: 100 }, { name: 'D', slots: 100 }],
    steps: [{ type: 'setup', scene: 's', removed: [], added: props }],
    times: Object.fromEntries(props.map((p, i) => [p, [i + 1, i + 2, i + 3, i + 4]])),
  });
  assert.strictEqual(r.propCount, 14);
  assert.strictEqual(r.zones[0].usedSlots, 14);
  assert.strictEqual(r.totalMinutes, props.reduce((a, _, i) => a + (i + 1), 0));
}

console.log('storage 测试全部通过');
