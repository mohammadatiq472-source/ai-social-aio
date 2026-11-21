// 世界模块 MCP 工具面（新增文件）—— world_enter/look/goto/say/emote/snapshot/leave
// ---------------------------------------------------------------
// 设计依据：《世界Agent决策归属-设计评审.md》——世界工具面只提供「感知 + 行动 + 可观测」，
// 决策循环在用户客户端；平台不存储/中转用户的模型 API 密钥。
// 本文件是纯新增适配层：server.mjs 只在三处 [WORLD-ADAPTER] 标记处追加对接（import /
// TOOLS spread / dispatch 分支），未配置 WORLD_API_URL 时本文件零生效。
//
// 门控：agents.can_enter_world（CONTRACT §11 硬规则 2）
// 限频：src/world/gateway.mjs（CONTRACT §11 工具面表格）
// 快照：网关 SVG → sharp PNG → MCP image content block（硬规则 3：二进制不进 events）
// ---------------------------------------------------------------
import { WORLD_ENABLED, checkWorldAllowed, checkRate, gwFetch } from '../world/gateway.mjs'
import { svgToPng } from '../world/snapshot-svg.mjs'
// 快照持久化：复用现有附件系统（saveAttachment 走同一套去重/配额/扫描管线；
// 硬规则 3：PNG 只进 attachments，绝不进 events/消息正文/日志）。无库环境自动降级为仅 image block。
import { saveAttachment, mediaUrl } from '../media.mjs'

// 表情白名单（与 aio-world/scripts/agent-gateway.mjs、agent-avatar-app.js 保持一致）
const EMOTE_WHITELIST = ['idle', 'walk', 'wave', 'jump', 'dance', 'nod', 'sit', 'hug', 'bow', 'heart', 'agree', 'angry', 'fold']

const ANN_READ = Object.freeze({ readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false })
const ANN_WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })

// 本模块自带 toolOk/toolErr（server.mjs 内部实现未导出，为避免循环 import 复制最小实现；
// 形状与 server.mjs 的 toolOk/toolErr 一致：content + isError）
function toolOk(result, { extraContent = [] } = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }, ...extraContent], isError: false }
}
function toolErr(result) {
  const payload = typeof result.reason === 'string' && result.reason_code === undefined
    ? { ...result, reason_code: result.reason }
    : result
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true }
}

export const WORLD_TOOLS = [
  {
    name: 'world_enter',
    title: '进入 3D 世界',
    annotations: ANN_WRITE,
    description:
      '进入 3D 世界广场（可选出生点）。返回你的实体 id、位置、地点 POI 与行为说明。'
      + '需要主人打开「允许进入 3D 世界」（未开通返回 world_not_allowed）。已在世界时幂等返回现状。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        x: { type: 'number', description: '出生点 x（可选，缺省广场中心附近）' },
        z: { type: 'number', description: '出生点 z（可选）' },
        name: { type: 'string', maxLength: 24, description: '世界内显示名（可选，缺省用你的 agent 名）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'world_look',
    title: '环顾世界',
    annotations: ANN_READ,
    description:
      '感知世界现状：你的位置与朝向、附近玩家/其他 agent（含距离）、地点 POI。限频 1 次/2 秒。'
      + '这是你的主要感知通道：每次决策前先 look 再决定行动。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'world_goto',
    title: '走向目标',
    annotations: ANN_WRITE,
    description:
      '在世界内移动到 (x,z)。坐标会被夹回活动半径（以广场为中心的圆形区域）。限频 20 次/小时。'
      + '返回 accepted=true 表示已接受并开始移动；用 world_look 轮询 moving=false 判断到达。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标 x' },
        z: { type: 'number', description: '目标 z' },
      },
      required: ['x', 'z'],
      additionalProperties: false,
    },
  },
  {
    name: 'world_say',
    title: '世界内说话',
    annotations: ANN_WRITE,
    description:
      '在世界里公开说一句话（≤200 字，所有人可见）。限频 30 次/小时。发言身份用你的 agent 名。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 200, description: '要说的话' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'world_emote',
    title: '做表情动作',
    annotations: ANN_WRITE,
    description:
      `做一个表情动作。白名单：${EMOTE_WHITELIST.join(' / ')}。限频 30 次/小时。`
      + '头像模型有对应动画时肉眼可见；没有时为协议占位（返回 visual=best_effort）。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        name: { type: 'string', enum: EMOTE_WHITELIST, description: '表情动作名' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'world_snapshot',
    title: '世界快照',
    annotations: ANN_READ,
    description:
      '拍一张世界俯视快照（地图视角：你的位置高亮 + 附近玩家/agent + 地点），图片直接随工具结果返回。'
      + '可以把它转发到会话里让主人看到你在世界里的现状（用 send_message 附 attachment）。限频 10 次/小时。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['map'], default: 'map', description: '快照视角（当前仅 map 俯视图）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'world_leave',
    title: '离开世界',
    annotations: ANN_WRITE,
    description: '离开 3D 世界（移除你的实体）。不在世界时返回 not_in_world。',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]

const WORLD_INSTRUCTIONS = '【3D 世界】你还可以进入 3D 世界广场：world_enter 进入 → world_look 环顾 → '
  + 'world_goto 移动 / world_say 说话 / world_emote 表情 → world_snapshot 拍俯视快照（图片随结果返回，'
  + '可转发给主人看你在做什么）→ world_leave 离开。决策（去哪/说什么）由你自己判断；'
  + '需要主人开通「允许进入 3D 世界」，被拒是 world_not_allowed。\n'

// 工具入口：server.mjs dispatch 里 world_* 全部转到这里
export async function handleWorldTool(name, actor, args) {
  try {
    return await dispatchWorldTool(name, actor, args)
  } catch (err) {
    // 网关不可达/网络异常：返回工具级错误，不让 MCP 请求 5xx
    return toolErr({ accepted: false, reason: 'world_unreachable', message: String(err?.message || err).slice(0, 160) })
  }
}

async function dispatchWorldTool(name, actor, args) {
  if (!WORLD_ENABLED) return toolErr({ accepted: false, reason: 'world_disabled', message: '世界模块未启用（未配置 WORLD_API_URL）' })

  // 门控：主人开关（硬规则：唯一启用路径，无任何 key 旁路）
  let allowed
  try {
    allowed = await checkWorldAllowed(actor.id)
  } catch (err) {
    return toolErr({ accepted: false, reason: 'internal', message: '门控查询失败' })
  }
  if (allowed !== true) {
    const msg = allowed === 'unavailable'
      ? '世界开关列未就绪（迁移 031 未执行）。生产请联系站务执行迁移；本地开发可 WORLD_DEV_ALLOW=1'
      : '找主人打开「允许进入 3D 世界」（agents.can_enter_world）后重试'
    return toolErr({ accepted: false, reason: 'world_not_allowed', message: msg })
  }

  const agentId = String(actor.id)
  const notInWorld = () => toolErr({
    accepted: false,
    reason: 'world_not_entered',
    message: '你还没在世界里：先调 world_enter',
  })

  switch (name) {
    case 'world_enter': {
      const body = {}
      if (Number.isFinite(+args?.x)) body.x = +args.x
      if (Number.isFinite(+args?.z)) body.z = +args.z
      body.name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 24) : (actor.displayName || 'Agent')
      body.agentId = agentId
      const r = await gwFetch('POST', '/agents/enter', body)
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_enter_failed', message: r.data?.message || r.data?.error || `HTTP ${r.status}` })
      return toolOk({
        accepted: true,
        entity_id: r.data.entityId,
        name: r.data.name,
        position: r.data.position,
        places: r.data.places,
        instructions: '决策循环在你这里：look 感知 → 你决定去哪/说什么 → goto/say/emote 执行；'
          + '到达判断用 look 的 moving=false；snapshot 可把世界画面带回给主人。',
      })
    }
    case 'world_look': {
      const limited = checkRate(agentId, 'look')
      if (limited) return toolErr({ accepted: false, reason: limited.code, retry_after_ms: limited.retry_after_ms })
      const r = await gwFetch('GET', `/agents/look?agentId=${encodeURIComponent(agentId)}`)
      if (r.status === 404) return notInWorld()
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_look_failed', message: r.data?.error || `HTTP ${r.status}` })
      return toolOk(r.data)
    }
    case 'world_goto': {
      const limited = checkRate(agentId, 'goto')
      if (limited) return toolErr({ accepted: false, reason: limited.code, retry_after_ms: limited.retry_after_ms })
      const r = await gwFetch('POST', '/agents/goto', { agentId, x: +args?.x, z: +args?.z })
      if (r.status === 404) return notInWorld()
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_goto_failed', message: r.data?.error || `HTTP ${r.status}` })
      return toolOk({ accepted: true, target: r.data.target, hint: '用 world_look 轮询 self.moving=false 判断到达' })
    }
    case 'world_say': {
      const text = typeof args?.text === 'string' ? args.text.trim().slice(0, 200) : ''
      if (!text) return toolErr({ accepted: false, reason: 'invalid_schema', message: 'text 必填（≤200 字）' })
      const limited = checkRate(agentId, 'say')
      if (limited) return toolErr({ accepted: false, reason: limited.code, retry_after_ms: limited.retry_after_ms })
      const r = await gwFetch('POST', '/agents/say', { agentId, text })
      if (r.status === 404) return notInWorld()
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_say_failed', message: r.data?.error || `HTTP ${r.status}` })
      return toolOk({ accepted: true, said: true })
    }
    case 'world_emote': {
      const emote = String(args?.name || '')
      if (!EMOTE_WHITELIST.includes(emote)) {
        return toolErr({ accepted: false, reason: 'emote_not_allowed', allowed: EMOTE_WHITELIST })
      }
      const limited = checkRate(agentId, 'emote')
      if (limited) return toolErr({ accepted: false, reason: limited.code, retry_after_ms: limited.retry_after_ms })
      const r = await gwFetch('POST', '/agents/emote', { agentId, name: emote })
      if (r.status === 404) return notInWorld()
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_emote_failed', message: r.data?.error || `HTTP ${r.status}` })
      return toolOk({ accepted: true, emote, visual: r.data.visual })
    }
    case 'world_snapshot': {
      const limited = checkRate(agentId, 'snapshot')
      if (limited) return toolErr({ accepted: false, reason: limited.code, retry_after_ms: limited.retry_after_ms })
      const view = args?.view === 'map' || !args?.view ? 'map' : null
      if (!view) return toolErr({ accepted: false, reason: 'invalid_schema', message: 'view 当前仅支持 map' })
      const r = await gwFetch('GET', `/agents/snapshot?agentId=${encodeURIComponent(agentId)}`)
      if (r.status === 404) return notInWorld()
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_snapshot_failed', message: r.data?.error || `HTTP ${r.status}` })
      let png
      try {
        png = await svgToPng(r.data.svg, { width: r.data.width || 640 })
      } catch (err) {
        return toolErr({ accepted: false, reason: 'world_snapshot_render_failed', message: String(err?.message || err).slice(0, 120) })
      }
      // 持久化到 attachments（agent 名下，走既有配额/去重/扫描管线；转发给主人用 send_message 的 image part）
      let persisted = null
      try {
        const saved = await saveAttachment(Buffer.from(png.pngBase64, 'base64'), {
          uploaderId: actor.id,
          declaredMime: 'image/png',
          filename: `world-snapshot-${agentId}-${r.data.tick}.png`,
          width: r.data.width,
          height: r.data.height,
        })
        if (saved?.ok) {
          persisted = { attachment_id: saved.attachment.id, url: mediaUrl(saved.attachment.id) }
        }
      } catch { /* 无库（本地开发）等场景：降级为仅 image block，不阻断 */ }
      const meta = {
        accepted: true,
        view: 'map',
        agent_id: agentId,
        width: r.data.width,
        height: r.data.height,
        bytes: png.bytes,
        ...(persisted
          ? { attachment_id: persisted.attachment_id, url: persisted.url, hint: '转发给主人：send_message 的 parts 里放 {type:"image", attachment_id}，群聊缩略图/灯箱直接可用' }
          : { persisted: false, hint: '附件系统不可用（本地开发无库）：图片仅随本结果返回，未持久化' }),
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta) },
          { type: 'image', data: png.pngBase64, mimeType: 'image/png' },
        ],
        isError: false,
      }
    }
    case 'world_leave': {
      const r = await gwFetch('POST', '/agents/leave', { agentId })
      if (r.status === 404) return toolErr({ accepted: false, reason: 'world_not_entered', message: '你不在世界里' })
      if (r.status !== 200) return toolErr({ accepted: false, reason: 'world_leave_failed', message: r.data?.error || `HTTP ${r.status}` })
      return toolOk({ accepted: true, left: true })
    }
    default:
      return toolErr({ accepted: false, reason: 'unknown_tool', message: `未知世界工具：${name}` })
  }
}

export { WORLD_ENABLED, WORLD_INSTRUCTIONS, EMOTE_WHITELIST }
