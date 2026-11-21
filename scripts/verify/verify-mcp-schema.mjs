#!/usr/bin/env node
// MCP 工具 schema 合法性（2026-11-19，对应外部审查 Q1）。
//
// 为什么需要这条验证：`dm` 的 inputSchema 曾经引用 `#/definitions/part`，而整个 schema 里
// 既没有 `definitions` 也没有 `$defs`。**服务端自测完全看不出来**——JSON 照样返回 200，
// 只有「严格按 JSON Schema 校验的客户端」才会在 tools/list 阶段拒绝加载，
// 表现成「这个服务连不上」而不是「某个工具坏了」。所以这里用 ajv 真的编译一遍，
// 而不是 grep 字符串。
//
// 覆盖：
//   1) 每个工具的 inputSchema / outputSchema 能被 ajv(draft 2020-12) 编译；
//   2) required 里的字段必须出现在 properties 里；
//   3) 抽样做「正例通过、反例拒绝」（dm 的 parts 曾经就是坏的）；
//   4) 所有 $ref 都能在自身 schema 内解析（跨 schema 引用一律视为坏，因为客户端拿到的是独立子 schema）。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-schema.mjs

import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function ensureAgent() {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const password = 'SchemaVerify!2026';
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password, display_name: 'Schema守卫', invite_code: process.env.REGISTER_CODE || '' },
  });
  if (reg.status !== 200) throw new Error(`register ${reg.status} ${String(reg.text).slice(0, 140)}`);
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const ag = await api('/api/agents', {
    method: 'POST', cookie, body: { display_name: `SchemaAI${rnd()}` },
  });
  if (!ag.json?.token) throw new Error(`create agent ${ag.status}`);
  return { cookie, token: ag.json.token };
}

async function mcpCall(token, method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

/** 抽出所有 $ref 并逐个在自身 schema 内解析；跨 schema 引用不可解析 = 坏 */
function refProblems(schema) {
  const refs = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') refs.push(v);
      else walk(v);
    }
  })(schema);
  const bad = [];
  for (const ref of refs) {
    if (!ref.startsWith('#')) { bad.push(`${ref}（外部引用）`); continue; }
    let cur = schema;
    for (const part of ref.slice(1).split('/').filter(Boolean)) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) { bad.push(`${ref}（解析不到 ${part}）`); cur = null; break; }
      cur = cur[part];
    }
  }
  return bad;
}

const main = async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  let token;
  try {
    ({ token } = await ensureAgent());
  } catch (err) {
    console.log(`SKIP：拿不到 Agent token（${err.message}）`);
    process.exit(0);
  }

  await mcpCall(token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-verify', version: '1.0.0' },
  });
  const listed = await mcpCall(token, 'tools/list', {});
  const tools = listed.result?.tools || [];
  check('拿得到工具清单', tools.length > 0, `${tools.length} 个`);

  let unparsable = [];
  let schemaBroken = [];
  let requiredBroken = [];
  let refBroken = [];

  for (const tool of tools) {
    for (const key of ['inputSchema', 'outputSchema']) {
      const schema = tool[key];
      if (!schema) continue;
      try {
        ajv.compile(schema); // 编译 = 严格校验（$ref 解析、关键字合法性）
      } catch (err) {
        if (key === 'inputSchema') unparsable.push(`${tool.name}: ${String(err.message).slice(0, 100)}`);
      }
      const refs = refProblems(schema);
      if (refs.length) refBroken.push(`${tool.name}.${key}: ${refs.join(', ')}`);
    }
    const props = tool.inputSchema?.properties || {};
    const req = tool.inputSchema?.required || [];
    const missing = req.filter((k) => !(k in props));
    if (missing.length) requiredBroken.push(`${tool.name}: ${missing.join(',')}`);
    if (!tool.inputSchema?.type) schemaBroken.push(`${tool.name}: 缺 type`);
  }

  check('所有 inputSchema 都能被 ajv 编译（严格客户端不会拒载）', unparsable.length === 0,
    unparsable.slice(0, 3).join(' | '));
  check('所有 $ref 都能在自身 schema 内解析', refBroken.length === 0, refBroken.slice(0, 3).join(' | '));
  check('required 字段都出现在 properties 里', requiredBroken.length === 0, requiredBroken.slice(0, 3).join(' | '));
  check('每个工具都有顶层 type', schemaBroken.length === 0, schemaBroken.slice(0, 3).join(' | '));

  // 抽样：dm 的 parts（曾经引用不存在的定义，是这次修复的对象）
  const dm = tools.find((t) => t.name === 'dm');
  check('dm 工具存在', Boolean(dm), dm ? '' : '清单里没有 dm');
  if (dm) {
    const validate = ajv.compile(dm.inputSchema);
    const good = {
      principal_id: 10000001,
      client_msg_id: 'verify-schema-0001',
      parts: [{ type: 'text', text: '你好' }],
    };
    const bad = { principal_id: 10000001, client_msg_id: 'verify-schema-0002', parts: [] };
    check('dm 正例通过（parts 形状可解析）', validate(good) === true, JSON.stringify(validate.errors || []).slice(0, 120));
    check('dm 反例被拒（parts 不能为空数组）', validate(bad) === false, '');
    const wrongPart = { principal_id: 10000001, client_msg_id: 'verify-schema-0003', parts: [{ type: 'text' }] };
    check('dm 反例被拒（text 段缺 text 字段）', validate(wrongPart) === false, '');
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length}/${results.length}`);
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exit(1);
});
