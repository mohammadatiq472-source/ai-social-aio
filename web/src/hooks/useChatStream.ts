// 会话流：会话列表 + 消息缓存 + WebSocket 增量 + 断线补齐。
// 从 ChatView 抽出来的目的：组件只负责布局和交互，数据规则集中在这里。
//
// 维护要点（改之前先看）：
// - 所有"按会话"的缓存都在 ref 里（messagesRef/lastSeqRef），state 只是镜像，避免闭包读到旧值
// - 断档（seq > known+1）时：当前会话直接 backfill；非当前会话丢弃缓存，等下次打开整段拉
// - 大帧降级（event.compact）时：只更新预览，正文按 seq 防抖 120ms 回补
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type {
  Conversation,
  LocalMessage,
  Me,
  Notify,
  WsEvent,
  WsResyncRequired,
  WsServerFrame,
  WsStatus,
  WsTyping,
} from '../types'
import { normalizeParts, previewOf, signatureOf } from '../parts'
import { ChatSocket } from '../ws'
import { play } from '../sound'
import {
  fromRest,
  maxSeqOf,
  mergeMessages,
  normalizeConversation,
  normalizeMember,
  sortConversations,
  sortMessages,
  toLocal,
} from '../lib/chat'

interface UseChatStreamOptions {
  me: Me
  /** 当前打开的会话（只用于判断"是不是正在看的那个会话"） */
  activeId: number | null
  notify: Notify
}

/**
 * 单个会话在内存/DOM 里保留的最大消息数（窗口上限）。
 *
 * 为什么必须有上限：屏外消息虽然挂了 `content-visibility:auto`，每行仍是真实 DOM 节点 +
 * React 元素；一个长时间开着的活跃群只靠 WS 追加是**无界增长**的（2000 条之后每次
 * 重渲染都能感觉到卡）。500 条 ≈ 常态 20 屏历史，日常回看够用；更早的历史用搜索
 * （`loadAroundSeq` 会把目标窗口钉住，见 PIN_TTL_MS）。
 *
 * 裁剪只从**头部**（最老）丢，尾部（最新）永远保留 —— 贴底、「N 条新消息」、发送归位
 * 全都依赖尾部，所以这些行为不变。`loadOlder` 到上限就停（见该函数里的守卫），
 * 避免「拉回来的老消息立刻被裁掉 → 无限重复请求」。
 */
const MESSAGE_WINDOW = 500
/** 搜索跳转命中后，目标 seq 在窗口裁剪里的保护期（跳转/高亮在 1s 内完成） */
const JUMP_PIN_TTL_MS = 10_000
/** 已读回执合并窗口：连续收消息时只上报一次最大 seq（服务端每收一次会向全群广播） */
const READ_COALESCE_MS = 500

/* ============================================================================
 * 启动预取：把「等 /api/me 回来才去拉会话列表」这段串行去掉
 *
 * 为什么能做：会话列表只依赖 cookie，不依赖 me 的返回值。App.bootstrap 里
 * 与 api.me() 同 tick 发出，ChatView 挂载后由 loadConversations 消费同一个 promise，
 * 不会再发第二次（takeStartupPrefetch 只能取一次）。
 *
 * 两个「不白跑」的闸：
 * - 只有本地留过 `qqmini.authed`（上次在这里登录成功过）才预取会话列表 ——
 *   否则未登录用户一进登录页就必然吃一个 401，纯浪费；
 * - 只有 `qqmini.lastConversation` 里有上次打开的会话 id 才预取那一窗消息。
 *
 * 失败隔离：两个 promise 都自带 catch（消费方照常走自己的错误分支：会话列表 → 错误块+重试，
 * 消息预取 → 直接丢弃，用户点进去时 loadMessages 重拉）。没人消费时也不会出现 unhandled rejection。
 * ========================================================================== */

const LAST_CONVERSATION_KEY = 'qqmini.lastConversation'
const SESSION_HINT_KEY = 'qqmini.authed'
/** 预取窗口与 loadMessages 的尾部一窗保持一致，命中后打开会话无需再请求 */
const PREFETCH_WINDOW = 200

export interface StartupPrefetch {
  conversations: Promise<Conversation[]>
  /** 上次会话的消息窗口；没有提示 / 预取失败时是 null */
  messages: Promise<{ conversationId: number; list: LocalMessage[] } | null>
}

let startupPrefetch: StartupPrefetch | null = null
let startupPrefetchTaken = false

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式 / 存储被禁用：当没有提示处理，功能退化成串行，不影响可用性
    return null
  }
}

function readLastConversation(): { id: number; lastSeq: number } | null {
  const local = store()
  if (!local) return null
  try {
    const raw = local.getItem(LAST_CONVERSATION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { id?: unknown; lastSeq?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return null
    const id = Number(parsed.id)
    if (!Number.isInteger(id) || id <= 0) return null
    return { id, lastSeq: Number(parsed.lastSeq) || 0 }
  } catch {
    return null
  }
}

/** 记录「上次打开的会话 + 当时读到的 lastSeq」，供下次启动并行预取 */
export function rememberLastConversation(convId: number, lastSeq: number): void {
  const local = store()
  if (!local || !Number.isInteger(convId) || convId <= 0) return
  try {
    local.setItem(
      LAST_CONVERSATION_KEY,
      JSON.stringify({ id: convId, lastSeq: Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0, at: Date.now() }),
    )
  } catch {
    /* 配额满/隐私模式：只是少了下次的预取 */
  }
}

/** 登录成功：留一个「这台浏览器有会话」的标记，下次启动才敢并行预取 */
export function markAuthedSession(): void {
  const local = store()
  if (!local) return
  try {
    local.setItem(SESSION_HINT_KEY, '1')
  } catch {
    /* 忽略 */
  }
}

/** 退出登录 / 401：标记与「上次会话」一起清掉，别把别人的会话 id 带去下一次登录 */
export function clearAuthedSession(): void {
  const local = store()
  if (local) {
    try {
      local.removeItem(SESSION_HINT_KEY)
      local.removeItem(LAST_CONVERSATION_KEY)
    } catch {
      /* 忽略 */
    }
  }
  resetStartupPrefetch()
}

function prefetchMessages(hint: { id: number; lastSeq: number }): Promise<{ conversationId: number; list: LocalMessage[] } | null> {
  const since = hint.lastSeq > PREFETCH_WINDOW ? hint.lastSeq - PREFETCH_WINDOW : 0
  return api
    .messages(hint.id, since, PREFETCH_WINDOW)
    .then((res) => ({ conversationId: hint.id, list: (res.messages ?? []).map(fromRest) }))
    .catch(() => null)
}

/**
 * 在 App.bootstrap 里调一次（与 api.me() 同一个 tick）。重复调用无副作用。
 */
export function startStartupPrefetch(): void {
  if (startupPrefetch || startupPrefetchTaken) return
  const local = store()
  if (!local) return
  let authed = false
  try {
    authed = local.getItem(SESSION_HINT_KEY) === '1'
  } catch {
    authed = false
  }
  if (!authed) return

  const conversations = api.conversations(0, 50)
  // 消费方会自己处理失败；这里先挂一个空 catch，避免「me 401 → ChatView 不挂载 → unhandled rejection」
  conversations.catch(() => {})
  const hint = readLastConversation()
  const messages = hint ? prefetchMessages(hint) : Promise.resolve(null)
  startupPrefetch = { conversations, messages }
}

/**
 * 取走预取（只能取一次）。loadConversations 消费它，避免「App 发一次 + ChatView 再发一次」。
 * 只有真的取到东西才记「已消费」：首访（没有登录标记）没有预取，这时不该挡住之后的 retry 预取。
 */
export function takeStartupPrefetch(): StartupPrefetch | null {
  const taken = startupPrefetch
  startupPrefetch = null
  if (taken) startupPrefetchTaken = true
  return taken
}

/** 退出登录时重置模块态，下次登录还能重新预取 */
export function resetStartupPrefetch(): void {
  startupPrefetch = null
  startupPrefetchTaken = false
}

export function useChatStream({ me, activeId, notify }: UseChatStreamOptions) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  // 会话列表「加载失败」和「真的没有群」必须分开：失败时侧栏原来显示「还没有会话」，
  // 用户会以为自己没有群（2026-11-14 前端审查 P1-2）。有值就渲染错误块 + 重试。
  const [conversationsError, setConversationsError] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<number, LocalMessage[]>>({})
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [membersLoading, setMembersLoading] = useState<Record<number, boolean>>({})
  // 正在输入：conversationId -> [{ id, name, at }]（4 秒没新帧就自动消失）
  const [typing, setTyping] = useState<Record<number, { id: number; name: string }[]>>({})

  const socketRef = useRef<ChatSocket | null>(null)
  const activeIdRef = useRef<number | null>(activeId)
  const messagesRef = useRef<Record<number, LocalMessage[]>>({})
  const lastSeqRef = useRef<Record<number, number>>({})
  const backfillingRef = useRef<Record<number, boolean>>({})
  // 紧凑帧（大消息被降级成指针）后按会话防抖回补正文
  const compactTimerRef = useRef<Record<number, number>>({})
  const readSentRef = useRef<Record<number, number>>({})
  /** convId -> 还没上报的最大 seq（500ms trailing 合并成一个 POST） */
  const readPendingRef = useRef<Record<number, number>>({})
  const readTimerRef = useRef<Record<number, number>>({})
  /** 搜索跳转命中的 seq：窗口裁剪时保护它（否则「跳过去」的目标会被裁掉） */
  const pinSeqRef = useRef<Record<number, { seq: number; at: number }>>({})
  // 首次连上不重复拉；重连成功后才按 since_seq 补齐
  const connectedOnceRef = useRef(false)
  const conversationsRef = useRef<Conversation[]>([])
  const membersInflightRef = useRef<Record<number, boolean>>({})

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  /* ---------------- 消息缓存读写 ---------------- */

  /**
   * 窗口裁剪：超限只从头部丢，尾部（最新）永远保留。
   * 例外：搜索跳转命中的目标 seq 在保护期内不裁 —— 否则「跳到这条消息」会先合并再被裁掉，
   * 界面上看着成功却滚不过去。保护期只有 10s，跳转/高亮早就完成了。
   */
  const trimWindow = useCallback((convId: number, list: LocalMessage[]): LocalMessage[] => {
    if (list.length <= MESSAGE_WINDOW) return list
    const pin = pinSeqRef.current[convId]
    if (pin != null && Date.now() - pin.at < JUMP_PIN_TTL_MS && list.some((item) => item.seq === pin.seq)) {
      // 保护期里允许临时超限，但最多多留 100 条：高流量会话不能因为一次跳转就把上限变成无界
      if (list.length <= MESSAGE_WINDOW + 100) return list
    }
    return list.slice(list.length - MESSAGE_WINDOW)
  }, [])

  const writeMessages = useCallback(
    (convId: number, updater: (list: LocalMessage[]) => LocalMessage[]) => {
      const next = updater(messagesRef.current[convId] ?? [])
      messagesRef.current = { ...messagesRef.current, [convId]: trimWindow(convId, next) }
      setMessages(messagesRef.current)
    },
    [trimWindow],
  )

  /** 新建/切到某个会话时先把本地缓存占位，避免被当成"未加载" */
  const seedConversation = useCallback((conv: Conversation) => {
    messagesRef.current = { ...messagesRef.current, [conv.id]: [] }
    lastSeqRef.current[conv.id] = conv.lastSeq ?? 0
    setMessages(messagesRef.current)
  }, [])

  /**
   * 真正把「已读到 seq」发给服务端（POST /api/conversations/:id/read）。
   * 服务端收到后会向全群广播 read 帧，所以逐条上报等于「每收一条消息就广播一次」：
   * 5 个人同时说话就是 5 倍上行 + 5×N 倍下行。这里只由 flushRead 调用，5 次/秒级合并成 1 次。
   */
  const sendRead = useCallback((convId: number, seq: number) => {
    if (!Number.isFinite(seq) || seq <= 0) return
    if ((readSentRef.current[convId] ?? 0) >= seq) return
    readSentRef.current[convId] = seq
    api.markRead(convId, seq).catch(() => {
      // 已读失败不打扰用户；把游标退回，下次 flush（切会话/页面隐藏）再试一次
      if (readSentRef.current[convId] === seq) delete readSentRef.current[convId]
    })
  }, [])

  /** 立刻上报该会话待合并的已读（切会话 / 页面隐藏 / 卸载时调用） */
  const flushRead = useCallback(
    (convId: number) => {
      const timer = readTimerRef.current[convId]
      if (timer != null) {
        window.clearTimeout(timer)
        delete readTimerRef.current[convId]
      }
      const seq = readPendingRef.current[convId]
      delete readPendingRef.current[convId]
      if (seq == null) return
      sendRead(convId, seq)
    },
    [sendRead],
  )

  /**
   * 标记「已读到 seq」。
   * - 本地立刻生效（unread=0 + 自己的 lastReadSeq 前进），不等服务端回声，UI 表现不变；
   * - 上报是 500ms trailing：期间连续来的消息只保留最大 seq，窗口结束时只发一个 POST。
   */
  const markRead = useCallback(
    (convId: number, seq: number) => {
      if (!Number.isFinite(seq) || seq <= 0) return
      setConversations((prev) => {
        const conv = prev.find((item) => item.id === convId)
        if (!conv) return prev
        const mine = conv.members.find((member) => member.id === me.id)
        const advance = mine != null && (mine.lastReadSeq ?? 0) < seq
        if (conv.unread === 0 && !advance) return prev
        return prev.map((item) =>
          item.id === convId
            ? {
                ...item,
                unread: 0,
                members: advance
                  ? item.members.map((member) => (member.id === me.id ? { ...member, lastReadSeq: seq } : member))
                  : item.members,
              }
            : item,
        )
      })
      const pending = readPendingRef.current[convId] ?? 0
      if (seq > pending) readPendingRef.current[convId] = seq
      if (readTimerRef.current[convId] != null) window.clearTimeout(readTimerRef.current[convId])
      readTimerRef.current[convId] = window.setTimeout(() => {
        delete readTimerRef.current[convId]
        flushRead(convId)
      }, READ_COALESCE_MS)
    },
    [flushRead, me.id],
  )

  // 切走会话：把这条会话还压着没上报的已读立刻结清，别等下一次有人说话。
  const lastActiveRef = useRef<number | null>(activeId)
  useEffect(() => {
    const previous = lastActiveRef.current
    lastActiveRef.current = activeId
    if (previous != null && previous !== activeId) flushRead(previous)
  }, [activeId, flushRead])

  // 切会话时也记一次：用户可能一直开着页面看这个群（不触发 pagehide），
  // 下次启动的预取窗口起点就靠这里的 lastSeq。
  useEffect(() => {
    if (activeId == null) return
    rememberLastConversation(activeId, lastSeqRef.current[activeId] ?? 0)
  }, [activeId])

  const loadMessages = useCallback(
    async (convId: number) => {
      setLoadingMessages(true)
      try {
        // 拉「尾部一窗」而不是 since_seq=0：
        // 接口是「seq > since 顺序取 limit 条」，从 0 开始只能拿到最早的一段；
        // 以前的做法是从 0 拉 100 再补一次尾，群超过 200 条时最新那几十条根本不会加载
        // （打开群停在旧消息、列表预览却显示最新，用户以为丢了消息）。
        // 会话列表里有 lastSeq，直接用它定位尾部；列表还没拉到时退回 0（新群本来就短）。
        const known = conversationsRef.current.find((conv) => conv.id === convId)?.lastSeq ?? 0
        const WINDOW = 200
        const since = known > WINDOW ? known - WINDOW : 0
        let first = await api.messages(convId, since, WINDOW)
        let list = (first.messages ?? []).map(fromRest)
        let head = Math.max(first.lastSeq ?? 0, maxSeqOf(list))
        // known 是缓存值，极小概率比真实 last_seq 还大（例如本地列表还没刷新）：
        // 这时上面会拿到空列表，回退到从 0 拉一窗，别让会话显示成「没有消息」。
        if (list.length === 0 && since > 0) {
          first = await api.messages(convId, 0, WINDOW)
          list = (first.messages ?? []).map(fromRest)
          head = Math.max(first.lastSeq ?? 0, maxSeqOf(list))
        }
        // 合并时保留已有的历史窗口：搜索结果跳转可能先补拉了老消息，
        // 这里若只保留「无 seq 的乐观气泡」就会把那段窗口丢掉（跳转目标随之消失）。
        writeMessages(convId, (prev) => mergeMessages(prev, list))
        lastSeqRef.current[convId] = Math.max(head, lastSeqRef.current[convId] ?? 0)
        setConversations((prev) =>
          prev.map((conv) => (conv.id === convId ? { ...conv, lastSeq: Math.max(conv.lastSeq, head) } : conv)),
        )
        olderDoneRef.current[convId] = false
        if (activeIdRef.current === convId) void markRead(convId, head)
      } catch (err) {
        notify(err instanceof ApiError ? err.message : '消息加载失败', 'error')
      } finally {
        setLoadingMessages(false)
      }
    },
    [markRead, notify, writeMessages],
  )

  /**
   * 向上翻历史（外部评审前端 §4-1）：取「紧挨着当前最早一条」的前一页，合并进缓存。
   * 返回本次真正加载的条数（0 = 已经到最早了，UI 据此停掉滚动触发）。
   * 分页游标是 seq（会话内单调），所以不会出现「拉回来一堆重复/空洞」。
   */
  const loadingOlderRef = useRef<Record<number, boolean>>({})
  const olderDoneRef = useRef<Record<number, boolean>>({})
  const loadOlder = useCallback(
    async (convId: number): Promise<number> => {
      if (loadingOlderRef.current[convId]) return 0
      if (olderDoneRef.current[convId]) return 0
      const list = messagesRef.current[convId] ?? []
      // 窗口上限：已经顶到 500 条就不再往上拉 —— 拉回来会被 trimWindow 立刻从头部裁掉，
      // 变成「滚到顶 → 请求 → 一条也没多 → 再请求」的死循环（更早的历史走搜索）。
      if (list.length >= MESSAGE_WINDOW) {
        olderDoneRef.current[convId] = true
        return 0
      }
      const minSeq = list.reduce((acc, item) => (item.seq != null && (acc === 0 || item.seq < acc) ? item.seq : acc), 0)
      if (!minSeq || minSeq <= 1) {
        olderDoneRef.current[convId] = true
        return 0
      }
      loadingOlderRef.current[convId] = true
      try {
        const res = await api.messages(convId, 0, 50, minSeq)
        const fetched = (res.messages ?? []).map(fromRest)
        if (fetched.length) writeMessages(convId, (prev) => mergeMessages(prev, fetched))
        // 不足一页 = 到最早了；置位后不再重复请求（新消息不会让「更早」重新出现）
        if (fetched.length < 50) olderDoneRef.current[convId] = true
        return fetched.length
      } catch {
        return 0
      } finally {
        loadingOlderRef.current[convId] = false
      }
    },
    [writeMessages],
  )

  /** 会话重新打开 / 第一次拉完时重置「已到最早」标记 */
  const resetOlderFlag = useCallback((convId: number) => {
    olderDoneRef.current[convId] = false
    loadingOlderRef.current[convId] = false
  }, [])

  /**
   * 从搜索结果跳到某条老消息：本地缓存里没有那一段时，先补拉「目标前 24 条 + 之后到 50 条」这一窗口。
   * 只补一段而不是整段历史 —— 搜索跳转本来就是偶发的，拉全量既慢又把内存顶上去。
   * 返回是否真的拿到了目标那条（false 时 UI 只提示「消息可能已被撤回」，不静默失败）。
   */
  const loadAroundSeq = useCallback(
    async (convId: number, seq: number) => {
      if (!Number.isFinite(seq) || seq <= 0) return false
      const list = messagesRef.current[convId] ?? []
      if (list.some((item) => item.seq === seq)) return true
      try {
        const res = await api.messages(convId, Math.max(0, seq - 25), 50)
        const fetched = (res.messages ?? []).map(fromRest)
        if (!fetched.length) return false
        // 先给目标上「窗口保护」，再合并：这段历史比现有窗口更老时，裁剪会把它当头部丢掉，
        // 于是 UI 收到「找到了」但列表里没有这条，滚不过去（MessageList 的 jump effect 不触发）。
        const found = fetched.some((item) => item.seq === seq)
        if (found) pinSeqRef.current[convId] = { seq, at: Date.now() }
        writeMessages(convId, (prev) => mergeMessages(prev, fetched))
        return found
      } catch {
        return false
      }
    },
    [writeMessages],
  )

  const backfill = useCallback(
    async (convId: number, sinceSeq: number) => {
      if (backfillingRef.current[convId]) return
      backfillingRef.current[convId] = true
      try {
        const res = await api.messages(convId, sinceSeq, 200)
        const list = (res.messages ?? []).map(fromRest)
        writeMessages(convId, (prev) => mergeMessages(prev, list))
        const head = Math.max(res.lastSeq ?? 0, sinceSeq, maxSeqOf(list))
        lastSeqRef.current[convId] = Math.max(head, lastSeqRef.current[convId] ?? 0)
        if (activeIdRef.current === convId) void markRead(convId, head)
      } catch {
        // 补拉失败时保留「正在重连…」等下一次重连再试
      } finally {
        backfillingRef.current[convId] = false
      }
    },
    [markRead, writeMessages],
  )

  // 页面隐藏 / 卸载（切到「空间」「我的」会卸载 ChatView）：补发所有待上报的已读，
  // 否则用户「看完就走」的那一批消息对别人永远显示未读。
  // 顺带把「上次会话 + 最新 lastSeq」落盘 —— 下一次启动时靠它预取离现在最近的一窗消息。
  // 页面重新可见时反向补一次消息缺口（见下方 onVisibility；因为要用 backfill，本 effect
  // 放在 backfill 定义之后）。
  useEffect(() => {
    const flushAll = () => {
      for (const key of Object.keys(readPendingRef.current)) flushRead(Number(key))
    }
    const persistHint = () => {
      const convId = activeIdRef.current
      if (convId == null) return
      rememberLastConversation(convId, lastSeqRef.current[convId] ?? 0)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushAll()
        persistHint()
        return
      }
      // 页面重新可见（手机切回来 / 切走标签页）：这段时间 WS 可能静默丢过帧
      // （服务端背压、系统挂起、浏览器节流），当前会话落后于列表 lastSeq 就补一次。
      // 这是外部审查 Q4 的兜底：resync_required 帧也会补，但那一帧本身也可能丢，双保险。
      const convId = activeIdRef.current
      if (convId == null) return
      const row = conversationsRef.current.find((conv) => conv.id === convId)
      if (!row) return
      const local = lastSeqRef.current[convId] ?? 0
      if ((row.lastSeq ?? 0) > local) void backfill(convId, local)
    }
    const onPageHide = () => {
      flushAll()
      persistHint()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      persistHint()
      flushAll()
      for (const timer of Object.values(readTimerRef.current)) window.clearTimeout(timer)
      readTimerRef.current = {}
    }
  }, [backfill, flushRead])

  const [hasMoreConversations, setHasMoreConversations] = useState(false)
  const loadingMoreConversations = useRef(false)
  /** 启动预取只许消费一次（切视图回来 / 重连刷新都不能再吃掉一份旧 promise） */
  const prefetchTakenRef = useRef(false)

  /**
   * 消费「上次会话」的消息预取（与会话列表并行发出的那一窗）。
   *
   * 三种落点：
   * - 上次那个会话还在 → 写进缓存，用户点进去 0 请求秒开；`head` 落后于 lastSeq 时补一次尾巴；
   * - 落后超过一页（关页面期间又来了 >200 条）→ **丢弃**：这段补不齐会在中间留空洞，
   *   不如让正常打开路径整窗重拉；
   * - 会话已不存在/已无权限 → 丢弃（什么都不做，也不额外请求）。
   */
  const adoptPrefetchedMessages = useCallback(
    async (prefetch: StartupPrefetch) => {
      const snapshot = await prefetch.messages
      if (!snapshot || snapshot.list.length === 0) return
      const conv = conversationsRef.current.find((item) => item.id === snapshot.conversationId)
      if (!conv) return
      const head = maxSeqOf(snapshot.list)
      if (head <= 0) return
      const target = Math.max(conv.lastSeq ?? 0, lastSeqRef.current[conv.id] ?? 0)
      const gap = target - head
      if (gap > PREFETCH_WINDOW) return
      writeMessages(conv.id, (prev) => mergeMessages(prev, snapshot.list))
      lastSeqRef.current[conv.id] = Math.max(head, lastSeqRef.current[conv.id] ?? 0)
      if (gap > 0) void backfill(conv.id, head)
    },
    [backfill, writeMessages],
  )

  const loadConversations = useCallback(async () => {
    // 首屏优先复用 App 里与 /api/me 并行发出的那次请求（只取一次；之后的重连刷新照常自己发）
    const prefetch = prefetchTakenRef.current ? null : takeStartupPrefetch()
    if (prefetch) prefetchTakenRef.current = true
    try {
      const list = prefetch ? await prefetch.conversations : await api.conversations(0, 50)
      const next = sortConversations(list.map(normalizeConversation))
      conversationsRef.current = next
      setConversations(next)
      setConversationsError(null)
      // 返回满一页说明可能还有；列表只记 50 条，避免几千个群一次性渲染
      setHasMoreConversations(list.length >= 50)
      // 列表到手后再认领预取的消息（要按列表里的 lastSeq 判断这段窗口是否还新鲜）
      if (prefetch) void adoptPrefetchedMessages(prefetch)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') return
      const message = err instanceof ApiError ? err.message : '会话列表加载失败'
      setConversationsError(message)
      notify(message, 'error')
    }
  }, [adoptPrefetchedMessages, notify])

  /** 列表底部「加载更多」：按 offset 追加，不重排已有的 */
  const loadMoreConversations = useCallback(async () => {
    if (loadingMoreConversations.current || !hasMoreConversations) return
    loadingMoreConversations.current = true
    try {
      const offset = conversationsRef.current.length
      const list = await api.conversations(offset, 50)
      const merged = sortConversations([...conversationsRef.current, ...list.map(normalizeConversation)])
      conversationsRef.current = merged
      setConversations(merged)
      setHasMoreConversations(list.length >= 50)
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'unauthorized') notify(err.message, 'error')
    } finally {
      loadingMoreConversations.current = false
    }
  }, [hasMoreConversations, notify])

  /**
   * 大群成员懒加载：membersComplete === false 时拉一次全量成员，合并进会话后置为 complete。
   * 结果留在 conversations state 里，切走再切回不会重复拉；loadConversations 刷新后自然回到 false 再拉。
   */
  const ensureMembers = useCallback(
    async (convId: number) => {
      const conv = conversationsRef.current.find((item) => item.id === convId)
      if (!conv) return
      if (conv.membersComplete !== false) return
      if (membersInflightRef.current[convId]) return

      membersInflightRef.current[convId] = true
      setMembersLoading((prev) => ({ ...prev, [convId]: true }))
      try {
        const res = await api.conversationMembers(convId)
        const list = Array.isArray(res.members) ? res.members.map(normalizeMember) : []
        if (list.length === 0) return
        setConversations((prev) =>
          prev.map((item) =>
            item.id === convId
              ? {
                  ...item,
                  members: list,
                  memberCount: typeof res.total === 'number' ? res.total : list.length,
                  agentCount: list.filter((member) => member.type === 'agent').length,
                  membersComplete: true,
                }
              : item,
          ),
        )
      } catch (err) {
        if (err instanceof ApiError && err.code !== 'unauthorized') notify(err.message, 'error')
      } finally {
        membersInflightRef.current[convId] = false
        setMembersLoading((prev) => {
          const next = { ...prev }
          delete next[convId]
          return next
        })
      }
    },
    [notify],
  )

  /* ---------------- WebSocket ---------------- */

  /* ---------------- 在线状态 / 正在输入 ---------------- */

  // `${convId}:${principalId}` -> 4 秒后清掉的定时器
  const typingTimersRef = useRef<Record<string, number>>({})

  /** 收到「正在输入」：同一个人的帧只续期，不重复往列表里加 */
  const handleTyping = useCallback((frame: WsTyping) => {
    const convId = frame.conversationId
    const key = `${convId}:${frame.principalId}`
    if (typingTimersRef.current[key]) window.clearTimeout(typingTimersRef.current[key])
    typingTimersRef.current[key] = window.setTimeout(() => {
      delete typingTimersRef.current[key]
      setTyping((prev) => {
        const list = (prev[convId] || []).filter((item) => item.id !== frame.principalId)
        const next = { ...prev }
        if (list.length) next[convId] = list
        else delete next[convId]
        return next
      })
    }, 4000)
    setTyping((prev) => {
      const list = prev[convId] || []
      if (list.some((item) => item.id === frame.principalId)) return prev
      return { ...prev, [convId]: [...list, { id: frame.principalId, name: frame.name }] }
    })
  }, [])

  // 我自己的「正在输入」限频：3 秒一帧，服务端还会再限一次（10 秒 5 次）
  const typingSentRef = useRef<Record<number, number>>({})
  const notifyTyping = useCallback((convId: number) => {
    const now = Date.now()
    if (now - (typingSentRef.current[convId] ?? 0) < 3000) return
    typingSentRef.current[convId] = now
    socketRef.current?.send({ t: 'typing', conversationId: convId })
  }, [])

  /**
   * 服务端因为背压丢帧了（外部审查 Q4）。
   *
   * 这一帧只说「哪个会话、丢到哪」，不假设我们补到哪：补拉起点一律用**本地** lastSeq，
   * 所以即使连着丢了多帧、或者 resync 帧本身迟到，也不会漏。
   * 三种落点：
   * - 当前会话 / 已有缓存 → 复用 backfill（和「重连后按 since_seq 补齐」同一条路径）；
   * - 从没打开过这个群（没有缓存）→ 丢掉游标，下次打开整段拉，别留半截缓存；
   * - lastSeq = 0（公告这类没有 seq 的帧）→ 只重拉会话列表，把元数据对齐。
   */
  const handleResync = useCallback(
    (frame: WsResyncRequired) => {
      const convId = frame.conversationId
      if (!Number.isInteger(convId) || convId <= 0) return
      if (!(frame.lastSeq > 0)) {
        void loadConversations()
        return
      }
      // 列表里还没有这个群（刚被拉进去、侧栏还没刷新）：先把列表拉一次，
      // 否则这条 resync 会落到「既没有缓存也没有行」的空处，用户看不到新群
      if (!conversationsRef.current.some((conv) => conv.id === convId)) {
        void loadConversations()
        return
      }
      // 列表里的 lastSeq 是「服务端已知最新」：先对齐，未读/落后判断才有依据
      setConversations((prev) =>
        prev.map((conv) =>
          conv.id === convId ? { ...conv, lastSeq: Math.max(conv.lastSeq, frame.lastSeq) } : conv,
        ),
      )
      if (messagesRef.current[convId] != null || activeIdRef.current === convId) {
        void backfill(convId, lastSeqRef.current[convId] ?? 0)
      } else {
        delete messagesRef.current[convId]
        delete lastSeqRef.current[convId]
        setMessages({ ...messagesRef.current })
      }
    },
    [backfill, loadConversations],
  )

  const handleIncoming = useCallback(
    (event: WsEvent) => {
      const convId = event.conversationId
      // 撤回事件：只把本地那条标成已撤回（不新增气泡、不覆盖会话预览、不响提示音）
      if (event.recalled === true || event.recalledAt != null) {
        setConversations((prev) =>
          prev.map((conv) => (conv.id === convId ? { ...conv, lastSeq: Math.max(conv.lastSeq, event.seq) } : conv)),
        )
        writeMessages(convId, (prev) =>
          prev.map((item) =>
            item.seq === event.seq
              ? {
                  ...item,
                  recalledAt: event.recalledAt ?? new Date().toISOString(),
                  body: '',
                  parts: [],
                  optimistic: false,
                  failed: false,
                }
              : item,
          ),
        )
        return
      }
      // 音效：别人发的消息才响；@ 了我用更明显的那声
      if (event.senderId !== me.id) {
        if (event.mentions.includes(me.id)) play('mention')
        else play('recv')
      }
      const isActive = activeIdRef.current === convId
      const knownSeq = lastSeqRef.current[convId]
      const loaded = messagesRef.current[convId] != null
      const incomingParts = normalizeParts(event.parts, event.body)
      const incomingSignature = signatureOf(incomingParts, event.body)
      // 紧凑帧：服务端为了不把 24KB 的 srcdoc 发给每个成员，只推了指针。
      // 预览已够用；当前会话里的正文/附件再按 seq 回补一次（防抖 120ms）。
      const isCompact = event.compact === true
      // [外部评审 §4-6] 紧凑帧只缺这一条的正文：单条点补即可。
      // 以前是 backfill(seq-1) 拉一整窗 200 条，大群连发图片时会放大 200 倍。
      const scheduleCompactFetch = (targetSeq: number) => {
        if (compactTimerRef.current[convId]) window.clearTimeout(compactTimerRef.current[convId])
        compactTimerRef.current[convId] = window.setTimeout(() => {
          delete compactTimerRef.current[convId]
          api
            .messageBySeq(convId, targetSeq)
            .then((res) => {
              if (!res?.message) return
              const one = fromRest(res.message)
              writeMessages(convId, (prev) => mergeMessages(prev, [one]))
            })
            .catch(() => {
              // 单条补不到（已删除/已隐藏）就退回整窗补拉，保证正文最终能对上
              void backfill(convId, Math.max(0, targetSeq - 1))
            })
        }, 120)
      }

      setConversations((prev) => {
        const next = prev.map((conv) =>
          conv.id === convId
            ? {
                ...conv,
                lastSeq: Math.max(conv.lastSeq, event.seq),
                lastMessagePreview: previewOf(incomingParts, event.body),
                lastMessageAt: event.createdAt,
                unread: isActive ? 0 : event.senderId === me.id ? conv.unread : conv.unread + 1,
              }
            : conv,
        )
        return sortConversations(next)
      })

      if (knownSeq != null && event.seq > knownSeq + 1) {
        if (isActive) void backfill(convId, knownSeq)
        else {
          // 非当前会话出现断档：丢弃本地缓存，下次打开做整段拉取
          delete messagesRef.current[convId]
          delete lastSeqRef.current[convId]
          setMessages({ ...messagesRef.current })
        }
      }

      if (!loaded || !isActive) {
        // 非当前会话不维护气泡列表，只在打开时统一拉取
        if (loaded && !isActive) {
          writeMessages(convId, (prev) => mergeMessages(prev, [toLocal(event)]))
          lastSeqRef.current[convId] = Math.max(lastSeqRef.current[convId] ?? 0, event.seq)
        }
        return
      }

      if (isCompact) {
        // 自己的消息被降级时，先把乐观气泡按「同正文」归位，避免出现两条
        if (event.senderId === me.id) {
          writeMessages(convId, (prev) => {
            const idx = prev.findIndex(
              (item) => item.seq == null && item.optimistic && item.senderId === me.id && item.body === event.body,
            )
            if (idx < 0) return prev
            const next = [...prev]
            next[idx] = { ...next[idx], seq: event.seq, eventId: event.eventId, optimistic: false }
            return sortMessages(next)
          })
        }
        lastSeqRef.current[convId] = Math.max(lastSeqRef.current[convId] ?? 0, event.seq)
        void markRead(convId, event.seq)
        scheduleCompactFetch(event.seq)
        return
      }

      writeMessages(convId, (prev) => {
        if (prev.some((item) => item.seq === event.seq)) return prev
        // 服务端事件没有 clientMsgId：按「同一组 parts / 同正文的待归位消息」兜底归位
        const pendingIndex = prev.findIndex(
          (item) =>
            item.seq == null &&
            item.optimistic &&
            item.senderId === me.id &&
            signatureOf(normalizeParts(item.parts, item.body), item.body) === incomingSignature,
        )
        if (pendingIndex >= 0) {
          const next = [...prev]
          next[pendingIndex] = { ...next[pendingIndex], seq: event.seq, eventId: event.eventId, optimistic: false }
          return sortMessages(next)
        }
        return mergeMessages(prev, [toLocal(event)])
      })
      lastSeqRef.current[convId] = Math.max(lastSeqRef.current[convId] ?? 0, event.seq)
      void markRead(convId, event.seq)
    },
    [backfill, markRead, me.id, writeMessages],
  )

  const handleFrame = useCallback(
    (frame: WsServerFrame) => {
      switch (frame.t) {
        case 'hello':
          break
        case 'pong':
          break
        case 'presence':
          // 只改「我列表里已经有这个人」的会话：不在同一个群的人本来也不该被我知道上下线
          setConversations((prev) =>
            prev.map((conv) =>
              conv.members.some((member) => member.id === frame.principalId)
                ? {
                    ...conv,
                    members: conv.members.map((member) =>
                      member.id === frame.principalId ? { ...member, online: frame.online } : member,
                    ),
                  }
                : conv,
            ),
          )
          break
        case 'typing':
          handleTyping(frame)
          break
        case 'read':
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === frame.conversationId
                ? {
                    ...conv,
                    members: conv.members.map((member) =>
                      member.id === frame.principalId ? { ...member, lastReadSeq: frame.seq } : member,
                    ),
                  }
                : conv,
            ),
          )
          break
        case 'announcement':
          // 公告是群级配置，不是消息：只改列表里那一行的两个字段，
          // 不碰 unread/lastSeq——否则未读数会莫名其妙跳。
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === frame.conversationId
                ? {
                    ...conv,
                    announcement: frame.announcement,
                    announcementUpdatedAt: frame.updatedAt,
                  }
                : conv,
            ),
          )
          break
        case 'event':
          handleIncoming(frame)
          break
        case 'resync_required':
          handleResync(frame)
          break
      }
    },
    [handleIncoming, handleResync, handleTyping],
  )

  const handleStatus = useCallback(
    (next: WsStatus) => {
      setStatus(next)
      if (next !== 'online') return
      // 首次连上不重复拉；重连成功后按 since_seq 补齐当前会话
      if (!connectedOnceRef.current) {
        connectedOnceRef.current = true
        return
      }
      void loadConversations()
      const convId = activeIdRef.current
      if (convId != null) {
        const since = lastSeqRef.current[convId] ?? 0
        void backfill(convId, since)
      }
    },
    [backfill, loadConversations],
  )

  const frameRef = useRef(handleFrame)
  frameRef.current = handleFrame
  const statusRef = useRef(handleStatus)
  statusRef.current = handleStatus

  useEffect(() => {
    const socket = new ChatSocket({
      onFrame: (frame) => frameRef.current(frame),
      onStatus: (next) => statusRef.current(next),
    })
    socketRef.current = socket
    socket.connect()
    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [])

  return {
    conversations,
    setConversations,
    conversationsError,
    messages,
    status,
    typing,
    notifyTyping,
    loadingMessages,
    membersLoading,
    writeMessages,
    seedConversation,
    markRead,
    loadMessages,
    loadAroundSeq,
    loadOlder,
    resetOlderFlag,
    backfill,
    loadConversations,
    loadMoreConversations,
    hasMoreConversations,
    ensureMembers,
    messagesRef,
    lastSeqRef,
    activeIdRef,
  }
}
