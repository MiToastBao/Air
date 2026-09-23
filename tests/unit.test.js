// 守門測試（只用人工造的假資料；真實監測資料不可放進 repo）
// 執行：node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');
const P = require('../js/parser.js');
const M = require('../js/model.js');

const U = (y, mo, d, h) => new Date(Date.UTC(y, mo - 1, d, h || 0));
function hours(day, fn) { // 產生某日 24 小時資料列
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ ts: day + ' ' + String(h).padStart(2, '0') + ':00', v: fn(h) });
  return out;
}
const one = (sensor, day) => Core.buildReports([sensor], { from: day, to: day });

test('一般四捨五入：剛好 .x5 一律進位（Access 會變成 .x4 或偶數）', () => {
  assert.equal(Core.exactMean1([1.2, 1.3]), 1.3);   // 1.25
  assert.equal(Core.exactMean1([2.4, 2.5]), 2.5);   // 2.45（銀行家進位會得 2.4）
  assert.equal(Core.exactMean1([0.1, 0.2]), 0.2);   // 0.15（浮點會得 0.1499…）
  assert.equal(Core.exactMean1([10, 10, 10.1]), 10); // 10.0333
  // 浮點直接算會得 0.6、2.3、8.1（0.65 存成 0.6499…）
  assert.equal(Core.exactMean1([0.6, 0.7]), 0.7);
  assert.equal(Core.exactMean1([2.3, 2.4]), 2.4);
  assert.equal(Core.exactMean1([8.1, 8.2]), 8.2);
  assert.equal(Core.roundHalfUp1(52.25), 52.3);
});

test('負值、空白、文字都不是有效值，也不能當 0', () => {
  assert.equal(Core.validValue(-9999), null);
  assert.equal(Core.validValue(-5.4), null);
  assert.equal(Core.validValue(''), null);
  assert.equal(Core.validValue('N/A'), null);
  assert.equal(Core.validValue('12.5'), 12.5);
  assert.equal(Core.validValue(0), 0);
  const s = { id: 'A', name: 'A', fields: ['TVOC'], rows: hours('2026-07-01', h => ({ TVOC: h < 12 ? 100 : null })) };
  const r = one(s, '2026-07-01').air[0];
  assert.equal(r.TVOC, 100); // 只平均 12 筆有效值；若把無效當 0 會變 50
  assert.equal(r.note, '有效資料12小時');
});

test('PM10、PM2.5 為 0 視為異常（可關閉），其他欄位 0 是有效值', () => {
  const s = { id: 'A', name: 'A', fields: ['PM10', 'TMP'], rows: hours('2026-07-01', h => ({ PM10: h < 12 ? 0 : 20, TMP: h < 12 ? 0 : 20 })) };
  const r = one(s, '2026-07-01').air[0];
  assert.equal(r.PM10, 20); assert.equal(r.TMP, 10);
  const r2 = Core.buildReports([s], { from: '2026-07-01', to: '2026-07-01' }, { zeroInvalid: [] }).air[0];
  assert.equal(r2.PM10, 10);
});

test('風向角度 → 16 方位文字', () => {
  const cases = [[0, '北'], [11.24, '北'], [11.25, '北北東'], [45, '東北'], [90, '東'], [180, '南'], [202.5, '南南西'],
    [270, '西'], [315, '西北'], [348.74, '北北西'], [348.75, '北'], [360, '北']];
  for (const [deg, name] of cases) assert.equal(Core.DIR16[Core.dirIndex(deg)], name, deg + '°');
});

test('最頻風向：只採計風速 > 0.3；並列最多時全部列出', () => {
  // 北 5 筆、西北 5 筆、南 8 筆但風速都 = 0.3（不採計）
  const rows = [];
  for (let h = 0; h < 5; h++) rows.push({ ts: '2026-07-01 ' + String(h).padStart(2, '0') + ':00', v: { WD: 0, WS: 1 } });
  for (let h = 5; h < 10; h++) rows.push({ ts: '2026-07-01 ' + String(h).padStart(2, '0') + ':00', v: { WD: 315, WS: 0.31 } });
  for (let h = 10; h < 18; h++) rows.push({ ts: '2026-07-01 ' + String(h).padStart(2, '0') + ':00', v: { WD: 180, WS: 0.3 } });
  rows.push({ ts: '2026-07-01 18:00', v: { WD: 180, WS: null } }); // 風速無效 → 不採計
  const r = one({ id: 'W', name: 'W', fields: ['WD', 'WS'], rows }, '2026-07-01').air[0];
  assert.equal(r.WD, '北風、西北風');
  assert.match(r.note, /最頻風向採計10小時（風速>0\.3）/);
});

test('最頻風向：全天風速都 <= 0.3 → 空白', () => {
  const s = { id: 'W', name: 'W', fields: ['WD', 'WS'], rows: hours('2026-07-01', () => ({ WD: 90, WS: 0.2 })) };
  assert.equal(one(s, '2026-07-01').air[0].WD, null);
});

test('噪音日晚夜：夜 = 當日 00–06 + 22–24，能量平均', () => {
  const s = { id: 'N', name: 'N', fields: ['LEQ'], rows: hours('2026-07-01', h => ({ LEQ: (h >= 6 && h < 20) ? 60 : (h < 22 && h >= 20) ? 55 : 50 })) };
  const r = one(s, '2026-07-01').noise[0];
  assert.deepEqual([r.DAY, r.EVE, r.NIGHT], [60, 55, 50]);
  assert.deepEqual(r.hours, { DAY: 14, EVE: 2, NIGHT: 8 });
  // 能量平均不是算術平均：50 與 60 → 57.4
  assert.equal(Core.energyMean1([50, 60]), 57.4);
});

test('雨量為當日加總，沒有雨量欄的測站不出現數值', () => {
  const s = { id: 'R', name: 'R', fields: ['RA', 'TMP'], rows: hours('2026-07-01', h => ({ RA: h === 3 ? 2.5 : h === 4 ? -9999 : 0.5, TMP: 25 })) };
  assert.equal(one(s, '2026-07-01').air[0].RA, 2.5 + 0.5 * 22);
  const s2 = { id: 'T', name: 'T', fields: ['TMP'], rows: hours('2026-07-01', () => ({ TMP: 25 })) };
  assert.equal(one(s2, '2026-07-01').air[0].RA, null);
});

test('期間內整天沒資料的日子會列出並註明', () => {
  const s = { id: 'A', name: 'A', fields: ['TMP'], rows: hours('2026-07-01', () => ({ TMP: 25 })) };
  const rep = Core.buildReports([s], { from: '2026-07-01', to: '2026-07-03' });
  assert.equal(rep.air.length, 3);
  assert.equal(rep.air[2].note, '當日無資料（有效資料0小時）');
});

test('季別起訖', () => {
  assert.deepEqual(Core.quarterRange(115, 1), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(Core.quarterRange(113, 1), { from: '2024-01-01', to: '2024-03-31' });
  assert.deepEqual(Core.quarterRange(115, 4), { from: '2026-10-01', to: '2026-12-31' });
});

// ---------- 解析器 ----------
function sheet(name, head, rows) { return { name, rows: [head].concat(rows) }; }

test('依表頭內容判讀欄位，欄位順序不同也正確', () => {
  const a = sheet('9000010', ['DateTime', 'TMP ℃', 'HUM %', 'PM10 ug/m3', 'PM2.5 ug/m3', 'TVOC ppb', 'WD degress', 'WS m/sec', '備註', '測試感測器2(含風速風向)9000010'],
    [[U(2026, 7, 1, 0), 25, 80, 10, 5, 150, 90, 1.2, '伺服器異常', null]]);
  const b = sheet('X', ['備註', 'PM2.5 ug/m3', 'DateTime', 'PM10 ug/m3', 'PM10_測試看板9000021'], [[null, 5, U(2026, 7, 1, 0), 10, null]]);
  const r = P.parseWorkbook([a, b]);
  assert.equal(r.blocked, false);
  const s1 = r.sensors[0], s2 = r.sensors[1];
  assert.deepEqual(s1.rows[0].v, { TMP: 25, HUM: 80, PM10: 10, PM25: 5, TVOC: 150, WD: 90, WS: 1.2 });
  assert.equal(s1.rows[0].note, '伺服器異常');
  assert.equal(s1.defaultName, '測試感測器2(含風速風向)');
  assert.equal(s2.id, '9000021');
  assert.deepEqual(s2.rows[0].v, { PM25: 5, PM10: 10 });
});

test('PM2.5 不會被當成 PM10；Leq(max) 不會被當成 Leq', () => {
  assert.equal(P.classifyHeader('PM2.5 ug/m3'), 'PM25');
  assert.equal(P.classifyHeader('PM10 ug/m3'), 'PM10');
  assert.equal(P.classifyHeader('Leq(max) dB(A)'), 'LMAX');
  assert.equal(P.classifyHeader('Leq dB(A)'), 'LEQ');
  assert.equal(P.classifyHeader('RA mm'), 'RA');
  assert.equal(P.classifyHeader('PM10_測試看板9000021'), null);
});

test('同一工作表內時間重複 → 擋下並說明是哪幾列', () => {
  const a = sheet('9000004', ['DateTime', 'TMP ℃'], [[U(2026, 7, 1, 0), 25], [U(2026, 7, 1, 0), 26]]);
  const r = P.parseWorkbook([a]);
  assert.equal(r.blocked, true);
  assert.match(r.issues[0].msg, /2026-07-01 00:00（第 2、3 列）/);
});

test('兩份檔案有同一感測器同一時間 → 整批擋下', () => {
  const mk = () => P.parseWorkbook([sheet('9000004', ['DateTime', 'TMP ℃'], [[U(2026, 7, 1, 0), 25]])]);
  const plan = M.planImport([{ fileName: 'a.xlsx', result: mk() }, { fileName: 'b.xlsx', result: mk() }], [], []);
  assert.equal(plan.ok, false);
  assert.equal(plan.ops.length, 0);
});

test('重複匯入同一個月是覆蓋，並在寫入前算出新增／覆蓋筆數', () => {
  const r1 = P.parseWorkbook([sheet('9000004', ['DateTime', 'TMP ℃'], [[U(2026, 7, 1, 0), 25], [U(2026, 7, 1, 1), 26]])]);
  const p1 = M.planImport([{ fileName: 'a.xlsx', result: r1 }], [], []);
  assert.deepEqual(p1.stats, { added: 2, overwritten: 0, changed: 0, unchanged: 0 });
  const chunks = p1.ops.filter(o => o.store === 'chunks').map(o => o.value);
  const r2 = P.parseWorkbook([sheet('9000004', ['DateTime', 'TMP ℃'], [[U(2026, 7, 1, 1), 27], [U(2026, 7, 1, 2), 28]])]);
  const p2 = M.planImport([{ fileName: 'b.xlsx', result: r2 }], chunks, [{ id: '9000004', label: '', name: 'x' }]);
  assert.deepEqual(p2.stats, { added: 1, overwritten: 1, changed: 1, unchanged: 0 });
  const merged = p2.ops.find(o => o.store === 'chunks').value;
  assert.equal(merged.rows.length, 3);
  assert.equal(merged.rows[1].v.TMP, 27);
});

test('日期可以是字串或民國年', () => {
  assert.equal(P.toTs('2026/07/01 13:00').ts, '2026-07-01 13:00');
  assert.equal(P.toTs('115/07/01 13:00').ts, '2026-07-01 13:00');
  assert.equal(P.toTs('2026/07/01 24:00').ts, '2026-07-02 00:00');
  assert.equal(P.toTs('2026/02/30 01:00'), null);
  assert.equal(P.toTs(new Date(Date.UTC(2026, 6, 1, 0, 59, 59, 999))).ts, '2026-07-01 01:00');
});

test('只補已匯入月份裡缺的日子，沒匯入的月份不補空白列', () => {
  const s = { id: 'A', name: 'A', fields: ['TMP'], rows: hours('2026-07-01', () => ({ TMP: 25 })) };
  const rep = Core.buildReports([s], { from: '2026-07-01', to: '2026-08-31' }, { importedMonths: ['2026-07'] });
  assert.equal(rep.air.length, 31);
  assert.equal(rep.air[30].date, '2026-07-31');
});

// ---------- 備註時段確認 ----------
function chunk(id, fields, rows) { return { key: id + '|2026-07', id, month: '2026-07', fields, rows }; }

test('只列出備註有文字且仍有有效數值的時段；全部無效的只計數', () => {
  const c = chunk('A', ['TMP', 'PM10'], [
    { ts: '2026-07-01 00:00', v: { TMP: 25, PM10: 10 }, note: '檢修完畢' },
    { ts: '2026-07-01 01:00', v: { TMP: null, PM10: null }, note: '伺服器異常' },
    { ts: '2026-07-01 02:00', v: { TMP: 25, PM10: 10 } }
  ]);
  const r = M.reviewItems([c], {});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'pending');
  assert.equal(r.autoInvalid, 1);
});

test('確認不採用後重新計算，備註欄寫出不採用的小時數', () => {
  const rows = hours('2026-07-01', h => ({ TVOC: h === 8 ? 400 : 100 }));
  rows[8].note = '檢修完畢';
  const c = chunk('A', ['TVOC'], rows);
  const sensors = M.sensorsFromChunks([c], [], null);
  const before = Core.buildReports(sensors, { from: '2026-07-01', to: '2026-07-01' }).air[0];
  assert.equal(before.TVOC, 112.5);
  const review = { 'A|2026-07-01 08:00': { sig: M.rowSig(rows[8]), exclude: ['TVOC'] } };
  const after = Core.buildReports(M.applyExclusions(sensors, review), { from: '2026-07-01', to: '2026-07-01' }).air[0];
  assert.equal(after.TVOC, 100);
  assert.match(after.note, /有效資料23小時；確認不採用：TVOC 1小時；月報備註：檢修完畢×1/);
  assert.equal(M.reviewItems([c], review).items[0].status, 'confirmed');
});

test('月報重新匯入後數值改變，舊的確認失效、不再套用', () => {
  const r0 = { ts: '2026-07-01 08:00', v: { TVOC: 400 }, note: '檢修完畢' };
  const review = { 'A|2026-07-01 08:00': { sig: M.rowSig(r0), exclude: ['TVOC'] } };
  const r1 = { ts: '2026-07-01 08:00', v: { TVOC: 380 }, note: '檢修完畢' };
  const c = chunk('A', ['TVOC'], [r1]);
  assert.equal(M.reviewItems([c], review).items[0].status, 'changed');
  const s = M.applyExclusions(M.sensorsFromChunks([c], [], null), review);
  assert.equal(s[0].rows[0].v.TVOC, 380);
});

test('不採用風速時，該小時的風向也不列入最頻風向', () => {
  const rows = [
    { ts: '2026-07-01 00:00', v: { WD: 0, WS: 2 }, note: '風速計異常' },
    { ts: '2026-07-01 01:00', v: { WD: 0, WS: 2 }, note: '風速計異常' },
    { ts: '2026-07-01 02:00', v: { WD: 180, WS: 2 } }
  ];
  const review = {};
  rows.slice(0, 2).forEach(r => { review['W|' + r.ts] = { sig: M.rowSig(r), exclude: ['WS'] }; });
  const s = M.applyExclusions(M.sensorsFromChunks([chunk('W', ['WD', 'WS'], rows)], [], null), review);
  assert.equal(Core.buildReports(s, { from: '2026-07-01', to: '2026-07-01' }).air[0].WD, '南風');
});

test('PM2.5 > PM10 的小時，PM10 與 PM2.5 都不計；相等仍有效；可關閉', () => {
  const rows = hours('2026-07-01', h => h < 4 ? { PM10: 1.0, PM25: 1.6, TMP: 25 } : h === 4 ? { PM10: 8, PM25: 8, TMP: 25 } : { PM10: 20, PM25: 10, TMP: 25 });
  const s = { id: 'P', name: 'P', fields: ['PM10', 'PM25', 'TMP'], rows };
  const r = one(s, '2026-07-01').air[0];
  assert.equal(r.PM10, Core.exactMean1([8].concat(Array(19).fill(20))));
  assert.equal(r.PM25, Core.exactMean1([8].concat(Array(19).fill(10))));
  assert.equal(r.TMP, 25);
  assert.match(r.note, /PM10 20、PM2\.5 20/);
  assert.match(r.note, /PM2\.5大於PM10不計：4小時/);
  const off = Core.buildReports([s], { from: '2026-07-01', to: '2026-07-01' }, { pmRatioInvalid: false }).air[0];
  assert.equal(off.PM25, Core.exactMean1([1.6, 1.6, 1.6, 1.6, 8].concat(Array(19).fill(10))));
  assert.doesNotMatch(off.note, /大於/);
});

test('PM10 為 0（已無效）時不拿來跟 PM2.5 比，PM2.5 照常計算', () => {
  const s = { id: 'P', name: 'P', fields: ['PM10', 'PM25'], rows: hours('2026-07-01', () => ({ PM10: 0, PM25: 3 })) };
  const r = one(s, '2026-07-01').air[0];
  assert.equal(r.PM10, null); assert.equal(r.PM25, 3);
});

test('手動不採用時段：範圍內（含起訖）指定測項不計，其他測項照常；備註寫出', () => {
  const rows = hours('2026-07-27', h => ({ PM10: 30, PM25: 10, TMP: 25 }));
  const s = [{ id: 'P', name: 'P', fields: ['PM10', 'PM25', 'TMP'], rows }];
  const man = [{ uid: 'a', id: 'P', from: '2026-07-27 06:00', to: '2026-07-27 11:00', fields: ['PM10', 'PM25'] }];
  const r = Core.buildReports(M.applyManual(s, man), { from: '2026-07-27', to: '2026-07-27' }).air[0];
  assert.equal(r.hours.PM10, 18); assert.equal(r.hours.TMP, 24);
  assert.match(r.note, /手動不採用：PM10 6、PM2\.5 6小時/);
  const other = M.applyManual(s, [{ uid: 'b', id: 'Q', from: '2026-07-27 00:00', to: '2026-07-27 23:00', fields: ['PM10'] }]);
  assert.equal(Core.buildReports(other, { from: '2026-07-27', to: '2026-07-27' }).air[0].hours.PM10, 24);
  const imp = M.manualImpact([{ key: 'P|2026-07', id: 'P', month: '2026-07', fields: ['PM10', 'PM25', 'TMP'], rows }], man[0]);
  assert.deepEqual(imp, { hours: 6, cells: 12, days: ['2026-07-27'] });
});

// ---------- 感測器編號／名稱對照 ----------
test('對照表：本系統範本三欄、使用者兩欄、舊報表重複列都讀得到', () => {
  const tpl = M.parseMapping([{ name: 'a', rows: [['月報感測器編號', '報表感測器編號', '感測器名稱'], [9000001, 'A-01', '一號'], ['9000002', '', '二號']] }]);
  assert.deepEqual(tpl.rows.map(r => [r.src, r.rid, r.name]), [['9000001', 'A-01', '一號'], ['9000002', '9000002', '二號']]);
  const two = M.parseMapping([{ name: 'b', rows: [['感測器編號', '感測器中文名稱'], [9000001, '感測器1(含風速風向)']] }]);
  assert.deepEqual(two.rows.map(r => [r.src, r.rid, r.name]), [['9000001', '9000001', '感測器1(含風速風向)']]);
  const rep = M.parseMapping([{ name: 'c', rows: [['感測器編號', '感測器名稱', '日期'], ['9000001', 'X', 1], ['9000001', 'X', 2]] }]);
  assert.equal(rep.rows.length, 1); assert.equal(rep.errors.length, 0);
  const bad = M.parseMapping([{ name: 'd', rows: [['感測器編號', '感測器名稱'], ['9000001', 'X'], ['9000001', 'Y']] }]);
  assert.equal(bad.errors.length, 1);
  assert.equal(M.parseMapping([{ name: 'e', rows: [['a', 'b']] }]).errors.length, 1);
});

test('對照表套用：列出變更、報表編號撞號會擋下、名稱空白維持原名', () => {
  const cur = [{ id: '9000001', label: 'L1', name: '舊一' }, { id: '9000002', label: 'L2', name: '舊二' }];
  const p1 = M.planMapping(M.parseMapping([{ name: 'a', rows: [['月報感測器編號', '報表感測器編號', '感測器名稱'], ['9000001', 'A-01', '新一'], ['9000002', '', '']] }]), cur, ['9000001', '9000002']);
  assert.equal(p1.ok, true); assert.equal(p1.changes.length, 1); assert.equal(p1.same, 1);
  assert.deepEqual(p1.ops[0].value, { id: '9000001', label: 'L1', name: '新一', reportId: 'A-01' });
  const p2 = M.planMapping(M.parseMapping([{ name: 'a', rows: [['月報感測器編號', '報表感測器編號', '感測器名稱'], ['9000001', '9000002', '新一']] }]), cur, ['9000001', '9000002']);
  assert.equal(p2.ok, false); assert.equal(p2.ops.length, 0);
});

test('匯入新月份時保留使用者設定的報表編號與名稱', () => {
  const r = P.parseWorkbook([{ name: '9000001', rows: [['DateTime', 'TMP ℃', '表頭新文字 9000001'], [U(2026, 8, 1, 0), 25]] }]);
  const plan = M.planImport([{ fileName: 'a.xlsx', result: r }], [], [{ id: '9000001', label: '舊表頭', name: '我的名稱', reportId: 'A-01' }]);
  const op = plan.ops.find(o => o.store === 'sensors');
  assert.deepEqual(op.value, { id: '9000001', label: '表頭新文字 9000001', name: '我的名稱', reportId: 'A-01' });
});
