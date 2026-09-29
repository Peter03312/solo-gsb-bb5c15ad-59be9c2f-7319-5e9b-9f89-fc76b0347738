'use strict';

const assert = require('assert');
const {
  validateStorage,
  solveStorage,
  parseCell,
  MAX_STORAGE_PROPS,
  MIN_ZONES,
  MAX_ZONES,
} = require('../storage');

const setup = (added, phase) => ({ type: 'setup', phase, added, removed: [] });
const trans = (removed, added, phase = 'suffix') => ({ type: 'transition', phase, removed, added });

/** 校验 + 求解的快捷函数 */
function run(body) {
  const v = validateStorage(body);
  assert.deepStrictEqual(v.errors, []);
  return solveStorage(v.props, v.counts, v.zones, v.costs);
}
const zoneOf = (r, p) => r.assignments.find(a => a.prop === p).zone;

/* 1. parseCell：正整数、不可达写法、非法值 */
{
  assert.deepStrictEqual(parseCell(3), { value: 3 });
  assert.deepStrictEqual(parseCell(null), { unreachable: true });
  assert.deepStrictEqual(parseCell(undefined), { unreachable: true });
  for (const s of ['不可达', ' 不可达 ', 'unreachable', 'X', 'x', '-']) {
    assert.deepStrictEqual(parseCell(s), { unreachable: true });
  }
  // 数字字符串不自动转型（API 只接受 JSON 数字）
  for (const bad of [0, -1, 1.5, NaN, '', '3', '7', 'abc', true, {}]) {
    assert.strictEqual(parseCell(bad), null);
  }
}

/* 2. 已完成步骤被忽略：只按待执行步骤汇总道具与次数；done 独有道具不要求耗时 */
{
  const body = {
    steps: [
      setup(['旧灯', '旧幕'], 'done'),
      trans(['旧灯'], ['灯笼']),
      trans(['灯笼'], ['桌子']),
    ],
    zones: [{ name: '甲', capacity: 3 }],
    times: {
      旧灯: { 甲: 1 },
      灯笼: { 甲: 2 },
      桌子: { 甲: 3 },
    },
  };
  const v = validateStorage(body);
  assert.deepStrictEqual(v.errors, []);
  // 旧幕只在 done 步骤出现 → 不进待执行清单；旧灯在待执行步骤被撤下 → 仍是待分配道具
  assert.deepStrictEqual(v.props, ['旧灯', '灯笼', '桌子']);
  // 旧灯：撤下 1 次；灯笼：摆上 1 + 撤下 1 = 2 次；桌子：摆上 1 次
  assert.deepStrictEqual(v.counts, { 旧灯: 1, 灯笼: 2, 桌子: 1 });
  const r = solveStorage(v.props, v.counts, v.zones, v.costs);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.totalMinutes, 1 + 2 * 2 + 3);
}

/* 3. 无待执行道具（全部步骤 done / steps 为空）：空分配、0 分钟 */
{
  const r = run({
    steps: [setup(['灯'], 'done'), trans(['灯'], ['幕'], 'done')],
    zones: [{ name: '甲', capacity: 2 }],
    times: {},
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.assignments, []);
  assert.strictEqual(r.propCount, 0);
  assert.strictEqual(r.totalMinutes, 0);
  assert.strictEqual(r.zones.length, 1);
  assert.strictEqual(r.zones[0].used, 0);

  const r2 = run({ steps: [], zones: [{ name: '甲', capacity: 1 }], times: {} });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.totalMinutes, 0);
}

/* 4. 基本最优性：按次数 × 单次耗时累计，选总耗时最短的区 */
{
  const r = run({
    steps: [trans(['A'], ['B']), trans(['B'], ['A'])], // A 2 次，B 2 次
    zones: [{ name: '近', capacity: 1 }, { name: '远', capacity: 1 }],
    times: {
      A: { 近: 1, 远: 10 },
      B: { 近: 10, 远: 1 },
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(zoneOf(r, 'A'), '近');
  assert.strictEqual(zoneOf(r, 'B'), '远');
  assert.strictEqual(r.totalMinutes, 2 + 2);
}

/* 5. 次数不同会改变最优归属：A 共 2 次、B 共 1 次，近端（容量 1）应留给单位价差更大的 B */
{
  const r = run({
    steps: [
      trans([], ['A']),   // A 摆上
      trans(['A'], ['B']),// A 撤下、B 摆上
    ],
    // A 2 次（近 1/远 2）、B 1 次（近 1/远 100）
    // A 远 4 + B 近 1 = 5；反之 A 近 2 + B 远 100 = 102
    zones: [{ name: '近', capacity: 1 }, { name: '远', capacity: 1 }],
    times: {
      A: { 近: 1, 远: 2 },
      B: { 近: 1, 远: 100 },
    },
  });
  assert.strictEqual(zoneOf(r, 'A'), '远');
  assert.strictEqual(zoneOf(r, 'B'), '近');
  assert.strictEqual(r.totalMinutes, 5);
}

/* 6. 同耗时时按道具首次出现顺序、区录入顺序稳定：都能放时优先录入更早的区 */
{
  const r = run({
    steps: [trans(['A'], ['B'])],
    zones: [{ name: 'Z1', capacity: 2 }, { name: 'Z2', capacity: 2 }],
    times: {
      A: { Z1: 3, Z2: 3 },
      B: { Z1: 3, Z2: 3 },
    },
  });
  assert.deepStrictEqual(r.assignments.map(a => a.zone), ['Z1', 'Z1']);

  // 容量各 1：A 先出现 → A 占 Z1，B 占 Z2
  const r2 = run({
    steps: [trans(['A'], ['B'])],
    zones: [{ name: 'Z1', capacity: 1 }, { name: 'Z2', capacity: 1 }],
    times: {
      A: { Z1: 3, Z2: 3 },
      B: { Z1: 3, Z2: 3 },
    },
  });
  assert.deepStrictEqual(r2.assignments.map(a => a.zone), ['Z1', 'Z2']);

  // 调换区录入顺序：A 应占新的第一区
  const r3 = run({
    steps: [trans(['A'], ['B'])],
    zones: [{ name: 'Z2', capacity: 1 }, { name: 'Z1', capacity: 1 }],
    times: {
      A: { Z2: 3, Z1: 3 },
      B: { Z2: 3, Z1: 3 },
    },
  });
  assert.deepStrictEqual(r3.assignments.map(a => a.zone), ['Z2', 'Z1']);
}

/* 7. 结果字段：每区清单、各道具位置、次数/单次/小计、总耗时一致 */
{
  const r = run({
    steps: [trans(['A'], ['B']), trans([], ['A'])], // A: 撤1 + 摆1 = 2，B: 摆1
    zones: [{ name: '近', capacity: 2 }, { name: '远', capacity: 2 }],
    times: {
      A: { 近: 4, 远: 5 },
      B: { 近: 6, 远: 2 },
    },
  });
  assert.strictEqual(r.totalMinutes, 2 * 4 + 1 * 2); // A 近 8 + B 远 2 = 10
  const aA = r.assignments.find(x => x.prop === 'A');
  assert.strictEqual(aA.zone, '近');
  assert.strictEqual(aA.moves, 2);
  assert.strictEqual(aA.minutesPerMove, 4);
  assert.strictEqual(aA.minutes, 8);
  const near = r.zones.find(z => z.name === '近');
  assert.strictEqual(near.used, 1);
  assert.deepStrictEqual(near.props.map(x => x.prop), ['A']);
  const far = r.zones.find(z => z.name === '远');
  assert.deepStrictEqual(far.props.map(x => x.prop), ['B']);
  // assignments 按道具首次出现顺序
  assert.deepStrictEqual(r.assignments.map(a => a.prop), ['A', 'B']);
}

/* 8. 不可行：道具对所有区不可达 */
{
  const r = run({
    steps: [trans(['A'], ['B'])],
    zones: [{ name: 'Z', capacity: 2 }],
    times: { A: { Z: 1 }, B: { Z: '不可达' } },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('B'));
  assert.ok(!r.assignments);
}

/* 9. 不可行：总格位不足 */
{
  const r = run({
    steps: [trans(['A', 'B', 'C'], [])],
    zones: [{ name: 'Z1', capacity: 1 }, { name: 'Z2', capacity: 1 }],
    times: {
      A: { Z1: 1, Z2: 1 },
      B: { Z1: 1, Z2: 1 },
      C: { Z1: 1, Z2: 1 },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('格位'));
}

/* 10. 不可行：单件可达、格位总数够，但可达性 + 容量耦合导致放不下 */
{
  const r = run({
    steps: [trans(['A', 'B', 'C'], [])],
    zones: [{ name: 'Z1', capacity: 1 }, { name: 'Z2', capacity: 2 }],
    times: {
      A: { Z1: 1, Z2: '不可达' },
      B: { Z1: 1, Z2: '不可达' },
      C: { Z1: '不可达', Z2: 1 },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('完整分配'));
  assert.ok(!r.assignments);
}

/* 11. 道具超过 14 种：报错；恰好 14 种可以 */
{
  const props15 = Array.from({ length: 15 }, (_, i) => `道具${i}`);
  const v = validateStorage({
    steps: [trans(props15, [])],
    zones: [{ name: 'Z', capacity: 15 }],
    times: Object.fromEntries(props15.map(p => [p, { Z: 1 }])),
  });
  assert.ok(v.errors.some(e => e.includes(String(MAX_STORAGE_PROPS))));
  const props14 = props15.slice(0, MAX_STORAGE_PROPS);
  const v2 = validateStorage({
    steps: [trans(props14, [])],
    zones: [{ name: 'Z', capacity: 14 }],
    times: Object.fromEntries(props14.map(p => [p, { Z: 1 }])),
  });
  assert.deepStrictEqual(v2.errors, []);
}

/* 12. 存放区数量：0 个、5 个报错；1～4 个合法 */
{
  const body0 = { steps: [trans(['A'], [])], zones: [], times: { A: {} } };
  assert.ok(validateStorage(body0).errors.some(e => e.includes('存放区')));
  const zones5 = Array.from({ length: 5 }, (_, i) => ({ name: `Z${i}`, capacity: 1 }));
  const v5 = validateStorage({
    steps: [trans(['A'], [])],
    zones: zones5,
    times: { A: Object.fromEntries(zones5.map(z => [z.name, 1])) },
  });
  assert.ok(v5.errors.some(e => e.includes(String(MAX_ZONES))));
  const one = run({
    steps: [trans(['A'], [])],
    zones: [{ name: '唯一', capacity: 1 }],
    times: { A: { 唯一: 1 } },
  });
  assert.strictEqual(one.zoneCount, MIN_ZONES);
  const four = run({
    steps: [trans(['A'], [])],
    zones: [1, 2, 3, 4].map(i => ({ name: `Z${i}`, capacity: 1 })),
    times: { A: { Z1: 1, Z2: 1, Z3: 1, Z4: 1 } },
  });
  assert.strictEqual(four.zoneCount, MAX_ZONES);
}

/* 13. 存放区名称空 / 重复：报错 */
{
  const v = validateStorage({
    steps: [trans(['A'], [])],
    zones: [{ name: ' 同名 ', capacity: 1 }, { name: '同名', capacity: 1 }],
    times: { A: { 同名: 1 } },
  });
  assert.ok(v.errors.some(e => e.includes('重复')));
  const v2 = validateStorage({
    steps: [trans(['A'], [])],
    zones: [{ name: '   ', capacity: 1 }],
    times: { A: {} },
  });
  assert.ok(v2.errors.some(e => e.includes('名称')));
}

/* 14. 格位数非正整数：0、负数、小数、缺字段均报错 */
{
  const mk = (capacity) => validateStorage({
    steps: [trans(['A'], [])],
    zones: [{ name: 'Z', capacity }],
    times: { A: { Z: 1 } },
  });
  assert.ok(mk(0).errors.length);
  assert.ok(mk(-2).errors.length);
  assert.ok(mk(1.5).errors.length);
  assert.ok(mk(undefined).errors.length);
  assert.ok(mk('abc').errors.length);
}

/* 15. 耗时配置：缺道具、缺区、非法值、多余道具、多余区均报错 */
{
  const zones = [{ name: 'Z1', capacity: 1 }, { name: 'Z2', capacity: 1 }];
  // 缺整件道具
  let v = validateStorage({ steps: [trans(['A'], [])], zones, times: {} });
  assert.ok(v.errors.some(e => e.includes('A') && e.includes('耗时')));
  // 缺某个区
  v = validateStorage({ steps: [trans(['A'], [])], zones, times: { A: { Z1: 1 } } });
  assert.ok(v.errors.some(e => e.includes('Z2')));
  // 非法值
  v = validateStorage({ steps: [trans(['A'], [])], zones, times: { A: { Z1: 0, Z2: 1 } } });
  assert.ok(v.errors.length);
  v = validateStorage({ steps: [trans(['A'], [])], zones, times: { A: { Z1: 2.5, Z2: 1 } } });
  assert.ok(v.errors.length);
  // 多余道具（不在任何步骤里）
  v = validateStorage({ steps: [trans(['A'], [])], zones, times: { A: { Z1: 1, Z2: 1 }, 幽灵: { Z1: 1, Z2: 1 } } });
  assert.ok(v.errors.some(e => e.includes('幽灵')));
  // 已完成步骤道具允许携带
  v = validateStorage({
    steps: [setup(['旧'], 'done'), trans(['A'], [])],
    zones,
    times: { A: { Z1: 1, Z2: 1 }, 旧: { Z1: 2, Z2: 3 } },
  });
  assert.deepStrictEqual(v.errors, []);
  // 多余的区名
  v = validateStorage({ steps: [trans(['A'], [])], zones, times: { A: { Z1: 1, Z2: 1, Z3: 9 } } });
  assert.ok(v.errors.some(e => e.includes('Z3')));
  // times 非对象 / 缺失
  assert.ok(validateStorage({ steps: [trans(['A'], [])], zones, times: null }).errors.length);
  assert.ok(validateStorage({ steps: [trans(['A'], [])], zones }).errors.length);
}

/* 16. steps 缺失 / 非数组：报错 */
{
  assert.ok(validateStorage({ zones: [{ name: 'Z', capacity: 1 }] }).errors.length);
  assert.ok(validateStorage({ steps: {}, zones: [{ name: 'Z', capacity: 1 }] }).errors.length);
}

/* 17. 数字字符串视为非法耗时（只接受 JSON 数字），null 为不可达 */
{
  const v = validateStorage({
    steps: [trans(['A'], [])],
    zones: [{ name: 'Z', capacity: 1 }],
    times: { A: { Z: '3' } },
  });
  assert.ok(v.errors.length);
  const v2 = validateStorage({
    steps: [trans(['A'], [])],
    zones: [{ name: 'Z', capacity: 1 }],
    times: { A: { Z: null } },
  });
  assert.deepStrictEqual(v2.errors, []);
}

/* 18. 14 件道具、4 个区的完整分配：区占用不超容量、每件恰好一区、总耗时一致 */
{
  const props = Array.from({ length: 14 }, (_, i) => `p${i}`);
  const r = run({
    steps: [trans(props.slice(0, 7), props.slice(7))],
    zones: [
      { name: 'Z1', capacity: 4 },
      { name: 'Z2', capacity: 4 },
      { name: 'Z3', capacity: 3 },
      { name: 'Z4', capacity: 3 },
    ],
    times: Object.fromEntries(props.map((p, i) => [p, {
      Z1: 1 + (i % 5), Z2: 2 + (i % 4), Z3: 3 + (i % 3), Z4: 1 + ((i + 2) % 6),
    }])),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.assignments.length, 14);
  assert.strictEqual(r.zones.reduce((a, z) => a + z.used, 0), 14);
  for (const z of r.zones) assert.ok(z.used <= z.capacity);
  const sumSub = r.zones.flatMap(z => z.props).reduce((a, x) => a + x.minutes, 0);
  assert.strictEqual(sumSub, r.totalMinutes);
}

console.log('storage tests OK');
