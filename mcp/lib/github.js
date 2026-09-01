// GitHub Contents API で tasks.txt を読み書きする。
// トークンは環境変数からのみ読む。引数でも設定でも受け取らない。

const cfg = () => ({
  owner: process.env.GITHUB_OWNER || 'reiji55',
  repo: process.env.GITHUB_REPO || 'task-3days',
  path: process.env.TASKS_PATH || 'tasks.txt',
  branch: process.env.GITHUB_BRANCH || 'main',
  token: process.env.GITHUB_TOKEN
});

const url = c => `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path}`;

const headers = c => ({
  Authorization: 'Bearer ' + c.token,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'task-3days-mcp'
});

// GitHub の言い分を捨てずに渡す。原因の切り分けはここの文面が頼りになる。
async function fail(res, what) {
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* 本文なし */ }
  const tail = detail ? `（${detail}）` : '';
  if (res.status === 401) return new Error(`GITHUB_TOKEN が無効か期限切れです${tail}`);
  if (res.status === 403) {
    return new Error(
      what === 'write'
        ? `書き込みを拒否されました。GITHUB_TOKEN の Contents を Read and write にしてください${tail}`
        : `読み取りを拒否されました。GITHUB_TOKEN がこのリポジトリを見られません${tail}`
    );
  }
  if (res.status === 404) {
    return new Error(`見つかりません。owner/repo/branch/path か、トークンの対象リポジトリを確認${tail}`);
  }
  return new Error(`GitHub API ${res.status}${tail}`);
}

/**
 * トークンで何ができるかだけを見る。ファイルには触らない。
 * @returns {{ repo:string, read:boolean, write:boolean, detail:string }}
 */
export async function checkAccess(fetchImpl = fetch) {
  const c = cfg();
  if (!c.token) return { repo: `${c.owner}/${c.repo}`, read: false, write: false, detail: 'GITHUB_TOKEN が未設定' };
  const res = await fetchImpl(`https://api.github.com/repos/${c.owner}/${c.repo}`, { headers: headers(c) });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* 本文なし */ }
    return { repo: `${c.owner}/${c.repo}`, read: false, write: false, detail: `HTTP ${res.status} ${detail}`.trim() };
  }
  const json = await res.json();
  const push = !!(json.permissions && json.permissions.push);
  return {
    repo: `${c.owner}/${c.repo}`,
    read: true,
    write: push,
    detail: push ? '読み書きできます' : '読めますが書けません。Contents を Read and write に'
  };
}

export async function readTasks(fetchImpl = fetch) {
  const c = cfg();
  if (!c.token) throw new Error('GITHUB_TOKEN が設定されていません');
  const res = await fetchImpl(`${url(c)}?ref=${encodeURIComponent(c.branch)}`, {
    headers: headers(c), cache: 'no-store'
  });
  if (!res.ok) throw await fail(res, 'read');
  const json = await res.json();
  return {
    text: Buffer.from(json.content, 'base64').toString('utf8'),
    sha: json.sha
  };
}

export async function writeTasks(text, sha, message, fetchImpl = fetch) {
  const c = cfg();
  if (!c.token) throw new Error('GITHUB_TOKEN が設定されていません');
  const res = await fetchImpl(url(c), {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha,
      branch: c.branch
    })
  });
  if (res.status === 409 || res.status === 422) {
    throw new Error('別の場所で先に更新されていました。読み直してからやり直してください');
  }
  if (!res.ok) throw await fail(res, 'write');
  return (await res.json()).content.sha;
}
