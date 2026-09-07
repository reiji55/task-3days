import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeek, summary, mondayOf, stampNow, sameContent, DIM_DEFAULT } from '../lib/week.js';

const NOW = new Date('2026-09-09T14:20:00+09:00');     // 9/7 の週の水曜
const STAMP = '2026-09-07T08:00:00+09:00';
const ev = (summary, start, end, extra = {}) => ({ summary, start, end, ...extra });

const WEEK = [
  ev('仕事（通勤含む）', '2026-09-07T07:00:00+09:00', '2026-09-07T19:00:00+09:00', { calendar: 'ブロッキング' }),
  ev('睡眠', '2026-09-08T00:00:00+09:00', '2026-09-08T06:00:00+09:00'),
  ev('KAPAP', '2026-09-12T19:00:00+09:00', '2026-09-12T22:00:00+09:00', { location: '阿佐ヶ谷駅' })
];

test('mondayOf: 週内のどの日を渡してもその週の月曜になる', () => {
  for (const d of ['2026-09-07','2026-09-08','2026-09-11','2026-09-13']) {
    assert.equal(mondayOf(d), '2026-09-07', d);
  }
  assert.equal(mondayOf('2026-09-14'), '2026-09-14', '次の月曜は自分自身');
  assert.equal(mondayOf('2026-09-06'), '2026-08-31', '日曜は前の月曜へ');
  assert.throws(() => mondayOf('9/7'), /日付の形式/);
});

test('buildWeek: 月曜に丸め、既定値を埋め、start 順に並べる', () => {
  const r = buildWeek({ week: '2026-09-11', events: [WEEK[2], WEEK[0], WEEK[1]] }, { updated: STAMP });
  const w = JSON.parse(r.json);
  assert.equal(r.week, '2026-09-07');
  assert.equal(w.week, '2026-09-07');
  assert.equal(w.updated, STAMP);
  assert.equal(w.start_hour, 5);
  assert.equal(w.end_hour, 26);
  assert.deepEqual(w.dim, DIM_DEFAULT);
  assert.deepEqual(w.events.map(e => e.summary), ['仕事（通勤含む）', '睡眠', 'KAPAP']);
  assert.equal(r.kept, 3);
  assert.equal(r.dropped, 0);
  assert.ok(r.json.endsWith('\n'), '改行で終わる');
});

test('buildWeek: 余計な欄は落とし、ある欄だけ残す', () => {
  const w = JSON.parse(buildWeek({
    week: '2026-09-07',
    events: [{ summary: 'あ', start: '2026-09-07T10:00:00+09:00', end: '2026-09-07T11:00:00+09:00',
               location: '', calendar: '', htmlLink: 'https://…', description: '長い説明' }]
  }, { updated: STAMP }).json);
  assert.deepEqual(Object.keys(w.events[0]), ['summary', 'start', 'end'], '空欄と余計な欄は入らない');

  const w2 = JSON.parse(buildWeek({
    week: '2026-09-07', events: [WEEK[2]]
  }, { updated: STAMP }).json);
  assert.equal(w2.events[0].location, '阿佐ヶ谷駅');
});

test('buildWeek: 週の外の予定は捨て、深夜またぎは残す', () => {
  const r = buildWeek({ week: '2026-09-07', events: [
    ...WEEK,
    ev('先週', '2026-09-01T10:00:00+09:00', '2026-09-01T11:00:00+09:00'),
    ev('再来週', '2026-09-21T10:00:00+09:00', '2026-09-21T11:00:00+09:00'),
    ev('日曜の夜ふかし', '2026-09-13T23:00:00+09:00', '2026-09-14T01:00:00+09:00')
  ] }, { updated: STAMP });
  const names = JSON.parse(r.json).events.map(e => e.summary);
  assert.ok(!names.includes('先週'));
  assert.ok(!names.includes('再来週'));
  assert.ok(names.includes('日曜の夜ふかし'), '週をまたいで終わる分は残す');
  assert.equal(r.dropped, 2);
});

test('buildWeek: dim は差し替えられる。空配列なら全部くっきり', () => {
  assert.deepEqual(JSON.parse(buildWeek({ week: '2026-09-07', events: WEEK, dim: ['会議'] },
    { updated: STAMP }).json).dim, ['会議']);
  assert.deepEqual(JSON.parse(buildWeek({ week: '2026-09-07', events: WEEK, dim: [] },
    { updated: STAMP }).json).dim, []);
});

test('buildWeek: 縦軸の範囲を変えられる', () => {
  const w = JSON.parse(buildWeek({ week: '2026-09-07', events: WEEK, start_hour: 6, end_hour: 24 },
    { updated: STAMP }).json);
  assert.equal(w.start_hour, 6);
  assert.equal(w.end_hour, 24);
});

test('buildWeek: 壊れた入力は弾く', () => {
  const base = { week: '2026-09-07', events: WEEK };
  assert.throws(() => buildWeek({ ...base, week: '2026/09/07' }), /日付の形式/);
  assert.throws(() => buildWeek({ ...base, start_hour: 20, end_hour: 10 }), /start_hour/);
  assert.throws(() => buildWeek({ week: '2026-09-07',
    events: [ev('あ', 'きのう', '2026-09-07T11:00:00+09:00')] }), /start の形式/);
  assert.throws(() => buildWeek({ week: '2026-09-07',
    events: [ev('あ', '2026-09-07T11:00:00+09:00', '2026-09-07T10:00:00+09:00')] }), /end が start より後/);
  assert.throws(() => buildWeek({ week: '2026-09-07',
    events: [ev('あ\nい', '2026-09-07T10:00:00+09:00', '2026-09-07T11:00:00+09:00')] }), /改行/);
  assert.throws(() => buildWeek({ week: '2026-09-07',
    events: [ev('あ', '2026-09-07T10:00:00+09:00', '2026-09-07T11:00:00+09:00', { color: 'あか' })] }), /#rrggbb/);
});

test('buildWeek: 予定0件でも作れる（白紙の週）', () => {
  const r = buildWeek({ week: '2026-09-07', events: [] }, { updated: STAMP });
  assert.equal(r.kept, 0);
  assert.deepEqual(JSON.parse(r.json).events, []);
});

test('buildWeek: 同じ入力からは同じ JSON が出る（差分が暴れない）', () => {
  const a = buildWeek({ week: '2026-09-07', events: WEEK }, { updated: STAMP }).json;
  const b = buildWeek({ week: '2026-09-09', events: [...WEEK].reverse() }, { updated: STAMP }).json;
  assert.equal(a, b);
});

test('summary: 7日分の枠が必ず並び、予定が日ごとに入る', () => {
  const s = summary(buildWeek({ week: '2026-09-07', events: WEEK }, { updated: STAMP }).json, 'Asia/Tokyo', NOW);
  assert.equal(s.week, '2026-09-07');
  assert.equal(s.today, '2026-09-09');
  assert.equal(s.updated, STAMP);
  assert.equal(s.stale, null, '今週なので警告なし');
  assert.equal(s.days.length, 7);
  assert.deepEqual(s.days.map(d => d.rel), ['月','火','水','木','金','土','日']);
  assert.deepEqual(s.days.map(d => d.date), [
    '2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13']);
  assert.deepEqual(s.days[0].events, [{ summary: '仕事（通勤含む）', time: '07:00-19:00' }]);
  assert.deepEqual(s.days[5].events, [{ summary: 'KAPAP', time: '19:00-22:00', location: '阿佐ヶ谷駅' }]);
  assert.deepEqual(s.days[3].events, [], '予定のない日も枠は残る');
});

test('summary: 日をまたぐ予定は終わりの日付を添える', () => {
  const json = buildWeek({ week: '2026-09-07',
    events: [ev('夜勤', '2026-09-07T22:00:00+09:00', '2026-09-08T08:00:00+09:00')] },
    { updated: STAMP }).json;
  const s = summary(json, 'Asia/Tokyo', NOW);
  assert.deepEqual(s.days[0].events, [{ summary: '夜勤', time: '22:00-08:00', ends: '2026-09-08' }]);
  assert.deepEqual(s.days[1].events, [], '始まった日だけに出す');
});

test('summary: 古い週は何週前かを教える', () => {
  const json = buildWeek({ week: '2026-08-24',
    events: [ev('あ', '2026-08-24T10:00:00+09:00', '2026-08-24T11:00:00+09:00')] },
    { updated: '2026-08-24T08:00:00+09:00' }).json;
  assert.equal(summary(json, 'Asia/Tokyo', NOW).stale, '2週前の写しです');
});

test('summary: 来週分でも警告は出さない', () => {
  const json = buildWeek({ week: '2026-09-14',
    events: [ev('あ', '2026-09-14T10:00:00+09:00', '2026-09-14T11:00:00+09:00')] },
    { updated: STAMP }).json;
  assert.equal(summary(json, 'Asia/Tokyo', NOW).stale, null);
});

test('summary: 壊れた JSON は理由を出して投げる', () => {
  assert.throws(() => summary('{ とちゅうで'), /JSON として読めません/);
});

test('stampNow: 壁の時計とオフセットで書く（UTC のままにしない）', () => {
  const at = new Date('2026-09-07T08:30:00Z');
  assert.equal(stampNow('Asia/Tokyo', at), '2026-09-07T17:30:00+09:00');
  assert.equal(stampNow('UTC', at), '2026-09-07T08:30:00+00:00');
});

test('sameContent: updated の違いだけなら同じとみなす', () => {
  const a = buildWeek({ week: '2026-09-07', events: WEEK }, { updated: STAMP }).json;
  const b = buildWeek({ week: '2026-09-07', events: WEEK }, { updated: '2026-09-14T09:00:00+09:00' }).json;
  assert.equal(sameContent(a, b), true);

  const c = buildWeek({ week: '2026-09-07', events: WEEK.slice(0, 2) }, { updated: STAMP }).json;
  assert.equal(sameContent(a, c), false, '予定が違えば別物');
  assert.equal(sameContent(a, ''), false, '空や壊れた相手とは一致させない');
  assert.equal(sameContent(a, '{ とちゅうで'), false);
});
