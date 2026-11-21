// 运行配置：全部来自环境变量，绝不硬编码口令
const bool = (v, d) => (v === undefined ? d : v === 'true' || v === '1');
// 毫秒阈值：非数字/负数回退默认；上限 60s（再大就不是“慢”而是故障，交给 error 日志）。
// 0 是合法值（= 全部记录），用于本地排查。
const msEnv = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(0, Math.min(60_000, Math.round(n)));
};
// 正整数 env：非法/越界回退默认（限流阈值配错不应该让服务起不来）
const intEnv = (v, d, min, max) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n)) return d;
  return Math.max(min, Math.min(max, n));
};

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',

  // 业务连接：qqmini_app，全表 DML（人类侧读写、建群、成员管理）
  databaseUrl: process.env.DATABASE_URL || '',
  // 受限连接：[C3] mcp_writer，只允许 events INSERT + 读模型 SELECT + 投影函数 EXECUTE
  writerDatabaseUrl: process.env.WRITER_DATABASE_URL || process.env.DATABASE_URL || '',

  secureCookie: bool(process.env.SECURE_COOKIE, true),
  cookieName: 'sid',
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 30 * 24 * 3600 * 1000),

  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787',
  logLevel: process.env.LOG_LEVEL || 'info',

  // 可观测性（P1-5）：慢 SQL / 慢 HTTP 阈值（毫秒，0..60000）。
  // 不引 Prometheus/Sentry：先让「慢在哪、池堵没堵」在日志与 /healthz 里可见。
  dbSlowMs: msEnv(process.env.DB_SLOW_MS, 300),
  httpSlowMs: msEnv(process.env.HTTP_SLOW_MS, 500),

  // MCP 读工具限流（防一个泄漏 token 刷读工具打爆 DB/CPU）。
  // 键 = agent principal id；写工具仍走各自业务门控，不在这里重复扣额度。
  // 默认：全局 120 次/分钟 burst 20；search_messages 单独 20 次/分钟 burst 5。
  mcpRate: {
    perMin: intEnv(process.env.MCP_RATE_PER_MIN, 120, 1, 60_000),
    burst: intEnv(process.env.MCP_RATE_BURST, 20, 1, 10_000),
    searchPerMin: intEnv(process.env.MCP_SEARCH_PER_MIN, 20, 1, 60_000),
    searchBurst: intEnv(process.env.MCP_SEARCH_BURST, 5, 1, 10_000),
  },

  // [C1] 单机护栏
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),
  writerPoolMax: Number(process.env.WRITER_POOL_MAX || 4),

  // 媒体（M0）：本地盘存储 + 签名 URL
  mediaDir: process.env.MEDIA_DIR || '/opt/aio/data/media',
  // 存储驱动：local（默认）| 以后 cos / r2。接口见 src/storage/index.mjs
  storageDriver: process.env.STORAGE_DRIVER || 'local',
  mediaUrlTtl: Number(process.env.MEDIA_URL_TTL || 600),
  // [外部评审 P0-1] 不做弱默认：媒体签名 + 会话都依赖它，缺失时 assertConfig 直接拒绝启动。
  // 以前回退到 'dev-only-secret'，生产忘配就是「公开常量当 HMAC 密钥」→ /media 签名可离线伪造。
  sessionSecret: process.env.SESSION_SECRET || '',
  // 内容扫描：none = 不拦（默认）；rule = 只做兜底规则；http = 交给外部服务
  scanProvider: process.env.SCAN_PROVIDER || 'none',
  scanUrl: process.env.SCAN_URL || '',
  // 内测邀请码：设了就只有带邀请码的人能注册；留空 = 开放注册
  registerCode: process.env.REGISTER_CODE || '',

  // 邀请制（B 方案，2026-11-18）：每个用户注册后拿到 inviteQuotaDefault 个名额，自己发码。
  // INVITE_MODE:
  //   ''   = 兼容模式：先试 DB 邀请码，失败再回退 REGISTER_CODE（老实例升级后行为不变）
  //   'db' = 只用 DB 邀请码，**彻底忽略 REGISTER_CODE**（否则一个旧 env 码会变成进站后门）
  inviteMode: (process.env.INVITE_MODE || '').toLowerCase(),
  // 新用户初始名额 / 邀请码默认有效期（天）
  inviteQuotaDefault: Number(process.env.INVITE_QUOTA_DEFAULT || 3),
  inviteTtlDays: Number(process.env.INVITE_TTL_DAYS || 30),
  // 邀请码 HMAC 的 pepper。留空则只用 SESSION_SECRET（同一把钥匙，但少一层隔离）。
  // 警告：换这个值 = 所有已发出的邀请码立即失效（库里只有 HMAC，没有明文可重算）。
  invitePepper: process.env.INVITE_PEPPER || '',
  // 防刷（B 方案没有邮箱验证，只能靠行为闸门）：
  //   同一出口 IP 24 小时最多成功兑换几个码——家宽 NAT / 机房代理批量造号的第一道闸；
  //   邀请深度上限——「A 拉 B、B 拉 C」不限深会指数繁衍，超过深度的账号不能再往下邀请。
  inviteMaxPerIpDay: Number(process.env.INVITE_MAX_PER_IP_DAY || 8),

  // 注册模式（实例开放，2026-11-19）：
  //   invite（默认）= 现状：必须凭邀请码注册
  //   waitlist      = 陌生人可以申请候补，站务发码后注册（没有邮箱验证时的安全中间态）
  //   open          = 无需邀请码，直接注册（⚠️ 没有邮箱/手机验证，等于给脚本开闸，仅限私域试点）
  signupMode: (process.env.SIGNUP_MODE || 'invite').toLowerCase(),

  // 缩略图派生的并发上限：sharp 单张 40MP 解码峰值约 160MB，动态上限 400MB（[C1]），
  // 不限制并发就是「同时传两张 40MP 图 = 进程直接 OOM」。2 是留了余量的经验值；
  // 调大之前先看 /healthz 的 memoryMB 与 RSS 峰值。
  thumbConcurrency: Number(process.env.THUMB_CONCURRENCY || 2),
  inviteMaxDepth: Number(process.env.INVITE_MAX_DEPTH || 8),

  // 发信（SMTP）：只用于「邮箱验证」。**一项都不配 = 该功能整体关闭**，
  // 注册/登录/其它所有功能行为不变（见 src/mail.mjs 的 emailVerifySettings）。
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    // true = 直连 465(wrapper TLS)；false = 587 明文起手后 STARTTLS（nodemailer 自动升级）
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
  // 邮箱验证模式（仅在配好 SMTP 后生效）：
  //   ''/'optional' = 注册后发一封验证信，但不拦人（默认）
  //   'required'    = 额外要求「验证过才能登录」——硬门禁，发信不可用时千万不要开
  //   'off'         = 配了 SMTP 也先不发
  emailVerifyMode: (process.env.EMAIL_VERIFY_MODE || '').toLowerCase(),

  // Web Push（系统通知）：三个键都不配 = 不发通知，账号不受影响
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // 推送服务要求能联系到你（mailto: 或 https:）
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost',
  },

  // 产品护栏（用户 2026-11-13 定的口径）
  limits: {
    maxGroupsPerUser: Number(process.env.MAX_GROUPS_PER_USER || 50),   // 每人最多 50 个群（创建 + 加入都算）
    maxGroupMembers: Number(process.env.MAX_GROUP_MEMBERS || 500),     // 单群 500 人
    mediaQuotaBytes: Number(process.env.MEDIA_QUOTA_BYTES || 2 * 1024 ** 3), // 每人媒体 2GB
    mediaRetentionDays: Number(process.env.MEDIA_RETENTION_DAYS || 30),      // 媒体保留 30 天
  },

  // [C10] 群内 AI 发言门控默认值
  // AI 自助注册：给「Agent 自己完成账号注册」的场景用（例如开新窗口的 AI 自我接入）。
  // 默认完全关闭；必须同时配邀请码和宿主账号（AI 挂在这个人类账号名下）才生效。
  agentSignup: {
    invite: process.env.AGENT_SIGNUP_INVITE || '',
    ownerAccount: Number(process.env.AGENT_SIGNUP_OWNER || 0),
  },

  // [C10] 门控：预算 + 令牌桶 + 熔断（评审任务书）
  // 原则：默认值要让「正常高频参与」不撞墙，墙只在异常模式（刷屏/循环/失控）上生效。
  gating: {
    perMessageMaxReplies: 2,      // 同一条人类消息最多触发几个 AI 回复（群级可调）
    dailyLimitDefault: Number(process.env.AGENT_DAILY_LIMIT_DEFAULT || 1000), // 每 AI 每日上限（主人可调）
    groupDailyLimitDefault: Number(process.env.GROUP_DAILY_LIMIT_DEFAULT || 600), // 全群 AI 每日合计（0=不限）
    bucketCapacity: Number(process.env.AGENT_BUCKET_CAPACITY || 5),   // 令牌桶容量（突发额度）
    bucketRefillPerMin: Number(process.env.AGENT_BUCKET_REFILL_PER_MIN || 10), // 每分钟补充速率
    // 空间说说：AI 每天最多发几条（人类侧不限制）。没有说话的上限，只有「发说说」的上限——
    // 群内发言的令牌桶是「每组」的，说说没有会话维度，所以用一个独立的日配额兜底防刷屏。
    feedDailyLimit: Number(process.env.AGENT_FEED_DAILY_LIMIT || 10),
    // 熔断模式：enforce = 触发就暂停（默认，任务书口径）；observe = 只记 BreakerObserved 事件、不暂停。
    // 想在真实流量上先观察阈值是否合适，就把这个设成 observe 跑一阵再切回 enforce。
    breakerMode: (process.env.GATING_BREAKER_MODE || 'enforce').toLowerCase() === 'observe' ? 'observe' : 'enforce',
  },
};

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.writerDatabaseUrl) missing.push('WRITER_DATABASE_URL');
  // [P0-1] 媒体签名/会话密钥必须显式配置：留空直接起不来，比文档里一行 warn 可靠
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (missing.length) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
  // 推送密钥是「要么都有、要么都没有」：只配一半是最常见的部署事故（按钮点了不响，日志也不说为什么）
  const hasPub = Boolean(config.vapid.publicKey);
  const hasPriv = Boolean(config.vapid.privateKey);
  if (hasPub !== hasPriv) {
    throw new Error('VAPID_PUBLIC_KEY 与 VAPID_PRIVATE_KEY 必须同时配置（或同时留空以关闭系统通知）');
  }
  if (hasPub) {
    if (!/^(mailto:|https:)/i.test(config.vapid.subject)) {
      throw new Error('VAPID_SUBJECT 必须是 mailto: 或 https: 开头的联系方式');
    }
  }
  // 邀请制：拼错模式名当成「开放注册」是最危险的静默失败（INVITE_MODE=DB 这种大小写
  // 已经在读取时 lower 掉了，剩下的都当配置错误处理）。
  if (!['', 'db'].includes(config.inviteMode)) {
    throw new Error(`未知的 INVITE_MODE=${config.inviteMode}（只支持 db，或留空走兼容模式）`);
  }
  // 不配 INVITE_PEPPER 不算致命：会回退到只用 SESSION_SECRET（见 core/invites.mjs#inviteKey）。
  // 但要在启动日志里说出来，免得有人以为 pepper 已经在生效。
  if (config.inviteMode === 'db' && !config.invitePepper) {
    console.warn('[config] INVITE_MODE=db 但未配置 INVITE_PEPPER：邀请码哈希退化为只用 SESSION_SECRET（可用，但少一层隔离）；且日后补配该值会让所有已发出的码失效');
  }
  if (!Number.isInteger(config.inviteQuotaDefault) || config.inviteQuotaDefault < 0) {
    throw new Error('INVITE_QUOTA_DEFAULT 必须是 >=0 的整数');
  }
  if (!Number.isInteger(config.inviteTtlDays) || config.inviteTtlDays < 1 || config.inviteTtlDays > 365) {
    throw new Error('INVITE_TTL_DAYS 必须是 1..365 的整数');
  }
  // 防刷闸门的配置错误必须启动即炸：写成 0 会把「所有人都不能兑换」伪装成「功能坏了」，
  // 写成字符串 'None' 会让比较永远为 false（闸门静默失效）——两种都比启动失败糟。
  if (!Number.isInteger(config.inviteMaxPerIpDay) || config.inviteMaxPerIpDay < 1) {
    throw new Error('INVITE_MAX_PER_IP_DAY 必须是 >=1 的整数（同一 IP 24 小时内允许的成功兑换数）');
  }
  if (!Number.isInteger(config.inviteMaxDepth) || config.inviteMaxDepth < 1 || config.inviteMaxDepth > 64) {
    throw new Error('INVITE_MAX_DEPTH 必须是 1..64 的整数（邀请链最大深度）');
  }
  if (!['invite', 'waitlist', 'open'].includes(config.signupMode)) {
    throw new Error("SIGNUP_MODE 只能是 invite|waitlist|open（留空 = invite）");
  }
  if (config.signupMode === 'open') {
    // 不阻止（私域试点合法），但必须把风险喊出来：没有验证时 open 等于敞开注册
    console.warn('[config] SIGNUP_MODE=open：注册不需要邀请码，且本实例没有邮箱/手机验证');
  }
  if (!Number.isInteger(config.thumbConcurrency) || config.thumbConcurrency < 1 || config.thumbConcurrency > 8) {
    throw new Error('THUMB_CONCURRENCY 必须是 1..8 的整数（同时解码的缩略图上限）');
  }
  // 发信配置：端口写错会让「验证邮件发不出去」伪装成「用户没收到」，启动即报错更省事。
  // 注意：SMTP 没配是**合法状态**（功能关闭），只有「写了一半」才是错误。
  if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535) {
    throw new Error('SMTP_PORT 必须是 1..65535 的整数');
  }
  if (config.smtp.host && config.smtp.secure && config.smtp.port === 587) {
    console.warn('[config] SMTP_SECURE=true 但用的是 587：587 一般走 STARTTLS（SET SMTP_SECURE=false）');
  }
  if (!['', 'off', 'optional', 'required'].includes(config.emailVerifyMode)) {
    throw new Error("EMAIL_VERIFY_MODE 只能是 off|optional|required（留空 = optional）；写成别的值会静默改变门禁语义");
  }
  if (config.emailVerifyMode === 'required' && !config.smtp.host) {
    throw new Error('EMAIL_VERIFY_MODE=required 但没配 SMTP_HOST：这会把所有人挡在登录之外');
  }
}
