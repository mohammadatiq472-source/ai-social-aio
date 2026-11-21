// 验证：世界 MCP 工具面（verify-world-mcp.mjs）
// ---------------------------------------------------------------
// 覆盖（CONTRACT.md §11 / 设计评审 §6 验收）：
//   A. 无密钥路径：WORLD_API_URL 配好后 7 个 world_* 工具出现在 tools/list
//   B. 全链路：enter → look → goto(到达) → say → emote(白名单内外) → snapshot(PNG) → leave
//   C. 门控：未启用世界模块 → world_disabled；无 WORLD_DEV_ALLOW 且无库 → 拒绝（绝不碰到网关）
//   D. 限频：look 1 次/2s；snapshot 10/小时，超限 world_snapshot_rate_limited
//   E. 禁用态不变量：未配置 WORLD_API_URL 时 TOOLS 保持 21 个
//
// 前置：世界服务器 :3000 运行中；本脚本自起 aio-world 网关（随机端口）。
// 跑法：node scripts/verify/verify-world-mcp.mjs
// ---------------------------------------------------------------
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// 环境必须在 import server/world-tools 之前设置
process.env.WORLD_API_URL = 'http://localhost:3000'
process.env.WORLD_GATEWAY_URL = 'http://127.0.0.1:3188'
process.env.WORLD_GATEWAY_TOKEN = 'verify-token'
process.env.WORLD_DEV_ALLOW = '1'

const { TOOLS } = await import('../../src/mcp/server.mjs')
const { handleWorldTool } = await import('../../src/mcp/world-tools.mjs')

const PORT = 3188
const TOKEN = 'verify-token'
const BASE = `http://127.0.0.1:${PORT}`
let pass = 0
let fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label) } }
const actor = { id: 99999, type: 'agent', displayName: '验证员' }
const call = (name, args) => handleWorldTool(name, actor, args)

// 自起网关（aio-world 树）
const gw = spawn(process.execPath, ['scripts/agent-gateway.mjs'], {
  cwd: new URL('../../aio-world', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, WORLD_GATEWAY_PORT: String(PORT), WORLD_GATEWAY_TOKEN: TOKEN, WORLD_WS_URL: 'ws://localhost:3000/ws' },
  stdio: ['ignore', 'ignore', 'ignore'],
})

try {
  // A. tools/list
  const worldTools = TOOLS.filter((t) => t.name.startsWith('world_'))
  ok(TOOLS.length === 28, `启用态 TOOLS = 28（21 + 7），实际 ${TOOLS.length}`)
  ok(worldTools.length === 7, '7 个 world_* 工具在 tools/list')

  // 等网关就绪
  let healthy = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    try {
      const r = await fetch(BASE + '/health')
      const j = await r.json()
      if (j.ok && j.world === 'connected') { healthy = true; break }
    } catch {}
  }
  ok(healthy, '网关就绪')

  // 全链路
  const enter = await call('world_enter', {})
  ok(enter.isError === false && JSON.parse(enter.content[0].text).accepted === true, 'world_enter 成功')
  ok((enter.content[0].text.includes('决策循环在你这里')), 'enter 返回行为说明（决策归属客户端）')

  const look = await call('world_look', {})
  ok(look.isError === false && JSON.parse(look.content[0].text).self?.agentId === '99999', 'world_look 返回 self')

  const goto = await call('world_goto', { x: 0, z: 9 })
  ok(goto.isError === false && JSON.parse(goto.content[0].text).accepted === true, 'world_goto 被接受')
  let arrived = false
  for (let i = 0; i < 24; i++) {
    await sleep(2500) // look 限频 1 次/2s，轮询间隔必须大于它
    const lastLook = await call('world_look', {})
    const d = JSON.parse(lastLook.content[0].text)
    if (d.self && !d.self.moving && Math.abs(d.self.z - 9) < 0.6) { arrived = true; break }
  }
  ok(arrived, 'goto 到达喷泉（look 轮询 moving=false）')

  // 限频：look 1 次/2s —— 必须紧贴 arrival 的最后一次 look 断言（后面的 saveAttachment
  // 无库时要等 ~5s 连接超时，会把 2s 窗口撑过期）
  const look2 = await call('world_look', {})
  if (!(look2.isError === true && look2.content[0].text.includes('world_look_rate_limited'))) {
    console.log('  [debug look2]', look2.content[0].text.slice(0, 200))
  }
  ok(look2.isError === true && look2.content[0].text.includes('world_look_rate_limited'), 'look 限频生效（1 次/2s）')

  const say = await call('world_say', { text: '工具面验证，大家好！' })
  ok(say.isError === false, 'world_say 成功')

  const emoteBad = await call('world_emote', { name: 'fly' })
  ok(emoteBad.isError === true && emoteBad.content[0].text.includes('emote_not_allowed'), '白名单外 emote 被拒')
  const emote = await call('world_emote', { name: 'wave' })
  ok(emote.isError === false, '白名单内 emote 成功')

  // snapshot：MCP image content block
  const snap = await call('world_snapshot', {})
  const img = snap.content?.find((c) => c.type === 'image')
  ok(snap.isError === false && img?.mimeType === 'image/png', 'world_snapshot 返回 image/png content block')
  ok(typeof img?.data === 'string' && img.data.startsWith('iVBOR'), 'PNG base64 魔数正确（sharp 转换成功）')
  // 持久化降级：无库环境下 meta.persisted=false 且不影响图片返回
  const snapMeta = JSON.parse(snap.content[0].text)
  ok(snapMeta.persisted === false || typeof snapMeta.attachment_id === 'number', '快照持久化路径正确（有库入库 / 无库降级）')

  // 限频：snapshot 10/h —— 已用 1 次，再刷 9 次后第 11 次应被拒
  let limited = false
  for (let i = 0; i < 9; i++) await call('world_snapshot', {})
  const snapOver = await call('world_snapshot', {})
  limited = snapOver.isError === true && snapOver.content[0].text.includes('world_snapshot_rate_limited')
  ok(limited, 'snapshot 限频生效（10 次/小时）')

  // leave + not_entered
  const leave = await call('world_leave', {})
  ok(leave.isError === false && JSON.parse(leave.content[0].text).left === true, 'world_leave 成功')
  await sleep(2100) // 让 look 限频窗口过期，专测 not_entered
  const ghost2 = await call('world_look', {})
  ok(ghost2.isError === true && ghost2.content[0].text.includes('world_not_entered'), '离开后 look 返回 world_not_entered')

  // C. 门控拒绝路径：子进程，无 WORLD_DEV_ALLOW、DATABASE_URL 指向关闭端口
  //    （注意清掉父进程的 WORLD_DEV_ALLOW，避免泄漏进子进程）
  const denyEnv = { ...process.env, WORLD_DEV_ALLOW: '', DATABASE_URL: 'postgres://nobody:pass@127.0.0.1:59998/none', WORLD_GATEWAY_URL: 'http://127.0.0.1:59999' }
  const deny = spawn(process.execPath, ['--input-type=module', '-e', `
    const { handleWorldTool } = await import('file:////path/to/aio/src/mcp/world-tools.mjs');
    const r = await handleWorldTool('world_enter', { id: 1, type: 'agent', displayName: 'X' }, {});
    console.log(JSON.stringify({ isError: r.isError, text: r.content[0].text }));
  `], { stdio: ['ignore', 'pipe', 'pipe'], env: denyEnv })
  let denyOut = ''
  deny.stdout.on('data', (d) => { denyOut += d })
  deny.stderr.on('data', () => {})
  await new Promise((r) => deny.on('close', r))
  const denyRes = JSON.parse(denyOut.trim().split('\n').pop() || '{}')
  ok(denyRes.isError === true && (denyRes.text.includes('world_not_allowed') || denyRes.text.includes('internal')), '门控拒绝：无开发放行 + 无库 → isError（未触碰网关）')

  // E. 禁用态：子进程不设 WORLD_API_URL
  const disabled = spawn(process.execPath, ['--input-type=module', '-e', `
    const { handleWorldTool } = await import('file:////path/to/aio/src/mcp/world-tools.mjs');
    const { TOOLS } = await import('file:////path/to/aio/src/mcp/server.mjs');
    const r = await handleWorldTool('world_enter', { id: 1, type: 'agent', displayName: 'X' }, {});
    console.log(JSON.stringify({ count: TOOLS.length, worldCount: TOOLS.filter(t=>t.name.startsWith('world_')).length, isError: r.isError, text: r.content[0].text }));
  `], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORLD_API_URL: '', WORLD_DEV_ALLOW: '' } })
  let disOut = ''
  disabled.stdout.on('data', (d) => { disOut += d })
  await new Promise((r) => disabled.on('close', r))
  const disRes = JSON.parse(disOut.trim().split('\n').pop() || '{}')
  ok(disRes.count === 21 && disRes.worldCount === 0, '禁用态 TOOLS=21、无 world 工具（不变量）')
  ok(disRes.isError === true && disRes.text.includes('world_disabled'), '禁用态调用返回 world_disabled')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
} finally {
  gw.kill()
}

process.exit(fail ? 1 : 0)
