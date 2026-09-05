// tasks.txt の解析と書き換え。
// ビューア（index.html）と同じ規則で読み、書き換えは該当行だけに限る。
// コメント行・空行・並び順・書式は触らない。

const TYPES = {
  '前進': 'accel', '前進型': 'accel', 'ぜんしん': 'accel', 'A': 'accel',
  'ルーチン': 'routine', 'ルーチン型': 'routine', 'R': 'routine'
};

const clean = s => (!s || s === '-' || s === 'ー' || s === '—') ? '' : s;

// 日付に紐づかない置き場。「すぐできるが、いつやるとは決めていない」もの。
// ファイル上は「# いつでも」という見出しで、3日の窓から外れても畳まれない。
export const ANYTIME = 'anytime';
const ANYTIME_HEADER = '# いつでも';
const ANYTIME_RE = /^#\s*(いつでも|anytime|inbox)\s*$/i;

/**
 * @returns {{ lines: string[], days: Map<string, object[]>, headers: Map<string, number> }}
 *   task: { id, date, index, done, time, type, kind, proj, title, memo, at, memoAt }
 *   at      … その行の lines 上の位置
 *   memoAt  … メモを構成している行の位置（複数可）
 *   headers … 日付見出しの行の位置
 */
export function parse(text) {
  const lines = text.split(/\r?\n/);
  const days = new Map();
  const headers = new Map();
  let curDate = null, curTask = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    const d = line.match(/^#\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (d || ANYTIME_RE.test(line)) {
      curDate = d
        ? `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`
        : ANYTIME;
      if (!days.has(curDate)) { days.set(curDate, []); headers.set(curDate, i); }
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

  return { lines, days, headers };
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
  const m = String(id).match(/^(\d{4}-\d{2}-\d{2}|anytime)#(\d+)$/);
  if (!m) throw new Error(`id の形式が違います: ${id}（例: 2026-08-28#2 / anytime#1）`);
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
  // 「いつでも」は日付ではないので、どの scope でも同じように別枠で返す
  const anytime = (days.get(ANYTIME) || []).map(view);
  if (scope === 'all') {
    return {
      today: todayKey(tz, now),
      anytime,
      days: [...days.keys()].filter(k => k !== ANYTIME).sort().map(date => ({
        date, rel: null, tasks: days.get(date).map(view)
      }))
    };
  }
  return {
    today: todayKey(tz, now),
    anytime,
    days: windowKeys(tz, now).map(({ date, rel }) => ({
      date, rel, tasks: (days.get(date) || []).map(view)
    }))
  };
}

/**
 * 中身が空になった過去の日付の見出しを、節ごと落とす。
 * タスクを全部消した日の見出しだけが残り、「その他の日」に空の欄として
 * 出続けるのを防ぐ。保存のついでに掃除する用で、単独では呼ばない。
 *
 * 触らないもの:
 *   - 3日の窓（昨日・今日・明日）… 空でも枠として要る
 *   - 今日以降の日付       … これから入れる場所
 *   - 「いつでも」          … 日付ではない
 *   - 空行以外が残っている節 … コメントなどを巻き込まない
 */
export function pruneEmptyDays(text, tz = 'Asia/Tokyo', now = new Date()) {
  const { lines, days, headers } = parse(text);
  const today = todayKey(tz, now);
  const win = new Set(windowKeys(tz, now).map(w => w.date));
  const marks = [...headers.entries()].sort((a, b) => a[1] - b[1]);

  const pruned = [];
  const cut = [];
  marks.forEach(([date, at], k) => {
    if (date === ANYTIME || win.has(date) || date >= today) return;
    if ((days.get(date) || []).length) return;
    const end = k + 1 < marks.length ? marks[k + 1][1] : lines.length;
    for (let i = at + 1; i < end; i++) if (lines[i].trim()) return;
    for (let i = at; i < end; i++) cut.push(i);
    pruned.push(date);
  });
  if (!cut.length) return { text, pruned };

  cut.sort((a, b) => b - a).forEach(i => lines.splice(i, 1));
  // 末尾に空行が並ぶことがあるので1本に詰め、改行で終わらせる
  while (lines.length > 1 && !lines.at(-1).trim() && !lines.at(-2).trim()) lines.pop();
  if (lines.length && lines.at(-1) !== '') lines.push('');
  return { text: lines.join('\n'), pruned };
}

/* ---------- 書き換え（text を受け取って text を返す） ----------
   どれも「読む → 該当箇所だけ直す → 返す」。呼び出し側は結果を丸ごと保存する。 */

const assertDate = d => {
  if (String(d) === ANYTIME) return ANYTIME;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
    throw new Error(`日付の形式が違います: ${d}（例: 2026-08-28 / いつでもは "anytime"）`);
  }
  return d;
};

const assertTitle = s => {
  const v = String(s ?? '').trim();
  if (!v) throw new Error('タスク名が空です');
  if (/[\r\n]/.test(v)) throw new Error('タスク名に改行は入れられません');
  return v;
};

const field = s => {
  const v = String(s ?? '').trim();
  if (/[\r\n|]/.test(v)) throw new Error(`「${v}」に改行や | は入れられません`);
  return v === '-' ? '' : v;
};

/** タスク1行を組み立てる。空の欄は「-」で埋め、末尾の空欄は落とす。 */
export function formatTask(t, bullet = '-') {
  const title = assertTitle(t.title);
  const lead = [field(t.time), field(t.type), field(t.proj)];
  let last = -1;
  lead.forEach((v, i) => { if (v) last = i; });
  // タスク名に | が入る場合は、4欄そろえないと解析時に取り違える
  if (title.includes('|')) last = 2;
  const head = `${bullet} [${t.done ? 'x' : ' '}] `;
  if (last < 0) return head + title;
  return head + [...lead.slice(0, last + 1).map(v => v || '-'), title].join(' | ');
}

const memoBlock = (memo, indent = '  ') =>
  String(memo ?? '').split('\n').map(s => s.trim()).filter(Boolean).map(s => indent + 'memo: ' + s);

const normalize = t => ({
  done: !!t.done,
  time: field(t.time), type: field(t.type), proj: field(t.project ?? t.proj),
  title: assertTitle(t.title), memo: String(t.memo ?? '')
});

const brief = t => ({ id: t.id, title: t.title });

export function setDone(text, ids, done) {
  const { lines, days } = parse(text);
  const targets = ids.map(id => findTask(days, id));
  const hit = targets.filter(t => t.done !== done);
  for (const t of hit) writeDone(lines, t.at, done);
  return { text: lines.join('\n'), updated: hit.map(brief), skipped: targets.length - hit.length };
}

export function setMemo(text, id, memo) {
  const { lines, days } = parse(text);
  const task = findTask(days, id);
  if ((task.memo || '').trim() !== String(memo ?? '').trim()) writeMemo(lines, task, memo);
  return { text: lines.join('\n'), task: brief(task) };
}

/** 欄を部分的に差し替える。渡さなかった欄はそのまま、空文字を渡すと空にする。 */
export function updateTask(text, id, patch) {
  const { lines, days } = parse(text);
  const t = findTask(days, id);
  const pick = (v, cur) => v === undefined ? cur : field(v);
  const next = {
    done: t.done,
    time: pick(patch.time, t.time),
    type: pick(patch.type, t.type),
    proj: pick(patch.project, t.proj),
    title: patch.title === undefined ? t.title : assertTitle(patch.title)
  };
  const m = lines[t.at].match(/^(\s*)([-*])/);
  lines[t.at] = (m ? m[1] : '') + formatTask(next, m ? m[2] : '-');
  return { text: lines.join('\n'), task: { id: t.id, ...next, project: next.proj } };
}

export function removeTasks(text, ids) {
  const { lines, days } = parse(text);
  const targets = ids.map(id => findTask(days, id));
  const kill = new Set();
  for (const t of targets) { kill.add(t.at); t.memoAt.forEach(i => kill.add(i)); }
  [...kill].sort((a, b) => b - a).forEach(i => lines.splice(i, 1));
  return { text: lines.join('\n'), removed: targets.map(brief) };
}

/**
 * 指定日にタスクを足す。日付見出しがなければ作る。
 * position: "end"（既定）その日の最後 / "start" 先頭
 * replace: true ならその日の既存タスクを先に全部消す
 */
export function addTasks(text, date, items, { position = 'end', replace = false } = {}) {
  assertDate(date);
  const list = (items || []).map(normalize);
  if (!list.length) throw new Error('追加するタスクがありません');

  let cur = text;
  if (replace) {
    const ids = (parse(cur).days.get(date) || []).map(t => t.id);
    if (ids.length) cur = removeTasks(cur, ids).text;
  }

  const { lines, days, headers } = parse(cur);
  const block = list.flatMap(t => [formatTask(t), ...memoBlock(t.memo)]);

  if (headers.has(date)) {
    const tasks = days.get(date) || [];
    const at = (position === 'start' || !tasks.length)
      ? headers.get(date) + 1
      : Math.max(tasks.at(-1).at, ...tasks.at(-1).memoAt) + 1;
    lines.splice(at, 0, ...block);
  } else {
    // 日付順に並んでいるファイルなら、その位置に差し込む。でなければ末尾。
    // 「いつでも」は日付ではないので必ず末尾。逆に、新しい日付は
    // 「いつでも」より前に入る（'anytime' は文字列比較でどの日付より後になる）。
    const header = date === ANYTIME ? ANYTIME_HEADER : `# ${date}`;
    const later = date === ANYTIME
      ? undefined
      : [...headers.entries()].filter(([d]) => d > date).sort((a, b) => a[1] - b[1])[0];
    if (later) {
      lines.splice(later[1], 0, header, ...block, '');
    } else {
      while (lines.length && lines.at(-1).trim() === '') lines.pop();
      lines.push('', header, ...block, '');
    }
  }
  return { text: lines.join('\n'), date, added: list.map(t => t.title), replaced: replace };
}

/** 別の日付へ移す（繰り越し）。チェック・メモ・欄はそのまま持っていく。 */
export function moveTasks(text, ids, date, position = 'end') {
  assertDate(date);
  const { days } = parse(text);
  const targets = ids.map(id => findTask(days, id));
  if (targets.some(t => t.date === date)) throw new Error(`既に ${date} にあるタスクが含まれています`);
  const carried = targets.map(t => ({
    done: t.done, time: t.time, type: t.type, project: t.proj, title: t.title, memo: t.memo
  }));
  const cut = removeTasks(text, ids).text;
  const out = addTasks(cut, date, carried, { position });
  return { text: out.text, moved: targets.map(brief), to: date };
}
