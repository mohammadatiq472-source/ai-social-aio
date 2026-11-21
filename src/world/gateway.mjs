// 世界模块适配层 · 网关客户端（新增文件，不改任何现有前后端逻辑）
// ---------------------------------------------------------------
// 对接点（环境变量，均未配置时世界模块整体禁用，tools/list 与升级前逐字节一致）：
//   WORLD_API_URL       世界服务器地址（如 http://localhost:3000）——本变量是模块总开关
//   WORLD_GATEWAY_URL   aio-world 网关地址（默认 http://127.0.0.1:3100，见 aio-world/scripts/agent-gateway.mjs）
//   WORLD_GATEWAY_TOKEN 网关 bearer（生产必须与网关侧一致；默认仅限本地开发）
//   WORLD_DEV_ALLOW=1   本地开发放行：agents.can_enter_world 列不存在时临时允许（生产跑迁移 031 后勿用）
//
// 门控：agents.can_enter_world（迁移 031_world_agent_flag.sql，默认 false）是唯一开关。
// 限频：本模块内存实现，per-agent 滑动窗口——goto 20/h、say 30/h、emote 30/h、
//       snapshot 10/h、look 1 次/2s。超限返回 reason_code=world_*_rate_limited。
// ---------------------------------------------------------------
import { query } from '../db.mjs'

export const WORLD_ENABLED = !!process.env.WORLD_API_URL

const GW_URL = (process.env.WORLD_GATEWAY_URL || 'http://127.0.0.1:3100').replace(/\/$/, '')
const GW_TOKEN = process.env.WORLD_GATEWAY_TOKEN || 'dev-gateway-token'
const DEV_ALLOW = process.env.WORLD_DEV_ALLOW === '1'

// ---- 门控 ----
// 返回 true=允许；false=拒绝（主人开关关）；'unavailable'=列不存在且未开开发放行
let flagColumnMissing = false
export async function checkWorldAllowed(agentId) {
  if (flagColumnMissing) return DEV_ALLOW ? true : 'unavailable'
  try {
    // agents 表主键是 principal_id（与 PATCH /api/agents/:id/leave 同一 WHERE 口径）
    const r = await query('SELECT can_enter_world FROM agents WHERE principal_id = $1', [agentId])
    return r.rows.length > 0 && r.rows[0].can_enter_world === true
  } catch (err) {
    // 42703 = undefined_column：迁移 031 还没跑
    if (err?.code === '42703') {
      flagColumnMissing = true
      return DEV_ALLOW ? true : 'unavailable'
    }
    // 本地开发（无 DATABASE_URL）：显式放行；生产（未设 DEV_ALLOW）数据库异常要暴露
    if (DEV_ALLOW) return true
    throw err
  }
}

// ---- 限频（滑动窗口）----
const LIMITS = {
  goto: { max: 20, windowMs: 3600_000, code: 'world_goto_rate_limited' },
  say: { max: 30, windowMs: 3600_000, code: 'world_say_rate_limited' },
  emote: { max: 30, windowMs: 3600_000, code: 'world_emote_rate_limited' },
  snapshot: { max: 10, windowMs: 3600_000, code: 'world_snapshot_rate_limited' },
  look: { max: 1, windowMs: 2000, code: 'world_look_rate_limited' },
}
const buckets = new Map() // `${agentId}:${action}` -> timestamps[]
export function checkRate(agentId, action) {
  const lim = LIMITS[action]
  if (!lim) return null
  const key = `${agentId}:${action}`
  const now = Date.now()
  const arr = (buckets.get(key) || []).filter((t) => now - t < lim.windowMs)
  if (arr.length >= lim.max) {
    const retryAfter = Math.ceil((arr[0] + lim.windowMs - now) / 1000)
    return { limited: true, code: lim.code, retry_after_ms: retryAfter * 1000 }
  }
  arr.push(now)
  buckets.set(key, arr)
  return null
}

// ---- 网关 HTTP 客户端 ----
export async function gwFetch(method, path, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(GW_URL + path, {
      method,
      headers: { 'Authorization': `Bearer ${GW_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}
