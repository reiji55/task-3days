// tasks.txt の解析と書き換え。
// ビューア（index.html）と同じ規則で読み、書き換えは該当行だけに限る。
// コメント行・空行・並び順・書式は触らない。

const TYPES = {
  '前進': 'accel', '前進型': 'accel', 'ぜんしん': 'accel', 'A': 'accel',
  'ルーチン': 'routine', 'ルーチン型': 'routine', 'R': 'routine'
};

const clean = s => (!s || s === '-' || s === 'ー' || s === '—') ? '' : s;

/**
 * @returns {{ lines: string[], days: Map<string, object[]> }}
 *   task: { id, date, index, done, time, type, kind, proj, title, memo, at, memoAt }
 *   at     … その行の lines 上の位置
 *   memoAt … メモを構成している行の位置（複数可）
 */
export function parse(text) {
  const lines = text.split(/\r?\n/);
  const days = new Map();
  let curDate = null, curTask = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    const d = line.match(/^#\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (d) {
      curDate = `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
      if (!days.has(curDate)) days.set(curDate, []);
      curTask = null;
      return;
    }

    const t = line.match(/^[-*]\s*\[([ xX✓])\]\s*(.*)$/);
    if (t && curDate) {
      const parts = t[2].split('|').map(s => s.trim());
      let time = '', type = '', proj = '', title = '';
      if (parts.length >= 4) { [time, type, proj] = parts; title = parts.slice(3).join(' | '); }
      else if (parts.length === 3) { [time, type] = parts; title = parts[2]; }
      else if (parts.length === 2) { time = parts[0]; title = parts[1]; }
      else { title = parts[0]; }

      const list = days.get(curDate);
      const index = list.length + 1;
      curTask = {
        id: `${curDate}#${index}`,
        date: curDate,
        index,
        done: t[1].toLowerCase() !== ' ',
        time: clean(time),
        type: clean(type),
        kind: TYPES[clean(type)] || null,
        proj: clean(proj),
        title,
        memo: '',
        at: i,
        memoAt: []
      };
      list.push(curTask);
      return;
    }

    const m = line.match(/^(?:memo|メモ)\s*[:：]\s*(.*)$/i);
    if (m && curTask) {
      curTask.memo = curTask.memo ? curTask.memo + '\n' + m[1] : m[1];
      curTask.memoAt.push(i);
      return;
    }
    if (curTask && /^[>|]/.test(line)) {
      const extra = line.replace(/^[>|]\s?/, '');
      curTask.memo = curTask.memo ? curTask.memo + '\n' + extra : extra;
      curTask.memoAt.push(i);
    }
  });

  return { lines, days };
}

/** チェック欄だけを差し替える。行の他の部分には触らない。 */
export function writeDone(lines, at, done) {
  const before = lines[at];
  lines[at] = before.replace(/^(\s*[-*]\s*\[)[ xX✓](\])/, (_, a, b) => a + (done ? 'x' : ' ') + b);
  if (lines[at] === before && /\[([ xX✓])\]/.test(before) === false) {
    throw new Error(`行 ${at + 1} はタスク行ではありません`);
  }
  return lines;
}

/** メモ行を丸ごと差し替える。1行につき memo: を1本置くので parse で往復できる。 */
export function writeMemo(lines, task, text) {
  const indent = (lines[task.at].match(/^\s*/) || [''])[0] + '  ';
  const block = String(text ?? '')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => indent + 'memo: ' + s);

  const old = task.memoAt.slice().sort((a, b) => a - b);
  if (old.length) {
    for (let k = old.length - 1; k >= 0; k--) lines.splice(old[k], 1);
    lines.splice(old[0], 0, ...block);
  } else {
    lines.splice(task.at + 1, 0, ...block);
  }
  return lines;
}

/** Vercel は UTC で動くので、日付は必ずタイムゾーンを指定して出す。 */
export function todayKey(tz = 'Asia/Tokyo', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/** 昨日・今日・明日の3日分のキー。 */
export function windowKeys(tz = 'Asia/Tokyo', now = new Date()) {
  const today = todayKey(tz, now);
  const [y, m, d] = today.split('-').map(Number);
  return [-1, 0, 1].map(off => {
    const dt = new Date(Date.UTC(y, m - 1, d + off));
    return {
      date: dt.toISOString().slice(0, 10),
      rel: ['昨日', '今日', '明日'][off + 1]
    };
  });
}

/** id（"2026-08-28#2"）からタスクを引く。 */
export function findTask(days, id) {
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2})#(\d+)$/);
  if (!m) throw new Error(`id の形式が違います: ${id}（例: 2026-08-28#2）`);
  const list = days.get(m[1]);
  if (!list) throw new Error(`その日付はありません: ${m[1]}`);
  const task = list[Number(m[2]) - 1];
  if (!task) throw new Error(`${m[1]} に ${m[2]} 番目のタスクはありません（${list.length}件）`);
  return task;
}

const view = t => ({
  id: t.id, done: t.done, time: t.time || null, type: t.type || null,
  kind: t.kind, project: t.proj || null, title: t.title, memo: t.memo || null
});

/** MCP が返す形。scope="window" なら3日分、"all" なら全部。 */
export function snapshot(days, scope = 'window', tz = 'Asia/Tokyo', now = new Date()) {
  if (scope === 'all') {
    return {
      today: todayKey(tz, now),
      days: [...days.keys()].sort().map(date => ({
        date, rel: null, tasks: days.get(date).map(view)
      }))
    };
  }
  return {
    today: todayKey(tz, now),
    days: windowKeys(tz, now).map(({ date, rel }) => ({
      date, rel, tasks: (days.get(date) || []).map(view)
    }))
  };
}
