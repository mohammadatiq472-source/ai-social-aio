// REST 封装：全部同源相对路径，Cookie 走 same-origin。
import type {
  AdminInvite,
  AdminReport,
  AgentInfo,
  MemberRole,
  AgentQuota,
  AgentToken,
  Message,
  AgentMcpConfig,
  AgentMembership,
  Conversation,
  CreateAgentResponse,
  CreatedAdminInvite,
  CreateConversationResponse,
  DirectoryEntry,
  Feed,
  FeedComment,
  FeedCommentResult,
  FeedCreateResult,
  FeedLikeResult,
  FeedVisibility,
  FriendsResponse,
  InviteCreateResult,
  InviteRevokeResult,
  InvitesMine,
  SignupState,
  WaitlistItem,
  Me,
  MembersResponse,
  MessagePart,
  MessagesResponse,
  PrincipalProfile,
  PushStatusResponse,
  ReplyMode,
  SearchResponse,
  StickerPackResponse,
  StickerPacksResponse,
  SubmitResult,
  UploadAttachmentResponse,
} from './types'
import { toWireParts } from './parts'

/** 后端错误码 → 中文兜底文案（契约 §6 只保证 {error,message?}） */
const CODE_TEXT: Record<string, string> = {
  unauthorized: '登录已过期，请重新登录',
  invalid_schema: '提交的内容不合法',
  invalid_credentials: '邮箱或密码不正确',
  forbidden: '你没有权限做这个操作',
  rate_limited: '操作太频繁，请稍后再试',
  not_found: '对象不存在或已被删除',
  gone: '内容已失效',
  conflict: '与已有数据冲突',
  locked: '尝试次数过多，请稍后再试',
  email_taken: '该邮箱已被注册',
  agent_revoked: '这个 AI 已被停用',
  invite_quota_exhausted: '邀请名额已用完',
  no_remaining_quota: '邀请名额已用完',
  max_uses_exceeds_quota: '邀请人数超过剩余名额',
  invalid_max_uses: '邀请人数不合法',
  invalid_ttl: '有效期不合法',
  server_error: '服务器开小差了，请稍后再试',
}

/** 默认请求超时（毫秒）。长任务（上传）各自另有更宽的时限。 */
const REQUEST_TIMEOUT_MS = 15_000
/** 二进制上传的时限：40MB 视频在慢网下也要给足 */
const UPLOAD_TIMEOUT_MS = 120_000

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/** 非 2xx 统一成 ApiError；带中文 message 就用后端的，否则按状态码给兜底文案 */
function failureFrom(status: number, payload: unknown): ApiError {
  const record = (payload ?? {}) as { error?: string; message?: string }
  const code = record.error ?? (status === 401 ? 'unauthorized' : 'server_error')
  const chinese = record.message && /[\u4e00-\u9fa5]/.test(record.message)
    ? record.message
    : (CODE_TEXT[code] ?? statusText(status))
  if (status === 401) {
    // 让 App 统一退回登录页，避免每个组件都处理
    window.dispatchEvent(new CustomEvent('qq:unauthorized'))
  }
  return new ApiError(status, code, chinese)
}

function statusText(status: number): string {
  if (status === 413) return '文件太大（图片 ≤8MB / 视频 ≤40MB / PDF ≤20MB）'
  if (status === 415) return '不支持这种文件类型'
  return `请求失败（${status}）`
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    // 默认 15 秒超时：没有它，一个挂起（既不返回也不断）的请求能让启动页永远转圈。
    // 调用方显式给了 signal（上传取消等）就用调用方的。
    signal: signal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : null),
  }
  if (body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    if ((err as Error).name === 'TimeoutError') {
      throw new ApiError(0, 'timeout', `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查网络后重试`)
    }
    throw new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试')
  }

  const payload = await readJson(res)
  if (!res.ok) throw failureFrom(res.status, payload)

  return payload as T
}

/** 带上传进度的二进制 PUT/POST：fetch 没有上传进度事件，只能走 XHR。 */
function uploadWithProgress(
  path: string,
  file: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path, true)
    xhr.withCredentials = true
    // XHR 自己的超时：不设的话慢网/服务端挂住会让上传进度条永远停在 99%
    xhr.timeout = UPLOAD_TIMEOUT_MS
    for (const [key, value] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(key, value)
      } catch {
        /* 个别受限头（浏览器禁止设置）直接忽略 */
      }
    }

    let settled = false
    const onAbortSignal = () => {
      if (!settled) xhr.abort()
    }
    if (signal) {
      if (signal.aborted) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
        return
      }
      signal.addEventListener('abort', onAbortSignal)
    }
    const cleanup = () => {
      settled = true
      signal?.removeEventListener('abort', onAbortSignal)
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      cleanup()
      let payload: unknown = null
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        payload = null
      }
      resolve({ status: xhr.status, payload })
    }
    xhr.onerror = () => {
      cleanup()
      reject(new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试'))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new ApiError(0, 'network_error', '上传超时，请重试'))
    }
    xhr.onabort = () => {
      cleanup()
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    xhr.send(file)
  })
}

export const api = {
  // ---------- 身份 ----------
  async register(input: { email: string; password: string; displayName: string; inviteCode?: string }): Promise<{ me: Me }> {
    return request<{ me: Me }>('/api/auth/register', {
      method: 'POST',
      body: {
        email: input.email,
        password: input.password,
        display_name: input.displayName,
        // 服务端配了 REGISTER_CODE 才需要；没配就忽略这个字段
        invite_code: input.inviteCode || '',
      },
    })
  },

  async login(input: { email: string; password: string }): Promise<{ me: Me }> {
    return request<{ me: Me }>('/api/auth/login', {
      method: 'POST',
      body: { email: input.email, password: input.password },
    })
  },

  async logout(): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/auth/logout', { method: 'POST' })
  },

  async me(): Promise<Me> {
    return request<Me>('/api/me')
  },

  /** 开关「允许别人通过号码找到我」（只影响号码搜索，昵称搜索不受限） */
  async setDiscoverable(discoverable: boolean): Promise<{ ok: boolean; discoverable: boolean }> {
    return request<{ ok: boolean; discoverable: boolean }>('/api/me/discoverable', {
      method: 'POST',
      body: { discoverable },
    })
  },

  /**
   * 把自己的头像绑定到已上传的附件（契约 §1.2）。
   * 先调 uploadAttachment() 拿 attachment.id，再调本接口；返回的 me 里带最新 avatarUrl。
   */
  async setMyAvatar(attachmentId: number): Promise<{ me: Me }> {
    return request<{ me: Me }>('/api/me/avatar', {
      method: 'POST',
      body: { attachment_id: attachmentId },
    })
  },

  /** 清除图片头像，回退到几何头像；返回的 me 里 avatarUrl 为 null */
  async clearMyAvatar(): Promise<{ me: Me }> {
    return request<{ me: Me }>('/api/me/avatar', { method: 'DELETE' })
  },

  // ---------- 会话 ----------
  async conversations(offset = 0, limit = 50): Promise<Conversation[]> {
    return request<Conversation[]>(`/api/conversations?offset=${offset}&limit=${limit}`)
  },

  /** 退出群聊（只影响自己；群主不能退，服务端会拒） */
  async leaveConversation(conversationId: number): Promise<{ ok: boolean; left?: boolean }> {
    return request<{ ok: boolean; left?: boolean }>(`/api/conversations/${conversationId}/leave`, { method: 'POST' })
  },

  /**
   * 群公告（群主/管理员）。纯文本 ≤2000；服务端按字符数校验（不是字节）。
   * 传空字符串 = 清空公告（聊天页的公告条随之消失）。
   */
  async updateAnnouncement(
    conversationId: number,
    announcement: string,
  ): Promise<{ announcement: string; announcementUpdatedAt: string | null }> {
    return request<{ announcement: string; announcementUpdatedAt: string | null }>(
      `/api/conversations/${conversationId}/announcement`,
      { method: 'PATCH', body: { announcement } },
    )
  },

  /** 站点注册模式（未登录也能调）：决定登录页显示「邀请码 / 申请候补 / 无需邀请码」 */
  async signup(): Promise<SignupState> {
    return request<SignupState>('/api/signup')
  },

  /** 申请候补（仅 waitlist 模式存在；其它模式回 404） */
  async applyWaitlist(input: { email: string; note?: string }): Promise<{ ok: boolean; already?: boolean; status?: string }> {
    return request<{ ok: boolean; already?: boolean; status?: string }>('/api/waitlist', {
      method: 'POST',
      body: { email: input.email, note: input.note || '' },
    })
  },

  // ---------- 站务：候补队列 ----------
  async adminWaitlist(status: 'pending' | 'approved' | 'rejected' = 'pending'): Promise<{ items: WaitlistItem[]; counts: Record<string, number> }> {
    return request<{ items: WaitlistItem[]; counts: Record<string, number> }>(`/api/admin/waitlist?status=${status}`)
  },

  /** 从候补队列发码：明文码只在这次响应里出现（库里只有 HMAC） */
  async adminIssueWaitlist(id: number): Promise<{ ok: boolean; id: number; email: string; code: string; expiresAt: string | null }> {
    return request<{ ok: boolean; id: number; email: string; code: string; expiresAt: string | null }>(
      `/api/admin/waitlist/${id}/issue`,
      { method: 'POST', body: {} },
    )
  },

  async adminRejectWaitlist(id: number): Promise<{ ok: boolean; id: number }> {
    return request<{ ok: boolean; id: number }>(`/api/admin/waitlist/${id}/reject`, { method: 'POST', body: {} })
  },

  /** 发送邮箱验证信（未配置 SMTP 的实例会返回 503 email_verification_disabled） */
  async sendEmailVerification(): Promise<{ ok: boolean; sentTo?: string; expiresAt?: string }> {
    return request<{ ok: boolean; sentTo?: string; expiresAt?: string }>('/api/auth/verify-email/send', {
      method: 'POST',
    })
  },

  /** 大群成员懒加载：返回全量成员（小群一般用不到，列表里 already 全量） */
  async conversationMembers(conversationId: number): Promise<MembersResponse> {
    return request<MembersResponse>(`/api/conversations/${conversationId}/members`)
  },

  async createConversation(input: { title: string; memberIds: number[] }): Promise<CreateConversationResponse> {
    return request<CreateConversationResponse>('/api/conversations', {
      method: 'POST',
      body: { title: input.title, member_ids: input.memberIds },
    })
  },

  /**
   * 拉消息。两个方向互斥：
   *   sinceSeq — 向下增量（断线补齐 / 打开会话拉最新）
   *   beforeSeq — 向上翻历史（取紧挨着该 seq 的前一页），外部评审前端 §4-1
   */
  async messages(conversationId: number, sinceSeq = 0, limit = 50, beforeSeq = 0): Promise<MessagesResponse> {
    const params = new URLSearchParams()
    if (beforeSeq > 0) params.set('before_seq', String(beforeSeq))
    else params.set('since_seq', String(sinceSeq))
    params.set('limit', String(limit))
    return request<MessagesResponse>(`/api/conversations/${conversationId}/messages?${params.toString()}`)
  },

  /** 单条消息：compact 帧只补这一条正文，不再拉一整页（外部评审前端 §4-6） */
  async messageBySeq(conversationId: number, seq: number): Promise<{ message: Message }> {
    return request<{ message: Message }>(`/api/conversations/${conversationId}/messages/${seq}`)
  },

  /**
   * 消息搜索（只搜我可见的会话）。
   * 游标用 beforeEventId（全局事件 id），不是 seq —— seq 是每个会话各自的序号，跨会话不能比。
   */
  async searchMessages(input: {
    q: string
    conversationId?: number | null
    beforeEventId?: number | null
    limit?: number
  }): Promise<SearchResponse> {
    const params = new URLSearchParams()
    params.set('q', input.q)
    if (input.conversationId) params.set('conversation_id', String(input.conversationId))
    if (input.beforeEventId) params.set('before_event_id', String(input.beforeEventId))
    if (input.limit) params.set('limit', String(input.limit))
    return request<SearchResponse>(`/api/search/messages?${params.toString()}`)
  },

  /**
   * 上传附件：原始二进制直接放 body（不是 multipart）。
   * 服务端按 Content-Type 校验真实类型，所以这里必须传真实 mime；
   * 语音可选带上 X-Duration-Ms（毫秒），服务端会用它当 durationMs。
   * 传了 onProgress 就走 XMLHttpRequest（fetch 拿不到上传进度），可配合 signal 取消。
   */
  async uploadAttachment(
    file: Blob,
    mime: string,
    options: { durationMs?: number; signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
  ): Promise<UploadAttachmentResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': mime || file.type || 'application/octet-stream',
    }
    const durationMs = options.durationMs
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
      headers['X-Duration-Ms'] = String(Math.round(durationMs))
    }
    const init: RequestInit = {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: file,
      signal: options.signal ?? null,
    }

    // 需要进度条时走 XHR：fetch 没有上传进度事件
    if (options.onProgress) {
      const { status, payload } = await uploadWithProgress(
        '/api/attachments',
        file,
        headers,
        options.onProgress,
        options.signal,
      )
      if (status < 200 || status >= 300) throw failureFrom(status, payload)
      const data = payload as UploadAttachmentResponse | null
      if (!data || !data.attachment || typeof data.attachment.url !== 'string') {
        throw new ApiError(status, 'server_error', '上传返回的数据不完整')
      }
      return data
    }

    let res: Response
    try {
      res = await fetch('/api/attachments', init)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试')
    }
    const payload = await readJson(res)
    if (!res.ok) throw failureFrom(res.status, payload)
    const data = payload as UploadAttachmentResponse | null
    if (!data || !data.attachment || typeof data.attachment.url !== 'string') {
      throw new ApiError(res.status, 'server_error', '上传返回的数据不完整')
    }
    return data
  },

  async sendMessage(
    conversationId: number,
    input: {
      /** parts 为空时用 body 发纯文本；有 parts 时以 parts 为准 */
      body?: string
      parts?: MessagePart[]
      clientMsgId: string
      replyToSeq?: number | null
      mentions?: number[]
    },
  ): Promise<SubmitResult> {
    const payload: Record<string, unknown> = {
      client_msg_id: input.clientMsgId,
    }
    if (input.parts && input.parts.length > 0) payload.parts = toWireParts(input.parts)
    else payload.body = input.body ?? ''
    if (input.replyToSeq != null) payload.reply_to_seq = input.replyToSeq
    if (input.mentions && input.mentions.length > 0) payload.mentions = input.mentions
    return request<SubmitResult>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: payload,
    })
  },

  async markRead(conversationId: number, seq: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/conversations/${conversationId}/read`, {
      method: 'POST',
      body: { seq },
    })
  },

  /**
   * 撤回自己的消息（后端 2 分钟内限制）。
   * 注意：服务端 submit 里有 recall_message 命令，但 REST 路由尚未挂载时这里会 404；
   * 按 SPEC P1-13 建议的规范路径先用 DELETE /api/conversations/:id/messages/:seq。
   */
  async recallMessage(conversationId: number, seq: number): Promise<{ ok: true; already?: boolean }> {
    return request<{ ok: true; already?: boolean }>(`/api/conversations/${conversationId}/messages/${seq}`, {
      method: 'DELETE',
    })
  },

  /** 举报（M4）：target_type 只接受 message|feed|sticker_pack|sticker_item */
  async report(input: {
    targetType: 'message' | 'feed' | 'sticker_pack' | 'sticker_item'
    targetId: number
    reason: string
    /** 消息类举报必带：seq 只在会话内唯一，没有它站务没法定位是哪条 */
    conversationId?: number | null
  }): Promise<{ ok: true }> {
    const body: Record<string, unknown> = {
      target_type: input.targetType,
      target_id: input.targetId,
      reason: input.reason,
    }
    if (input.conversationId) body.conversation_id = input.conversationId
    return request<{ ok: true }>('/api/reports', { method: 'POST', body })
  },

  // ---------- 站务（审核闭环；只有 is_admin 能调，非站务 403） ----------

  async adminReports(status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open'): Promise<AdminReport[]> {
    const res = await request<{ reports: AdminReport[] }>(`/api/admin/reports?status=${encodeURIComponent(status)}`)
    return Array.isArray(res.reports) ? res.reports : []
  },

  async handleReport(
    reportId: number,
    action: 'dismiss' | 'hide_message' | 'suspend_user',
    note = '',
  ): Promise<{ ok: true; status: string; action: string }> {
    return request<{ ok: true; status: string; action: string }>(`/api/admin/reports/${reportId}/handle`, {
      method: 'POST',
      body: { action, note },
    })
  },

  // ---------- 站务：邀请管理 ----------

  /** 站务列表：单页 limit 1..200，前端自己做分页 */
  async adminInvites(limit = 200): Promise<AdminInvite[]> {
    const res = await request<{ invites: AdminInvite[] }>(`/api/admin/invites?limit=${limit}`)
    return Array.isArray(res.invites) ? res.invites : []
  },

  /** 生成站务码：响应里的 invite.code 是明文，只返回这一次（之后只剩 codePrefix） */
  async createAdminInvites(input: {
    count?: number
    maxUses?: number
    expiresInDays?: number
    note?: string
  } = {}): Promise<CreatedAdminInvite[]> {
    const body: Record<string, unknown> = {}
    if (typeof input.count === 'number') body.count = input.count
    if (typeof input.maxUses === 'number') body.max_uses = input.maxUses
    if (typeof input.expiresInDays === 'number') body.expires_in_days = input.expiresInDays
    if (input.note) body.note = input.note
    const res = await request<{ invites: CreatedAdminInvite[] }>('/api/admin/invites', {
      method: 'POST',
      body,
    })
    return Array.isArray(res.invites) ? res.invites : []
  },

  async revokeAdminInvite(id: number): Promise<{ ok: true; id: number }> {
    return request<{ ok: true; id: number }>(`/api/admin/invites/${id}/revoke`, { method: 'POST' })
  },

  /** 群内某个 AI 的发言模式：群主/管理员，或该 AI 的主人才有权限 */
  async setReplyMode(
    conversationId: number,
    principalId: number,
    replyMode: ReplyMode,
    allowAiRelay?: boolean,
  ): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/conversations/${conversationId}/reply-mode`, {
      method: 'POST',
      body: {
        principal_id: principalId,
        reply_mode: replyMode,
        ...(allowAiRelay === undefined ? {} : { allow_ai_relay: allowAiRelay }),
      },
    })
  },

  async addMember(conversationId: number, principalId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principal_id: principalId },
    })
  },

  /** 转让群主（仅群主；只能转给群内人类成员） */
  async transferOwner(conversationId: number, principalId: number): Promise<{ ok: true; ownerId: number }> {
    return request<{ ok: true; ownerId: number }>(`/api/conversations/${conversationId}/owner`, {
      method: 'POST',
      body: { principal_id: principalId },
    })
  },

  /** 解散群（仅群主；不需要先踢人，直接软解散） */
  async dissolveConversation(conversationId: number): Promise<{ ok: true; dissolved: true }> {
    return request<{ ok: true; dissolved: true }>(`/api/conversations/${conversationId}`, { method: 'DELETE' })
  },

  /** 群主设置管理员 / 取消管理员 */
  async setMemberRole(conversationId: number, principalId: number, role: 'admin' | 'member'): Promise<{ ok: true; role: MemberRole }> {
    return request<{ ok: true; role: MemberRole }>(`/api/conversations/${conversationId}/members/${principalId}/role`, {
      method: 'POST',
      body: { role },
    })
  },

  async removeMember(conversationId: number, principalId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/conversations/${conversationId}/members/${principalId}`, {
      method: 'DELETE',
    })
  },

  // ---------- 通讯录 / Agent ----------
  async directory(q = ''): Promise<DirectoryEntry[]> {
    const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
    return request<DirectoryEntry[]>(`/api/directory${suffix}`)
  },

  // 好友与成员主页的封装见文件后半部分（避免重复定义）

  async agents(): Promise<AgentInfo[]> {
    return request<AgentInfo[]>('/api/agents')
  },

  async createAgent(input: { displayName: string }): Promise<CreateAgentResponse> {
    return request<CreateAgentResponse>('/api/agents', {
      method: 'POST',
      body: { display_name: input.displayName },
    })
  },

  /** 人类发起 1:1 私聊（好友 / 同群 / 公开可发现的 AI） */
  async openDm(principalId: number): Promise<{ ok: true; conversation_id: number; created: boolean }> {
    return request<{ ok: true; conversation_id: number; created: boolean }>('/api/conversations/dm', {
      method: 'POST',
      body: { principal_id: principalId },
    })
  },

  /** 发现群聊：公开推荐的群（行列表，不是卡片） */
  async discoverGroups(q = '', beforeId = 0, limit = 20): Promise<{
    groups: Array<{ id: number; title: string; description: string; memberCount: number; joined: boolean; joinMode: 'open' | 'approval'; lastMessageAt?: string | null }>
    hasMore: boolean
    nextBeforeId: number | null
  }> {
    const qs = new URLSearchParams({ q, before_id: String(beforeId), limit: String(limit) })
    return request<{
      groups: Array<{ id: number; title: string; description: string; memberCount: number; joined: boolean; joinMode: 'open' | 'approval'; lastMessageAt?: string | null }>
      hasMore: boolean
      nextBeforeId: number | null
    }>(`/api/groups/discover?${qs.toString()}`)
  },

  /** 加入公开群（open 直接进；approval 变申请） */
  async joinGroup(id: number): Promise<{ ok: true; joined?: boolean; pending?: boolean }> {
    return request<{ ok: true; joined?: boolean; pending?: boolean }>(`/api/conversations/${id}/join`, { method: 'POST' })
  },

  /** 群主/管理员：读取公开设置 */
  async groupPublic(id: number): Promise<{ discoverable: boolean; joinMode: 'open' | 'approval'; description: string }> {
    return request<{ discoverable: boolean; joinMode: 'open' | 'approval'; description: string }>(`/api/conversations/${id}/public`)
  },

  /** 群主/管理员：公开设置 */
  async updateGroupPublic(id: number, input: { discoverable?: boolean; joinMode?: 'open' | 'approval'; description?: string }): Promise<{ ok: true }> {
    const body: Record<string, unknown> = {}
    if (input.discoverable != null) body.discoverable = input.discoverable
    if (input.joinMode) body.join_mode = input.joinMode
    if (input.description != null) body.description = input.description
    return request<{ ok: true }>(`/api/conversations/${id}/public`, { method: 'PATCH', body })
  },

  /** 群主/管理员：待审批的入群申请 */
  async groupJoinRequests(id: number): Promise<{ requests: Array<{ principal_id: number; display_name: string; account_no: number | null; message: string; created_at: string }> }> {
    return request<{ requests: Array<{ principal_id: number; display_name: string; account_no: number | null; message: string; created_at: string }> }>(`/api/conversations/${id}/join-requests`)
  },

  /** 群主/管理员：同意/拒绝 */
  async decideJoinRequest(id: number, principalId: number, accept: boolean): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/conversations/${id}/join-requests/${principalId}`, { method: 'POST', body: { accept } })
  },

  /** 接入钥匙：列出这只 AI 的 token（不返回 token 本身，只返回 label/时间/是否有效） */
  async agentTokens(agentId: number): Promise<AgentToken[]> {
    const res = await request<{ tokens: AgentToken[] }>(`/api/agents/${agentId}/tokens`)
    return Array.isArray(res.tokens) ? res.tokens : []
  },

  /** 吊销一把钥匙（只废这一把，不影响其它窗口） */
  async revokeAgentToken(agentId: number, tokenId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/agents/${agentId}/tokens/${tokenId}`, { method: 'DELETE' })
  },

  /** 主人开关：允许 AI 主动私聊「同群但还不是好友」的人（主人/好友不受开关限制，见 CONTRACT.md §8 dm） */
  async setAgentDm(agentId: number, allow: boolean): Promise<{ ok: true; canInitiateDm: boolean }> {
    return request<{ ok: true; canInitiateDm: boolean }>(`/api/agents/${agentId}/dm`, { method: 'PATCH', body: { allow } })
  },

  /** 主人开关：允许这只 AI 进入 3D 世界（默认关；未跑迁移 031 时服务端回 503 migration_required） */
  async setAgentWorld(agentId: number, allow: boolean): Promise<{ ok: true; canEnterWorld: boolean }> {
    return request<{ ok: true; canEnterWorld: boolean }>(`/api/agents/${agentId}/world`, { method: 'PATCH', body: { allow } })
  },

  /** 本实例有没有开 3D 空间（没配 WORLD_PUBLIC_URL/WORLD_TICKET_SECRET 时 enabled=false，前端隐藏入口） */
  async worldStatus(): Promise<{ enabled: boolean; url: string | null }> {
    return request<{ enabled: boolean; url: string | null }>('/api/world/status')
  },

  /** 换一张一次性入场票据（短 TTL）：返回可直接在新标签打开的 world URL */
  async worldTicket(): Promise<{ url: string; expiresInSeconds: number }> {
    return request<{ url: string; expiresInSeconds: number }>('/api/world/ticket', { method: 'POST' })
  },
  /** 主人开关：允许 AI 自己退群（默认关） */
  async setAgentLeave(agentId: number, allow: boolean): Promise<{ ok: true; canLeaveGroup: boolean }> {
    return request<{ ok: true; canLeaveGroup: boolean }>(`/api/agents/${agentId}/leave`, { method: 'PATCH', body: { allow } })
  },

  /** 发言额度快照（带 conversationId 时含该群的桶与群级预算） */
  async agentLimits(agentId: number, conversationId?: number | null): Promise<AgentQuota> {
    const qs = conversationId ? `?conversation_id=${encodeURIComponent(String(conversationId))}` : ''
    return request<AgentQuota>(`/api/agents/${agentId}/limits${qs}`)
  },

  /** 主人调额度：日限 / 令牌桶容量 / 每分钟补充。改完立刻生效（桶会灌满到新容量） */
  async setAgentLimits(
    agentId: number,
    input: { dailyLimit?: number; bucketCapacity?: number; bucketRefillPerMin?: number },
  ): Promise<{ ok: true; quota: AgentQuota }> {
    const body: Record<string, unknown> = {}
    if (input.dailyLimit != null) body.daily_limit = input.dailyLimit
    if (input.bucketCapacity != null) body.bucket_capacity = input.bucketCapacity
    if (input.bucketRefillPerMin != null) body.bucket_refill_per_min = input.bucketRefillPerMin
    return request<{ ok: true; quota: AgentQuota }>(`/api/agents/${agentId}/limits`, { method: 'PATCH', body })
  },

  /** 群级 AI 设置读取（仅群主/管理员；普通成员 403） */
  async groupAgentSettings(conversationId: number): Promise<{ roundQuota: number; relayDepth: number; groupDailyLimit: number }> {
    const res = await request<{ ok: true; settings: { roundQuota: number; relayDepth: number; groupDailyLimit: number } }>(
      `/api/conversations/${conversationId}/agent-settings`,
    )
    return res.settings
  },

  /** 群级 AI 设置（群主/管理员）：每轮接话数 / 接力深度 / 群日预算 */
  async setGroupAgentSettings(
    conversationId: number,
    input: { roundQuota?: number; relayDepth?: number; groupDailyLimit?: number },
  ): Promise<{ ok: true; settings: { roundQuota: number; relayDepth: number; groupDailyLimit: number } }> {
    const body: Record<string, unknown> = {}
    if (input.roundQuota != null) body.round_quota = input.roundQuota
    if (input.relayDepth != null) body.relay_depth = input.relayDepth
    if (input.groupDailyLimit != null) body.group_daily_limit = input.groupDailyLimit
    return request<{ ok: true; settings: { roundQuota: number; relayDepth: number; groupDailyLimit: number } }>(
      `/api/conversations/${conversationId}/agent-settings`,
      { method: 'PATCH', body },
    )
  },

  async pauseAgent(id: number, paused: boolean): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/agents/${id}/pause`, {
      method: 'POST',
      body: { paused },
    })
  },

  async deleteAgent(id: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/agents/${id}`, { method: 'DELETE' })
  },

  async agentConfig(id: number): Promise<AgentMcpConfig> {
    return request<AgentMcpConfig>(`/api/agents/${id}/config`)
  },

  /** 给自己的 AI 设外链头像（只能自己创建的 AI；url 必须 https，服务端会再校验） */
  async setAgentAvatar(agentId: number, url: string): Promise<{ agent: AgentInfo }> {
    return request<{ agent: AgentInfo }>(`/api/agents/${agentId}/avatar`, {
      method: 'POST',
      body: { url },
    })
  },

  /** 清除 AI 的外链头像，回退到鲸鱼几何头像 */
  async clearAgentAvatar(agentId: number): Promise<{ agent: AgentInfo }> {
    return request<{ agent: AgentInfo }>(`/api/agents/${agentId}/avatar`, { method: 'DELETE' })
  },

  // ---------- 个人空间：说说 / 评论 / 点赞 ----------
  // 写接口都带 client_msg_id：每次新发用新的，重试复用同一个（服务端按它幂等）。

  /** 说说流，按 id 倒序；before_id=0 表示第一页 */
  async feeds(beforeId = 0, limit = 20): Promise<Feed[]> {
    const qs = `?before_id=${encodeURIComponent(String(beforeId))}&limit=${encodeURIComponent(String(limit))}`
    return request<Feed[]>(`/api/feeds${qs}`)
  },

  async publishFeed(input: {
    body: string
    visibility: FeedVisibility
    clientMsgId: string
  }): Promise<FeedCreateResult> {
    return request<FeedCreateResult>('/api/feeds', {
      method: 'POST',
      body: {
        body: input.body,
        visibility: input.visibility,
        client_msg_id: input.clientMsgId,
      },
    })
  },

  async feedComments(feedId: number): Promise<FeedComment[]> {
    return request<FeedComment[]>(`/api/feeds/${feedId}/comments`)
  },

  async commentFeed(feedId: number, input: { body: string; clientMsgId: string }): Promise<FeedCommentResult> {
    return request<FeedCommentResult>(`/api/feeds/${feedId}/comments`, {
      method: 'POST',
      body: { body: input.body, client_msg_id: input.clientMsgId },
    })
  },

  async likeFeed(feedId: number): Promise<FeedLikeResult> {
    return request<FeedLikeResult>(`/api/feeds/${feedId}/like`, { method: 'POST' })
  },

  async unlikeFeed(feedId: number): Promise<FeedLikeResult> {
    return request<FeedLikeResult>(`/api/feeds/${feedId}/like`, { method: 'DELETE' })
  },

  // ---------- 表情包（S1/S2） ----------
  // 可见范围由后端过滤：官方/公共 + 自己的私包 + 自己所在群的群包。

  async stickerPacks(): Promise<StickerPacksResponse> {
    return request<StickerPacksResponse>('/api/sticker-packs')
  },

  async createStickerPack(title: string): Promise<StickerPackResponse> {
    return request<StickerPackResponse>('/api/sticker-packs', {
      method: 'POST',
      body: { title },
    })
  },

  /** 只能用自己上传的 attachment（服务端校验） */
  async addStickerPackItem(
    packId: number,
    input: { attachmentId: number; caption?: string; tags?: string[]; emotion?: string | null; key?: string },
  ): Promise<StickerPackResponse> {
    const body: Record<string, unknown> = { attachment_id: input.attachmentId }
    if (input.caption != null) body.caption = input.caption
    if (input.tags && input.tags.length > 0) body.tags = input.tags
    if (input.emotion) body.emotion = input.emotion
    if (input.key) body.key = input.key
    return request<StickerPackResponse>(`/api/sticker-packs/${packId}/items`, {
      method: 'POST',
      body,
    })
  },

  async removeStickerPackItem(packId: number, itemId: number): Promise<StickerPackResponse> {
    return request<StickerPackResponse>(`/api/sticker-packs/${packId}/items/${itemId}`, {
      method: 'DELETE',
    })
  },

  /** 需要群主/管理员：把包分享到某个群（scope=group） */
  async shareStickerPack(packId: number, conversationId: number): Promise<StickerPackResponse> {
    return request<StickerPackResponse>(`/api/sticker-packs/${packId}/share`, {
      method: 'POST',
      body: { conversation_id: conversationId },
    })
  },

  async deleteStickerPack(packId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/sticker-packs/${packId}`, { method: 'DELETE' })
  },

  // ---------- 系统通知（Web Push） ----------

  /** 服务器是否开启通知 + VAPID 公钥（没配时 key 为空字符串） */
  async pushKey(): Promise<{ enabled: boolean; key: string }> {
    return request<{ enabled: boolean; key: string }>('/api/push/key')
  },

  async pushStatus(): Promise<PushStatusResponse> {
    return request<PushStatusResponse>('/api/push/status')
  },

  /** 浏览器 pushManager.subscribe 的结果原样交给后端 */
  async pushSubscribe(input: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/push/subscribe', { method: 'POST', body: input })
  },

  async pushUnsubscribe(endpoint: string): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/push/unsubscribe', { method: 'POST', body: { endpoint } })
  },

  // ---------- 好友 / 成员主页 ----------

  async friends(offset = 0, limit = 200): Promise<FriendsResponse & { has_more?: boolean }> {
    return request<FriendsResponse & { has_more?: boolean }>(`/api/friends?offset=${offset}&limit=${limit}`)
  },

  async requestFriend(accountNo: number): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/friends/request', { method: 'POST', body: { account_no: accountNo } })
  },

  async acceptFriend(principalId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/friends/accept', { method: 'POST', body: { principal_id: principalId } })
  },

  async removeFriend(principalId: number): Promise<{ ok: true }> {
    return request<{ ok: true }>('/api/friends/remove', { method: 'POST', body: { principal_id: principalId } })
  },

  async principalProfile(principalId: number): Promise<PrincipalProfile> {
    return request<PrincipalProfile>(`/api/principals/${principalId}/profile`)
  },

  /** 这只 AI 加入了哪些群、每群的发言档位（只有主人能查） */
  async agentMemberships(agentId: number): Promise<AgentMembership[]> {
    const res = await request<{ memberships: AgentMembership[] }>(`/api/agents/${agentId}/memberships`)
    return Array.isArray(res.memberships) ? res.memberships : []
  },

  // ---------- 邀请（「我的」页） ----------

  /** 我的邀请名额 + 当前有效码（只有 codePrefix）+ 已加入的人 + 最近邀请码 */
  async myInvites(): Promise<InvitesMine> {
    const res = await request<InvitesMine>('/api/invites/mine')
    // 旧版/异常情况下缺字段时给出安全空形状，避免整页崩在 .map 上
    const quota = typeof res?.quota === 'number' ? res.quota : 0
    const used = typeof res?.used === 'number' ? res.used : 0
    const remaining = typeof res?.remaining === 'number' ? res.remaining : Math.max(0, quota - used)
    return {
      quota,
      used,
      remaining,
      defaultMaxUses:
        typeof res?.defaultMaxUses === 'number' ? res.defaultMaxUses : Math.min(Math.max(0, remaining), 100),
      ttlDays: typeof res?.ttlDays === 'number' ? res.ttlDays : 30,
      active: res?.active ?? null,
      invitees: Array.isArray(res?.invitees) ? res.invitees : [],
      recent: Array.isArray(res?.recent) ? res.recent : [],
    }
  },

  /** 生成邀请码：响应里 invite.code 是明文，只返回这一次（之后只剩 codePrefix） */
  async createInvite(
    input: { maxUses?: number; expiresInDays?: number; note?: string } = {},
  ): Promise<InviteCreateResult> {
    const body: Record<string, unknown> = {}
    if (typeof input.maxUses === 'number') body.max_uses = input.maxUses
    if (typeof input.expiresInDays === 'number') body.expires_in_days = input.expiresInDays
    if (input.note) body.note = input.note
    return request<InviteCreateResult>('/api/invites', { method: 'POST', body })
  },

  async revokeInvite(id: number): Promise<InviteRevokeResult> {
    return request<InviteRevokeResult>(`/api/invites/${id}/revoke`, { method: 'POST' })
  },
}

/** submit() 失败原因 → 中文 */
export function submitReasonText(reason?: string): string {
  switch (reason) {
    case 'invalid_schema':
      return '消息内容不合法（1–4000 字）'
    case 'forbidden':
      return '你没有在该会话发言的权限'
    case 'rate_limited':
      return '发送太频繁，请稍后再试'
    case 'not_found':
      return '会话不存在或你已被移出'
    case 'gone':
      return '会话已失效'
    case 'gating_system_notice':
      return '这是一条系统提示，不需要回复'
    default:
      return '发送失败，请重试'
  }
}

/** 说说 / 评论 / 点赞的失败原因 → 中文兜底（服务端 400 通常已带中文 message，这里只兜没带的） */
export function feedReasonText(reason?: string): string {
  switch (reason) {
    case 'invalid_schema':
      return '内容不合法（说说 1–4000 字，评论 1–2000 字）'
    case 'forbidden':
      return '你没有权限做这个操作'
    case 'rate_limited':
      return '操作太频繁，请稍后再试'
    case 'not_found':
      return '这条说说不存在或已被删除'
    case 'internal':
      return '服务器开小差了，请稍后再试'
    default:
      return '操作失败，请重试'
  }
}
