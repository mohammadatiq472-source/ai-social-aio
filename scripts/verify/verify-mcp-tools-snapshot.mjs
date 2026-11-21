#!/usr/bin/env node
// MCP 工具面快照（2026-11-19，对应外部审查 Q8）。
//
// 为什么需要这条：现有的 MCP 守卫都「只守一部分」——
//   - mcp-unit 只调 handler，**不编译 inputSchema**（坏 $ref 在 169/169 全绿里隐形，见 Q1）；
//   - verify-mcp-schema 只编译 schema，不看工具面本身；
//   - verify-mcp-modern 只抽样几个工具的 annotations。
// 于是「谁把 conversation_id 改名成 group_id / 把可选参数改成必填 / 翻转一个
// idempotentHint / 改了一句工具描述」在 CI 里完全看不出来，AI 客户端却会照着错的描述办事。
// 这里把 tools/list 归一化后与 fixtures/mcp-tools-snapshot.json 逐字段比对：
// **任何工具面变化都必须显式重建快照并一起提交**（`--update`），不允许静默漂移。
//
// 归一化后的稳定结构（每个工具）：
//   name / title / description（原文，去首尾空白）
//   required（排序）/ properties（参数名 → type，按参数名排序）
//   annotations 四类（readOnlyHint / destructiveHint / idempotentHint / openWorldHint）
//   has_output_schema（structuredContent 试点面：只有 my_limits 有，翻倍上下文前要看一眼）
// 刻意**不**收录：inputSchema 里的 minimum/maxLength/pattern/description 等细节
// （它们由 verify-mcp-schema 的 ajv 编译守），以及 initialize.instructions
// （那是会话级文案，不是工具面；改它不该逼着重建工具快照）。
//
// 用法：
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-tools-snapshot.mjs
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-tools-snapshot.mjs --update
//
// 自造数据：注册 t_xxx@test.dev 用户（昵称「形状探针」）+ 一只 `SchemaAI…` 的临时 AI，
// 两者都在 scripts/cleanup-test.mjs 的清理范围内（邮箱前缀 / TEST_NAMES / `SchemaAI%`）；
// 跑完尽力删除这只 AI，用户留给 cleanup-test（events 还引用它，不能物理删）。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mcp-tools-snapshot.json');
const UPDATE = process.argv.includes('--update');
const ANNOTATION_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const sid = (res.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function mcpCall(token, method, params = {}, id = 1) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

/** 注册临时用户 + 建临时 AI 拿 qqa_ token（与 verify-mcp-schema 同一套路） */
async function ensureAgent() {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email,
      password: 'SnapshotVerify!2026',
      display_name: '形状探针',
      invite_code: process.env.REGISTER_CODE || '',
    },
  });
  if (reg.status !== 200) throw new Error(`register ${reg.status} ${String(reg.text).slice(0, 140)}`);
  // 名字上限 20 字（src 侧 invalid_name），所以这里是短前缀 + 8 位随机；
  // 前缀 `SchemaAI` 与 cleanup-test.mjs 的 LIKE 规则对齐，脚本中途失败也不会留脏 AI。
  const ag = await api('/api/agents', {
    method: 'POST', cookie: reg.cookie, body: { display_name: `SchemaAI${rnd()}` },
  });
  if (ag.status !== 200 || !ag.json?.token) throw new Error(`create agent ${ag.status} ${String(ag.text).slice(0, 140)}`);
  return { cookie: reg.cookie, token: ag.json.token, agentId: ag.json.agent?.id ?? null };
}

/** 把 tools/list 的一个工具压成稳定结构（排序、只留契约面） */
function normalizeTool(tool) {
  const props = tool.inputSchema?.properties || {};
  const properties = {};
  for (const name of Object.keys(props).sort()) {
    const p = props[name] || {};
    // 一律落成字符串：type 缺失时不要悄悄变成 undefined（JSON 里会消失，diff 就看不出来了）
    properties[name] = typeof p.type === 'string'
      ? p.type
      : (p.const !== undefined ? `const:${JSON.stringify(p.const)}` : '(untyped)');
  }
  const ann = tool.annotations || {};
  const annotations = {};
  for (const key of ANNOTATION_KEYS) annotations[key] = typeof ann[key] === 'boolean' ? ann[key] : null;
  return {
    name: String(tool.name ?? ''),
    title: String(tool.title ?? ''),
    description: String(tool.description ?? '').trim(),
    required: [...(tool.inputSchema?.required || [])].sort(),
    properties,
    annotations,
    has_output_schema: Boolean(tool.outputSchema),
  };
}

/** 单行摘要：只用来在 detail 里给出「差在哪」，真正的 diff 由 printDiff 打 */
function describeChange(before, after) {
  const out = [];
  for (const key of ['title', 'description', 'has_output_schema']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.push(key);
  }
  if (JSON.stringify(before.required) !== JSON.stringify(after.required)) out.push('required');
  if (JSON.stringify(before.annotations) !== JSON.stringify(after.annotations)) out.push('annotations');
  if (JSON.stringify(before.properties) !== JSON.stringify(after.properties)) out.push('properties');
  return out.join(',');
}

function short(s, n = 240) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…（共 ${one.length} 字）` : one;
}

/** 人可读 diff：新增/消失的工具 + 逐个字段的 +/-/~ 行 */
function printDiff(beforeTools, afterTools) {
  const before = new Map(beforeTools.map((t) => [t.name, t]));
  const after = new Map(afterTools.map((t) => [t.name, t]));
  console.log('\n' + '-'.repeat(60));
  console.log(`快照不一致：${path.relative(process.cwd(), FIXTURE)}`);
  console.log('（- 快照里的旧值 / + 服务端现在的值 / ~ 值变了）');

  for (const name of [...after.keys()].filter((n) => !before.has(n))) console.log(`  + 新增工具：${name}`);
  for (const name of [...before.keys()].filter((n) => !after.has(n))) console.log(`  - 工具消失：${name}`);

  for (const [name, now] of after) {
    const old = before.get(name);
    if (!old) continue;
    const lines = [];
    if (old.title !== now.title) lines.push(`    title:\n      - ${short(old.title)}\n      + ${short(now.title)}`);
    if (old.description !== now.description) {
      lines.push(`    description:\n      - ${short(old.description)}\n      + ${short(now.description)}`);
    }
    if (JSON.stringify(old.required) !== JSON.stringify(now.required)) {
      const added = now.required.filter((k) => !old.required.includes(k));
      const removed = old.required.filter((k) => !now.required.includes(k));
      const bits = [];
      if (added.length) bits.push(`+ ${added.join(',')}`);
      if (removed.length) bits.push(`- ${removed.join(',')}`);
      lines.push(`    required: ${bits.join('  ')}`);
    }
    if (JSON.stringify(old.properties) !== JSON.stringify(now.properties)) {
      const sub = [];
      for (const key of Object.keys(now.properties)) {
        if (!(key in old.properties)) sub.push(`      + ${key}: ${now.properties[key]}`);
        else if (old.properties[key] !== now.properties[key]) sub.push(`      ~ ${key}: ${old.properties[key]} → ${now.properties[key]}`);
      }
      for (const key of Object.keys(old.properties)) {
        if (!(key in now.properties)) sub.push(`      - ${key}: ${old.properties[key]}`);
      }
      lines.push(`    properties:\n${sub.join('\n')}`);
    }
    if (JSON.stringify(old.annotations) !== JSON.stringify(now.annotations)) {
      const sub = [];
      for (const key of ANNOTATION_KEYS) {
        if (old.annotations[key] !== now.annotations[key]) {
          sub.push(`      ~ ${key}: ${JSON.stringify(old.annotations[key])} → ${JSON.stringify(now.annotations[key])}`);
        }
      }
      lines.push(`    annotations:\n${sub.join('\n')}`);
    }
    if (old.has_output_schema !== now.has_output_schema) {
      lines.push(`    has_output_schema: ${old.has_output_schema} → ${now.has_output_schema}`);
    }
    if (lines.length) {
      console.log(`\n  ${name}:`);
      console.log(lines.join('\n'));
    }
  }
  console.log('-'.repeat(60));
  console.log('如果这是有意的改动：node scripts/verify/verify-mcp-tools-snapshot.mjs --update');
  console.log('重建快照，并把 fixtures/mcp-tools-snapshot.json 与代码一起提交（评审时看 diff）。');
}

async function readFixture() {
  try {
    return JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`快照文件读不出来（${err.message}）`);
  }
}

async function writeFixture(tools) {
  const body = {
    // 这份文件是「工具面的契约」，不是给人读的文档：每次改动都要在评审里看 diff
    note: 'MCP tools/list 归一化快照（name/title/description/required/properties 类型/annotations/has_output_schema）。'
      + '改动工具面后跑 node scripts/verify/verify-mcp-tools-snapshot.mjs --update 重建。',
    tool_count: tools.length,
    tools,
  };
  await fs.mkdir(path.dirname(FIXTURE), { recursive: true });
  await fs.writeFile(FIXTURE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path.relative(process.cwd(), FIXTURE);
}

const main = async () => {
  let agent = null;
  try {
    agent = await ensureAgent();
  } catch (err) {
    // 这里不 SKIP：快照守卫的价值就在于「没比对成 = 红」，否则服务没起来时 CI 会假绿
    console.error(`拿不到 Agent token（${err.message}）；先确认 ${BASE} 已起、注册入口可用`);
    process.exit(1);
  }

  try {
    await mcpCall(agent.token, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-snapshot', version: '1.0.0' },
    });
    const listed = await mcpCall(agent.token, 'tools/list', {}, 2);
    const raw = listed.result?.tools || [];
    check('拿得到 tools/list', raw.length > 0, `${raw.length} 个工具`);
    // 用 throw 而不是 process.exit：让 finally 有机会删掉刚建的临时 AI
    if (!raw.length) throw new Error(`tools/list 为空：${JSON.stringify(listed).slice(0, 300)}`);

    const now = raw.map(normalizeTool).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (UPDATE) {
      const where = await writeFixture(now);
      console.log(`已写入快照：${now.length} 个工具 → ${where}`);
      console.log(`\n全部通过：${results.length}/${results.length}`);
      return;
    }

    const fixture = await readFixture();
    if (!fixture) {
      // 没基线 = 没比对过，不能算绿；但也不能 process.exit（finally 还要删临时 AI）
      throw new Error(`快照不存在：${path.relative(process.cwd(), FIXTURE)}\n`
        + '先跑一次 node scripts/verify/verify-mcp-tools-snapshot.mjs --update 生成基线。');
    }
    const before = Array.isArray(fixture.tools) ? fixture.tools : [];

    check('工具数量与快照一致', before.length === now.length, `快照 ${before.length} / 现在 ${now.length}`);
    const namesEqual = JSON.stringify(before.map((t) => t.name)) === JSON.stringify(now.map((t) => t.name));
    check('工具名集合与快照一致（按名字排序后比对，增删工具都会红）', namesEqual,
      namesEqual ? `${now.length} 个` : `快照=${before.map((t) => t.name).join(',')} 现在=${now.map((t) => t.name).join(',')}`);

    const beforeByName = new Map(before.map((t) => [t.name, t]));
    for (const tool of now) {
      const old = beforeByName.get(tool.name);
      const changed = old ? describeChange(old, tool) : '新增';
      check(`${tool.name} 与快照一致（required / 参数类型 / annotations / 描述）`,
        Boolean(old) && changed === '', changed);
    }
    for (const old of before) {
      if (!now.some((t) => t.name === old.name)) check(`${old.name} 与快照一致（required / 参数类型 / annotations / 描述）`, false, '服务端已经没有这个工具');
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length) printDiff(before, now);
    console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join('; '));
      process.exitCode = 1;
    }
  } finally {
    // 尽力删除临时 AI；注册的 t_xxx@test.dev 用户留给 scripts/cleanup-test.mjs（events 还引用它）
    if (agent?.agentId) {
      try { await api(`/api/agents/${agent.agentId}`, { method: 'DELETE', cookie: agent.cookie }); } catch { /* ignore */ }
    }
  }
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
});
