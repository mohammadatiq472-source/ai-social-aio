/**
 * 发信出口（SMTP）与「邮箱验证」的启用判定。
 *
 * 设计口径（用户 2026-11-19 定）：**未配置 SMTP 就不启用**。
 * 所以这里所有能力都是「配置驱动」的：
 *   - 没配 SMTP_HOST → enabled=false，验证接口回 503 email_verification_disabled，
 *     注册/登录/其它功能完全不变（不会因为没配邮件就少一个能力而崩）；
 *   - EMAIL_VERIFY_MODE 只在配了 SMTP 时才有意义：
 *       optional（默认）= 注册后发一封验证信，但不拦任何人；
 *       required        = 额外要求「验证过才能登录」（硬门禁，误配会把所有人挡在门外）；
 *       off             = 配了 SMTP 也先不发。
 *
 * 为什么 nodemailer 用动态 import：它是可选能力。
 * 如果部署机上 `npm install` 没跑/失败，import 失败只会让「发信」报错，
 * 不会让整个服务起不来——一个没启用的功能不该成为启动阻塞项。
 */
import { config } from './config.mjs';

let transportPromise = null;

export function emailVerifySettings() {
  const configured = Boolean(String(config.smtp.host || '').trim());
  const raw = String(config.emailVerifyMode || '').toLowerCase();
  let mode;
  if (!configured) mode = 'off';
  else if (raw === 'off' || raw === 'required') mode = raw;
  else mode = 'optional'; // 配了 SMTP 但没写/写错 → 取安全默认（只发信，不拦人）
  return { configured, mode, enabled: mode !== 'off', from: config.smtp.from };
}

function fromAddress() {
  if (config.smtp.from) return config.smtp.from;
  if (config.smtp.user) return config.smtp.user;
  // 没有 From 的 SMTP 会被多数服务商拒收；给个基于域名的兜底，并在日志里说明
  const domain = String(config.smtp.host || 'localhost').split(':')[0];
  return `no-reply@${domain}`;
}

async function getTransport() {
  if (!transportPromise) {
    transportPromise = (async () => {
      const mod = await import('nodemailer');
      const nodemailer = mod.default || mod;
      return nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        // 用户名为空 = 不做 AUTH（本地/内网中继常见）
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        // 发信是后台动作：不让一个慢 SMTP 把请求挂住
        connectionTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10_000),
        greetingTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10_000),
        socketTimeout: Number(process.env.SMTP_TIMEOUT_MS || 15_000),
      });
    })();
  }
  return transportPromise;
}

/** 发送一封纯文本 + HTML 的邮件。调用方负责兜住异常（发信失败不该影响主流程）。 */
export async function sendMail({ to, subject, text, html }) {
  const settings = emailVerifySettings();
  if (!settings.enabled) throw Object.assign(new Error('smtp not configured'), { code: 'smtp_disabled' });
  const transport = await getTransport();
  return transport.sendMail({ from: fromAddress(), to, subject, text, html: html || undefined });
}

/** 给运维/验证脚本用：不发信，只报配置判定结果（不打印任何口令） */
export function mailStatus() {
  const s = emailVerifySettings();
  return {
    configured: s.configured,
    mode: s.mode,
    enabled: s.enabled,
    host: config.smtp.host || null,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: Boolean(config.smtp.user),
    from: s.configured ? fromAddress() : null,
  };
}
