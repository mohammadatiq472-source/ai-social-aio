import { EventEmitter } from 'node:events';
import { authenticateSession } from '../auth/service.mjs';
import { query } from '../db.mjs';
import { notifyOffline } from '../push.mjs';

// 进程内事件总线：submit() 提交后 publish，WS 层订阅后按成员资格投递。
// [C1] 单进程，所以不需要 Redis pub/sub；多进程时才需要引入（明确不在 v1 范围）。
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publishMessage(msg) {
  bus.emit('message', msg);
}

export function publishRead(payload) {
  bus.emit('read', payload);
}

// principalId -> Set<WebSocket>
const sockets = new Map();

function addSocket(principalId, socket) {
  if (!sockets.has(principalId)) sockets.set(principalId, new Set());
  sockets.get(principalId).add(socket);
}

function removeSocket(principalId, socket) {
  const set = sockets.get(principalId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sockets.delete(principalId);
}

/**
 * 在线状态广播：只发给「和这个人有共同会话」的在线成员。
 * 为什么不在连接时全站广播：那是 O(在线人数²)，而且会泄露「谁和谁在同一个群」。
 * 只发「在线/离线」一个布尔，不发时间戳/设备信息。
 */
async function broadcastPresence(principalId, online) {
  const rows = await query(
    `SELECT DISTINCT peer.principal_id
       FROM conversation_members me
       JOIN conversation_members peer ON peer.conversation_id = me.conversation_id
      WHERE me.principal_id = $1 AND peer.principal_id <> $1`,
    [principalId],
  ).catch(() => []);
  if (!rows.length) return;
  const text = JSON.stringify({ t: 'presence', principalId: Number(principalId), online });
  for (const row of rows) {
    const set = sockets.get(Number(row.principal_id));
    if (!set) continue;
    for (const s of set) sendText(s, text);
  }
}

// 同一个人的第一个连接上线 / 最后一个连接下线才广播（多标签页不该反复闪）
function markPresence(principalId, becameOnline) {
  broadcastPresence(principalId, becameOnline).catch(() => {});
}

export function onlineCount() {
  let n = 0;
  for (const set of sockets.values()) n += set.size;
  return n;
}

export function isOnline(principalId) {
  return (sockets.get(principalId)?.size || 0) > 0;
}

// 单帧上限：超过它就走"紧凑帧"（不带 parts），客户端收到后按 seq 回补正文。
// 典型触发是 srcdoc（HTML 段最大 24KB）——300 人群里每人都收一份就是 7MB。
const MAX_FRAME_BYTES = 8 * 1024;
// 背压：客户端读得慢（bufferedAmount 高）时不硬塞。但**不能静默丢**（外部审查 Q4）：
// 丢的那一帧若正好是最新一条，后面没有更大的 seq 来暴露缺口，界面会一直缺这条，
// 只有重连（hello 后的 since_seq 补齐）才会补上。
// 所以丢帧时给这个 socket 单独排一帧 {t:'resync_required', conversationId, lastSeq}，
// 客户端收到后按自己本地 lastSeq 走 REST 补拉（web/src/hooks/useChatStream.ts 的 backfill）。
// 阈值可用 WS_MAX_BUFFERED_BYTES 覆盖：验证脚本（verify-ws-backpressure.mjs）把它调小，
// 否则只有真实弱网才触发，这条回归就永远跑不到。
const MAX_BUFFERED_BYTES = Number(process.env.WS_MAX_BUFFERED_BYTES) > 0
  ? Number(process.env.WS_MAX_BUFFERED_BYTES)
  : 1.5 * 1024 * 1024;
// 慢消费者会连着触发几十帧。逐帧发 resync 等于用同样的方式再把它的缓冲撑大，
// 所以冷却窗口内只累积「每个会话最靠后的被丢 seq」，窗口结束统一补发一帧：
// 客户端从自己的 lastSeq 补拉，一次就能把中间全拿到。
const SLOW_NOTIFY_COOLDOWN_MS = 1000;
/** 一次 resync 最多报几个会话：慢消费者可能同时漏掉多个群的帧，别让帧数反过来变成新的负担 */
const SLOW_NOTIFY_MAX_CONVERSATIONS = 8;

// socket -> 慢消费者状态。用 WeakMap 而不是挂字段：不污染 ws 的 socket，连接断开自动回收。
const slowStates = new WeakMap();
// socket -> principalId（只用于日志里的 ws.slow_consumer，不参与任何判定）
const socketPrincipals = new WeakMap();

function slowStateOf(socket) {
  let st = slowStates.get(socket);
  if (!st) {
    st = { pending: new Map(), notifiedAt: 0, timer: null, dropped: 0, buffered: 0 };
    slowStates.set(socket, st);
  }
  return st;
}

function forgetSlowState(socket) {
  const st = slowStates.get(socket);
  if (st?.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  slowStates.delete(socket);
  socketPrincipals.delete(socket);
}

/**
 * 记一次「因为背压而丢弃」的帧。只累积、不立刻发：冷却窗口结束时由 flushSlowNotify 补一帧。
 * conversationId 缺失（presence 之类）就只累计计数；seq 缺失（typing/read/公告）记 0，
 * 客户端把它当成「这个会话的元数据要重拉」，不会去算消息空洞。
 */
function noteSlowDrop(socket, conversationId, seq, bufferedAmount) {
  const st = slowStateOf(socket);
  const cid = Number(conversationId) || 0;
  if (cid > 0) {
    const s = Number(seq) || 0;
    st.pending.set(cid, Math.max(st.pending.get(cid) ?? 0, s));
  }
  st.buffered = bufferedAmount;
  st.dropped += 1;
  scheduleSlowNotify(socket);
}

function scheduleSlowNotify(socket) {
  const st = slowStateOf(socket);
  if (st.timer) return;
  const wait = Math.max(0, SLOW_NOTIFY_COOLDOWN_MS - (Date.now() - st.notifiedAt));
  st.timer = setTimeout(() => {
    st.timer = null;
    flushSlowNotify(socket);
  }, wait);
  // 别为了一个测试连接把进程钉住（CI / 本地脚本都要能干净退出）
  st.timer.unref?.();
}

function flushSlowNotify(socket) {
  const st = slowStateOf(socket);
  if (socket.readyState !== 1) {
    st.pending.clear();
    return;
  }
  const batch = [...st.pending.entries()].slice(0, SLOW_NOTIFY_MAX_CONVERSATIONS);
  st.pending.clear();
  if (!batch.length) return;
  st.notifiedAt = Date.now();
  const droppedFrames = st.dropped;
  st.dropped = 0;
  const principalId = socketPrincipals.get(socket) ?? null;
  for (const [conversationId, lastSeq] of batch) {
    // 直接用 socket.send 而不是 sendText：这帧的意义就是「在背压时也要送到」，
    // 再走一次阈值判断等于永远发不出去。
    try {
      socket.send(JSON.stringify({ t: 'resync_required', conversationId, lastSeq }));
    } catch {
      /* 连接已断：close/error 会回收 */
    }
    // [C6] 指标只记 principal / 水位 / 会话 / seq —— 绝不记正文、绝不记 token
    console.warn('[ws.slow_consumer]', JSON.stringify({
      principalId,
      conversationId,
      lastSeq,
      bufferedAmount: Math.round(st.buffered || 0),
      droppedFrames,
    }));
  }
}

/**
 * 投递一帧。背压时返回 false 并记一次慢消费者（gap 描述这帧「丢掉了什么」）：
 * - 消息帧传 { conversationId, seq }，客户端据此知道缺口从哪开始；
 * - 公告帧传 { conversationId, seq: 0 }，客户端只需要重拉元数据；
 * - presence/typing/read 这类瞬时帧不传，丢了本身会自愈（下一条覆盖）。
 */
function sendText(socket, text, gap = null) {
  try {
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (gap) noteSlowDrop(socket, gap.conversationId, gap.seq, socket.bufferedAmount);
      return false;
    }
    socket.send(text);
    return true;
  } catch {
    /* 连接已断，忽略 */
    return false;
  }
}

function send(socket, obj) {
  sendText(socket, JSON.stringify(obj));
}

// 把一条新消息投给会话内所有在线成员
export async function deliverToConversation(conversationId, payload) {
  const members = await query(
    'SELECT principal_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  ).catch(() => []);
  // 屏蔽（Q12，单向写、双向生效）：**在线帧和离线推送都要按这条过滤**，
  // 否则「拉黑」只在刷新后的 REST 列表里生效，实时通道还能收到对方的完整消息。
  const senderId = Number(payload.senderId) || 0;
  let recipients = members;
  if (senderId) {
    // 与 query.blockRelationsOf 同一条口径：发送者是 AI 时，它主人的屏蔽也算（双向生效）。
    const own = await query('SELECT owner_user_id FROM agents WHERE principal_id = $1', [senderId]).catch(() => []);
    const selfIds = new Set([senderId]);
    for (const r of own) if (r.owner_user_id != null) selfIds.add(Number(r.owner_user_id));
    const rel = await query(
      `SELECT blocker_id, blocked_id FROM principal_blocks
        WHERE blocker_id = ANY($1::bigint[]) OR blocked_id = ANY($1::bigint[])`,
      [[...selfIds]],
    ).catch(() => []);
    if (rel.length) {
      const blocked = new Set();
      for (const r of rel) {
        const b = Number(r.blocker_id);
        const d = Number(r.blocked_id);
        if (!selfIds.has(b)) blocked.add(b);
        if (!selfIds.has(d)) blocked.add(d);
      }
      recipients = members.filter((m) => !blocked.has(Number(m.principal_id)));
    }
  }
  const frame = { t: 'event', conversationId, ...payload };
  // 关键：整条消息只 stringify 一次，所有在线成员共用同一个字符串
  let text = JSON.stringify(frame);
  let compact = false;
  if (text.length > MAX_FRAME_BYTES) {
    compact = true;
    text = JSON.stringify({ ...frame, compact: true, parts: [] });
  }
  for (const m of recipients) {
    const set = sockets.get(Number(m.principal_id));
    if (!set) continue;
    // gap 带上 seq：被丢的是哪条消息，客户端据此知道缺口从哪开始（外部审查 Q4）
    for (const s of set) sendText(s, text, { conversationId, seq: payload.seq });
  }

  // 系统通知：只给「没有 WS 连接」的成员，且不在投递路径上等待（推送慢不能拖慢聊天）
  // 自己发的消息由 notifyOffline 内部再过滤一次（senderId）
  const offlineIds = recipients
    .filter((m) => !sockets.has(Number(m.principal_id)))
    .map((m) => Number(m.principal_id));
  if (offlineIds.length) {
    notifyOffline({
      conversationId,
      senderId: payload.senderId,
      senderName: payload.senderName,
      body: payload.body,
      mentions: payload.mentions,
      offlineIds,
    }).catch((err) => {
      // [C6] 不打正文；只记失败原因
      console.error('[push] notify failed', err.message);
    });
  }

  return { recipients: members.length, bytes: text.length, compact, offline: offlineIds.length };
}

/**
 * 群公告变更帧：只发给「此刻在线」的会话成员。
 *
 * 为什么现在发（2026-11-19 改口径）：公告就是群规，别人开着页面却看不到新规，
 * 等于「规则改了但没人知道」。旧口径以「怕刷屏」为由不发，但公告是低频人工操作
 * （人手点保存才算一次），量级比消息低两三个数量级，刷屏的前提不成立。
 *
 * 为什么不复用 deliverToConversation：那条路径会给离线成员发 Web Push，
 * 而公告变更不该出现在手机通知栏（它不是消息，也不需要立刻惊动人）。
 * 为什么不塞进 event 帧：客户端把 event 一律当消息处理（seq / parts / 未读计数），
 * 公告没有 seq，混进去会让未读与断线回补算错。
 */
export async function deliverAnnouncement(conversationId, payload) {
  const members = await query(
    'SELECT principal_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  ).catch(() => []);
  if (!members.length) return { recipients: 0, bytes: 0 };
  // 与 deliverToConversation 同口径：整帧只 stringify 一次，所有成员共用
  const text = JSON.stringify({ t: 'announcement', conversationId: Number(conversationId), ...payload });
  let recipients = 0;
  for (const m of members) {
    const set = sockets.get(Number(m.principal_id));
    if (!set) continue;
    for (const s of set) {
      // 公告没有 seq：gap 传 0，客户端据此只重拉元数据（不当作消息空洞）
      if (sendText(s, text, { conversationId: Number(conversationId), seq: 0 })) recipients += 1;
    }
  }
  return { recipients, bytes: text.length };
}

// 「正在输入」转发：只转发「你在那个群里」的人，且限频——否则任何人可以拿 typing 刷别人的屏幕
const typingHits = new Map();
function typingAllowed(key, limitPer10s = 5) {
  const now = Date.now();
  const arr = (typingHits.get(key) || []).filter((t) => now - t < 10_000);
  if (arr.length >= limitPer10s) {
    typingHits.set(key, arr);
    return false;
  }
  arr.push(now);
  typingHits.set(key, arr);
  return true;
}

async function relayTyping(actor, conversationId) {
  // AI 不发 typing（它们没有输入框）；只在人类侧转发
  if (actor.type !== 'user') return;
  const cid = Number(conversationId);
  if (!Number.isInteger(cid) || cid <= 0) return;
  if (!typingAllowed(`${actor.id}:${cid}`)) return;

  const mine = await query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
    [cid, actor.id],
  ).catch(() => []);
  if (!mine.length) return; // 不在群里就别想让别人看到「XX 正在输入」

  const peers = await query(
    'SELECT principal_id FROM conversation_members WHERE conversation_id = $1 AND principal_id <> $2',
    [cid, actor.id],
  ).catch(() => []);
  const text = JSON.stringify({ t: 'typing', conversationId: cid, principalId: Number(actor.id), name: actor.displayName });
  for (const row of peers) {
    const set = sockets.get(Number(row.principal_id));
    if (!set) continue;
    for (const s of set) sendText(s, text);
  }
}

export async function attachWebSocket(fastify) {
  fastify.get('/ws', { websocket: true }, async (connection, req) => {
    const socket = connection?.socket || connection; // @fastify/websocket v11 传的是 socket 本身
    const cookies = req.headers.cookie || '';
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(cookies)?.[1];
    const actor = await authenticateSession(sid ? decodeURIComponent(sid) : '');
    if (!actor) {
      try { socket.close(4401, 'unauthorized'); } catch { /* ignore */ }
      return;
    }
    addSocket(actor.id, socket);
    socketPrincipals.set(socket, Number(actor.id));
    // 只有「第一个连接」才算上线：多开标签页不该让好友看到反复上下线
    if (sockets.get(actor.id)?.size === 1) markPresence(actor.id, true);
    send(socket, { t: 'hello', me: { id: actor.id, displayName: actor.displayName } });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.t === 'ping') send(socket, { t: 'pong' });
      if (msg?.t === 'typing') relayTyping(actor, msg.conversationId).catch(() => {});
    });

    // 心跳既要发现「网络已死但 socket 还 OPEN」的半开连接，也要避免把弱网抖动误杀：
    // 每个周期先看上一轮有没有回 pong，没有就判死？——不，先给一个完整周期的宽限。
    // 语义：周期 1 置 isAlive=false 并 ping；周期 2 仍没收到 pong → terminate。
    // 所以回收延迟 = 1~2 个周期（默认 30s 周期 → 30~60s 内回收）。
    // 周期可用 WS_HEARTBEAT_MS 覆盖：验证脚本用 800ms，否则只能在生产等一分钟才能观察。
    let isAlive = true;
    socket.on('pong', () => { isAlive = true; });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (!isAlive) {
        // 已经漏掉一个周期：直接 terminate。半开连接不会自己发 close，
        // 不主动 terminate 的话 sockets Map / wsOnline / 广播目标会一直留着它。
        try { socket.terminate(); } catch { /* ignore */ }
        clearInterval(heartbeat);
        return;
      }
      isAlive = false;
      try { socket.ping(); } catch { /* ignore */ }
    }, Math.max(100, Number(process.env.WS_HEARTBEAT_MS) || 30_000));

    socket.on('close', () => {
      clearInterval(heartbeat);
      forgetSlowState(socket);
      removeSocket(actor.id, socket);
      if (!sockets.has(actor.id)) markPresence(actor.id, false);
    });
    socket.on('error', () => {
      clearInterval(heartbeat);
      forgetSlowState(socket);
      removeSocket(actor.id, socket);
      if (!sockets.has(actor.id)) markPresence(actor.id, false);
    });
  });
}

// 订阅总线：新消息 → 投递到会话成员
bus.on('message', (payload) => {
  // 空间（feed）等非会话事件没有 conversationId，不走进会话投递
  if (!payload || !payload.conversationId) return;
  deliverToConversation(payload.conversationId, payload).catch((e) => {
    console.error('[ws] deliver failed', e.message);
  });
});

// 已读回执：只投给同会话其他人（v1 轻量）
bus.on('read', async ({ conversationId, principalId, seq }) => {
  const members = await query(
    'SELECT principal_id FROM conversation_members WHERE conversation_id = $1 AND principal_id <> $2',
    [conversationId, principalId],
  ).catch(() => []);
  const text = JSON.stringify({ t: 'read', conversationId, principalId, seq });
  for (const m of members) {
    const set = sockets.get(Number(m.principal_id));
    if (!set) continue;
    for (const s of set) sendText(s, text);
  }
});

// ============================================================================
// 仅供 scripts/verify/verify-ws-backpressure.mjs 注入「可控 bufferedAmount 的假 socket」。
//
// 为什么需要这个钩子：背压分支（bufferedAmount > MAX_BUFFERED_BYTES）能不能走到，
// 取决于内核的收发缓冲——Linux 会把 rcvbuf/tcp_wmem 自动调优到几 MB，几十条 ~7KB 的帧
// 根本顶不过阈值（生产实测：脚本 7/12，背压分支压根没执行）。把「真实 TCP 能不能撑爆」
// 当回归断言，等于把内核参数当契约：Linux 上必红、Windows 上偶绿。
// 所以把两个内部函数暴露出来，让验证脚本直接注入一个 bufferedAmount 已知的 socket，
// 稳定复现「丢帧 → resync_required → 补拉」这条链。生产路径一行都没变。
//
// addSocket 这里多写一步 socketPrincipals：真实连接是在 attachWebSocket 里补的，
// 注入的假 socket 没有那条路径；不补的话 ws.slow_consumer 的 principalId 会是 null，
// 日志就失去定位意义（这条正是被 verify-ws-backpressure 抓出来的）。
// ============================================================================
export const __testHooks = Object.freeze({
  addSocket(principalId, socket) {
    socketPrincipals.set(socket, Number(principalId));
    addSocket(principalId, socket);
  },
  removeSocket,
});
