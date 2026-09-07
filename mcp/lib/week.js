// week.json の検証と組み立て。
// Google カレンダーの写しで、ビューア（../index.html の「週」）が読むだけの資料。
// 中身の形は weekplan スキルの events.json と同じにしてあるので、
// 同じ JSON から印刷用のPDFもスマホの画面も作れる。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export const DIM_DEFAULT = ['睡眠', '生活時間'];

const dayNo = key => {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/** その日を含む週の月曜（YYYY-MM-DD）。1970-01-01 は木曜なので +3 で月曜起点になる。 */
export function mondayOf(key) {
  if (!DATE_RE.test(String(key))) throw new Error(`日付の形式が違います: ${key}（例: 2026-09-07）`);
  const n = dayNo(key);
  return new Date((n - ((n + 3) % 7)) * 86400000).toISOString().slice(0, 10);
}

/** Vercel は UTC で動くので、今日はタイムゾーンを指定して出す。 */
export function todayKey(tz = 'Asia/Tokyo', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/**
 * 「2026-09-07T17:30:00+09:00」を作る。
 * ビューアは壁の時計をそのまま読むので、UTC のまま書くと9時間ずれて出る。
 */
export function stampNow(tz = 'Asia/Tokyo', now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now).find(x => x.type === 'timeZoneName');
  const off = String(zone && zone.value || '').replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}${off}`;
}

const str = (v, what) => {
  const s = String(v ?? '').trim();
  if (/[\r\n]/.test(s)) throw new Error(`${what} に改行は入れられません`);
  return s;
};

const stamp = (v, what) => {
  const s = String(v ?? '').trim();
  if (!STAMP_RE.test(s)) {
    throw new Error(`${what} の形式が違います: ${v}（例: 2026-09-07T19:00:00+09:00）`);
  }
  return s;
};

/**
 * 予定1件を整える。余計な欄は落とし、足りない欄は補う。
 * 並びは start 順にそろえるので、書くたびに差分が暴れない。
 */
function normalize(e) {
  const out = {
    summary: str(e.summary, 'summary') || '(無題)',
    start: stamp(e.start, 'start'),
    end: stamp(e.end, 'end')
  };
  if (out.end <= out.start) throw new Error(`end が start より後になっていません: ${out.summary}`);
  if (String(e.location ?? '').trim()) out.location = str(e.location, 'location');
  if (String(e.calendar ?? '').trim()) out.calendar = str(e.calendar, 'calendar');
  if (String(e.color ?? '').trim()) {
    const c = str(e.color, 'color');
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`color は #rrggbb で: ${c}`);
    out.color = c;
  }
  return out;
}

/**
 * week.json 全体を組み立てる。週の月曜に丸め、範囲外の予定は捨てる。
 * @returns {{ json:string, week:string, kept:number, dropped:number }}
 */
export function buildWeek(input, { updated, tz = 'Asia/Tokyo', now = new Date() } = {}) {
  const week = mondayOf(String(input.week ?? '').trim());
  const startHour = Number(input.start_hour ?? 5);
  const endHour = Number(input.end_hour ?? 26);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) {
    throw new Error(`start_hour / end_hour が不正です（${startHour} / ${endHour}）`);
  }
  const dim = Array.isArray(input.dim) ? input.dim.map(s => str(s, 'dim')).filter(Boolean) : DIM_DEFAULT;

  const all = (input.events || []).map(normalize);
  // 月曜0時から翌週月曜の end_hour まで。前後の深夜またぎは残す
  const from = week + 'T00:00';
  const to = new Date((dayNo(week) + 7) * 86400000).toISOString().slice(0, 10) + 'T03:00';
  const events = all.filter(e => e.end > from && e.start < to)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const body = {
    week,
    updated: updated || stampNow(tz, now),
    start_hour: startHour,
    end_hour: endHour,
    dim,
    events
  };
  return {
    json: JSON.stringify(body, null, 2) + '\n',
    week,
    kept: events.length,
    dropped: all.length - events.length
  };
}

/** updated の違いだけなら「同じ」とみなす。見に行っただけで書かないため。 */
export function sameContent(a, b) {
  const strip = t => {
    try { const { updated, ...rest } = JSON.parse(t); return JSON.stringify(rest); }
    catch (e) { return null; }
  };
  const x = strip(a), y = strip(b);
  return x !== null && x === y;
}

/** 読んだ week.json の要約。全部返すと長いので、日ごとにまとめる。 */
export function summary(text, tz = 'Asia/Tokyo', now = new Date()) {
  let w;
  try { w = JSON.parse(text); } catch (e) { throw new Error('week.json が JSON として読めません: ' + e.message); }
  const week = mondayOf(String(w.week ?? '').trim());
  const base = dayNo(week);
  const dow = ['月', '火', '水', '木', '金', '土', '日'];
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date((base + i) * 86400000).toISOString().slice(0, 10);
    return { date, rel: dow[i], events: [] };
  });

  for (const e of (w.events || [])) {
    const i = e.start.slice(0, 10) === '' ? -1 : dayNo(e.start.slice(0, 10)) - base;
    if (i < 0 || i > 6) continue;                       // 週の前後にはみ出した分
    days[i].events.push({
      summary: e.summary,
      time: `${e.start.slice(11, 16)}-${e.end.slice(11, 16)}`,
      ...(e.location ? { location: e.location } : {}),
      ...(e.start.slice(0, 10) !== e.end.slice(0, 10) ? { ends: e.end.slice(0, 10) } : {})
    });
  }

  const today = todayKey(tz, now);
  const behind = Math.round((dayNo(mondayOf(today)) - base) / 7);
  return {
    week,
    today,
    updated: w.updated || null,
    stale: behind > 0 ? `${behind}週前の写しです` : null,
    days
  };
}
