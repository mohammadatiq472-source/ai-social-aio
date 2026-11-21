import { randomUUID } from 'node:crypto';
import { withTx, withWriterTx, pool, query } from '../db.mjs';
import { config } from '../config.mjs';
import { publishMessage, deliverAnnouncement } from '../ws/hub.mjs';
import { publishFeed, addComment, addLike, removeLike } from './feed.mjs';
import { hydrateParts } from '../media.mjs';
import { assertNotSuspended } from './suspend.mjs';

// ============================================================================
// [C3][M1][M5] 唯一写入口。人类与 AI 都必须走这里；禁止任何地方直接 INSERT 读模型表。
//   - 人类 actor 用 qqmini_app 角色的事务
//   - AI   actor 用 mcp_writer 角色的事务（只能 INSERT events + 调 SECURITY DEFINER 投影函数）
// ============================================================================

const ok = (extra = {}) => ({ accepted: true, ...extra });
// extra 里放机器可读字段（reason_code / retry_after_ms / limits）：MCP 层原样透传给 Agent，
// 让它能「sleep 后重试」，而不是把失败当终局、或者把没发出去说成发出去了。
const fail = (reason, message, extra = {}) => ({ accepted: false, reason, message, ...extra });

// 进程内滑动窗口限流（单机；重启清零，可接受）
// 导出给 HTTP 层复用（举报/搜索这类不进 submit 的读或旁路写）：不要在路由里各写一份，
// 否则「哪个入口按什么频率限流」会散在多个文件里，调阈值时容易漏。
const rateBuckets = new Map();
export function hitRate(key, limitPerMinute) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (rateBuckets.get(key) || []).filter((t) => t > windowStart);
  if (arr.length >= limitPerMinute) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ============================================================================
// [M1] 真正的「每小时」滚动窗口。
//
// 为什么单独一个函数：hitRate 是 60 秒窗，历史调用（举报/搜索/发消息的瞬时洪泛）
// 全按它的语义调阈值，改它等于同时改一堆不相干的限额。社交模块的文案写的是
// 「每小时 N 次」，就必须有一个真的 3600s 窗口可用，否则文案与实际差 60 倍
// （外部评审 2026-11-15 的 M1：AI 好友请求/新私聊实测 600 次/小时）。
//
// nowMs 可注入：回归脚本要断言「61 秒后仍拦、3601 秒放行」而不真等一小时。
// ============================================================================
const hourBuckets = new Map();
let hourSweepAt = 0;
export function hitRateHour(key, limitPerHour, nowMs = Date.now()) {
  const limit = Math.max(1, Number(limitPerHour) || 1);
  // 轻量清扫：键只增不减会一直吃内存（评审 L7 的同类问题）。
  // 10 分钟一次，把已经滑出窗口的空桶删掉；不按访问顺序做 LRU（没必要，量很小）。
  if (nowMs - hourSweepAt >= 600_000) {
    hourSweepAt = nowMs;
    for (const [k, arr] of hourBuckets) {
      if (!arr.some((t) => nowMs - t < 3_600_000)) hourBuckets.delete(k);
    }
  }
  const windowStart = nowMs - 3_600_000;
  const arr = (hourBuckets.get(key) || []).filter((t) => t > windowStart);
  if (arr.length >= limit) {
    hourBuckets.set(key, arr);
    return false;
  }
  arr.push(nowMs);
  hourBuckets.set(key, arr);
  return true;
}

const UUID_RE = /^[0-9a-zA-Z_-]{8,64}$/;

// 一条消息的 parts：文本/图片/语音/视频/表情/文件/网页
// [外链富内容] docs/富内容外链.md §2：image/voice/video/file/html 允许用 https 外链
// 代替 attachment_id。二进制一律不进本站：这里只做形状与安全校验，不抓取、不转存、不转码。
const PART_TYPES = new Set(['text', 'image', 'voice', 'video', 'file', 'sticker', 'html']);
// 预览文案（会话列表 / 引用条 / 没有文本段的消息气泡）
const PREVIEW_TEXT = {
  image: '[图片]', voice: '[语音]', video: '[视频]',
  file: '[文件]', html: '[网页]', sticker: '[表情]',
};

// —— 契约 §2.1 的硬上限：改这里必须同步 docs/富内容外链.md 与 MCP 侧 inputSchema ——
const MAX_PARTS = 5;              // 一条消息最多 5 段
const MAX_TEXT_LEN = 4000;        // 文本段合计
const MAX_URL_LEN = 2048;         // 外链长度
const MAX_NAME_LEN = 60;          // file.name / html.title
const MAX_FILE_NAME_LEN = 80;     // files[].name
const MAX_MIME_LEN = 80;
const MAX_ALT_LEN = 120;
const MAX_DURATION_MS = 3_600_000;
const MAX_DIMENSION = 10_000;
const MAX_BYTES = 2 ** 31;        // 2 GiB
const MAX_FILES = 50;             // 文件包清单条数
const MAX_SRCDOC_LEN = 24_576;    // 24KB（存进 events，可审计）

// javascript: / data: / file: 这类自带执行或本地文件语义的协议一律拒
const DANGEROUS_SCHEME_RE = /^(?:javascript|data|file|vbscript|blob):/i;

// 段级校验结果：失败时 reason 固定 invalid_schema，message 要能让调用方看懂改哪
const badPart = (message) => ({ ok: false, reason: 'invalid_schema', message });

// https 外链：只认 https、≤2048、不允许内嵌 user:pass@。
// 返回原始字符串（不改写），因为签名 URL 的 query 不能被 URL 规范化重新编码。
function readHttpsUrl(raw, label) {
  if (typeof raw !== 'string') return badPart(`${label} 必须是 https 外链字符串`);
  const url = raw.trim();
  if (!url) return badPart(`${label} 不能为空`);
  if (url.length > MAX_URL_LEN) {
    return badPart(`${label} 最长 ${MAX_URL_LEN} 字符，当前 ${url.length} 字符；请换成更短的外链`);
  }
  if (DANGEROUS_SCHEME_RE.test(url)) {
    return badPart(`${label} 只能是 https:// 外链，禁止 javascript: / data: / file:`);
  }
  if (!/^https:\/\//i.test(url)) {
    return badPart(`${label} 必须以 https:// 开头（http:// 明文、相对路径、//host 协议相对都不行）`);
  }
  if (/\s/.test(url)) return badPart(`${label} 不能包含空格或换行`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return badPart(`${label} 不是合法的 URL`);
  }
  if (parsed.protocol !== 'https:') return badPart(`${label} 只能是 https:// 外链`);
  if (parsed.username || parsed.password) {
    return badPart(`${label} 不允许内嵌账号密码（user:pass@ 形式）`);
  }
  if (!parsed.hostname) return badPart(`${label} 缺少域名`);
  return { ok: true, value: url };
}

// 可选整数字段：缺省放过，给了就必须落在 [min, max]
function readOptInt(raw, label, min, max) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return badPart(`${label} 必须是 ${min}..${max} 的整数（当前 ${Number.isFinite(n) ? n : String(raw)}）`);
  }
  return { ok: true, value: n };
}

// 可选字符串字段：允许空串（alt 这类），只卡长度
function readOptStr(raw, label, max) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return badPart(`${label} 必须是字符串`);
  const s = raw.trim();
  if (s.length > max) return badPart(`${label} 最长 ${max} 字符（当前 ${s.length}）`);
  return { ok: true, value: s };
}

// 可选名字类字段：给了就必须 1..max（name / title / mime）
function readOptName(raw, label, max) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return badPart(`${label} 必须是字符串`);
  const s = raw.trim();
  if (s.length < 1 || s.length > max) {
    return badPart(`${label} 必须是 1..${max} 字符（当前 ${s.length}）`);
  }
  return { ok: true, value: s };
}

function readAttachmentId(raw, label) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return badPart(`${label} 必须是正整数（本站附件 id）`);
  return { ok: true, value: id };
}

// 外链段的可选元数据白名单：字段名 → 校验规则（attachment_id 变体不接受客户端覆盖）
const META_RULES = {
  mime: { kind: 'name', max: MAX_MIME_LEN },
  alt: { kind: 'str', max: MAX_ALT_LEN },
  width: { kind: 'int', min: 0, max: MAX_DIMENSION },
  height: { kind: 'int', min: 0, max: MAX_DIMENSION },
  duration_ms: { kind: 'int', min: 0, max: MAX_DURATION_MS },
  bytes: { kind: 'int', min: 0, max: MAX_BYTES },
};

// 按白名单把可选元数据拷进 part（失败返回 badPart）
function applyMeta(part, p, at, keys) {
  for (const key of keys) {
    const rule = META_RULES[key];
    const v = p[key];
    if (v === undefined || v === null) continue;
    let r;
    if (rule.kind === 'int') r = readOptInt(v, `${at}.${key}`, rule.min, rule.max);
    else if (rule.kind === 'name') r = readOptName(v, `${at}.${key}`, rule.max);
    else r = readOptStr(v, `${at}.${key}`, rule.max);
    if (!r.ok) return r;
    part[key] = r.value;
  }
  return { ok: true };
}

// 返回 { ok:true, parts } 或 { ok:false, reason, message }（调用方直接 fail(reason, message)）
export function normalizeParts(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PARTS) {
    return badPart(`parts 必须是有序数组，1..${MAX_PARTS} 段`);
  }
  const out = [];
  let textLen = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const p = raw[i];
    const at = `parts[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return badPart(`${at} 必须是对象`);
    if (!PART_TYPES.has(p.type)) {
      return badPart(`${at}.type 不支持：${JSON.stringify(p.type)}（可用 text/image/voice/video/file/sticker/html）`);
    }

    if (p.type === 'text') {
      if (typeof p.text !== 'string') return badPart(`${at}.text 必须是字符串`);
      const t = p.text.replace(/\r\n/g, '\n').trim();
      if (!t) return badPart(`${at}.text 不能为空`);
      textLen += t.length;
      out.push({ type: 'text', text: t });
      continue;
    }

    if (p.type === 'sticker') {
      if (!/^[a-z0-9-]{2,40}$/.test(String(p.pack || '')) || !/^[a-z0-9-]{2,40}$/.test(String(p.key || ''))) {
        return badPart(`${at} 表情段需要 pack 与 key（小写字母/数字/连字符，2..40 位）`);
      }
      const caption = readOptStr(p.caption, `${at}.caption`, 80);
      if (!caption.ok) return caption;
      const part = { type: 'sticker', pack: String(p.pack), key: String(p.key), caption: caption.value || '' };
      out.push(part);
      continue;
    }

    // —— 以下都是内容段：url（https 外链）或 attachment_id（本站附件）二选一 ——

    if (p.type === 'html') {
      const part = { type: 'html' };
      if (p.url !== undefined && p.url !== null) {
        const url = readHttpsUrl(p.url, `${at}.url`);
        if (!url.ok) return url;
        part.url = url.value;
        // 契约 §2.1：同时给 url 与 srcdoc 时以 url 为准（srcdoc 不落库，省体积）
      } else if (p.srcdoc !== undefined && p.srcdoc !== null) {
        if (typeof p.srcdoc !== 'string') return badPart(`${at}.srcdoc 必须是字符串`);
        if (!p.srcdoc.trim()) return badPart(`${at}.srcdoc 不能为空`);
        if (p.srcdoc.length > MAX_SRCDOC_LEN) {
          return badPart(`${at}.srcdoc 最长 ${MAX_SRCDOC_LEN} 字符（24KB），当前 ${p.srcdoc.length} 字符`);
        }
        part.srcdoc = p.srcdoc;
      } else {
        return badPart(`${at} 需要 url（https 外链）或 srcdoc（≤${MAX_SRCDOC_LEN} 字符）`);
      }
      const title = readOptName(p.title, `${at}.title`, MAX_NAME_LEN);
      if (!title.ok) return title;
      if (title.value !== undefined) part.title = title.value;
      const height = readOptInt(p.height, `${at}.height`, 0, MAX_DIMENSION);
      if (!height.ok) return height;
      if (height.value !== undefined) part.height = height.value;
      out.push(part);
      continue;
    }

    if (p.type === 'file') {
      const part = { type: 'file' };
      const hasUrl = p.url !== undefined && p.url !== null;
      // 人类上传的 PDF 仍走 attachment_id；Agent 走 https 外链（契约 §2 的 file 行）
      if (hasUrl) {
        const url = readHttpsUrl(p.url, `${at}.url`);
        if (!url.ok) return url;
        part.url = url.value;
      } else if (p.attachment_id !== undefined && p.attachment_id !== null) {
        const id = readAttachmentId(p.attachment_id, `${at}.attachment_id`);
        if (!id.ok) return id;
        part.attachment_id = id.value;
      } else {
        return badPart(`${at} 需要 url（https 外链）或 attachment_id（本站附件 id）`);
      }
      const name = readOptName(p.name, `${at}.name`, MAX_NAME_LEN);
      if (!name.ok) return name;
      if (name.value !== undefined) part.name = name.value;
      // 外链文件必须显式给名字：链接里看不出来是什么文件
      else if (hasUrl) return badPart(`${at} 用外链时必须带 name（文件名，1..${MAX_NAME_LEN} 字符）`);
      const meta = applyMeta(part, p, at, ['bytes', 'mime']);
      if (!meta.ok) return meta;
      if (p.files !== undefined && p.files !== null) {
        if (!Array.isArray(p.files)) return badPart(`${at}.files 必须是数组（包内清单）`);
        if (p.files.length > MAX_FILES) {
          return badPart(`${at}.files 最多 ${MAX_FILES} 项（当前 ${p.files.length}）`);
        }
        const files = [];
        for (let j = 0; j < p.files.length; j += 1) {
          const f = p.files[j];
          const fat = `${at}.files[${j}]`;
          if (!f || typeof f !== 'object' || Array.isArray(f)) return badPart(`${fat} 必须是 {name, bytes?} 对象`);
          const fname = readOptName(f.name, `${fat}.name`, MAX_FILE_NAME_LEN);
          if (!fname.ok) return fname;
          if (fname.value === undefined) return badPart(`${fat}.name 必填（1..${MAX_FILE_NAME_LEN} 字符）`);
          const item = { name: fname.value };
          if (f.bytes !== undefined && f.bytes !== null) {
            const b = readOptInt(f.bytes, `${fat}.bytes`, 0, MAX_BYTES);
            if (!b.ok) return b;
            item.bytes = b.value;
          }
          files.push(item);
        }
        part.files = files;
      }
      out.push(part);
      continue;
    }

    // image / voice / video
    const part = { type: p.type };
    const hasUrl = p.url !== undefined && p.url !== null;
    if (!hasUrl && (p.attachment_id === undefined || p.attachment_id === null)) {
      return badPart(`${at} 需要 url（https 外链）或 attachment_id（本站附件 id）`);
    }
    if (hasUrl) {
      const url = readHttpsUrl(p.url, `${at}.url`);
      if (!url.ok) return url;
      part.url = url.value;
    } else {
      const id = readAttachmentId(p.attachment_id, `${at}.attachment_id`);
      if (!id.ok) return id;
      part.attachment_id = id.value;
    }

    if (p.type === 'video') {
      // 视频封面：外链用 poster_url，本站附件用 poster_attachment_id（客户端抽帧后单独上传）
      if (p.poster_url !== undefined && p.poster_url !== null) {
        const poster = readHttpsUrl(p.poster_url, `${at}.poster_url`);
        if (!poster.ok) return poster;
        part.poster_url = poster.value;
      }
      if (p.poster_attachment_id !== undefined && p.poster_attachment_id !== null) {
        const pid = readAttachmentId(p.poster_attachment_id, `${at}.poster_attachment_id`);
        if (!pid.ok) return pid;
        part.poster_attachment_id = pid.value;
      }
    }

    // 元数据只对「外链变体」生效；attachment_id 变体由 hydrateParts 统一补，避免客户端覆盖
    if (hasUrl) {
      const keys = p.type === 'image'
        ? ['width', 'height', 'alt', 'mime']
        : p.type === 'voice'
          ? ['duration_ms', 'mime']
          : ['duration_ms', 'width', 'height', 'mime'];
      const meta = applyMeta(part, p, at, keys);
      if (!meta.ok) return meta;
    }
    out.push(part);
  }

  if (textLen > MAX_TEXT_LEN) return badPart(`文本段合计最多 ${MAX_TEXT_LEN} 字符（当前 ${textLen}）`);
  return { ok: true, parts: out };
}

// 档位别名：旧值 mention→low，free→high
const LEVEL_ALIAS = { mention: 'low', free: 'high', off: 'off', low: 'low', mid: 'mid', high: 'high' };
// 档位越高，冷却越短
// 门控口径（评审任务书）：速率交给令牌桶（agents.bucket_capacity / bucket_refill_per_min），
// 不再用「按档位固定冷却 15/30/60 秒」——那对正常高频发言是系统性误伤。
const GREETING_WINDOW_MS = 10 * 60_000; // 入群问候窗口
const GREETING_MAX = 2;                 // 窗口内免 @ 问候最多 2 条
const MID_PROACTIVE_WINDOW = '10 minutes';
const MID_PROACTIVE_MAX = 2;
const BREAKER_WINDOW = '10 minutes';
const BREAKER_MIN_TOTAL = 20;
const BREAKER_RELAY_RATIO = 0.8;

function normalizeBody(raw) {
  if (typeof raw !== 'string') return null;
  const body = raw.replace(/\r\n/g, '\n').trim();
  if (body.length < 1 || body.length > 4000) return null;
  return body;
}

function normalizeMentions(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw.slice(0, 50)) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

async function getMembership(conversationId, principalId) {
  const { rows } = await pool.query(
    `SELECT cm.role, cm.reply_mode, cm.allow_ai_relay, cm.joined_at,
            c.owner_id, c.type, c.title, c.agent_daily_limit, c.agent_round_quota,
            c.agent_relay_max_depth
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.conversation_id = $1 AND cm.principal_id = $2`,
    [conversationId, principalId],
  );
  return rows[0] || null;
}

// [C10] AI 发言门控（语义层）
//
// 只做「该不该回」的判断：档位、@、relay 深度、系统消息、入群问候豁免、日限/群预算。
// 速率不再看固定冷却，交给事务里的令牌桶（qm_take_agent_token）——这样「连发 5 条打招呼」
// 不会被 60 秒冷却拦，而「每秒刷一条」会在第 6 条拿到带 retry_after_ms 的结构化拒绝。
//
// q：调用方传 pool.query（事务外）或 client.query.bind(client)（事务内，advisory lock 之后）。
async function checkAgentGating(q, actor, membership, command) {
  // 1:1 私聊没有「@」这回事：对话本身就是对着你；档位/relay/每轮人数都不适用，
  // 只保留日限与令牌桶（防刷屏）。群里那套语义一行都不改。
  const isDm = membership.type === 'c2c';
  const level = isDm ? 'high' : LEVEL_ALIAS[membership.reply_mode] || 'low';
  if (level === 'off' && !isDm) {
    return fail('gating_off', '该 AI 在此群已被设为只看不回', { reason_code: 'agent_muted' });
  }

  // 先把"要回的那条消息"取出来：@ 判定、relay 判定、深度判定都靠它
  let target = null;
  if (command.reply_to_seq) {
    const { rows } = await q(
      `SELECT sender_id, sender_type, mentions, created_at, relay_depth, kind
         FROM messages WHERE conversation_id = $1 AND seq = $2`,
      [command.conversation_id, command.reply_to_seq],
    );
    target = rows[0] || null;
  }

  // 系统消息（表情包分享这类事件反馈）不是「有人在跟你说话」，AI 一律不回
  if (target?.kind === 'system') {
    return fail('gating_system_notice', '这是一条系统提示，不需要回复', { reason_code: 'system_notice' });
  }

  // @ 判定只看「它要回的那条消息有没有 @ 它」。绝不允许自己把自己写进 mentions。
  const mentioned = (target?.mentions || []).map(Number).includes(actor.id);

  // 入群问候（任务书 §4）：刚被拉进群 10 分钟内，免 @ 最多发 2 条——打招呼是社交礼仪，
  // 不是刷屏。计数复用「主动插话」的 10 分钟窗口，不新增独立计数器。
  const joinedAt = membership.joined_at ? new Date(membership.joined_at).getTime() : 0;
  const inGreetingWindow = joinedAt > 0 && Date.now() - joinedAt <= GREETING_WINDOW_MS;
  let greetingUsed = 0;
  if (inGreetingWindow && !mentioned) {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM messages
        WHERE conversation_id = $1 AND sender_id = $2
          AND created_at > GREATEST(now() - interval '10 minutes', $3::timestamptz)`,
      [command.conversation_id, actor.id, membership.joined_at],
    );
    greetingUsed = Number(rows[0]?.n || 0);
  }
  const greetingAllowed = inGreetingWindow && !mentioned && greetingUsed < GREETING_MAX;

  // relay：AI 回 AI 需要该 AI 在此群开启 relay，且接力深度 < 群配置上限（默认 2）
  if (!isDm && target?.sender_type === 'agent') {
    if (!membership.allow_ai_relay) {
      return fail('gating_no_ai_to_ai', '该 AI 未开启「接 AI 的话」（relay）；请回复人类消息，或让主人在设置里打开', {
        reason_code: 'relay_disabled',
      });
    }
    const maxDepth = Number(membership.agent_relay_max_depth ?? 2);
    if (Number(target.relay_depth || 0) >= maxDepth) {
      return fail('gating_relay_depth', `接力已到上限（深度 ${maxDepth}），请等人类成员接话`, {
        reason_code: 'relay_depth',
        max_depth: maxDepth,
      });
    }
  }

  if (!isDm && level === 'low') {
    if (!mentioned && !greetingAllowed) {
      return fail(
        'gating_mention_required',
        '当前档位是「低（只回 @）」。先看 whats_new 里 may_reply=true 的消息，再用 reply_to_seq 引用它回复',
        { reason_code: 'mention_required', hint: '要么被 @，要么在入群 10 分钟内打招呼（最多 2 条）' },
      );
    }
  } else if (!isDm && level === 'mid') {
    if (!mentioned && !greetingAllowed) {
      if (!target || target.sender_type === 'agent') {
        return fail('gating_proactive_requires_context', '「中」档主动插话必须引用最近的一条人类消息', {
          reason_code: 'proactive_needs_context',
        });
      }
      const ageMs = Date.now() - new Date(target.created_at).getTime();
      if (ageMs > 5 * 60_000) {
        return fail('gating_proactive_stale', '「中」档只能接最近 5 分钟内的人类消息', { reason_code: 'proactive_stale' });
      }
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM messages
          WHERE conversation_id = $1 AND sender_id = $2
            AND sender_type = 'agent' AND created_at > now() - interval '${MID_PROACTIVE_WINDOW}'`,
        [command.conversation_id, actor.id],
      );
      if (Number(rows[0]?.n || 0) >= MID_PROACTIVE_MAX) {
        return fail('gating_proactive_quota', `「中」档 10 分钟内最多主动插话 ${MID_PROACTIVE_MAX} 次`, {
          reason_code: 'proactive_quota',
          retry_after_ms: 60_000,
        });
      }
    }
  }

  // 每 AI 每日上限（主人可调；默认 1000）
  const dailyLimit = Number(actor.dailyLimit || config.gating.dailyLimitDefault);
  const { rows: dayRows } = await q(
    `SELECT count(*)::int AS n FROM messages
      WHERE sender_id = $1 AND sender_type = 'agent' AND created_at > date_trunc('day', now())`,
    [actor.id],
  );
  if (Number(dayRows[0]?.n || 0) >= dailyLimit) {
    return fail('gating_daily_limit', `已达到今日发言上限（${dailyLimit} 条），明天 0 点恢复`, {
      reason_code: 'daily_limit',
      retry_after_ms: msUntilTomorrow(),
      limits: { daily_limit: dailyLimit, used_today: Number(dayRows[0].n) },
    });
  }

  // [C10] 群级日预算：整群所有 AI 加起来今天说多少条
  const groupLimit = Number(membership.agent_daily_limit ?? config.gating.groupDailyLimitDefault);
  if (groupLimit > 0) {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM messages
        WHERE conversation_id = $1 AND sender_type = 'agent'
          AND created_at > date_trunc('day', now())`,
      [command.conversation_id],
    );
    if (Number(rows[0]?.n || 0) >= groupLimit) {
      return fail('gating_group_budget', `本群今日 AI 发言总额度（${groupLimit} 条）已用完，明天 0 点恢复`, {
        reason_code: 'group_budget',
        retry_after_ms: msUntilTomorrow(),
        limits: { group_daily_limit: groupLimit, group_used_today: Number(rows[0].n) },
      });
    }
  }
  return null;
}

/** 到本地次日 0 点的毫秒数（日限/群预算的 retry_after_ms） */
function msUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, tomorrow.getTime() - now.getTime());
}

/** 取令牌（事务内，advisory lock 之后）：原子扣减，拒绝时给出精确的 retry_after_ms */
async function takeAgentToken(q, actor, conversationId) {
  const { rows: cfgRows } = await q(
    'SELECT bucket_capacity, bucket_refill_per_min FROM agents WHERE principal_id = $1',
    [actor.id],
  );
  const cfg = cfgRows[0] || {};
  const capacity = Number(cfg.bucket_capacity ?? config.gating.bucketCapacity);
  const refill = Number(cfg.bucket_refill_per_min ?? config.gating.bucketRefillPerMin);
  const { rows } = await q('SELECT * FROM qm_take_agent_token($1,$2,$3,$4)', [
    actor.id,
    conversationId,
    capacity,
    refill,
  ]);
  const row = rows[0] || { allowed: false, tokens: 0, retry_after_ms: 60000 };
  return {
    allowed: row.allowed === true,
    tokens: Number(row.tokens),
    retry_after_ms: Number(row.retry_after_ms || 0),
    capacity,
    refill_per_min: refill,
  };
}

/**
 * 熔断（任务书 §6）：AI→AI 接力死循环的「停机检查」。
 * 触发条件：同一 Agent 在 10 分钟内发言 ≥20 条，且其中 AI→AI 占比 >80%。
 * 正常活跃永远不会触发；失控循环会在下一次发言后秒级被掐断。
 * 只停这一个 Agent，留下 paused_reason + 群内系统提示，主人可在「我的 AI」里恢复。
 */
async function maybeTripBreaker(actor, conversationId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM messages t
                 WHERE t.conversation_id = m.conversation_id
                   AND t.seq = m.reply_to_seq
                   AND t.sender_type = 'agent'
              )
            )::int AS relay
       FROM messages m
      WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.sender_type = 'agent'
        AND m.created_at > now() - interval '${BREAKER_WINDOW}'`,
    [conversationId, actor.id],
  );
  const total = Number(rows[0]?.total || 0);
  const relay = Number(rows[0]?.relay || 0);
  if (total < BREAKER_MIN_TOTAL || relay / Math.max(total, 1) <= BREAKER_RELAY_RATIO) return;

  // 已经停过就不要重复插系统提示（否则每来一条都会刷一条）
  const { rows: agentRows } = await pool.query('SELECT status FROM agents WHERE principal_id = $1', [actor.id]);
  if (agentRows[0]?.status === 'paused') return;

  // 观察模式：只记事件，不暂停（用来在真实流量上校准阈值，避免误伤）
  if (config.gating.breakerMode === 'observe') {
    await pool.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal',$1,'BreakerObserved',$1,'agent',$2::jsonb)`,
      [actor.id, JSON.stringify({ total, relay, conversation_id: conversationId, would_pause: true })],
    ).catch(() => {});
    console.warn(`[gating] breaker observed (not enforced): agent=${actor.id} total=${total} relay=${relay}`);
    return;
  }

  await pool.query('SELECT qm_pause_agent($1,$2)', [actor.id, 'circuit_breaker']);
  const notice = `「${actor.displayName}」因疑似 AI 之间互相接力（10 分钟内 ${total} 条、其中 ${relay} 条是接 AI 的话）被自动暂停。主人可在「我的 → 我的 AI」里恢复。`;
  try {
    await withTx(async (client) => {
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MessageSent',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ body: notice, kind: 'system', mentions: [], parts: [] })],
      );
      // 系统提示走 qm_apply_system_message：群里显示成居中灰字，不会cosplay成 AI 自己说的话
      await client.query('SELECT qm_apply_system_message($1,$2,$3,$4,$5,$6)', [
        Number(ev.rows[0].id), conversationId, actor.id, actor.type, notice, [],
      ]);
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('principal',$1,'AgentPaused',$1,'agent',$2::jsonb)`,
        [actor.id, JSON.stringify({ reason: 'circuit_breaker', total, relay, conversation_id: conversationId })],
      );
    });
  } catch (err) {
    console.error('[gating] breaker notice failed', err.message);
  }
}

// [C10] 每轮最多 N 个 AI 回复：统计最近 90 秒"回应人类消息"的 AI 发言数。
// relay（AI 回 AI）不计入——否则接力链第一跳就把名额用完。群主可调（conversations.agent_round_quota）。
async function checkRoundQuota(q, conversationId, actor, quotaLimit) {
  const { rows } = await q(
    `SELECT count(*)::int AS n
       FROM messages m
      WHERE m.conversation_id = $1 AND m.sender_type = 'agent'
        AND m.created_at > now() - interval '90 seconds'
        AND (
          m.reply_to_seq IS NULL
          OR EXISTS (
            SELECT 1 FROM messages t
             WHERE t.conversation_id = m.conversation_id
               AND t.seq = m.reply_to_seq
               AND t.sender_type = 'user'
          )
        )`,
    [conversationId],
  );
  const limit = Number(quotaLimit ?? config.gating.perMessageMaxReplies);
  if (rows[0]?.n > 0 && Number(rows[0]?.n || 0) >= limit) {
    return fail('gating_round_quota', `本轮的 AI 发言名额已用完（每轮最多 ${limit} 个 AI 接话），请等下一轮人类消息`, {
      reason_code: 'round_quota',
      retry_after_ms: 90_000,
      limits: { per_message_max_replies: limit },
    });
  }
  return null;
}

// [M3] 表情包可见性下沉到写路径（外部评审 2026-11-15 M3）。
//
// 以前唯一的强制点是 MCP send_message 的预检（server.mjs），而 MCP `dm` 工具和
// 人类 REST POST /api/conversations/:id/messages 都直接进 submit，于是任何登录用户/
// 任何 AI 都能引用别人私有包的 slug+key（slug 还可预测：user<id>-<base36 时间>）。
// 这里放在 submit 里做「一处强制全覆盖」；MCP 预检保留（早失败，省一次事务）。
//
// 为什么用直接 SQL 而不是 import query.mjs#stickerPackVisibleFor：
// query.mjs 依赖写模型/限流（与 submit 同层），互相 import 会成环；这段判定只有
// 三行 SQL，重复一份比引入循环依赖安全。口径必须与 stickerPackVisibleFor 一致：
// official 公开 / 自己的 / 主人代持的 / 已分享到本会话的 group 包。
//
// 不存在与不可见返回同一句文案：否则 slug 变成一个「这个包存在吗」的探测口。
function stickerNotVisible(slug) {
  return fail(
    'sticker_not_visible',
    `表情包「${slug}」不可用：不是公开包，也不属于你或你主人，且没有分享到本会话。`
      + '请用 search_stickers 找自己能用的，或先 create_sticker_pack 自建',
    { reason_code: 'sticker_not_visible' },
  );
}

async function checkStickerVisible(parts, conversationId, actor) {
  const slugs = [...new Set(parts.filter((p) => p.type === 'sticker').map((p) => String(p.pack)))];
  if (!slugs.length) return null;
  const { rows } = await pool.query(
    'SELECT slug, scope, owner_id, group_id FROM sticker_packs WHERE slug = ANY($1::text[])',
    [slugs],
  );
  const bySlug = new Map(rows.map((r) => [String(r.slug), r]));
  const ownerId = actor?.type === 'agent'
    ? Number(actor.ownerUserId) || Number(actor.id)
    : Number(actor.id);
  for (const slug of slugs) {
    const pack = bySlug.get(slug);
    if (!pack) return stickerNotVisible(slug);
    // official / public 都是「全站可见」（与 qm_search_stickers 的可见性口径一致：
    // 009/020 迁移里 sp.scope IN ('official','public')；不能出现「搜得到但发不出」）
    if (pack.scope === 'official' || pack.scope === 'public') continue;
    if (Number(pack.owner_id) === Number(actor.id) || Number(pack.owner_id) === ownerId) continue;
    if (pack.scope === 'group' && Number(pack.group_id) === Number(conversationId)) continue;
    return stickerNotVisible(slug);
  }
  return null;
}

async function sendMessage(command, actor) {
  const conversationId = Number(command.conversation_id);
  // 站务封禁：仍然能读历史，但不能发言（否则封了等于没封）。
  // 判定收在 core/suspend.mjs：groups/social 的新写入口用同一个口径。
  const suspended = assertNotSuspended(actor, '发言');
  if (suspended) return fail(suspended.reason, suspended.message);
  const body = normalizeBody(command.body);
  const clientMsgId = typeof command.client_msg_id === 'string' ? command.client_msg_id : '';
  const replyToSeq = command.reply_to_seq == null ? null : Number(command.reply_to_seq);
  const mentions = normalizeMentions(command.mentions);

  // parts：新形态；不传则把 body 当成唯一文本段（向后兼容）
  let parts = null;
  if (command.parts !== undefined) {
    // [外链富内容] normalizeParts 现在返回结构化结果，拒绝原因直接透传给调用方（告诉他改哪一段哪个字段）
    const checkedParts = normalizeParts(command.parts);
    if (!checkedParts.ok) return fail(checkedParts.reason, checkedParts.message);
    parts = checkedParts.parts;
  } else if (body) {
    parts = [{ type: 'text', text: body }];
  }

  if (!Number.isInteger(conversationId) || conversationId <= 0) return fail('invalid_schema', 'conversation_id 非法');
  if (!parts || parts.length === 0) return fail('invalid_schema', 'body 或 parts 至少要有一段内容');
  if (!UUID_RE.test(clientMsgId)) return fail('invalid_schema', 'client_msg_id 必须是 8..64 位的幂等键');
  if (mentions === null) return fail('invalid_schema', 'mentions 必须是正整数数组');
  if (replyToSeq !== null && (!Number.isInteger(replyToSeq) || replyToSeq <= 0)) {
    return fail('invalid_schema', 'reply_to_seq 非法');
  }

  // 附件归属：只能引用自己上传的（视频封面同理）
  const attIds = parts
    .flatMap((p) => [p.attachment_id, p.poster_attachment_id])
    .filter((v) => v != null)
    .map(Number);
  if (attIds.length) {
    const { rows } = await pool.query(
      'SELECT id FROM attachments WHERE id = ANY($1::bigint[]) AND uploader_id = $2 AND deleted_at IS NULL',
      [attIds, actor.id],
    );
    if (rows.length !== new Set(attIds).size) {
      return fail('forbidden', '只能引用你自己上传的附件');
    }
  }

  // 预览文本：有文本段就用文本，否则用 [图片] / [语音] 这类占位
  // 表情段的 caption 在存储里挂在 sticker_items 上：发送时如果 part 没写 caption，
  // 就从包里回灌一条，避免「别人看图不知道什么意思」（真实互测反馈）。
  for (const part of parts) {
    if (part.type !== 'sticker' || part.caption) continue;
    const { rows } = await pool.query(
      `SELECT si.caption FROM sticker_items si
         JOIN sticker_packs sp ON sp.id = si.pack_id
        WHERE sp.slug = $1 AND si.key = $2 LIMIT 1`,
      [part.pack, part.key],
    );
    if (rows[0]?.caption) part.caption = String(rows[0].caption).slice(0, 80);
  }

  const textJoined = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim();
  const previewBody = (textJoined || PREVIEW_TEXT[parts[0].type] || '[消息]').slice(0, 4000);

  // 静默成功防线：客户端把中文塞进命令行 argv 时，编码坏掉的字节会变成 U+FFFD；
  // 如果照单收下，发送方看到 200/accepted，群里却是一串乱码——比失败更糟。
  const hasBrokenEncoding = (text) => typeof text === 'string' && text.includes('\uFFFD');
  if (hasBrokenEncoding(previewBody) || parts.some((p) => p.type === 'text' && hasBrokenEncoding(p.text))) {
    return fail(
      'invalid_schema',
      '正文包含非法 UTF-8 字符（常见于命令行把中文塞进 argv 时编码损坏）。请把 JSON 写成 UTF-8 文件后用 --data-binary 发送，或改用正确的编码重发',
      { reason_code: 'invalid_encoding' },
    );
  }


  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');

  // 幂等作用域：同一个 client_msg_id 只在「本群」内去重
  const idemScope = `c:${conversationId}`;

  // [幂等优先] 重试必须早于限流与门控
  const dup = await pool.query(
    'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
    [actor.id, idemScope, clientMsgId],
  );
  if (dup.rows[0]) {
    return ok({
      event_id: Number(dup.rows[0].id),
      seq: dup.rows[0].seq == null ? null : Number(dup.rows[0].seq),
      conversation_id: conversationId,
      deduplicated: true,
    });
  }

  // 限流：人类按 60 条/分钟（进程内近似）；AI 的速率交给事务内的令牌桶，
  // 这里只保留一个粗粒度防御，防止单连接瞬间把事件循环刷爆。
  if (actor.type === 'user' && !hitRate(`user:${actor.id}`, 60)) {
    return fail('rate_limited', '发送太频繁，请稍后再试', { reason_code: 'rate_limited', retry_after_ms: 60_000 });
  }

  // [M3] 表情可见性：写路径统一强制（人类 REST / MCP send_message / MCP dm 全覆盖）。
  // 放在幂等早退之后：重试同一条消息不该因为「包后来被删了」而变成失败。
  const stickerBlocked = await checkStickerVisible(parts, conversationId, actor);
  if (stickerBlocked) return stickerBlocked;

  const run = actor.type === 'agent' ? withWriterTx : withTx;
  let outcome;
  try {
    outcome = await run(async (client) => {
      // 幂等在事务内再查一次：并发双请求时唯一会漏的地方就是「查完到写入之间」
      const dup = await client.query(
        'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
        [actor.id, idemScope, clientMsgId],
      );
      if (dup.rows[0]) {
        return { deduplicated: true, eventId: Number(dup.rows[0].id), seq: dup.rows[0].seq == null ? null : Number(dup.rows[0].seq) };
      }

      if (actor.type === 'agent') {
        // [任务书 §7] 检查 + 写入原子化：先拿 advisory lock，再做门控检查与扣令牌。
        // 以前门控在事务外，两个并发连接（不同 client_msg_id）能同时通过冷却/配额。
        await client.query('SELECT pg_advisory_xact_lock($1)', [actor.id]);
        const q = client.query.bind(client);
        const gate = await checkAgentGating(q, actor, membership, { ...command, conversation_id: conversationId, mentions });
        if (gate) return gate;
        if (membership.type !== 'c2c') {
          const quota = await checkRoundQuota(q, conversationId, actor, membership.agent_round_quota);
          if (quota) return quota;
        }
        const token = await takeAgentToken(q, actor, conversationId);
        if (!token.allowed) {
          return fail(
            'rate_limited',
            `发言太快：令牌桶已用完（容量 ${token.capacity}、每分钟补 ${token.refill_per_min} 条）。`
              + `请等待约 ${Math.max(1, Math.ceil(token.retry_after_ms / 1000))} 秒后重试。`,
            {
              reason_code: 'gating_token_bucket',
              retry_after_ms: token.retry_after_ms,
              limits: {
                bucket_capacity: token.capacity,
                bucket_refill_per_min: token.refill_per_min,
                tokens: token.tokens,
              },
            },
          );
        }
      }

      const inserted = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload, client_msg_id, idem_scope)
         VALUES ('conversation', $1, 'MessageSent', $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (actor_id, idem_scope, client_msg_id) DO NOTHING
         RETURNING id`,
        [
          conversationId,
          actor.id,
          actor.type,
          JSON.stringify({ body: previewBody, reply_to_seq: replyToSeq, mentions, parts }),
          clientMsgId,
          idemScope,
        ],
      );

      if (inserted.rows.length === 0) {
        const existing = await client.query(
          'SELECT id, seq FROM events WHERE actor_id = $1 AND idem_scope = $2 AND client_msg_id = $3',
          [actor.id, idemScope, clientMsgId],
        );
        const row = existing.rows[0];
        return { deduplicated: true, eventId: Number(row.id), seq: row.seq == null ? null : Number(row.seq) };
      }

      const eventId = Number(inserted.rows[0].id);
      // [C3] 投影通过 SECURITY DEFINER 函数完成：mcp_writer 自己没有任何写读模型的权限
      const applied = await client.query(
        'SELECT qm_apply_message($1,$2,$3,$4,$5,$6,$7,$8) AS seq',
        [eventId, conversationId, actor.id, actor.type, previewBody, replyToSeq, mentions, JSON.stringify(parts)],
      );
      return { deduplicated: false, eventId, seq: Number(applied.rows[0].seq) };
    });
  } catch (err) {
    console.error('[submit] send_message failed', err.message);
    return fail('internal', '写入失败，请重试', { reason_code: 'internal' });
  }

  // 门控拒绝：事务里没有写任何东西，直接返回（不要发布 WS 帧）
  if (outcome.accepted === false) return outcome;

  // 引用预览：WS 帧直接带上，前端不用为"被引用消息不在本地窗口"再补一次请求
  let replyPreview = null;
  let replySenderName = null;
  if (replyToSeq) {
    const { rows } = await pool.query(
      `SELECT m.body, p.display_name FROM messages m JOIN principals p ON p.id = m.sender_id
        WHERE m.conversation_id = $1 AND m.seq = $2`,
      [conversationId, replyToSeq],
    );
    if (rows[0]) {
      replyPreview = String(rows[0].body).slice(0, 40);
      replySenderName = rows[0].display_name;
    }
  }

  const message = {
    conversationId,
    seq: outcome.seq,
    eventId: outcome.eventId,
    clientMsgId,
    senderId: actor.id,
    senderType: actor.type,
    senderName: actor.displayName,
    avatarHue: actor.avatarHue ?? 200,
    avatarUrl: actor.avatarUrl ?? null,
    body: previewBody,
    // 注意：这份 parts 只用于 WS 广播帧，而帧是「整条只 stringify 一次、全群共用」的。
    // 所以必须按**非上传者视角**（viewer=null）签：扫描未完成的附件（pending）在这里不带 URL，
    // 否则上传者的审核中图片会把签名地址广播给全群（外部审查 Q6）。
    // 上传者本人要看自己的预览，走读路径（REST 消息列表 / MCP whats_new），那里 viewer=自己。
    parts: await hydrateParts(parts, null),
    replyToSeq,
    replyPreview,
    replySenderName,
    mentions,
    createdAt: new Date().toISOString(),
  };
  if (!outcome.deduplicated) publishMessage(message);
  // 熔断是「停机检查」：正常活跃永不触发，失控循环在下一条消息后被掐断。
  if (actor.type === 'agent' && !outcome.deduplicated) {
    maybeTripBreaker(actor, conversationId).catch((err) => console.error('[gating] breaker check failed', err.message));
  }
  return ok({
    event_id: outcome.eventId,
    seq: outcome.seq,
    conversation_id: conversationId,
    deduplicated: outcome.deduplicated,
  });
}

// 拉人规则（create_group 与 add_member 共用）：只能拉「好友」或「自己的 AI」。
// 不加这条的话，任何人只要知道对方号码就能把他拖进任意群——这是隐私漏洞。
// 护栏计数：加入的群数 / 群成员数（用户 2026-11-13 定的口径：每人 50 群、单群 500 人）
async function joinedGroupCount(client, principalId) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM conversation_members WHERE principal_id = $1', [principalId]);
  return Number(rows[0].n);
}

/**
 * 群容量守卫：**先锁会话行、再数人数**，把「数人数」和「插人」放进同一个串行区间。
 *
 * 为什么必须锁 conversations 行（外部审查 Q10）：`SELECT count(*)` 与 `INSERT` 之间没有任何
 * 互斥，两个并发入群请求都会读到「还差 1 个」，然后都插入 → 最终 501 人。
 * 锁住会话行后，后到的事务要等前一个提交；PostgreSQL 默认 READ COMMITTED，每条语句取新快照，
 * 所以它拿到锁之后重新 count 就能看到前一个已提交的插入（这也是为什么锁必须在这条 count 之前）。
 *
 * 为什么不用 conversations.member_count 冗余列（审查给的另一个选项）：那需要迁移，而且多一个
 * 必须与 conversation_members 永远同步的字段——漏一处就永久漂移，比竞态更难查；
 * 行锁不动 schema，代价只是同一个群的并发写入串行化，而入群本来就是低频操作
 * （500 人的群不会每秒进人）。
 *
 * 调用约束：必须在 withTx 里调用，且**先锁行、后 INSERT**；三个入口共用这一段
 * （groups#requestJoin 的 open 分支、groups#decideJoinRequest 的 accept 分支、这里的 addMember），
 * 各写一份迟早漏一份——Q10 的原始缺陷就是「两处都写了一遍同样的 count，两处都漏了锁」。
 */
export async function lockGroupAndCount(client, conversationId, maxMembers = config.limits.maxGroupMembers) {
  const { rows } = await client.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  if (!rows[0]) return { exists: false, size: 0, full: false };
  const { rows: cnt } = await client.query(
    'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  );
  const size = Number(cnt[0].n);
  return { exists: true, size, full: size >= maxMembers };
}

async function canInvite(client, actorId, principalId) {
  const mine = await client.query('SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2', [principalId, actorId]);
  if (mine.rows[0]) return true;
  const friend = await client.query(
    `SELECT 1 FROM friendships
      WHERE status = 'accepted'
        AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
      LIMIT 1`,
    [actorId, principalId],
  );
  return Boolean(friend.rows[0]);
}

async function createGroup(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', '只有人类用户可以建群');
  const title = typeof command.title === 'string' ? command.title.trim() : '';
  if (title.length < 1 || title.length > 60) return fail('invalid_schema', '群名必须是 1..60 字符');
  const rawIds = Array.isArray(command.member_ids) ? command.member_ids : [];
  const memberIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].filter((n) => n !== actor.id);
  if (memberIds.length > 50) return fail('invalid_schema', '一次最多拉 50 人');
  // 建群也要限流：否则可以无限建群刷别人的会话列表
  if (!hitRate(`group:${actor.id}`, 5)) return fail('rate_limited', '建群太频繁，请稍后再试');
  const limits = config.limits;
  // 建群不需要锁：这个 conversation 是下面才 INSERT 的新行，除本事务外没人能往里加人，
  // 所以「成员数 = 1 + 邀请人数」是纯算术（Q10 的两条竞态入口是「已存在的群」的入群/拉人）。
  if (memberIds.length + 1 > limits.maxGroupMembers) {
    return fail('group_full', `单群最多 ${limits.maxGroupMembers} 人`);
  }

  try {
    const out = await withTx(async (client) => {
      // 群数护栏：发起人自己的群数、以及每个被邀请人的群数
      const myGroups = await joinedGroupCount(client, actor.id);
      if (myGroups >= limits.maxGroupsPerUser) {
        return { rejected: [{ id: actor.id, reason: 'group_limit' }] };
      }
      // 和 add_member 同一套校验：陌生人不能被直接拖进群
      const invited = [];
      const rejected = [];
      for (const id of memberIds) {
        const joined = await joinedGroupCount(client, id);
        if (joined >= limits.maxGroupsPerUser) {
          rejected.push({ id, reason: 'member_limit' });
          continue;
        }
        const exists = await client.query('SELECT id, type FROM principals WHERE id = $1', [id]);
        if (!exists.rows[0]) {
          rejected.push({ id, reason: 'not_found' });
          continue;
        }
        if (!(await canInvite(client, actor.id, id))) {
          rejected.push({ id, reason: 'not_friend', type: exists.rows[0].type });
          continue;
        }
        invited.push(Number(id));
      }
      if (rejected.length) {
        return {
          rejected,
          notFriend: rejected.some((r) => r.reason === 'not_friend'),
        };
      }

      const conv = await client.query(
        `INSERT INTO conversations (type, title, owner_id, created_by) VALUES ('group',$1,$2,$2)
         RETURNING id, join_mode, discoverable, description`,
        [title, actor.id],
      );
      const conversationId = Number(conv.rows[0].id);
      await client.query(
        `INSERT INTO conversation_members (conversation_id, principal_id, role) VALUES ($1,$2,'owner')`,
        [conversationId, actor.id],
      );
      for (const id of invited) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, principal_id, role) VALUES ($1,$2,'member')
           ON CONFLICT DO NOTHING`,
          [conversationId, id],
        );
      }
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'GroupCreated',$2,$3,$4::jsonb)`,
        // join_mode/discoverable/description 必须进事件：`sql/rebuild.sql` 要能从事件把会话元信息重建出来
        // （2026-11-19 Q9 之前只存了 title/member_ids，重建后公开性与入群方式会退回默认值）。
        [conversationId, actor.id, actor.type, JSON.stringify({
          title,
          member_ids: memberIds,
          join_mode: conv.rows[0].join_mode,
          discoverable: conv.rows[0].discoverable,
          description: conv.rows[0].description,
        })],
      );
      return { conversationId, invited };
    });
    if (out.rejected) {
      const hitLimit = out.rejected.some((r) => r.reason === 'group_limit' || r.reason === 'member_limit');
      const hitMissing = out.rejected.some((r) => r.reason === 'not_found');
      return fail(
        hitLimit ? 'group_limit' : out.notFriend ? 'not_friend' : 'invalid_schema',
        hitLimit
          ? `群数已达上限（每人最多 ${limits.maxGroupsPerUser} 个群）`
          : out.notFriend
            ? '只能拉好友或自己的 AI 进群：先把对方加为好友并等对方同意'
            : hitMissing
              ? '有成员不存在，群未创建'
              : '群未创建',
      );
    }
    return ok({ conversation_id: out.conversationId, event_id: null, seq: null, member_ids: out.invited });
  } catch (err) {
    console.error('[submit] create_group failed', err.message);
    return fail('internal', '建群失败');
  }
}

async function addMember(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', 'AI 不能拉人入群');
  const conversationId = Number(command.conversation_id);
  const principalId = Number(command.principal_id);
  if (!Number.isInteger(conversationId) || !Number.isInteger(principalId)) return fail('invalid_schema', '参数非法');
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  if (!['owner', 'admin'].includes(membership.role)) return fail('forbidden', '只有群主或管理员可以拉人');

  try {
    const out = await withTx(async (client) => {
      const target = await client.query('SELECT id, type FROM principals WHERE id = $1', [principalId]);
      if (!target.rows[0]) return { missing: true };
      // 先锁会话行再数人数：并发两次「拉最后一个人」只能成功一次（外部审查 Q10）
      const cap = await lockGroupAndCount(client, conversationId);
      if (!cap.exists) return { missing: true };
      if (cap.full) return { full: true };
      const joined = await joinedGroupCount(client, principalId);
      if (joined >= config.limits.maxGroupsPerUser) return { memberLimit: true };

      if (!(await canInvite(client, actor.id, principalId))) {
        return { notFriend: true, targetType: target.rows[0].type };
      }

      await client.query(
        `INSERT INTO conversation_members (conversation_id, principal_id, role) VALUES ($1,$2,'member')
         ON CONFLICT DO NOTHING`,
        [conversationId, principalId],
      );
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MemberAdded',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: principalId })],
      );
      return { eventId: Number(ev.rows[0].id) };
    });
    if (out.missing) return fail('not_found', '找不到这个成员');
    if (out.full) return fail('group_full', `单群最多 ${config.limits.maxGroupMembers} 人`);
    if (out.memberLimit) return fail('group_limit', `对方已达 ${config.limits.maxGroupsPerUser} 个群上限`);
    if (out.notFriend) {
      return fail(
        'not_friend',
        out.targetType === 'agent'
          ? '只能拉自己的 AI 或好友的 AI 进群'
          : '只能拉好友进群：先按号码加好友，对方同意后再拉',
      );
    }
    return ok({ conversation_id: conversationId, event_id: out.eventId });
  } catch (err) {
    console.error('[submit] add_member failed', err.message);
    return fail('internal', '拉人失败');
  }
}

async function removeMember(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', 'AI 不能移出成员');
  const conversationId = Number(command.conversation_id);
  const principalId = Number(command.principal_id);
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  const isSelf = principalId === Number(actor.id);
  // 普通成员可以自己退群（否则只能被踢，体验不合理）；群主不能退自己的群（没有转让入口）
  if (isSelf) {
    if (membership.role === 'owner') return fail('forbidden', '群主不能退出自己的群');
  } else if (!['owner', 'admin'].includes(membership.role)) {
    return fail('forbidden', '只有群主或管理员可以移出成员');
  }
  if (principalId === Number(membership.owner_id)) return fail('forbidden', '不能移出群主');
  // 管理员只能移出普通成员；管理员之间要群主来动手（避免互相踢人拉票）
  if (!isSelf && membership.role === 'admin') {
    const { rows: target } = await pool.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
      [conversationId, principalId],
    );
    if (target[0]?.role === 'admin') return fail('forbidden', '管理员不能移出另一个管理员（请群主操作）');
  }

  try {
    const out = await withTx(async (client) => {
      await client.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2', [conversationId, principalId]);
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MemberRemoved',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: principalId })],
      );
      return { eventId: Number(ev.rows[0].id) };
    });
    return ok({ conversation_id: conversationId, event_id: out.eventId });
  } catch (err) {
    console.error('[submit] remove_member failed', err.message);
    return fail('internal', '移出失败');
  }
}

/**
 * AI 自己退群（P2）。
 *
 * 为什么不复用 removeMember：removeMember 的口径是「移出某个成员」，人类侧可以踢人，
 * 所以它开头就挡掉 actor.type!=='user'。AI 退**自己**是另一件事——不是管理权限，
 * 只是放弃自己的成员资格；把两者混在一个命令里，迟早有人为了「让 AI 能退群」
 * 去放宽那个判断，顺手把「AI 能踢人」也放开。
 *
 * 门禁：agents.can_leave_group（默认关闭，主人用 /api/agents/:id/leave 打开）。
 * 群主不能退（没有无主群）；AI 当不了群主，这里只是与 removeMember 保持同一条不变量。
 */
async function leaveGroup(command, actor) {
  if (actor.type !== 'agent') {
    return fail('forbidden', 'leave_group 只给 AI 用；人类退群走网页/接口的 remove_member');
  }
  const conversationId = Number(command.conversation_id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return fail('invalid_schema', 'conversation_id 非法');
  }
  const { rows } = await pool.query('SELECT can_leave_group FROM agents WHERE principal_id = $1', [actor.id]);
  if (!rows[0]) return fail('not_found', '这个 AI 不存在');
  if (!rows[0].can_leave_group) {
    return fail(
      'leave_not_allowed',
      '主人还没允许这只 AI 自己退群：请主人调用 PATCH /api/agents/:id/leave {"allow":true} '
      + '（或在群里由群主把你移出）',
    );
  }
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('not_found', '你不在这个会话里（可能已经退过）');
  if (membership.role === 'owner') return fail('forbidden', '群主不能退出自己的群（先转让群主）');

  try {
    const out = await withTx(async (client) => {
      await client.query(
        'DELETE FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
        [conversationId, actor.id],
      );
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MemberRemoved',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: Number(actor.id), self: true })],
      );
      return { eventId: Number(ev.rows[0].id) };
    });
    return ok({ conversation_id: conversationId, event_id: out.eventId, left: true });
  } catch (err) {
    console.error('[submit] leave_group failed', err.message);
    return fail('internal', '退群失败');
  }
}

/**
 * 成员角色：群主可以把成员设为管理员、或把管理员降回成员。
 * - 只有群主可以操作（管理员不能拉帮结派）
 * - 不能改群主自己的角色（没有「转让群主」入口，避免误操作把群变成无主）
 * - 角色只影响「能不能改群设置 / 拉人踢人」，和 AI 的发言档位是两件事
 */
async function setMemberRole(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', 'AI 不能调整成员角色');
  const conversationId = Number(command.conversation_id);
  const principalId = Number(command.principal_id);
  const role = String(command.role || '');
  if (!Number.isInteger(conversationId) || !Number.isInteger(principalId)) return fail('invalid_schema', '参数非法');
  if (role !== 'admin' && role !== 'member') return fail('invalid_schema', 'role 只能是 admin 或 member');
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  if (membership.role !== 'owner') return fail('forbidden', '只有群主可以设置管理员');
  if (principalId === Number(membership.owner_id)) return fail('forbidden', '不能修改群主的角色');

  const { rows: target } = await pool.query(
    'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
    [conversationId, principalId],
  );
  if (!target[0]) return fail('not_found', '这个成员不在群里');

  try {
    await withTx(async (client) => {
      await client.query(
        'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND principal_id = $2',
        [conversationId, principalId, role],
      );
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MemberRoleChanged',$2,$3,$4::jsonb)`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: principalId, role })],
      );
    });
    return ok({ conversation_id: conversationId, principal_id: principalId, role });
  } catch (err) {
    console.error('[submit] set_member_role failed', err.message);
    return fail('internal', '设置角色失败');
  }
}

/**
 * 转让群主：只有现任群主可以操作；只能转给群里的**人类**成员（AI 没有网页界面，做群主等于群没人管）。
 * 转完后原群主降为普通成员，可以自己退群（remove_member 已经允许成员退群）。
 */
async function transferOwner(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', 'AI 不能转让群主');
  const conversationId = Number(command.conversation_id);
  const principalId = Number(command.principal_id);
  if (!Number.isInteger(conversationId) || !Number.isInteger(principalId)) return fail('invalid_schema', '参数非法');
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  if (membership.role !== 'owner') return fail('forbidden', '只有群主可以转让群主');
  if (principalId === Number(actor.id)) return fail('invalid_schema', '你已经是群主');

  const { rows } = await pool.query(
    `SELECT cm.principal_id, p.type, p.display_name
       FROM conversation_members cm JOIN principals p ON p.id = cm.principal_id
      WHERE cm.conversation_id = $1 AND cm.principal_id = $2`,
    [conversationId, principalId],
  );
  const target = rows[0];
  if (!target) return fail('not_found', '这个成员不在群里');
  if (target.type !== 'user') return fail('forbidden', '只能把群主转让给人类成员');

  try {
    await withTx(async (client) => {
      await client.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [conversationId, principalId]);
      await client.query(
        "UPDATE conversation_members SET role = 'member' WHERE conversation_id = $1 AND principal_id = $2",
        [conversationId, actor.id],
      );
      await client.query(
        "UPDATE conversation_members SET role = 'owner' WHERE conversation_id = $1 AND principal_id = $2",
        [conversationId, principalId],
      );
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'OwnerTransferred',$2,$3,$4::jsonb)`,
        [conversationId, actor.id, actor.type, JSON.stringify({ from: Number(actor.id), to: principalId })],
      );
    });
    return ok({ conversation_id: conversationId, owner_id: principalId });
  } catch (err) {
    console.error('[submit] transfer_owner failed', err.message);
    return fail('internal', '转让失败，请重试');
  }
}

/**
 * 解散群：群主可以直接解散（不需要先把成员踢完）。软解散——保留 conversations/messages/events，
 * 清空成员表：所有读路径都以成员资格判权，因此「列表消失 + 读写 403」自动成立。
 */
async function dissolveConversation(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', 'AI 不能解散群');
  const conversationId = Number(command.conversation_id);
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  if (membership.role !== 'owner') return fail('forbidden', '只有群主可以解散群');

  try {
    const out = await withTx(async (client) => {
      const done = await client.query(
        'UPDATE conversations SET dissolved_at = now(), dissolved_by = $2 WHERE id = $1 AND dissolved_at IS NULL',
        [conversationId, actor.id],
      );
      if (done.rowCount === 0) return { already: true };
      await client.query('DELETE FROM conversation_members WHERE conversation_id = $1', [conversationId]);
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'ConversationDissolved',$2,$3,$4::jsonb)`,
        [conversationId, actor.id, actor.type, JSON.stringify({ dissolved_by: Number(actor.id) })],
      );
      return { already: false };
    });
    if (out.already) return fail('gone', '这个群已经解散了');
    return ok({ conversation_id: conversationId, dissolved: true });
  } catch (err) {
    console.error('[submit] dissolve_conversation failed', err.message);
    return fail('internal', '解散失败，请重试');
  }
}

// 档位 + relay 设置（旧字段名 reply_mode 仍兼容）
async function setReplyMode(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', '只有人类可以调整 AI 发言设置');
  const conversationId = Number(command.conversation_id);
  const principalId = Number(command.principal_id);
  const raw = String(command.reply_mode || command.activity || '');
  const mode = LEVEL_ALIAS[raw];
  const relay = command.allow_ai_relay;
  if (!mode) return fail('invalid_schema', 'activity 只能是 off/low/mid/high（旧值 mention/free 仍兼容）');
  if (relay !== undefined && typeof relay !== 'boolean') return fail('invalid_schema', 'allow_ai_relay 必须是布尔值');

  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  // 只有该 AI 的主人能改它的发言设置。群主/管理员也不行——
  // 群主嫌吵可以把它请出群，但不能替别人调它的性格。
  {
    const { rows } = await pool.query('SELECT owner_user_id FROM agents WHERE principal_id = $1', [principalId]);
    if (!rows[0]) return fail('not_found', '这个成员不是 AI');
    if (Number(rows[0].owner_user_id) !== actor.id) {
      return fail('not_owner', '只有这只 AI 的主人可以调整它的发言设置');
    }
  }

  try {
    await withTx(async (client) => {
      if (relay === undefined) {
        await client.query(
          'UPDATE conversation_members SET reply_mode = $3 WHERE conversation_id = $1 AND principal_id = $2',
          [conversationId, principalId, mode],
        );
      } else {
        await client.query(
          'UPDATE conversation_members SET reply_mode = $3, allow_ai_relay = $4 WHERE conversation_id = $1 AND principal_id = $2',
          [conversationId, principalId, mode, relay],
        );
      }
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'AgentSettingsChanged',$2,$3,$4::jsonb)`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: principalId, activity: mode, allow_ai_relay: relay ?? null })],
      );
    });
    return ok({ conversation_id: conversationId, activity: mode, allow_ai_relay: relay ?? null });
  } catch (err) {
    console.error('[submit] set_reply_mode failed', err.message);
    return fail('internal', '设置失败');
  }
}

// ============================================================================
// 群公告（群规）：[P0] AI 现在完全读不到群规，只能在被骂之后才知道边界。
// 公告是「群级配置」，但它的变更必须留痕（谁在什么时候改过群规），所以仍走 submit（[C2]）。
//
// 为什么不把公告正文塞进事件 payload：公告是群内公开内容（不是敏感数据），但 2000 字
// 文本进 append-only 日志会在重放/索引时被反复放大；事件只记 length + 谁改的，
// 正文留在 conversations.announcement 这一行上（与 discoverable/description 同一套口径）。
// 为什么不发系统消息：群规被改一次就刷屏一次，200 人群里等于一次广播事故。
// ============================================================================
const ANNOUNCEMENT_MAX = 2000;

async function setGroupAnnouncement(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', '只有人类可以修改群公告');
  const conversationId = Number(command.conversation_id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return fail('invalid_schema', 'conversation_id 非法');
  if (command.announcement === undefined || command.announcement === null) {
    return fail('invalid_schema', '缺少 announcement（要清空请传空字符串）');
  }
  if (typeof command.announcement !== 'string') return fail('invalid_schema', 'announcement 必须是字符串');
  const suspended = assertNotSuspended(actor, '修改群公告');
  if (suspended) return fail(suspended.reason, suspended.message);

  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个群');
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return fail('forbidden', '只有群主或管理员可以修改群公告');
  }

  // 纯文本：统一换行符、去首尾空白；按**码点**数字符（与 DB 的 char_length 一致，
  // 用 .length 会把 emoji 算成 2 个字符，和「2000 字」的产品口径对不上）。
  const text = command.announcement.replace(/\r\n/g, '\n').trim();
  if ([...text].length > ANNOUNCEMENT_MAX) return fail('invalid_schema', `群公告最多 ${ANNOUNCEMENT_MAX} 字`);
  if (text.includes('\u0000')) return fail('invalid_schema', '群公告里不能有 NUL 字符');

  try {
    const result = await withTx(async (client) => {
      const cur = await client.query(
        'SELECT announcement FROM conversations WHERE id = $1 AND dissolved_at IS NULL',
        [conversationId],
      );
      if (!cur.rows[0]) return fail('not_found', '群不存在或已解散');
      if (String(cur.rows[0].announcement || '') === text) {
        // 重复提交同样的内容不写事件：审计里不该出现「原样保存」的噪声
        return ok({ conversation_id: conversationId, announcement: text, changed: false });
      }
      const upd = await client.query(
        `UPDATE conversations
            SET announcement = $2, announcement_updated_at = now(), announcement_updated_by = $3
          WHERE id = $1
        RETURNING announcement_updated_at`,
        [conversationId, text, actor.id],
      );
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'GroupAnnouncementChanged',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ length: [...text].length })],
      );
      return ok({
        conversation_id: conversationId,
        announcement: text,
        announcement_updated_at: upd.rows[0]?.announcement_updated_at || null,
        changed: true,
        event_id: Number(ev.rows[0].id),
      });
    });

    // 帧在事务提交之后才发：事务回滚了就不该有人看到新公告。
    // 失败不影响保存结果（公告已经落库，前端下次拉列表仍能拿到），所以只 warn。
    if (result.accepted && result.changed) {
      deliverAnnouncement(conversationId, {
        announcement: result.announcement ?? '',
        updatedAt: result.announcement_updated_at || null,
      }).catch((err) => console.error('[ws] announcement frame failed', err.message));
    }
    return result;
  } catch (err) {
    console.error('[submit] set_group_announcement failed', err.message);
    return fail('internal', '修改群公告失败');
  }
}

/**
 * 人类退出一个群（2026-11-19）。
 *
 * 为什么必须有：原来只有「群主解散自己的群」，被拉进一个不想待的群时**没有任何出口**
 * （Agent 有 leave_group，人反而没有——实测清库时发现的）。
 *
 * 与 agent leave_group 的区别：
 *   - 人不需要主人开关（自己的账号自己决定）；
 *   - 群主不能退（否则群变无主）：先转让或解散，报错里说清楚；
 *   - 私聊（c2c）不能"退"，那是好友关系的一部分，要删请在好友里处理。
 *
 * 审计：写 MemberRemoved（payload 带 self:true），与 Agent 退群同一事件类型，
 * 这样「谁主动离开过」在事件流里只有一种查法。
 */
async function leaveConversation(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', '这个接口只给人类账号用');
  const conversationId = Number(command.conversation_id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return fail('invalid_schema', 'conversation_id 非法');

  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('not_found', '你不在这个会话里（可能已经退过）');
  if (membership.type === 'c2c') return fail('invalid_schema', '私聊不能退群；要停止对方私聊请在好友里处理');
  if (membership.role === 'owner') {
    return fail('forbidden', '群主不能退群（先把群主转让给别人，或直接解散群）');
  }

  try {
    const out = await withTx(async (client) => {
      await client.query(
        'DELETE FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
        [conversationId, actor.id],
      );
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MemberRemoved',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ principal_id: Number(actor.id), self: true })],
      );
      return { eventId: Number(ev.rows[0].id) };
    });
    return ok({ conversation_id: conversationId, event_id: out.eventId, left: true });
  } catch (err) {
    console.error('[submit] leave_conversation failed', err.message);
    return fail('internal', '退群失败，请重试');
  }
}

async function recallMessage(command, actor) {
  const conversationId = Number(command.conversation_id);
  const seq = Number(command.seq);
  if (!Number.isInteger(conversationId) || !Number.isInteger(seq)) return fail('invalid_schema', '参数非法');
  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');
  try {
    return await withTx(async (client) => {
      const msg = await client.query(
        'SELECT sender_id, created_at, recalled_at FROM messages_meta WHERE conversation_id = $1 AND seq = $2 FOR UPDATE',
        [conversationId, seq],
      );
      const row = msg.rows[0];
      if (!row) return fail('not_found', '消息不存在');
      if (Number(row.sender_id) !== actor.id) return fail('forbidden', '只能撤回自己的消息');
      if (row.recalled_at) return ok({ conversation_id: conversationId, already: true });
      if (Date.now() - new Date(row.created_at).getTime() > 120_000) return fail('gone', '超过 2 分钟不能撤回');
      // 迁移 012 起 messages 是视图，真实表是 messages_meta
      await client.query('UPDATE messages_meta SET recalled_at = now() WHERE conversation_id = $1 AND seq = $2', [conversationId, seq]);
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('conversation',$1,'MessageRecalled',$2,$3,$4::jsonb) RETURNING id`,
        [conversationId, actor.id, actor.type, JSON.stringify({ seq })],
      );
      publishMessage({
        conversationId, seq, eventId: Number(ev.rows[0].id),
        senderId: actor.id, senderType: actor.type, senderName: actor.displayName,
        body: '', replyToSeq: null, mentions: [], recalled: true, createdAt: new Date().toISOString(),
      });
      return ok({ conversation_id: conversationId, event_id: Number(ev.rows[0].id) });
    });
  } catch (err) {
    console.error('[submit] recall_message failed', err.message);
    return fail('internal', '撤回失败');
  }
}

// 系统消息：表情包分享这类"事件反馈"。走同一个写入口 + 同一个事件类型 MessageSent，
// 只是 payload.kind='system'，投影成 messages.kind='system'（居中灰字，不带头像/气泡）。
// 只有人类 actor 能触发；AI 侧没有这条 command，也就伪造不了系统提示。
async function systemNotice(command, actor) {
  if (actor.type !== 'user') return fail('forbidden', '只有人类可以发系统消息');
  const conversationId = Number(command.conversation_id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) return fail('invalid_schema', 'conversation_id 非法');
  const body = normalizeBody(command.body);
  if (!body) return fail('invalid_schema', '系统消息必须是 1..4000 字符');
  if (body.length > 500) return fail('invalid_schema', '系统消息最多 500 字');
  // 静默成功防线：客户端把中文塞进命令行 argv 时，编码坏掉的字节会变成 U+FFFD；
  // 如果照单收下，发送方看到 200/accepted，群里却是一串乱码——比失败更糟。
  // （这段原来夹在 send_message 的副本里，引用了本函数不存在的 previewBody/parts，
  //  导致「人类把表情包分享到群」这条路径 100% 抛 ReferenceError → 500。评审回归时抓到。）
  if (body.includes('\uFFFD')) {
    return fail(
      'invalid_schema',
      '正文包含非法 UTF-8 字符（常见于命令行把中文塞进 argv 时编码损坏）。请把 JSON 写成 UTF-8 文件后用 --data-binary 发送，或改用正确的编码重发',
      { reason_code: 'invalid_encoding' },
    );
  }

  const membership = await getMembership(conversationId, actor.id);
  if (!membership) return fail('forbidden', '你不在这个会话里');

  // 幂等：同一个 client_msg_id（例如「包 X 分享到群 Y」）重试不会刷出第二条
  const clientMsgId = typeof command.client_msg_id === 'string' && UUID_RE.test(command.client_msg_id)
    ? command.client_msg_id
    : randomUUID();
  const idemScope = `c:${conversationId}`;

  try {
    const outcome = await withTx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload, client_msg_id, idem_scope)
         VALUES ('conversation',$1,'MessageSent',$2,$3,$4::jsonb,$5,$6)
         ON CONFLICT (actor_id, idem_scope, client_msg_id) DO NOTHING
         RETURNING id`,
        [
          conversationId,
          actor.id,
          actor.type,
          JSON.stringify({ body, kind: 'system', reply_to_seq: null, mentions: [], parts: [] }),
          clientMsgId,
          idemScope,
        ],
      );
      if (inserted.rows.length === 0) {
        const existing = await client.query(
          'SELECT e.id, m.seq FROM events e LEFT JOIN messages m ON m.event_id = e.id WHERE e.actor_id=$1 AND e.idem_scope=$2 AND e.client_msg_id=$3',
          [actor.id, idemScope, clientMsgId],
        );
        return { deduplicated: true, eventId: Number(existing.rows[0]?.id || 0), seq: Number(existing.rows[0]?.seq || 0) };
      }
      const eventId = Number(inserted.rows[0].id);
      const applied = await client.query(
        'SELECT qm_apply_system_message($1,$2,$3,$4,$5,$6) AS seq',
        [eventId, conversationId, actor.id, actor.type, body, []],
      );
      return { deduplicated: false, eventId, seq: Number(applied.rows[0].seq) };
    });

    if (!outcome.deduplicated) {
      publishMessage({
        conversationId,
        seq: outcome.seq,
        eventId: outcome.eventId,
        senderId: actor.id,
        senderType: actor.type,
        senderName: actor.displayName,
        avatarHue: actor.avatarHue ?? 200,
        avatarUrl: actor.avatarUrl ?? null,
        body,
        parts: [],
        kind: 'system',
        replyToSeq: null,
        mentions: [],
        createdAt: new Date().toISOString(),
      });
    }
    return ok({
      event_id: outcome.eventId || null,
      seq: outcome.seq || null,
      conversation_id: conversationId,
      deduplicated: !!outcome.deduplicated,
    });
  } catch (err) {
    console.error('[submit] system_notice failed', err.message);
    return fail('internal', '写入系统消息失败');
  }
}

// [M5] 唯一入口：所有 Command 从这里分发
// 站务处理举报：只有 is_admin 能调，动作与事件一一对应（审计链里能看到谁在什么时候处理了哪条）。
// 三个动作：
//   dismiss      — 驳回，不动内容
//   hide_message — 下架消息（写 messages_meta.hidden_at，原文保留给申诉）
//   suspend_user — 封禁消息发送者 7 天（principals.suspended_until）
const SUSPEND_DAYS = 7;

async function handleReport(command, actor) {
  if (!actor.isAdmin) return fail('forbidden', '只有站务可以处理举报');
  const reportId = Number(command.report_id);
  const action = String(command.action || '');
  const note = String(command.note || '').slice(0, 200);
  if (!Number.isInteger(reportId) || reportId <= 0) return fail('invalid_schema', 'report_id 非法');
  if (!['dismiss', 'hide_message', 'suspend_user'].includes(action)) return fail('invalid_schema', '未知处理动作');

  try {
    return await withTx(async (client) => {
      const rep = await client.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [reportId]);
      const r = rep.rows[0];
      if (!r) return fail('not_found', '举报不存在');
      if (r.status !== 'open') return fail('conflict', '这条举报已经处理过了');

      // 消息类举报才有 (conversation_id, seq)；老数据缺定位信息 → 只能驳回
      const conversationId = r.conversation_id == null ? null : Number(r.conversation_id);
      const seq = Number(r.target_id);
      let senderId = null;
      let eventType = 'ReportHandled';
      let aggregateType = 'report';
      let aggregateId = reportId;
      let payload = { action, note, report_id: reportId, target_type: r.target_type, target_id: seq };

      if (action !== 'dismiss') {
        if (r.target_type !== 'message' || conversationId == null) {
          return fail('invalid_schema', '这条举报没有可定位的消息（旧数据），只能驳回');
        }
        const msg = await client.query(
          'SELECT sender_id, hidden_at FROM messages_meta WHERE conversation_id = $1 AND seq = $2 FOR UPDATE',
          [conversationId, seq],
        );
        if (!msg.rows[0]) return fail('not_found', '消息不存在');
        senderId = Number(msg.rows[0].sender_id);
        if (action === 'hide_message') {
          if (msg.rows[0].hidden_at) return fail('conflict', '这条消息已经隐藏');
          await client.query(
            'UPDATE messages_meta SET hidden_at = now() WHERE conversation_id = $1 AND seq = $2',
            [conversationId, seq],
          );
          eventType = 'MessageHidden';
          aggregateType = 'conversation';
          aggregateId = conversationId;
          payload = { seq, report_id: reportId, note };
        } else {
          // 封禁：只针对消息发送者；不能封自己（避免管理员误操作把自己锁死）
          if (senderId === Number(actor.id)) return fail('forbidden', '不能封禁自己');
          const until = await client.query(
            `UPDATE principals SET suspended_until = now() + ($2 || ' days')::interval
              WHERE id = $1 RETURNING suspended_until`,
            [senderId, SUSPEND_DAYS],
          );
          eventType = 'UserSuspended';
          aggregateType = 'principal';
          aggregateId = senderId;
          payload = {
            principal_id: senderId,
            suspended_until: until.rows[0]?.suspended_until || null,
            report_id: reportId,
            note,
          };
        }
      }

      // 处理动作也要落事件（C2：所有写操作走 submit；C3：审计链可追）
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
        [aggregateType, aggregateId, eventType, actor.id, actor.type, JSON.stringify(payload)],
      );
      await client.query(
        `UPDATE reports SET status = $2, action = $3, action_note = $4, handled_by = $5, handled_at = now()
          WHERE id = $1`,
        [reportId, action === 'dismiss' ? 'dismissed' : 'resolved', action, note, actor.id],
      );

      // 消息被下架：给在线成员推一条「已撤回」帧，前端按撤回渲染（不显示原文）
      if (eventType === 'MessageHidden') {
        publishMessage({
          conversationId,
          seq,
          eventId: Number(ev.rows[0].id),
          senderId: senderId,
          senderType: 'user',
          senderName: actor.displayName,
          body: '',
          replyToSeq: null,
          mentions: [],
          recalled: true,
          createdAt: new Date().toISOString(),
        });
      }
      return ok({
        report_id: reportId,
        status: action === 'dismiss' ? 'dismissed' : 'resolved',
        action,
        event_id: Number(ev.rows[0].id),
        ...(senderId ? { sender_id: senderId } : {}),
      });
    });
  } catch (err) {
    console.error('[submit] handle_report failed', err.message);
    return fail('internal', '处理失败，请重试');
  }
}

// 解封：与 suspend_user 对称的一条写路径（[C2] 只走 submit）。只清 suspended_until。
// 为什么不把「解封」塞进 handle_report 的 action：解封时举报早已 resolved，没有 open 的举报可挂。
// 硬塞会造出「没有举报也能处理」的假动作，审计链反而看不出是谁在什么时候按下了复位。
// payload 只放 principal_id：目标、操作人、时间都在事件自身的列上；备注是站务手写的自由文本，
// 不进 append-only 事件日志（[C3] 事件保持机器可读、最小化）。
async function unsuspendUser(command, actor) {
  if (!actor.isAdmin) return fail('forbidden', '只有站务可以解封');
  const principalId = Number(command.principal_id);
  if (!Number.isInteger(principalId) || principalId <= 0) return fail('invalid_schema', 'principal_id 非法');
  try {
    return await withTx(async (client) => {
      const found = await client.query(
        'SELECT id, display_name, suspended_until FROM principals WHERE id = $1 FOR UPDATE',
        [principalId],
      );
      const row = found.rows[0];
      if (!row) return fail('not_found', '账号不存在');
      // 只有「当前真的还在封禁期」才解封。重复解封回 not_found 而不是 200：
      // 假装成功会让站务以为是自己解的，实际可能已被另一个站务解过（或封禁已到期）。
      const until = row.suspended_until ? new Date(row.suspended_until).getTime() : 0;
      if (!until || until <= Date.now()) return fail('not_found', '这个账号当前不在封禁中');

      await client.query('UPDATE principals SET suspended_until = NULL WHERE id = $1', [principalId]);
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('principal',$1,'UserUnsuspended',$2,$3,$4::jsonb) RETURNING id`,
        [principalId, actor.id, actor.type, JSON.stringify({ principal_id: principalId })],
      );
      return ok({
        principal_id: principalId,
        display_name: row.display_name,
        event_id: Number(ev.rows[0].id),
      });
    });
  } catch (err) {
    console.error('[submit] unsuspend_user failed', err.message);
    return fail('internal', '解封失败，请重试');
  }
}

/**
 * 站务手动把某个账号标成「邮箱已验证」（2026-11-19）。
 *
 * 为什么需要这条口子：邮箱验证的硬门禁（EMAIL_VERIFY_MODE=required）在「发信挂了」
 * 或「用户邮箱本身收不到信」时会把真人永久锁在门外——功能越强，兜底出口越必须有。
 *
 * 与令牌核销的区别：这里不写 email_verifications（那是「发过哪封信」的流水，
 * 人工操作没有令牌可对应）；只把 user_accounts.email_verified_at 置位，
 * 并写一条 UserEmailVerifiedManually 事件留下「谁在什么时候放了谁进来」。
 * 事件 payload 只放 principal_id 与人工备注（≤200 字），不放邮箱——审计日志不该带 PII。
 */
async function adminVerifyEmail(command, actor) {
  if (!actor.isAdmin) return fail('forbidden', '只有站务可以手动标记邮箱已验证');
  const note = String(command.note || '').slice(0, 200);
  try {
    let principalId = Number(command.principal_id);
    if (!Number.isInteger(principalId) || principalId <= 0) {
      const no = Number(command.account_no);
      if (!Number.isInteger(no) || no <= 0) return fail('invalid_schema', '需要 principal_id 或 account_no');
      const hit = await pool.query('SELECT id FROM principals WHERE account_no = $1', [no]);
      if (!hit.rows[0]) return fail('not_found', '没有这个账号号');
      principalId = Number(hit.rows[0].id);
    }

    return await withTx(async (client) => {
      const found = await client.query(
        'SELECT id, display_name FROM principals WHERE id = $1 FOR UPDATE',
        [principalId],
      );
      const row = found.rows[0];
      if (!row) return fail('not_found', '账号不存在');
      const ua = await client.query(
        'SELECT email, email_verified_at FROM user_accounts WHERE principal_id = $1',
        [principalId],
      );
      const acc = ua.rows[0];
      // AI 成员没有 user_accounts 行：这里明确拒绝，而不是"成功了一个空操作"
      if (!acc) return fail('not_found', '这个账号没有邮箱（AI 成员不适用）');
      if (acc.email_verified_at) return fail('not_found', '这个邮箱已经是已验证状态');

      const upd = await client.query(
        'UPDATE user_accounts SET email_verified_at = now() WHERE principal_id = $1 RETURNING email_verified_at',
        [principalId],
      );
      const ev = await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('principal',$1,'UserEmailVerifiedManually',$2,$3,$4::jsonb) RETURNING id`,
        [principalId, actor.id, actor.type, JSON.stringify({ principal_id: principalId, note })],
      );
      return ok({
        principal_id: principalId,
        display_name: row.display_name,
        email_verified_at: upd.rows[0]?.email_verified_at || null,
        event_id: Number(ev.rows[0].id),
      });
    });
  } catch (err) {
    console.error('[submit] admin_verify_email failed', err.message);
    return fail('internal', '标记失败，请重试');
  }
}

/**
 * 屏蔽 / 拉黑（外部审查 Q12）。**单向写、双向生效**：
 *   A 屏蔽 B 之后，A 看不到 B 的消息、B 也看不到 A 的；双方不能私聊、不能加好友。
 *
 * 为什么写事件 + 投影（而不是只写表）：屏蔽是用户可见的社交动作，灾备/审计要能重放
 * （sql/rebuild.sql 会按 BlockCreated/BlockRemoved 重建 principal_blocks）。
 * 事件载荷只放**对方 id**，不复制昵称/正文——审计里不该出现别人资料的副本。
 */
async function setBlock(command, actor) {
  const target = Number(command.principal_id);
  const on = command.type === 'block_principal';
  if (!Number.isInteger(target) || target <= 0) return fail('invalid_schema', 'principal_id 非法');
  if (target === Number(actor.id)) return fail('invalid_schema', '不能屏蔽自己');
  // 防刷：屏蔽/解除本身是廉价写，但没必要允许脚本每分钟改几百次
  if (!hitRate(`block:${actor.id}`, 30)) return fail('rate_limited', '操作太频繁，请稍后再试');
  try {
    return await withTx(async (client) => {
      const who = await client.query('SELECT id FROM principals WHERE id = $1 AND hidden = false', [target]);
      if (!who.rows[0]) return fail('not_found', '账号不存在');
      if (on) {
        await client.query(
          `INSERT INTO principal_blocks (blocker_id, blocked_id) VALUES ($1,$2)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
          [actor.id, target],
        );
        await client.query(
          `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
           VALUES ('principal',$1,'BlockCreated',$2,$3,$4::jsonb)`,
          [actor.id, actor.id, actor.type, JSON.stringify({ blocked_id: target })],
        );
      } else {
        await client.query('DELETE FROM principal_blocks WHERE blocker_id=$1 AND blocked_id=$2', [actor.id, target]);
        await client.query(
          `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
           VALUES ('principal',$1,'BlockRemoved',$2,$3,$4::jsonb)`,
          [actor.id, actor.id, actor.type, JSON.stringify({ blocked_id: target })],
        );
      }
      return ok({ principal_id: target, blocked: on });
    });
  } catch (err) {
    console.error('[submit] setBlock failed', err.message);
    return fail('internal', '操作失败，请重试');
  }
}

export async function submit(command, actor) {
  if (!actor || !Number.isInteger(Number(actor.id))) return fail('forbidden', '未认证');
  if (!command || typeof command !== 'object' || !command.type) return fail('invalid_schema', '缺少 command.type');
  switch (command.type) {
    case 'handle_report': return handleReport(command, actor);
    case 'unsuspend_user': return unsuspendUser(command, actor);
    case 'admin_verify_email': return adminVerifyEmail(command, actor);
    case 'send_message': return sendMessage(command, actor);
    case 'system_notice': return systemNotice(command, actor);
    case 'create_group': return createGroup(command, actor);
    case 'add_member': return addMember(command, actor);
    case 'remove_member': return removeMember(command, actor);
    case 'leave_group': return leaveGroup(command, actor);
    case 'leave_conversation': return leaveConversation(command, actor);
    case 'set_reply_mode': return setReplyMode(command, actor);
    case 'set_group_announcement': return setGroupAnnouncement(command, actor);
    case 'set_member_role': return setMemberRole(command, actor);
    case 'transfer_owner': return transferOwner(command, actor);
    case 'dissolve_conversation': return dissolveConversation(command, actor);
    case 'recall_message': return recallMessage(command, actor);
    case 'publish_feed': return publishFeed(command, actor);
    case 'add_comment': return addComment(command, actor);
    case 'add_like': return addLike(command, actor);
    case 'remove_like': return removeLike(command, actor);
    case 'block_principal':
    case 'unblock_principal': return setBlock(command, actor);
    default: return fail('invalid_schema', `未知 command.type: ${command.type}`);
  }
}

export async function countToday() {
  const rows = await query(`SELECT count(*)::int AS n FROM events WHERE created_at > date_trunc('day', now())`);
  return Number(rows[0]?.n || 0);
}
