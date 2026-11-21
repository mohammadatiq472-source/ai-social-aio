import { useEffect, useState } from 'react'
import type { HTMLAttributes, ReactElement } from 'react'
import type { FilePart, HtmlPart, ImagePart, MessagePart, StickerPart, VideoPart, VoicePart } from '../types'
import { clampHtmlHeight, formatBytes, hasImageSize, hostOf, voiceSeconds, voiceWidth } from '../parts'
import { toggleVoice, useVoicePlayer } from '../voicePlayer'
import { cn } from '../utils'

interface MessageContentProps {
  parts: MessagePart[]
  /** 表情包的静态地址解析（清单没加载完时给兜底路径）；pack/key 非法时返回 null，表示不渲染图片 */
  stickerUrl: (pack: string, key: string) => string | null
  onOpenImage: (part: ImagePart) => void
  /** 只挂到文字气泡上的长按/右键手势（图片、语音、表情各走自己的逻辑） */
  bubbleHandlers?: HTMLAttributes<HTMLDivElement>
}

type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'image'; key: string; part: ImagePart }
  | { kind: 'sticker'; key: string; part: StickerPart }
  | { kind: 'voice'; key: string; part: VoicePart }
  | { kind: 'video'; key: string; part: VideoPart }
  | { kind: 'file'; key: string; part: FilePart }
  | { kind: 'html'; key: string; part: HtmlPart }
  | { kind: 'unsupported'; key: string; rawType?: string }

/** 相邻 text 段合并成一个气泡；图 / 表情 / 语音 / 文件包 / 网页 / 未知段各自成块，顺序保持 */
function groupParts(parts: MessagePart[]): Block[] {
  const blocks: Block[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'text') {
        last.text = last.text ? `${last.text}\n${part.text}` : part.text
        return
      }
      blocks.push({ kind: 'text', key: `t-${index}`, text: part.text })
      return
    }
    if (part.type === 'image') {
      blocks.push({ kind: 'image', key: `i-${index}`, part })
      return
    }
    if (part.type === 'sticker') {
      blocks.push({ kind: 'sticker', key: `s-${index}`, part })
      return
    }
    if (part.type === 'voice') {
      blocks.push({ kind: 'voice', key: `v-${index}`, part })
      return
    }
    if (part.type === 'video') {
      blocks.push({ kind: 'video', key: `m-${index}`, part })
      return
    }
    if (part.type === 'file') {
      blocks.push({ kind: 'file', key: `f-${index}`, part })
      return
    }
    if (part.type === 'html') {
      blocks.push({ kind: 'html', key: `h-${index}`, part })
      return
    }
    blocks.push({ kind: 'unsupported', key: `u-${index}`, rawType: part.rawType })
  })
  return blocks
}

/** 右上角「外链」小标：内容不在本站，看的人要心里有数（契约 §4） */
function ExtBadge() {
  return (
    <span className="rich-card__ext" title="内容来自站外链接，本平台不存储、不扫描">
      外链
    </span>
  )
}

/** 纯外链媒体（没有本地附件，只有 https 直链）：attachmentId 为 0 */
function isExternalMedia(part: { attachmentId?: number }): boolean {
  return (part.attachmentId ?? 0) <= 0
}

/**
 * [Q14] 外链媒体是否先过「点击加载」闸：没有本站附件（attachmentId<=0）却有 url，
 * 说明内容由站外域名提供。直接 `img src` 会把访问者 IP/UA/时间送给对方（1px 追踪图），
 * 所以占位阶段**不发任何请求**，用户点了才把 url 交给真正的 media 元素。
 * 站内附件（attachmentId>0）不经过这里，自动加载行为与原来完全一致。
 */
function needsExternalGate(part: { attachmentId?: number; url?: string | null }): boolean {
  return isExternalMedia(part) && Boolean(part.url)
}

/** 外链占位上的固定文案：必须让用户知道「这是站外内容、本站没审过」（Q14 要求） */
const EXT_GATE_NOTE = '外链内容未经本站审核'

const EXT_KIND_LABEL = { image: '图片', voice: '语音', video: '视频' } as const

/**
 * 外链媒体的占位卡（域名 + 「外部内容，点击加载」+ 未审核提示）。
 * 这里刻意不渲染 img/video/audio：占位本身零网络请求，点击才触发加载。
 */
function ExternalMediaGate({
  kind,
  url,
  onLoad,
}: {
  kind: 'image' | 'voice' | 'video'
  url: string
  onLoad: () => void
}) {
  const host = hostOf(url) || '站外域名'
  return (
    <button
      type="button"
      className={`msg__ext-gate msg__ext-gate--${kind}`}
      onClick={onLoad}
      aria-label={`外部${EXT_KIND_LABEL[kind]}（${host}），点击加载；${EXT_GATE_NOTE}`}
      title="点击加载外链内容"
    >
      <span className="msg__ext-gate__host" title={host}>
        {host}
      </span>
      <span className="msg__ext-gate__text">外部内容，点击加载</span>
      <span className="msg__ext-gate__note">{EXT_GATE_NOTE}</span>
    </button>
  )
}

/** 给外链媒体套一层定位容器，右上角挂「外链」标；站内附件原样返回 */
function withExtBadge(part: { attachmentId?: number }, body: ReactElement, variant?: 'voice'): ReactElement {
  if (!isExternalMedia(part)) return body
  return (
    <div className={variant === 'voice' ? 'msg__ext-wrap msg__ext-wrap--voice' : 'msg__ext-wrap'}>
      {body}
      <ExtBadge />
    </div>
  )
}

function ImageBlock({ part, onOpen }: { part: ImagePart; onOpen: (part: ImagePart) => void }) {
  const [broken, setBroken] = useState(false)
  // 缩略图加载失败只回退一次到原图；原图再失败才判破图（否则两个 src 互相回退会来回打）
  const [thumbFailed, setThumbFailed] = useState(false)
  const url = part.url ?? ''
  const thumb = part.thumbUrl ?? ''
  // 外链图默认不加载（Q14）。记「用户点过哪条 url」而不是布尔：消息内容被替换时自动回到占位
  const gate = needsExternalGate(part)
  const [allowedUrl, setAllowedUrl] = useState<string | null>(gate ? null : url)
  const useThumb = Boolean(thumb) && !thumbFailed
  const src = useThumb ? thumb : url
  const alt = part.alt ?? '图片'
  // 扫描态优先于"有没有 url"：pending 时非上传者本来就没有 url，
  // 显示"图片不可用"会让用户以为文件坏了、去重发（Q6 的语义是"在审核"）。
  if (part.pending) {
    return withExtBadge(
      part,
      <div className="msg__image msg__image--broken" role="img" aria-label="图片审核中">
        审核中
      </div>,
    )
  }
  if (part.blocked) {
    return withExtBadge(
      part,
      <div className="msg__image msg__image--broken" role="img" aria-label="图片不可用">
        内容不可用
      </div>,
    )
  }
  if (!src || broken) {
    return withExtBadge(
      part,
      <div className="msg__image msg__image--broken" role="img" aria-label="图片不可用">
        图片不可用
      </div>,
    )
  }
  // 外链图：先给占位卡；点过才挂 <img src>（站内附件 allowedUrl 恒等于 url，不会走到这里）
  if (gate && allowedUrl !== url) {
    return withExtBadge(
      part,
      <ExternalMediaGate kind="image" url={url} onLoad={() => setAllowedUrl(url)} />,
    )
  }
  const sized = hasImageSize(part)
  return withExtBadge(
    part,
    <button
      type="button"
      className="msg__image"
      // 点击永远打开原图：part 原样交给灯箱，url 未被缩略图替换
      onClick={() => onOpen(part)}
      aria-label={`查看大图：${alt}`}
      title="点击查看大图"
    >
      <img
        className={sized ? 'msg__image-img' : 'msg__image-img msg__image-img--cover'}
        src={src}
        alt={alt}
        width={sized ? (part.width as number) : 200}
        height={sized ? (part.height as number) : 200}
        loading="lazy"
        decoding="async"
        // 外链图不把本站地址当 Referer 发出去（全局 Referrer-Policy 之外的第二道保险）
        referrerPolicy="no-referrer"
        onError={() => {
          if (useThumb) setThumbFailed(true)
          else setBroken(true)
        }}
      />
    </button>,
  )
}

function StickerBlock({
  part,
  stickerUrl,
}: {
  part: StickerPart
  stickerUrl: (pack: string, key: string) => string | null
}) {
  const [broken, setBroken] = useState(false)
  const caption = part.caption ?? '表情'
  const src = stickerUrl(part.pack, part.key)

  // 自定义包第一次渲染时包列表可能还没到（会先猜一个静态路径）；列表到位后重试
  useEffect(() => {
    setBroken(false)
  }, [src])

  // pack/key 没通过白名单（stickerSrc 返回 null）：不放 <img>，直接显示占位文本
  if (!src || broken) {
    return (
      <span className="msg__sticker msg__sticker--broken" title={caption}>
        [表情]
      </span>
    )
  }
  return (
    <img
      className="msg__sticker"
      src={src}
      alt={caption}
      title={caption}
      width={120}
      height={120}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  )
}

const PLAY_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8.4 5.4v13.2L19 12 8.4 5.4Z" fill="currentColor" />
  </svg>
)

const PAUSE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6.8" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
    <rect x="13.6" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
  </svg>
)

/** 简版波形：固定高度序列，按 attachmentId 轮转，视觉上每条略有差别 */
const WAVE_BARS = [42, 68, 52, 86, 60, 94, 48, 74, 58, 88, 46, 66]

function VoiceBlock({ part }: { part: VoicePart }) {
  const player = useVoicePlayer()
  // 外链语音没有 attachmentId，用 url 当播放器 key，否则多条外链会互相顶掉
  const key = part.attachmentId > 0 ? `v:${part.attachmentId}` : `v:u:${part.url ?? ''}`
  // 外链语音同样先过「点击加载」（Q14）：占位阶段不创建 Audio，也就没有请求
  const gate = needsExternalGate(part)
  const [allowedUrl, setAllowedUrl] = useState<string | null>(gate ? null : (part.url ?? ''))
  const active = player.key === key
  const playing = active && player.playing
  const totalMs = active && player.totalMs > 0 ? player.totalMs : (part.durationMs ?? 0)
  const progress = active && totalMs > 0 ? Math.min(1, Math.max(0, player.currentMs / totalMs)) : 0
  const seconds = voiceSeconds(part.durationMs ?? totalMs)
  const remaining = Math.max(1, Math.ceil((totalMs - (active ? player.currentMs : 0)) / 1000))
  const width = voiceWidth(part.durationMs)
  const offset = (part.attachmentId > 0 ? part.attachmentId : (part.url ?? '').length) % WAVE_BARS.length
  const bars = WAVE_BARS.map((_, index) => WAVE_BARS[(index + offset) % WAVE_BARS.length])
  const litBars = Math.round(progress * bars.length)

  if (!part.url) {
    // 扫描态先判：pending 的人本来就没有 url，别把它显示成"语音坏了"
    if (part.pending) {
      return withExtBadge(part, <span className="voice voice--broken" title="语音审核中">审核中</span>, 'voice')
    }
    if (part.blocked) {
      return withExtBadge(part, <span className="voice voice--broken" title="内容不可用">内容不可用</span>, 'voice')
    }
    return withExtBadge(
      part,
      <span className="voice voice--broken" title="语音不可用">
        语音不可用
      </span>,
      'voice',
    )
  }

  if (gate && allowedUrl !== part.url) {
    return withExtBadge(
      part,
      <ExternalMediaGate
        kind="voice"
        url={part.url}
        onLoad={() => {
          setAllowedUrl(part.url as string)
          // 用户这一次点击就是「同意加载」，顺手播一遍；不点则永远不创建 Audio
          toggleVoice(key, part.url as string, part.durationMs)
        }}
      />,
      'voice',
    )
  }

  return withExtBadge(
    part,
    <button
      type="button"
      className={cn('voice', active && 'voice--active', playing && 'voice--playing', active && player.error && 'voice--error')}
      style={{ width: `${width}px` }}
      onClick={() => toggleVoice(key, part.url as string, part.durationMs)}
      aria-label={`语音 ${seconds} 秒，点击${playing ? '暂停' : '播放'}`}
      title={active && player.error ? player.error : `${seconds}'' 点击${playing ? '暂停' : '播放'}`}
    >
      <span className="voice__play" aria-hidden="true">
        {playing ? PAUSE_ICON : PLAY_ICON}
      </span>
      <span className="voice__wave" aria-hidden="true">
        {bars.map((height, index) => (
          <span
            key={index}
            className={cn('voice__bar', index < litBars && 'voice__bar--on')}
            style={{ height: `${height}%` }}
          />
        ))}
      </span>
      <span className="voice__time">{playing ? `${remaining}''` : `${seconds}''`}</span>
    </button>,
    'voice',
  )
}

/** 视频：默认只显示封面 + 播放键，点了才真正加载 <video>（省流量） */
function VideoBlock({ part }: { part: VideoPart }) {
  const [active, setActive] = useState(false)
  const [broken, setBroken] = useState(false)
  // 外链封面可能挂掉：失败后退回渐变占位，别在卡片里显示裂图
  const [posterBroken, setPosterBroken] = useState(false)
  // 外链视频也先过「点击加载」：占位阶段不挂 poster，避免封面图先把访问者 IP 送给对方（Q14）
  const gate = needsExternalGate(part)
  const [allowedUrl, setAllowedUrl] = useState<string | null>(gate ? null : (part.url ?? ''))
  const poster = posterBroken ? undefined : (part.posterUrl ?? undefined)
  if (!part.url || broken) {
    if (part.pending) {
      return withExtBadge(part, <div className="msg__video msg__video--broken" role="img" aria-label="视频审核中">审核中</div>)
    }
    if (part.blocked) {
      return withExtBadge(part, <div className="msg__video msg__video--broken" role="img" aria-label="视频不可用">内容不可用</div>)
    }
    return withExtBadge(
      part,
      <div className="msg__video msg__video--broken" role="img" aria-label="视频不可用">
        视频不可用
      </div>,
    )
  }
  if (gate && allowedUrl !== part.url) {
    return withExtBadge(
      part,
      <ExternalMediaGate kind="video" url={part.url} onLoad={() => setAllowedUrl(part.url as string)} />,
    )
  }
  if (!active) {
    return withExtBadge(
      part,
      <button
        type="button"
        className="msg__video"
        onClick={() => setActive(true)}
        aria-label="播放视频"
        title="点击播放"
      >
        {poster ? <img className="msg__video-poster" src={poster} alt="视频封面" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setPosterBroken(true)} /> : <span className="msg__video-blank" />}
        <span className="msg__video-play" aria-hidden="true">
          {PLAY_ICON}
        </span>
      </button>,
    )
  }
  return withExtBadge(
    part,
    <video
      className="msg__video-player"
      src={part.url}
      poster={poster}
      controls
      autoPlay
      playsInline
      preload="metadata"
      onError={() => setBroken(true)}
    />,
  )
}

/* ---------------- 外链富内容（契约 docs/富内容外链.md §4） ---------------- */

const FILE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.2 2.9h7.1l4.5 4.5v13.7H6.2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M13.1 3.1v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9 12.4h6M9 15.6h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const WEB_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3.5 12h17M12 3.4c2.3 2.4 3.5 5.3 3.5 8.6S14.3 18.2 12 20.6c-2.3-2.4-3.5-5.3-3.5-8.6S9.7 5.8 12 3.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

/** 文件包：图标 + 文件名 + 大小 + 「打开」；有清单时可展开（只列名字与大小，不联网） */
function FileBlock({ part }: { part: FilePart }) {
  const [open, setOpen] = useState(false)
  const files = part.files ?? []
  const size = formatBytes(part.bytes)
  const sub = [size, part.mime].filter(Boolean).join(' · ')
  return (
    <div className="rich-card rich-card--file">
      <ExtBadge />
      <div className="rich-card__head">
        <span className="rich-card__icon" aria-hidden="true">
          {FILE_ICON}
        </span>
        <span className="rich-card__meta">
          <span className="rich-card__name" title={part.name}>
            {part.name}
          </span>
          <span className="rich-card__sub">{sub || '文件包'}</span>
        </span>
      </div>
      <div className="rich-card__actions">
        <a className="rich-card__btn rich-card__btn--primary" href={part.url} target="_blank" rel="noopener noreferrer">
          打开
        </a>
        {files.length > 0 ? (
          <button
            type="button"
            className="rich-card__btn"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起清单' : '查看清单'}（{files.length}）
          </button>
        ) : null}
      </div>
      {open && files.length > 0 ? (
        <ul className="rich-filelist">
          {files.map((file, index) => (
            <li className="rich-filelist__item" key={`${file.name}-${index}`}>
              <span className="rich-filelist__name" title={file.name}>
                {file.name}
              </span>
              <span className="rich-filelist__size">{formatBytes(file.bytes) || '—'}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 在线预览：卡片 + 沙箱 iframe。
 * 安全底线：绝不加 allow-same-origin（否则沙箱页面能读本站 Cookie/localStorage）。
 * src 与 srcDoc 二选一，url 优先（契约 §2.1）。
 */
function HtmlBlock({ part }: { part: HtmlPart }) {
  const [open, setOpen] = useState(false)
  const src = part.url ?? ''
  const srcdoc = part.srcdoc ?? ''
  const title = part.title ?? '网页'
  const host = hostOf(src)
  const height = clampHtmlHeight(part.height)
  const canFrame = Boolean(src) || Boolean(srcdoc)
  return (
    <div className="rich-card rich-card--html">
      <ExtBadge />
      <div className="rich-card__head">
        <span className="rich-card__icon rich-card__icon--web" aria-hidden="true">
          {WEB_ICON}
        </span>
        <span className="rich-card__meta">
          <span className="rich-card__name" title={title}>
            {title || '网页'}
          </span>
          <span className="rich-card__sub">{host || (srcdoc ? '内嵌页面' : '网页')}</span>
        </span>
      </div>
      <div className="rich-card__actions">
        <button
          type="button"
          className="rich-card__btn rich-card__btn--primary"
          aria-expanded={open}
          disabled={!canFrame}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起预览' : '预览'}
        </button>
        {src ? (
          <a className="rich-card__btn" href={src} target="_blank" rel="noopener noreferrer">
            新窗口
          </a>
        ) : null}
      </div>
      {open && canFrame ? (
        <iframe
          className="rich-html__frame"
          title={title || '网页预览'}
          style={{ height }}
          src={src || undefined}
          srcDoc={src ? undefined : srcdoc}
          sandbox="allow-scripts allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : null}
    </div>
  )
}

/** 超过这个字数就折叠：4000 字在手机上能占 8–12 屏，会把上下文和滚动条一起挤没 */
const COLLAPSE_CHARS = 600

/**
 * 文字气泡。超长正文折叠成 8 行 + 「展开全文」（前端审查 R6）。
 * 用 CSS line-clamp 而不是截断文本：复制/搜索/长按都还能拿到原文。
 */
function TextBubble({ text, handlers }: { text: string; handlers?: HTMLAttributes<HTMLDivElement> }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = text.length > COLLAPSE_CHARS
  return (
    <div className="bubble" {...handlers}>
      <p className={cn('bubble__body', collapsible && !expanded && 'bubble__body--clamped')}>{text}</p>
      {collapsible ? (
        <button
          type="button"
          className="bubble__more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `展开全文（${text.length} 字）`}
        </button>
      ) : null}
    </div>
  )
}

/** 一条消息的正文：按 parts 有序渲染；没有 parts 的老消息由调用方回退出 text 段 */
export function MessageContent({ parts, stickerUrl, onOpenImage, bubbleHandlers }: MessageContentProps) {
  const blocks = groupParts(parts)
  return (
    <div className="msg__parts">
      {blocks.map((block) => {
        if (block.kind === 'text') {
          return <TextBubble key={block.key} text={block.text} handlers={bubbleHandlers} />
        }
        if (block.kind === 'image') {
          return <ImageBlock key={block.key} part={block.part} onOpen={onOpenImage} />
        }
        if (block.kind === 'sticker') {
          return <StickerBlock key={block.key} part={block.part} stickerUrl={stickerUrl} />
        }
        if (block.kind === 'voice') {
          return <VoiceBlock key={block.key} part={block.part} />
        }
        if (block.kind === 'video') {
          return <VideoBlock key={block.key} part={block.part} />
        }
        if (block.kind === 'file') {
          return <FileBlock key={block.key} part={block.part} />
        }
        if (block.kind === 'html') {
          return <HtmlBlock key={block.key} part={block.part} />
        }
        return (
          <div className="msg__unsupported" key={block.key}>
            [暂不支持的类型]
          </div>
        )
      })}
    </div>
  )
}
