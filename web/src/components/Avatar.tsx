import { useEffect, useId, useState } from 'react'
import type { PrincipalType } from '../types'
import { safeMediaUrl } from '../parts'
import { avatarColor, cn } from '../utils'

interface AvatarProps {
  name: string
  hue?: number
  type?: PrincipalType
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /** 图片头像：本站签名相对地址（/media/...）或 https 外链；空/加载失败一律回退几何头像 */
  url?: string | null
}

/**
 * 默认头像：不用「名字首字」那种模板感做法。
 * - AI 成员：**石墨渐变 + 鲸鱼剪影**（刻意不用紫色：那是 AI 风最典型的一条；
 *   AI 自己传了头像就用它自己的，这里只是没传时的兜底）
 * - 人类：按色相 + 名字哈希生成的几何图案，同一人永远同一张
 */
function Geometry({ hue, seed, ai }: { hue: number; seed: number; ai: boolean }) {
  const a = ((hue % 360) + 360) % 360
  const b = (a + 38) % 360
  const c = (a + 76) % 360
  // 渐变 id 必须**文档内唯一**。以前写成 `ag${seed % 991}${ai ? 'x' : 'y'}` ——
  // 同一个人的头像会在会话列表 + 每条消息里各出现一次，于是生成多个同名 id；
  // 而浏览器的 url(#id) 是文档级解析、永远取第一份，后面的 <rect> 全指向第一个渐变，
  // 表现出来就是「消息头像退化成平涂、左栏却有渐变」（2026-11-15 修）。
  // useId() 给每个实例唯一 id，同一人多次出现也各自独立。
  const gid = `ag${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  // AI 兜底头像用中性石墨色，不跟随 avatar_hue（否则又会变成紫色）
  const c1 = ai ? '#3b4247' : `hsl(${a} 68% 56%)`
  const c2 = ai ? '#5d666d' : `hsl(${b} 64% 38%)`
  const c3 = ai ? '#8d959b' : `hsl(${c} 70% 62%)`

  if (ai) {
    return (
      <svg viewBox="0 0 40 40" className="avatar__art" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1} />
            <stop offset="1" stopColor={c2} />
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill={`url(#${gid})`} />
        {/* 鲸鱼：身体 + 尾巴 + 眼睛，和 DeepWhale 表情同一个剪影 */}
        <path
          d="M9 23.5c0-6.2 5-10.5 12-10.5 6.4 0 10.5 3.6 10.5 9.2 0 4.6-4.2 7.3-10.5 7.3C14 29.5 9 28.2 9 23.5Z"
          fill="rgba(255,255,255,.92)"
        />
        <path d="M30 20.5c2.6-2.4 5 0.4 6.4 2-1.6.6-2.4 2-2.2 3.4-2-.8-3.4-2.4-4.2-5.4Z" fill="rgba(255,255,255,.8)" />
        <circle cx="20.5" cy="21.5" r="1.5" fill={c2} />
      </svg>
    )
  }

  const mode = (seed + Math.round(a / 90)) % 4
  return (
    <svg viewBox="0 0 40 40" className="avatar__art" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c1} />
          <stop offset="1" stopColor={c2} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" fill={`url(#${gid})`} />
      {mode === 0 ? (
        <>
          <circle cx="11" cy="31" r="16" fill="rgba(255,255,255,.4)" />
          <circle cx="31" cy="9" r="9" fill={c3} opacity="0.6" />
        </>
      ) : null}
      {mode === 1 ? (
        <>
          <path d="M-8 36 L28 0 L40 0 L8 36 Z" fill="rgba(255,255,255,.4)" />
          <circle cx="32" cy="31" r="10" fill={c3} opacity="0.55" />
        </>
      ) : null}
      {mode === 2 ? (
        <>
          <path d="M0 40 L40 8 L40 40 Z" fill="rgba(255,255,255,.36)" />
          <circle cx="11" cy="11" r="8" fill={c3} opacity="0.65" />
        </>
      ) : null}
      {mode === 3 ? (
        <>
          <path d="M20 4 a16 16 0 0 1 0 32 a16 16 0 0 1 0-32" fill="rgba(255,255,255,.24)" />
          <path d="M20 12 a8 8 0 0 1 0 16 a8 8 0 0 1 0-16" fill="rgba(255,255,255,.42)" />
        </>
      ) : null}
    </svg>
  )
}

/**
 * 头像：有图片头像时优先图片（失败回退几何图案）。
 * AI 成员不再加描边/大角标——它自己传的头像就是它的脸，只在右下角压一个很小的「AI」字。
 */
export function Avatar({ name, hue, type, size = 'md', className, url }: AvatarProps) {
  const isAgent = type === 'agent'
  const h = typeof hue === 'number' && Number.isFinite(hue) ? hue : 210
  const seed = [...(name || 'x')].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 997, 7)
  // 头像地址来自服务端（`/media/...` 或用户填的外链），和消息里的媒体一样必须过白名单：
  // 只有站内相对路径与 https 能进 <img src>，javascript:/data:/http: 一律当作没设头像 → 几何兜底。
  const src = safeMediaUrl(url)
  // 图片加载失败（外链挂了/签名过期）时回退几何图案：不能出裂图或空白
  const [failed, setFailed] = useState(false)
  // url 变了就把失败状态清掉，否则换了新头像还停在回退图案上
  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    // avatar--ai 是**预留的语义钩子**：给测试（按 AI 身份选元素）和将来可能的可访问性样式用，
    // 当前 CSS 里没有任何 .avatar--ai 规则，**不是漏写**。要加规则前先确认
    // 「AI 不靠颜色/描边区分身份」（身份只靠右下角 8.5px 小字）这条视觉约定。
    <span
      className={cn('avatar', `avatar--${size}`, isAgent && 'avatar--ai', className)}
      style={avatarColor(h)}
      aria-hidden="true"
    >
      {src && !failed ? (
        <img
          className="avatar__img"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Geometry hue={h} seed={seed} ai={isAgent} />
      )}
      {isAgent ? <span className="avatar__ai">AI</span> : null}
    </span>
  )
}
