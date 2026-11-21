#!/usr/bin/env node
// 公开文档与代码的一致性守卫（2026-11-19，对应外部审查 Q7）。
//
// 为什么要有这条：对外 README 是陌生人接触这个项目的第一入口，而它漂移的代价特别高——
// 参数名写错（`group_id` vs `conversation_id`）会让 AI 第一次调用就失败；
// 快速开始漏一行 `npm install` 会让「照着文档做」的人在第一步就放弃。
// 这类错**代码本身不会报**，只有真人照着做才会踩，所以必须用脚本钉住。
//
// 判定口径刻意「精确而不猜」：文档里反引号包起来的 snake_case 标识符，
// 要么是真实工具名，要么是某个工具 schema 的字段名，否则就是漂移。
// 参数名白名单直接来自 `tools/list` 的 schema，不维护第二份人工清单。
//
// [Q11] 私聊口径是**同一句话**的三处投影：代码常量 DM_SCOPE_TEXT → 运行时
// `tools/list` 的 dm.description / `initialize.instructions`（HTTP 实际返回，不是本地常量）
// → 契约 CONTRACT.md。以前描述写「只允许主人或好友」、代码放过同群的人，AI 就少做一件事。
// 所以这里逐字比对：少了任何一处都算漂移，而不是「意思差不多」。
//
// [Q3] 工具数从 20 加到 21（`get_context`）：文档里的 `get_context` 由下面那条
// 「反引号标识符必须是真工具名/字段名」的机制统一覆盖，另外单独钉「存在 + 必填
// conversation_id」，防止工具加了但参数名漂移。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-docs-consistency.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DM_SCOPE_TEXT } from '../../src/mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function realTools() {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'DocsGuard!2026', display_name: '文档守卫', invite_code: process.env.REGISTER_CODE || '' },
  });
  if (reg.status !== 200) throw new Error(`register ${reg.status}`);
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `文档AI${rnd()}` } });
  const token = ag.json?.token;
  if (!token) throw new Error(`create agent ${ag.status}`);
  const call = async (method, params) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return {}; }
  };
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docs-guard', version: '1' } });
  const listed = await call('tools/list', {});
  return {
    tools: listed.result?.tools || [],
    instructions: String(init.result?.instructions || ''),
  };
}

/** 从所有工具的 inputSchema 里收集字段名（含一层嵌套，够覆盖 parts 这类） */
function schemaFieldNames(tools) {
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties)) { names.add(k); walk(v); }
    }
    if (node.items) walk(node.items);
    if (node.oneOf) walk(node.oneOf);
    if (node.anyOf) walk(node.anyOf);
  };
  for (const t of tools) walk(t.inputSchema);
  return names;
}

const main = async () => {
  // 文档只在开发机/仓库里；生产机不部署 docs/，这里应当跳过而不是失败
  const readmePath = path.join(ROOT, 'docs/public/README.md');
  if (!fs.existsSync(readmePath)) {
    console.log('SKIP：当前目录没有 docs/public（生产机不部署文档，本条只在仓库里跑）');
    process.exit(0);
  }

  const publicReadme = read('docs/public/README.md');
  const publicArch = read('docs/public/docs/architecture.md');
  const publicAll = `${publicReadme}\n${publicArch}`;

  // ---------- 静态断言（不依赖服务端）
  check('公开 README 的快速开始包含 `npm install`',
    /```bash[\s\S]*?npm install[\s\S]*?```/.test(publicReadme), '');
  check('公开 README 提醒了「重新构建后必须重启后端」',
    /重启后端|必须重启/.test(publicReadme), '');
  check('公开文档里没有 `group_id`（已废弃参数名）',
    !publicAll.includes('group_id'), '');

  // [Q11] CONTRACT.md 是发布给接入方的契约（公开快照里叫 docs/contract.md）。
  // 生产机可能只带 docs/public 而没有这份，保持 SKIP；仓库里必须与代码常量逐字一致。
  const contractPath = path.join(ROOT, 'CONTRACT.md');
  if (fs.existsSync(contractPath)) {
    const contract = fs.readFileSync(contractPath, 'utf8');
    check('CONTRACT.md 的 dm 允许范围与代码常量 DM_SCOPE_TEXT 逐字一致',
      contract.includes(DM_SCOPE_TEXT), `"${DM_SCOPE_TEXT.slice(0, 24)}…"`);
  } else {
    skip('CONTRACT.md 的 dm 允许范围（仓库里没有 CONTRACT.md）');
  }

  // ---------- 需要真实工具清单的断言
  let listing = null;
  try {
    listing = await realTools();
  } catch (err) {
    skip('工具数量 / 名称 / 参数名一致性（BASE 不可达）', err.message);
  }

  if (listing) {
    const tools = listing.tools;
    const toolNames = tools.map((t) => t.name);
    const fieldNames = schemaFieldNames(tools);
    check('拿得到工具清单', toolNames.length > 0, `${toolNames.length} 个`);

    const declared = [...publicAll.matchAll(/工具面（(\d+) 个）|(\d+)\s*个工具/g)]
      .map((m) => Number(m[1] || m[2]))
      .filter((n) => Number.isInteger(n));
    check('公开文档声明的工具数量与真实一致',
      declared.length > 0 && declared.every((n) => n === toolNames.length),
      `文档 ${declared.join('/') || '未写'} vs 真实 ${toolNames.length}`);

    // 输出/错误契约里的字段与基础设施术语：不是工具名、也不是 inputSchema 字段，
    // 但确实应该出现在文档里。这份清单只放「协议输出字段」和「表名/角色名」，
    // 新增时要写清为什么——否则这个守卫会退化成「白名单兜底」。
    const CONTRACT_WORDS = new Set([
      'reason_code',      // 写失败的结构化原因（MCP 结果里）
      'retry_after_ms',   // 限流时告诉客户端多久后重试
      'messages_meta',    // 读模型表名（架构文档会提）
      'mcp_writer',       // DB 角色名（权限模型段落会提）
    ]);

    // 文档里反引号内的 snake_case 标识符：必须是工具名、某工具字段名，或上面这几个契约字段
    const words = [...new Set([...publicAll.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]))];
    const unknown = words.filter((w) => !toolNames.includes(w) && !fieldNames.has(w) && !CONTRACT_WORDS.has(w));
    check('公开文档里的参数名/工具名都真实存在', unknown.length === 0, unknown.slice(0, 8).join(', '));

    check('join_group 的文档示例用的是 conversation_id',
      /join_group\s*\{\s*conversation_id/.test(publicReadme), '');

    // [Q11] 运行时口径：必须打 HTTP 拿 tools/list 与 initialize.instructions，
    // 不能只看本地 TOOLS 常量——那样改完代码忘重启会「测过了但线上还是旧的」。
    const dmTool = tools.find((t) => t.name === 'dm');
    const dmDesc = String(dmTool?.description || '');
    check('tools/list 的 dm 描述包含统一私聊口径（DM_SCOPE_TEXT）',
      Boolean(dmTool) && dmDesc.includes(DM_SCOPE_TEXT),
      dmTool ? `len=${dmDesc.length}` : '没有 dm 工具');
    check('initialize.instructions 包含同一句私聊口径',
      listing.instructions.includes(DM_SCOPE_TEXT),
      `len=${listing.instructions.length}`);

    // [Q3] get_context 是第 21 个工具：AI 新入群/重启后靠它建上下文。
    // 这里只钉「存在 + 必填参数就是 conversation_id」两件事——参数名改名（conversation_id → group_id）
    // 会让照文档接的客户端第一次调用就失败，和 Q7 是同一类事故。
    // 文档侧不用另写断言：上面「反引号标识符必须是真工具名/字段名」的机制已经覆盖 `get_context`。
    const ctx = tools.find((t) => t.name === 'get_context');
    check('tools/list 存在 get_context 且必填参数是 conversation_id',
      Boolean(ctx)
      && Array.isArray(ctx.inputSchema?.required)
      && ctx.inputSchema.required.length === 1
      && ctx.inputSchema.required[0] === 'conversation_id',
      ctx ? JSON.stringify(ctx.inputSchema?.required) : '没有 get_context');
  } else {
    // 不能因为服务端不可达就让这两条「消失」——显式 SKIP，条数才说得清（生产/离线环境仍不算失败）
    skip('tools/list 的 dm 描述包含统一私聊口径（BASE 不可达）');
    skip('initialize.instructions 包含同一句私聊口径（BASE 不可达）');
    skip('tools/list 存在 get_context 且必填参数是 conversation_id（BASE 不可达）');
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length - skipped.length}/${results.length}` + (skipped.length ? `（跳过 ${skipped.length} 项）` : ''));
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exit(1);
});
