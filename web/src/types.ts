// 与 CONTRACT.md §6 / §7 对齐的前端类型定义。
// 约定：后端字段为 camelCase；时间均为 ISO 字符串。

export type PrincipalType = 'user' | 'agent'
export type MemberRole = 'owner' | 'admin' | 'member'
export type ReplyMode = 'off' | 'low' | 'mid' | 'high' | 'mention' | 'free'
export type AgentStatus = 'active' | 'paused' | 'revoked'

export interface Me {
  id: number
  displayName: string
  email: string
  avatarHue: number
  /** 图片头像：本站附件为签名相对地址 /media/:id?...，外链为 https；空 = 回退几何头像（契约 §1） */
  avatarUrl?: string | null
  /** 8 位账号号（QQ 式）；后端旧版本可能没有 */
  accountNo?: number | null
  /** 是否允许别人通过号码找到我；后端旧版本可能不返回 */
  discoverable?: boolean
  /** 站务：只有 true 才显示「审核」入口（服务端每个管理接口仍会校验） */
  isAdmin?: boolean
  /** 邮箱是否已验证（后端旧版本/未启用邮箱验证时为 false 或缺省） */
  emailVerified?: boolean
  /** 邮箱验证能力：enabled=false 表示这个实例没配 SMTP，前端不要显示入口 */
  emailVerification?: { enabled: boolean; mode: 'off' | 'optional' | 'required' }
}

export interface Member {
  id: number
  type: PrincipalType
  displayName: string
  role: MemberRole
  replyMode: ReplyMode
  allowAiRelay?: boolean
  lastReadSeq: number
  avatarHue?: number
  /** 图片头像（本站签名地址或 https 外链）；空 = 回退几何头像 */
  avatarUrl?: string | null
  online?: boolean
  // 契约 §6 未定义「上次同步」字段；这里对可能的命名做容错，缺失时 UI 显示「未知」
  lastSyncedAt?: string | null
  lastSyncAt?: string | null
  lastSeenAt?: string | null
  // GET /api/conversations 的成员上已返回：AI 主人昵称、AI 当前状态
  ownerName?: string | null
  agentStatus?: AgentStatus | string | null
}

export interface Conversation {
  id: number
  type: 'c2c' | 'group'
  title: string | null
  lastSeq: number
  unread: number
  role: MemberRole
  /** 小群（≤50）是全量；大群（>50）只含前 20 个 AI，需要再调 /members */
  members: Member[]
  /** 大群时为 false：members 不完整，成员面板要懒加载 */
  membersComplete?: boolean
  /** 后端给的成员总数 / AI 数（大群时前端数不出来） */
  memberCount?: number
  agentCount?: number
  lastMessagePreview?: string | null
  lastMessageAt?: string | null
  /** 群公告（纯文本，≤2000）；后端旧版本可能不返回，c2c 会话恒为空字符串 */
  announcement?: string
  /** 公告最后更新时间；空公告时为 null */
  announcementUpdatedAt?: string | null
}

/** GET /api/signup：站点当前的注册模式 */
export interface SignupState {
  mode: 'invite' | 'waitlist' | 'open'
  inviteRequired: boolean
  waitlistOpen: boolean
}

/** GET /api/admin/waitlist 的条目（邮箱只给掩码，明文仅在发码响应里出现一次） */
export interface WaitlistItem {
  id: number
  emailMasked: string
  note: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt: string | null
  codePrefix: string | null
  maxUses: number | null
  usedCount: number | null
}

/** GET /api/conversations/:id/members */
export interface MembersResponse {
  members: Member[]
  total: number
}


/* ---------------- 消息段（parts）：一条消息 = 有序若干段 ---------------- */

export interface TextPart {
  type: 'text'
  text: string
}

/**
 * 图片段。读路径后端可能给 snake_case 的 attachment_id，也可能给 camelCase；
 * 统一由 normalizeParts() 归一成 attachmentId。
 * 纯外链图片（Agent 发 https 直链）没有本地附件，attachmentId 为 0，只靠 url 渲染。
 */
export interface ImagePart {
  type: 'image'
  attachmentId: number
  mime?: string
  bytes?: number
  width?: number | null
  height?: number | null
  /** 图片描述（契约 §2.2 允许 alt，外链图片常用）；缺省时按「图片」处理 */
  alt?: string | null
  /** 站内相对地址（短期签名）或外链 https 直链；直接当 <img src>，不要自己拼 */
  url?: string | null
  /**
   * 服务端派生的缩略图地址（480px WebP，形如 `/media/:id?v=thumb&e=…&s=…`），气泡优先用它。
   * 三个约束：① 签名按「变体」参与 HMAC，**不能**自己给 url 加 `v=thumb`（会 403）；
   * ② 只有服务端生成了缩略图、且 hydration 把字段带下来时才有，缺省一律回退 url（旧消息/GIF/外链）；
   * ③ 只用于列表展示，点开大图/灯箱必须仍用 url（原图）。
   */
  thumbUrl?: string | null
  /**
   * 扫描中（外部审查 Q6）：内容已入库但还没审完。
   * 只有上传者本人这时能拿到 url；其他人拿到的是 pending=true、没有 url 的占位。
   * 注意 pending ≠ 失败：不要显示"图片不可用"，也不要让用户重试发送。
   */
  pending?: boolean
  /** 判定违规：永久不可见（没有 url），显示占位即可，不要重试 */
  blocked?: boolean
}

export interface StickerPart {
  type: 'sticker'
  pack: string
  key: string
  caption?: string | null
}

/* ---------------- 表情包（S1/S2）：/api/sticker-packs ---------------- */

export type StickerPackScope = 'official' | 'private' | 'group' | 'public'

export interface StickerPackItem {
  id: number
  key: string
  caption: string
  tags: string[]
  emotion?: string | null
  url: string
}

export interface StickerPack {
  id: number
  slug: string
  title: string
  scope: StickerPackScope
  license?: string | null
  itemCount: number
  /** 是不是我自己的包（决定能不能加/删/分享） */
  mine: boolean
  items: StickerPackItem[]
}

export interface StickerPacksResponse {
  packs: StickerPack[]
}

export interface StickerPackResponse {
  pack: StickerPack
}

/** 最近使用的一条（只存引用，url/caption 用当前包数据解析） */
export interface StickerRecent {
  pack: string
  key: string
}


/** 语音段：durationMs 由录制时算（Date.now 差值）或服务端探测，播放条宽度按它算 */
export interface VoicePart {
  type: 'voice'
  /** 纯外链语音为 0（只有 url） */
  attachmentId: number
  mime?: string
  bytes?: number
  durationMs?: number | null
  /** 短期签名地址（站内相对路径）或外链 https 地址；直接当 <audio src>，不要自己拼 */
  url?: string | null
  /** 扫描中（仅上传者可见，见 ImagePart.pending 的说明） */
  pending?: boolean
  /** 判定违规：永久不可见 */
  blocked?: boolean
}

/** 视频段：posterUrl 是客户端抽帧后单独上传的封面（服务端不做转码） */
export interface VideoPart {
  type: 'video'
  /** 纯外链视频为 0（只有 url） */
  attachmentId: number
  posterAttachmentId?: number
  mime?: string
  bytes?: number
  width?: number
  height?: number
  durationMs?: number | null
  /** 站内相对地址或外链 https 直链；直接当 <video src> */
  url?: string | null
  posterUrl?: string | null
  /** 扫描中（仅上传者可见）；封面上传同样受扫描态约束，pending 时不会有 posterUrl */
  pending?: boolean
  /** 判定违规：永久不可见 */
  blocked?: boolean
}

/** 文件包清单里的一项：只有名字与大小，客户端不联网校验 */
export interface FileEntry {
  name: string
  bytes?: number
}

/**
 * 文件包段（外链）：二进制不进本站，只存 https 直链 + 元数据。
 * files 是包内清单（≤50 条），只用于展示，不下载、不解压。
 */
export interface FilePart {
  type: 'file'
  url: string
  name: string
  bytes?: number
  mime?: string
  files?: FileEntry[]
}

/**
 * 在线预览段（外链 HTML）：在沙箱 iframe 里渲染。
 * url 与 srcdoc 二选一，同时存在时 url 优先（与契约 §2.1 一致）。
 */
export interface HtmlPart {
  type: 'html'
  url?: string | null
  srcdoc?: string | null
  title?: string | null
  /** 期望高度（px）；渲染时夹在 160..640 */
  height?: number | null
}

/** 前端归一化的「不认识的段」：不白屏，渲染成灰色占位 */
export interface UnsupportedPart {
  type: 'unsupported'
  rawType?: string
}

export type MessagePart =
  | TextPart
  | ImagePart
  | StickerPart
  | VoicePart
  | VideoPart
  | FilePart
  | HtmlPart
  | UnsupportedPart

/** 上传接口返回的附件元数据 */
export interface Attachment {
  id: number
  kind: 'image' | 'voice' | 'video' | 'file' | 'sticker' | string
  mime: string
  bytes: number
  width?: number | null
  height?: number | null
  durationMs?: number | null
  url: string
  /** 图片且缩略图派生成功时才有（见 ImagePart.thumbUrl 的三条约束）；有就带给 message part */
  thumbUrl?: string
}

export interface UploadAttachmentResponse {
  attachment: Attachment
  reused?: boolean
}

/** 消息读模型：REST §6 与 WS §7 的并集，本地额外挂乐观态字段。 */
export interface Message {
  seq: number
  eventId: number
  senderId: number
  senderType: PrincipalType
  /** 'text' | 'system'：system 是事件反馈（如表情包分享），居中灰字，不带头像/气泡 */
  kind?: 'text' | 'system' | string
  senderName: string
  avatarHue?: number
  /** 发送者的图片头像（本站签名地址或 https 外链）；空 = 回退几何头像 */
  avatarUrl?: string | null
  body: string
  /** 富内容段；老消息没有这个字段时回退 body 文本 */
  parts?: unknown
  replyToSeq: number | null
  replyPreview?: string | null
  mentions: number[]
  createdAt: string
  recalledAt?: string | null
}

export interface DirectoryEntry {
  id: number
  type: PrincipalType
  displayName: string
  username: string
  ownedByMe: boolean
  avatarHue?: number
  avatarUrl?: string | null
  /** 8 位账号号：纯数字搜索时后端会带；旧版本可能没有 */
  accountNo?: number | null
}

export interface AgentInfo {
  id: number
  displayName: string
  status: AgentStatus
  avatarHue?: number
  /** 外链图片头像（https）；空 = 回退鲸鱼几何头像 */
  avatarUrl?: string | null
  createdAt: string
  tokenLabel?: string | null
  /** 8 位账号号（/api/agents 旧版本可能不返回，前端会用创建时的返回值兜底） */
  accountNo?: number | null
  // 契约未定义，容错读取
  lastSyncedAt?: string | null
  /** 发言额度（门控改造后：主人可调） */
  dailyLimit?: number
  bucketCapacity?: number
  bucketRefillPerMin?: number
  /** 暂停原因：circuit_breaker = 熔断自动暂停，manual = 主人手动 */
  pausedReason?: string | null
  pausedAt?: string | null
  limitsChangedAt?: string | null
  /** 主人开关：允许这只 AI 主动私聊「同群但还不是好友」的人（主人/好友不受开关限制） */
  canInitiateDm?: boolean
  /** 主人开关：允许这只 AI 自己退群（默认关；关着时 MCP leave_group 回 leave_not_allowed） */
  canLeaveGroup?: boolean
  /** 主人开关：允许这只 AI 进入 3D 世界（迁移 031；老库没有该列时为 false/缺省） */
  canEnterWorld?: boolean
}

export interface AgentMcpConfig {
  mcp: {
    url: string
    headers: Record<string, string>
  }
  snippets: {
    claudeCode: string
    cursor: string
    codex: string
  }
}

export interface MessagesResponse {
  messages: Message[]
  lastSeq: number
}

/** GET /api/search/messages 的一条命中（后端只给命中片段，不是整段正文） */
export interface SearchHit {
  conversationId: number
  conversationTitle: string
  seq: number
  eventId: number
  senderId: number
  senderType: PrincipalType
  senderName: string
  avatarHue?: number
  avatarUrl?: string | null
  kind: 'text' | 'system' | string
  /** 命中附近的片段（首尾可能带 …），前端只负责高亮 */
  body: string
  createdAt: string
}

export interface SearchResponse {
  query: string
  results: SearchHit[]
  hasMore: boolean
  /** 下一页游标（全局事件 id，不是会话内 seq）；null = 没有下一页 */
  nextBeforeEventId: number | null
}

/** GET /api/push/status：我这台/所有设备的系统通知订阅 */
export interface PushSubscriptionInfo {
  id: number
  /** 推送服务主机名（不回完整 endpoint：里面有设备令牌） */
  host: string
  createdAt: string
  lastSeenAt: string
  lastPushAt: string | null
  /** 上次推送失败原因（成功时为 null） */
  lastError: string | null
  attempts: number
}

export interface PushStatusResponse {
  enabled: boolean
  subscriptions: PushSubscriptionInfo[]
}

/** submit() 返回值（REST 原样透传） */
export interface SubmitResult {
  accepted: boolean
  event_id?: number
  seq?: number
  deduplicated?: boolean
  conversation_id?: number
  reason?: 'invalid_schema' | 'forbidden' | 'rate_limited' | 'not_found' | 'gone' | string
  message?: string
}

export interface CreateAgentResponse {
  agent: { id: number; displayName: string; accountNo?: number | null }
  token: string
  /** 号码 + 登录密码：只返回这一次，给只能填账号密码的 MCP 客户端用 */
  login?: { accountNo?: number | null; password: string } | null
}

/** GET /api/agents/:id/memberships：这只 AI 加入了哪些群、每群的档位 */
export interface AgentMembership {
  conversationId: number
  /** 群级 AI 设置（群主可调；这里带出来只读展示 + 编辑用） */
  roundQuota?: number
  relayMaxDepth?: number
  groupDailyLimit?: number
  title: string | null
  replyMode: ReplyMode
  allowAiRelay: boolean
  memberCount: number
}

// ---------- 个人空间（说说 / 评论 / 点赞） ----------

export type FeedVisibility = 'friends' | 'private'

/** 说说读模型：GET /api/feeds（按 id 倒序） */
export interface Feed {
  id: number
  authorId: number
  authorType: PrincipalType
  authorName: string
  avatarHue?: number
  avatarUrl?: string | null
  body: string
  visibility: FeedVisibility
  likeCount: number
  commentCount: number
  likedByMe: boolean
  createdAt: string
}

/** 说说下的评论：GET /api/feeds/:id/comments */
export interface FeedComment {
  id: number
  authorId: number
  authorType: PrincipalType
  authorName: string
  avatarHue?: number
  avatarUrl?: string | null
  body: string
  createdAt: string
}

/** POST /api/feeds 的返回：成功 {accepted:true,event_id,feed_id}，失败 {accepted:false,reason,message} */
export interface FeedCreateResult {
  accepted: boolean
  event_id?: number
  feed_id?: number
  deduplicated?: boolean
  reason?: string
  message?: string
}

/** POST /api/feeds/:id/comments 的返回 */
export interface FeedCommentResult {
  accepted: boolean
  event_id?: number
  comment_id?: number
  deduplicated?: boolean
  reason?: string
  message?: string
}

/** POST / DELETE /api/feeds/:id/like 的返回 */
export interface FeedLikeResult {
  accepted: boolean
  feed_id?: number
  liked?: boolean
  deduplicated?: boolean
  reason?: string
  message?: string
}

export interface CreateConversationResponse {
  conversation: Conversation
}

// ---------- WebSocket 帧 ----------

export interface WsHello {
  t: 'hello'
  me: { id: number; displayName: string }
}

export interface WsEvent {
  t: 'event'
  conversationId: number
  seq: number
  eventId: number
  senderId: number
  senderType: PrincipalType
  senderName: string
  body: string
  /** 'text' | 'system' */
  kind?: 'text' | 'system' | string
  /** 服务端把大帧降级成"指针帧"（不带 parts），客户端按 seq 回补正文 */
  compact?: boolean
  avatarHue?: number
  /** 发送者的图片头像（本站签名地址或 https 外链）；空 = 回退几何头像 */
  avatarUrl?: string | null
  /** 富内容段；后端未升级时缺省 */
  parts?: unknown
  /** 撤回事件：服务端 publishMessage 里带 recalled:true */
  recalled?: boolean
  recalledAt?: string | null
  replyToSeq: number | null
  mentions: number[]
  createdAt: string
}

export interface WsRead {
  t: 'read'
  conversationId: number
  principalId: number
  seq: number
}

export interface WsPong {
  t: 'pong'
}

/** 在线状态变化：只发给和它有共同会话的人，只含「在线/离线」 */
export interface WsPresence {
  t: 'presence'
  principalId: number
  online: boolean
}

/** 正在输入：服务端限频（10 秒 5 次）后转发给同会话其他人 */
export interface WsTyping {
  t: 'typing'
  conversationId: number
  principalId: number
  name: string
}

/** 群公告变更：只发给在线的会话成员。它不是消息（没有 seq / 未读），别塞进 event 帧 */
export interface WsAnnouncement {
  t: 'announcement'
  conversationId: number
  announcement: string
  updatedAt: string | null
}

/**
 * 服务端因为背压（这个连接读得太慢）丢掉了帧，要求客户端补拉。
 *
 * 为什么需要这一帧：以前背压是**静默丢**——连接还在、客户端不知道少了东西；
 * 如果丢的正好是最后一条消息，后面没有更大的 seq 来暴露缺口，界面会一直缺这条。
 * lastSeq = 被丢那帧的 seq（客户端从自己的 lastSeq 补拉即可，服务端不假设客户端进度）；
 * lastSeq = 0 表示「这个会话的元数据（公告等）要重拉」，不是消息空洞。
 */
export interface WsResyncRequired {
  t: 'resync_required'
  conversationId: number
  lastSeq: number
}

export type WsServerFrame =
  | WsHello
  | WsEvent
  | WsRead
  | WsPong
  | WsPresence
  | WsTyping
  | WsAnnouncement
  | WsResyncRequired

export type WsStatus = 'connecting' | 'online' | 'reconnecting' | 'offline'

/** 本地消息：seq 为 null 表示「还没有服务端 seq 的乐观消息」 */
export interface LocalMessage extends Omit<Message, 'seq'> {
  seq: number | null
  clientMsgId?: string
  optimistic?: boolean
  failed?: boolean
}

// ---------- 好友 / 成员主页 ----------

export interface Friend {
  id: number
  type: PrincipalType
  displayName: string
  accountNo?: number | null
  avatarHue?: number
  /** 图片头像（本站签名地址或 https 外链）；空 = 回退几何头像 */
  avatarUrl?: string | null
  ownerName?: string | null
  since?: string | null
}

export interface FriendRequest {
  id: number
  displayName: string
  accountNo?: number | null
  avatarUrl?: string | null
  requestedAt?: string | null
}

export interface FriendsResponse {
  friends: Friend[]
  requests: FriendRequest[]
}

export type FriendStatus = 'none' | 'pending' | 'incoming' | 'friend' | 'self' | string

export interface ProfileConversation {
  id: number
  title: string | null
  lastAt: string | null
}

export interface ProfileMessage {
  conversationId: number
  title: string | null
  seq: number
  body: string
  createdAt: string
}

export interface PrincipalProfile {
  id: number
  type: PrincipalType
  displayName: string
  accountNo?: number | null
  avatarHue?: number
  /** 图片头像（本站签名地址或 https 外链）；空 = 回退几何头像 */
  avatarUrl?: string | null
  isAgent?: boolean
  ownedByMe?: boolean
  ownerName?: string | null
  friendStatus?: FriendStatus
  conversations: ProfileConversation[]
  recentMessages: ProfileMessage[]
}

/** 全局提示（toast）：所有视图共用的回调类型 */
export type Notify = (text: string, kind?: 'info' | 'success' | 'error') => void

// ---------- 站务（审核闭环） ----------

export interface AdminReport {
  id: number
  targetType: string
  targetId: number
  conversationId: number | null
  conversationTitle: string | null
  /** 被举报消息的正文片段（旧数据可能为 null） */
  messagePreview: string | null
  messageSender: string | null
  reason: string
  status: 'open' | 'resolved' | 'dismissed' | string
  action: string | null
  actionNote: string | null
  handledBy: number | null
  handlerName: string | null
  handledAt: string | null
  reporterName: string
  createdAt: string
}

/** 发言额度快照（GET /api/agents/:id/limits 与 MCP my_limits 同源） */
export interface AgentQuota {
  agent_id: number
  paused: boolean
  paused_reason: string | null
  paused_at: string | null
  daily_limit: number
  used_today: number
  remaining_today: number
  bucket_capacity: number
  bucket_refill_per_min: number
  limits_changed_at: string | null
  retry_after_ms: number
  conversation?: {
    id: number
    group_daily_limit: number
    group_used_today: number
    group_remaining_today: number | null
    per_message_max_replies: number
    relay_max_depth: number
    tokens: number
  }
}

/** 接入钥匙（GET /api/agents/:id/tokens）：不含 token 本身 */
export interface AgentToken {
  id: number
  label: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  active: boolean
}

// ---------- 邀请（「我的」页邀请朋友） ----------

/**
 * 邀请码。服务端只存明文哈希，所以这里永远只有 codePrefix（4 位）：
 * 明文只在 POST /api/invites 的响应里出现一次，之后任何接口都查不到。
 */
export interface InviteCode {
  id: number
  /** 4 位前缀；前端掩码渲染成 AIO-7K2M-****-**** */
  codePrefix: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  note: string
}

/** POST /api/invites 返回的 invite：明文 code 只在这个响应里出现一次 */
export interface CreatedInvite extends InviteCode {
  code: string
}

/** 通过我的邀请加入的人 */
export interface Invitee {
  displayName: string
  accountNo: number | null
  joinedAt: string
}

/** GET /api/invites/mine：名额是扁平数字，不是嵌套对象 */
export interface InvitesMine {
  quota: number
  used: number
  remaining: number
  /** 创建表单的默认人数 = min(remaining, 100)；remaining=0 时是 0 */
  defaultMaxUses: number
  /** 默认有效期（天），给表单展示用 */
  ttlDays: number
  /** 当前有效的邀请码；null = 没有（可以新建） */
  active: InviteCode | null
  invitees: Invitee[]
  /** 最近 10 张（含已吊销/已过期） */
  recent: InviteCode[]
}

/** POST /api/invites */
export interface InviteCreateResult {
  invite: CreatedInvite
  /** 被自动吊销的旧有效码 id（再创建会先吊销旧码未用部分） */
  revokedPrevious: number[]
  quota: number
  used: number
  remaining: number
}

/** POST /api/invites/:id/revoke */
export interface InviteRevokeResult {
  ok: true
  id: number
}

// ---------- 站务：邀请管理（GET/POST /api/admin/invites） ----------

/** 邀请码的创建人；null = 站务码（owner_user_id 为空，不占任何人的名额） */
export interface AdminInviteOwner {
  id: number
  displayName: string
  accountNo: number | null
}

/** 站务列表里的一张邀请码。服务端只存哈希，所以永远只有 codePrefix。 */
export interface AdminInvite {
  id: number
  codePrefix: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
  note: string
  owner: AdminInviteOwner | null
  /** 已兑换人数（invite_redemptions 行数） */
  redemptions: number
}

/** POST /api/admin/invites 返回的 invite：多一个明文 code，只此一次 */
export interface CreatedAdminInvite extends AdminInvite {
  code: string
}
