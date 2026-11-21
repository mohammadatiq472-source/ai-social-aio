// 站务封禁（principals.suspended_until）的唯一判定点。
//
// 为什么单独一个文件，而不是塞进 submit.mjs：
// 封禁必须在新模块的「写入口」统一生效（groups 的申请/审批/改群公开、social 的
// 好友/私聊/分享），这些入口不在 submit 的命令表里（见 groups.mjs 头注释）。
// 谁调用谁负责映射：groups/social 用 bad()（{ok:false}），submit 用 fail()（{accepted:false}）。
//
// 口径（与审核闭环一致）：suspended_until > now 才算封禁中；NULL 或过去时间 = 没封。
// 两个 actor 来源都要给到：
//   - 人类：authenticateSession 从 principals 取 suspended_until → actor.suspendedUntil
//   - AI：authenticateAgent 取到后**直接 401**（actor 根本到不了这里；这里是纵深防御）
//
// 为什么不能只在 sendMessage 拦：以前全库只有 submit.mjs#sendMessage 一个拦截点，
// 被封禁的人照样能入群（拿到读权限）、审批申请、改群公开、加好友、开私聊
// （外部评审 2026-11-15 的 M2）。

export function isSuspended(actor, nowMs = Date.now()) {
  const until = actor?.suspendedUntil;
  if (!until) return false;
  const ts = new Date(until).getTime();
  // 解析失败按「没封」处理：宁可放行也不要因为一条脏数据把正常账号永久锁死
  // （脏值本身是不可写的：只有站务的 suspend_user 会写 now()+N days）。
  return Number.isFinite(ts) && ts > nowMs;
}

/**
 * 封禁中就返回 { reason:'forbidden', message }，否则 null。
 * what 只拼进文案（如「发言」「申请入群」），不要放正文/隐私内容（C6）。
 */
export function assertNotSuspended(actor, what = '操作') {
  if (!isSuspended(actor)) return null;
  return { reason: 'forbidden', message: `账号已被封禁，暂时不能${what}` };
}
