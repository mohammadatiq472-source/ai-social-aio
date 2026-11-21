#!/usr/bin/env node
// ============================================================================
// scripts/poll-github.mjs —— 公开仓库增量轮询（issue / issue 评论 / push 提交）
//
// 为什么不用 webhook：这台机器是本地 Windows，没有公网回调；用 `gh api` 定时拉取最省事。
// 凭据：不读任何 token 文件，直接复用本机已登录的 `gh`（keyring）。绝不把 PAT 写进代码/配置。
//
// 状态：默认 tmp/github-poll/state.json（tmp/ 已 gitignore），记录：
//   - lastCheckedAt：上次成功检查的时间（ISO，含 2 分钟重叠，防边界漏项）
//   - seenIssues / seenComments / seenCommits：用于「改过才算新」的去重
//
// 用法：
//   node scripts/poll-github.mjs             # 拉增量，更新状态，输出 JSON
//   node scripts/poll-github.mjs --status    # 只打印状态，不请求网络
//   node scripts/poll-github.mjs --baseline  # 忽略状态，把当前全部当基线（首次建库）
//
// 退出码：0 有/无增量都算成功；2 gh 调用失败（状态不更新）；3 状态文件坏了
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = process.env.POLL_REPO || 'mohammadatiq472-source/ai-social-platform';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STATE_FILE = process.env.POLL_STATE || path.join(ROOT, 'tmp', 'github-poll', 'state.json');
const OVERLAP_MS = 2 * 60 * 1000; // 两次检查之间留 2 分钟重叠，避免请求边界丢事件

const args = new Set(process.argv.slice(2));

function ghApi(endpoint) {
  const out = execFileSync('gh', ['api', endpoint, '--paginate'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // --paginate 会在数组结果之间直接拼接多个 JSON 数组；统一捞成一个数组
  const chunks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        chunks.push(JSON.parse(out.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return chunks.flat();
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
      repoPushedAt: typeof parsed.repoPushedAt === 'string' ? parsed.repoPushedAt : null,
      seenIssues: parsed.seenIssues && typeof parsed.seenIssues === 'object' ? parsed.seenIssues : {},
      seenComments: parsed.seenComments && typeof parsed.seenComments === 'object' ? parsed.seenComments : {},
      seenCommits: Array.isArray(parsed.seenCommits) ? parsed.seenCommits : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { lastCheckedAt: null, repoPushedAt: null, seenIssues: {}, seenComments: {}, seenCommits: [] };
    }
    throw err;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

const itemTime = (iso) => {
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

function main() {
  const state = readState();

  if (args.has('--status')) {
    console.log(JSON.stringify({
      stateFile: STATE_FILE,
      repo: REPO,
      lastCheckedAt: state.lastCheckedAt,
      seen: {
        issues: Object.keys(state.seenIssues).length,
        comments: Object.keys(state.seenComments).length,
        commits: state.seenCommits.length,
      },
    }, null, 2));
    return;
  }

  const baseline = args.has('--baseline') || !state.lastCheckedAt;
  const sinceIso = baseline
    ? null
    : new Date(itemTime(state.lastCheckedAt) - OVERLAP_MS).toISOString();

  const repo = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}`, '--jq',
    '{pushed_at, open_issues_count, updated_at}'], { encoding: 'utf8' }).trim());

  const issueQuery = `repos/${REPO}/issues?state=all&sort=updated&direction=desc&per_page=100${sinceIso ? `&since=${sinceIso}` : ''}`;
  const commentQuery = `repos/${REPO}/issues/comments?sort=updated&direction=desc&per_page=100${sinceIso ? `&since=${sinceIso}` : ''}`;
  const commitQuery = `repos/${REPO}/commits?per_page=100${sinceIso ? `&since=${sinceIso}` : ''}`;

  const issues = ghApi(issueQuery);
  const comments = ghApi(commentQuery);
  const commits = ghApi(commitQuery);

  const additions = { issues: [], comments: [], commits: [] };
  const seenCommits = new Set(state.seenCommits);

  for (const it of issues) {
    const key = String(it.number);
    const prev = state.seenIssues[key];
    const changed = !prev || prev.updated_at !== it.updated_at;
    if (!changed) continue;
    additions.issues.push({
      number: it.number,
      title: it.title,
      state: it.state,
      author: it.user?.login ?? null,
      created_at: it.created_at,
      updated_at: it.updated_at,
      comments: it.comments,
      isPullRequest: Boolean(it.pull_request),
      url: it.html_url,
      labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    });
    state.seenIssues[key] = { updated_at: it.updated_at, state: it.state };
  }

  for (const c of comments) {
    const key = String(c.id);
    const prev = state.seenComments[key];
    if (prev && prev.updated_at === c.updated_at) continue;
    const isNew = !prev;
    additions.comments.push({
      id: c.id,
      issueNumber: Number(String(c.issue_url || '').split('/').pop()),
      author: c.user?.login ?? null,
      body: String(c.body || '').slice(0, 2000),
      created_at: c.created_at,
      updated_at: c.updated_at,
      url: c.html_url,
      edited: !isNew,
    });
    state.seenComments[key] = { updated_at: c.updated_at };
  }

  for (const c of commits) {
    if (seenCommits.has(c.sha)) continue;
    additions.commits.push({
      sha: c.sha?.slice(0, 7),
      fullSha: c.sha,
      message: String(c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name ?? c.author?.login ?? null,
      date: c.commit?.author?.date ?? null,
      url: c.html_url,
    });
    seenCommits.add(c.sha);
  }

  // 只留最近 300 条 commit sha，避免状态文件无限增长
  state.seenCommits = [...seenCommits].slice(-300);
  // 状态里的时间用「本次开始时间」而不是结束时间：请求期间的更新会在下一轮被 2 分钟重叠捞到
  const checkedAt = new Date().toISOString();
  state.lastCheckedAt = checkedAt;
  state.repoPushedAt = repo.pushed_at ?? null;

  additions.commits.sort((a, b) => itemTime(b.date) - itemTime(a.date));
  additions.issues.sort((a, b) => itemTime(b.updated_at) - itemTime(a.updated_at));
  additions.comments.sort((a, b) => itemTime(b.updated_at) - itemTime(a.updated_at));

  const report = {
    repo: REPO,
    checkedAt,
    baseline,
    since: sinceIso,
    repoState: {
      openIssuesAndPrs: repo.open_issues_count,
      pushedAt: repo.pushed_at,
    },
    counts: {
      issues: additions.issues.length,
      comments: additions.comments.length,
      commits: additions.commits.length,
    },
    additions,
    stateFile: STATE_FILE,
  };

  writeState(state);
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (err) {
  const detail = err.stderr ? String(err.stderr).trim().slice(0, 800) : err.message;
  console.error(JSON.stringify({ ok: false, error: 'gh_failed', detail }, null, 2));
  process.exit(2);
}
