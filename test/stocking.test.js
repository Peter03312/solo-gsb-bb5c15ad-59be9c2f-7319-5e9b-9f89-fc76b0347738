'use strict';

const assert = require('assert');
const { validateStocking, solveStocking, MAX_STOCK_MISSING, MAX_PACKAGES } = require('../stocking');

const S = (id, props) => ({ id, name: id, props });

/** 构造已校验载荷并求解的快捷函数 */
function run(body) {
  const v = validateStocking(body);
  assert.deepStrictEqual(v.errors, []);
  return solveStocking(v.required, v.prepared, v.missing, v.packages);
}

const names = (r) => r.selected.map(p => p.name);

/* 1. 缺省 prepared / packages：全部道具均为缺件 */
{
  const v = validateStocking({ scenes: [S('A', ['灯', '幕'])] });
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.missing, ['灯', '幕']);
  assert.deepStrictEqual(v.prepared, []);
}

/* 2. 场景道具汇总去重：保持场景序、场景内顺序（与装箱同口径） */
{
  const v = validateStocking({
    scenes: [S('s1', ['灯笼', '地毯', '灯笼']), S('s2', ['桌子', '灯笼'])],
    prepared: ['地毯'],
  });
  assert.deepStrictEqual(v.required, ['灯笼', '地毯', '桌子']);
  assert.deepStrictEqual(v.prepared, ['地毯']);
  assert.deepStrictEqual(v.missing, ['灯笼', '桌子']);
}

/* 3. 无缺件：空组合、总价 0（即使采购包里有无效数据之外的正常包） */
{
  const r = run({
    scenes: [S('A', ['灯'])],
    prepared: ['灯'],
    packages: [{ name: '包甲', price: 10, props: ['灯'] }],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.selected, []);
  assert.strictEqual(r.packageCount, 0);
  assert.strictEqual(r.totalPrice, 0);
}

/* 4. 无场景道具：报错 */
{
  const v = validateStocking({ scenes: [S('A', [])], packages: [] });
  assert.ok(v.errors.some(e => e.includes('道具')));
  const v2 = validateStocking({});
  assert.ok(v2.errors.length > 0);
}

/* 5. 简单覆盖：缺 A、B；单包 {A,B} 价 10 优于两个单价 6 的包 */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    packages: [
      { name: 'AB', price: 10, props: ['A', 'B'] },
      { name: '仅A', price: 6, props: ['A'] },
      { name: '仅B', price: 6, props: ['B'] },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['AB']);
  assert.strictEqual(r.totalPrice, 10);
  assert.deepStrictEqual(r.selected[0].coversMissing, ['A', 'B']);
}

/* 6. 拆分更便宜：包只覆盖部分缺件时取组合 */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    packages: [
      { name: 'AB', price: 10, props: ['A', 'B'] },
      { name: '仅A', price: 4, props: ['A'] },
      { name: '仅B', price: 4, props: ['B'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['仅A', '仅B']);
  assert.strictEqual(r.totalPrice, 8);
  assert.strictEqual(r.packageCount, 2);
}

/* 7. 同价优先包数少：两包合计 10 与单包 10 取单包 */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    packages: [
      { name: '仅A', price: 4, props: ['A'] },
      { name: '仅B', price: 6, props: ['B'] },
      { name: 'AB', price: 10, props: ['A', 'B'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['AB']);
  assert.strictEqual(r.packageCount, 1);
}

/* 8. 同价同包数：按录入顺序稳定选取——{包1,包4} 与 {包2,包3} 都覆盖且同价，
   取在更早分歧位含包的组合（录入更早的包优先） */
{
  // 缺件 x y；包1={x,价6} 包2={y,价6} 包3={x,价6} 包4={y,价6}
  // {包1,包2} 与 {包1,包4} 与 {包3,包4} 都为 12；最优应为 {包1,包2}（字典序最小）
  const r = run({
    scenes: [S('s', ['x', 'y'])],
    packages: [
      { name: 'p1', price: 6, props: ['x'] },
      { name: 'p2', price: 6, props: ['y'] },
      { name: 'p3', price: 6, props: ['x'] },
      { name: 'p4', price: 6, props: ['y'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['p1', 'p2']);
  // 调换录入顺序后结果随之变化（稳定性：按录入顺序）
  const r2 = run({
    scenes: [S('s', ['x', 'y'])],
    packages: [
      { name: 'q3', price: 6, props: ['x'] },
      { name: 'q4', price: 6, props: ['y'] },
      { name: 'q1', price: 6, props: ['x'] },
      { name: 'q2', price: 6, props: ['y'] },
    ],
  });
  assert.deepStrictEqual(names(r2), ['q3', 'q4']);
}

/* 9. 同价同包数且共享前缀的情形：{p1,p3} 与 {p1,p4} 取含更早 p3 者 */
{
  // 缺 x y z；p1={x,5} p2={y,5} p3={z,5} p4={z,5}；{p1,p2,p3} 与 {p1,p2,p4} 同为 15
  const r = run({
    scenes: [S('s', ['x', 'y', 'z'])],
    packages: [
      { name: 'p1', price: 5, props: ['x'] },
      { name: 'p2', price: 5, props: ['y'] },
      { name: 'p3', price: 5, props: ['z'] },
      { name: 'p4', price: 5, props: ['z'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['p1', 'p2', 'p3']);
}

/* 10. 重复覆盖允许：大包重复覆盖缺件不影响，每包只买一次 */
{
  const r = run({
    scenes: [S('s', ['A', 'B', 'C'])],
    packages: [
      { name: 'ABC', price: 9, props: ['A', 'B', 'C'] },
      { name: 'AB', price: 1, props: ['A', 'B'] },
      { name: 'C', price: 1, props: ['C'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['AB', 'C']);
  assert.strictEqual(r.totalPrice, 2);
}

/* 11. 包可只含已备齐道具；备齐道具不影响最优性（贵的纯备齐包不会被选） */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    prepared: ['A'],
    packages: [
      { name: '含备齐', price: 100, props: ['A'] },
      { name: 'B包', price: 7, props: ['A', 'B'] },
    ],
  });
  assert.deepStrictEqual(r.missing, ['B']);
  assert.deepStrictEqual(names(r), ['B包']);
  assert.deepStrictEqual(r.selected[0].coversMissing, ['B']);
}

/* 12. 缺件无法覆盖：明确报错且不输出方案 */
{
  const v = validateStocking({
    scenes: [S('s', ['A', 'B'])],
    packages: [{ name: '仅A', price: 3, props: ['A'] }],
  });
  assert.deepStrictEqual(v.errors, []);
  const r = solveStocking(v.required, v.prepared, v.missing, v.packages);
  assert.strictEqual(r.ok, false);
  assert.ok(r.uncovered.includes('B'));
  assert.ok(r.errors[0].includes('B'));
  assert.ok(!r.selected);
}

/* 13. 缺件超过 14 种：报错 */
{
  const props = Array.from({ length: 15 }, (_, i) => `道具${i}`);
  const v = validateStocking({ scenes: [S('s', props)], packages: [] });
  assert.ok(v.errors.some(e => e.includes('14') && e.includes('缺件')));
  // 恰好 14 种不报错
  const v2 = validateStocking({ scenes: [S('s', props.slice(0, MAX_STOCK_MISSING))], packages: [] });
  assert.deepStrictEqual(v2.errors, []);
}

/* 14. 包名重复 / 空名：报错 */
{
  const v = validateStocking({
    scenes: [S('s', ['A'])],
    packages: [
      { name: '同名', price: 1, props: ['A'] },
      { name: '同名', price: 2, props: ['A'] },
      { name: '  ', price: 1, props: ['A'] },
    ],
  });
  assert.ok(v.errors.some(e => e.includes('重复')));
  assert.ok(v.errors.some(e => e.includes('名称')));
}

/* 15. 价格非正整数：0、负数、小数、非数字均报错 */
{
  const v = validateStocking({
    scenes: [S('s', ['A'])],
    packages: [
      { name: '零价', price: 0, props: ['A'] },
      { name: '负价', price: -3, props: ['A'] },
      { name: '小数', price: 1.5, props: ['A'] },
      { name: '缺价', props: ['A'] },
    ],
  });
  assert.strictEqual(v.errors.length, 4);
}

/* 16. 包内道具无效：空包、需求清单之外的道具、非数组均报错 */
{
  const v = validateStocking({
    scenes: [S('s', ['A'])],
    packages: [
      { name: '空包', price: 1, props: [] },
      { name: '外来', price: 1, props: ['X'] },
      { name: '坏格式', price: 1, props: 'A' },
      { name: '空白道具', price: 1, props: ['  '] },
    ],
  });
  assert.ok(v.errors.some(e => e.includes('至少')));
  assert.ok(v.errors.some(e => e.includes('需求清单之外')));
  assert.ok(v.errors.some(e => e.includes('数组')));
}

/* 17. 包数超过 30：报错 */
{
  const packages = Array.from({ length: MAX_PACKAGES + 1 }, (_, i) =>
    ({ name: `包${i}`, price: 1, props: ['A'] }));
  const v = validateStocking({ scenes: [S('s', ['A'])], packages });
  assert.ok(v.errors.some(e => e.includes(String(MAX_PACKAGES))));
  // 恰好 30 个不报错
  const v2 = validateStocking({ scenes: [S('s', ['A'])], packages: packages.slice(0, MAX_PACKAGES) });
  assert.deepStrictEqual(v2.errors, []);
}

/* 18. 已备齐道具不在需求清单：报错 */
{
  const v = validateStocking({
    scenes: [S('s', ['A'])],
    prepared: ['A', '幽灵道具'],
  });
  assert.ok(v.errors.some(e => e.includes('幽灵道具')));
  // prepared 非数组
  const v2 = validateStocking({ scenes: [S('s', ['A'])], prepared: 'A' });
  assert.ok(v2.errors.length > 0);
}

/* 19. 包内重复道具按一件计，不报错 */
{
  const v = validateStocking({
    scenes: [S('s', ['A'])],
    packages: [{ name: '重复', price: 3, props: ['A', 'A', ' A '] }],
  });
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.packages[0].props, ['A']);
}

/* 20. 结果中的 packages 带回每包的缺件覆盖；selected 按录入顺序排列 */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    packages: [
      { name: '先录', price: 4, props: ['B'] },
      { name: '后录', price: 4, props: ['A'] },
    ],
  });
  assert.deepStrictEqual(names(r), ['先录', '后录']);
  assert.deepStrictEqual(r.packages[0].coversMissing, ['B']);
  assert.deepStrictEqual(r.packages[1].coversMissing, ['A']);
  assert.strictEqual(r.selected[0].index, 1);
  assert.strictEqual(r.selected[1].index, 2);
}

/* 21. 备齐全部道具时，含需求道具的包也不会被选（总价 0） */
{
  const r = run({
    scenes: [S('s', ['A', 'B'])],
    prepared: ['B', 'A'],
    packages: [{ name: '全包', price: 1, props: ['A', 'B'] }],
  });
  assert.strictEqual(r.totalPrice, 0);
  assert.deepStrictEqual(r.selected, []);
}

console.log('stocking tests OK');
