import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { api, ApiError } from '../api'
import type { Me } from '../types'
import { cn, copyText } from '../utils'
import { isMuted, play, toggleMuted } from '../sound'
import { currentEndpoint, disablePush, enablePush, pushSupported } from '../push-client'
import { AgentsView } from './AgentsView'
import { Avatar } from './Avatar'
import { ConfirmDialog } from './ConfirmDialog'
import { InviteCard } from './invites/InviteCard'

/** 与 web/package.json 的 version 保持一致（vite 配置不在本次改动范围，先内置） */
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

/* 头像规格（契约 §1.1）：只收 JPG/PNG/WebP，原图 ≤4MB，成品 512×512 JPEG，目标 ≤512KB */
const AVATAR_SIZE = 512
const AVATAR_MAX_SOURCE = 4 * 1024 * 1024
const AVATAR_TARGET_BYTES = 512 * 1024
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** 读图：用 <img> 解码（浏览器会按 EXIF 摆正方向），失败时 reject */
function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('decode_failed'))
    }
    img.src = objectUrl
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode_failed'))), 'image/jpeg', quality)
  })
}

/**
 * 居中裁正方形并缩放到 512×512，输出 JPEG：
 * - 质量 0.85 先出图；若 > 512KB 再压到 0.75 取较小的那张（契约允许的一次降级）
 * - 透明 PNG 转 JPEG 会变黑，所以先铺白底
 */
async function makeAvatarBlob(file: Blob): Promise<Blob> {
  const img = await loadImage(file)
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  if (!side) throw new Error('empty_image')
  const sx = Math.floor((img.naturalWidth - side) / 2)
  const sy = Math.floor((img.naturalHeight - side) / 2)

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no_canvas')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)

  let blob = await canvasToJpeg(canvas, 0.85)
  if (blob.size > AVATAR_TARGET_BYTES) {
    const smaller = await canvasToJpeg(canvas, 0.75)
    if (smaller.size < blob.size) blob = smaller
  }
  return blob
}

interface MeViewProps {
  me: Me
  notify: (text: string, kind?: 'info' | 'success' | 'error') => void
  onLogout: () => void | Promise<void>
  /** 头像变更后把新的 me 回传，让顶栏/其它页立即换图（否则要刷新才生效） */
  onMeChange?: (me: Me) => void
}

/** 「我的」页：账号号 + 号码可发现开关 + 音效 + App 信息 + 退出登录 */
export function MeView({ me, notify, onLogout, onMeChange }: MeViewProps) {
  const [sub, setSub] = useState<'root' | 'friends' | 'agents'>('root')
  const [discoverable, setDiscoverable] = useState(me.discoverable !== false)
  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [muted, setMuted] = useState(() => isMuted())
  const [busyLogout, setBusyLogout] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  // 图片头像：先用父级给的 me 初始化；接口返回新 me 后本地立即刷新
  const [avatarUrl, setAvatarUrl] = useState<string | null>(me.avatarUrl ?? null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  // 邮箱验证：只有实例配了 SMTP 才会显示入口（后端 /api/me 的 emailVerification.enabled）
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifySentTo, setVerifySentTo] = useState<string | null>(null)

  /* ------------ 邮箱验证（没配 SMTP 就不显示入口） ------------ */
  const verifyEnabled = me.emailVerification?.enabled === true
  const emailVerified = me.emailVerified === true
  const sendVerifyMail = async () => {
    if (verifyBusy) return
    setVerifyBusy(true)
    try {
      const out = await api.sendEmailVerification()
      setVerifySentTo(out.sentTo || null)
      notify(`验证邮件已发出：${out.sentTo || '请查收邮箱'}`)
    } catch (err) {
      const code = err instanceof ApiError ? err.code : ''
      if (code === 'email_verification_disabled') notify('本实例没有配置发信服务，邮箱验证不可用')
      else if (code === 'too_many') notify('刚发过一封，请稍后再试')
      else notify('验证邮件没发出去，请稍后重试')
    } finally {
      setVerifyBusy(false)
    }
  }

  /* ------------ 系统通知（Web Push）------------ */
  // pushOn 表示「这台设备已经在本站订阅了通知」，不是服务端配置开关
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushServerOn, setPushServerOn] = useState(false)

  useEffect(() => {
    if (!pushSupported()) return
    let alive = true
    void api
      .pushKey()
      .then((res) => {
        if (alive) setPushServerOn(Boolean(res.enabled && res.key))
      })
      .catch(() => {
        // 老版本后端没有这个接口：当作不支持，不打扰用户
      })
    void currentEndpoint().then((endpoint) => {
      if (alive && endpoint) setPushOn(true)
    })
    return () => {
      alive = false
    }
  }, [])

  async function togglePush() {
    if (pushBusy) return
    setPushBusy(true)
    try {
      if (!pushOn) {
        const key = await api.pushKey()
        if (!key.enabled || !key.key) {
          notify('服务器还没有开启系统通知', 'info')
          return
        }
        const sub = await enablePush(key.key)
        await api.pushSubscribe(sub)
        setPushOn(true)
        notify('已开启系统通知：有新消息会弹通知', 'success')
      } else {
        const endpoint = await disablePush()
        if (endpoint) await api.pushUnsubscribe(endpoint)
        setPushOn(false)
        notify('已关闭系统通知', 'info')
      }
    } catch (err) {
      // enablePush 抛的是给用户看的中文原因；接口错走 ApiError.message
      notify(err instanceof ApiError ? err.message : (err as Error).message || '设置失败，请重试', 'error')
    } finally {
      setPushBusy(false)
    }
  }

  useEffect(() => {
    setAvatarUrl(me.avatarUrl ?? null)
  }, [me.avatarUrl])

  /**
   * 选图 → 客户端校验 → canvas 裁 512×512 JPEG → 上传附件 → 绑定到我的头像。
   * 失败保持原头像不变，只 toast 后端 message。
   */
  async function handleAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // 清空 value：同一张图再选一次也能触发
    if (!file) return
    if (!AVATAR_TYPES.includes(file.type)) {
      notify('只支持 JPG、PNG、WebP', 'error')
      return
    }
    if (file.size > AVATAR_MAX_SOURCE) {
      notify('头像最大 4MB', 'error')
      return
    }
    if (avatarBusy) return
    setAvatarBusy(true)
    try {
      const blob = await makeAvatarBlob(file)
      const uploaded = await api.uploadAttachment(blob, 'image/jpeg')
      const res = await api.setMyAvatar(uploaded.attachment.id)
      setAvatarUrl(res.me.avatarUrl ?? null)
      onMeChange?.(res.me)
      notify('头像已更新', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '头像上传失败，请重试', 'error')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function clearAvatar() {
    if (avatarBusy) return
    setAvatarBusy(true)
    try {
      const res = await api.clearMyAvatar()
      setAvatarUrl(res.me.avatarUrl ?? null)
      onMeChange?.(res.me)
      notify('已恢复默认头像', 'success')
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '恢复默认头像失败，请重试', 'error')
    } finally {
      setAvatarBusy(false)
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const accountNo = typeof me.accountNo === 'number' ? String(me.accountNo) : null

  async function copyAccountNo() {
    if (!accountNo) return
    const ok = await copyText(accountNo)
    notify(ok ? '号码已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error')
  }

  async function copyMcp() {
    if (!origin) return
    const ok = await copyText(`${origin}/mcp`)
    notify(ok ? 'MCP 地址已复制' : '复制失败，请手动选择复制', ok ? 'success' : 'error')
  }

  async function toggleDiscoverable() {
    if (discoverBusy) return
    const next = !discoverable
    setDiscoverable(next) // 乐观
    setDiscoverBusy(true)
    try {
      const res = await api.setDiscoverable(next)
      setDiscoverable(res.discoverable !== false)
      notify(res.discoverable !== false ? '别人可以通过号码找到你了' : '已关闭：别人不能用号码搜到你', 'success')
    } catch (err) {
      setDiscoverable(!next) // 回滚
      notify(err instanceof ApiError ? err.message : '设置失败，请重试', 'error')
    } finally {
      setDiscoverBusy(false)
    }
  }

  function toggleSound() {
    const next = toggleMuted()
    setMuted(next)
    if (!next) play('recv') // 开启时给一声，确认真的响了
    notify(next ? '音效已关闭' : '音效已开启', 'info')
  }

  async function handleLogout() {
    if (busyLogout) return
    // 二次确认由 ConfirmDialog 负责（原生 confirm 在移动端/深色模式下不可控）
    setBusyLogout(true)
    try {
      await onLogout()
    } finally {
      setBusyLogout(false)
    }
  }

  if (sub === 'agents') return <AgentsView notify={notify} onBack={() => setSub('root')} />

  return (
    <>
    <div className="me">
      <div className="me__inner">
        <header className="me__head">
          <h1 className="me__title">我的</h1>
        </header>

        {/* 资料卡：头像本身就是「更换」入口（不再单独占一张卡） */}
        <section className="me-card me-profile">
          <button
            type="button"
            className="me-profile__avatar"
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarBusy}
            title="点击更换头像"
            aria-label={avatarBusy ? '头像上传中' : '更换头像'}
          >
            <Avatar name={me.displayName} hue={me.avatarHue} size="lg" url={avatarUrl} />
            <span className="me-profile__cam" aria-hidden="true">
              {avatarBusy ? (
                <span className="me-profile__spinner" />
              ) : (
                <svg viewBox="0 0 24 24" width="13" height="13">
                  <path
                    d="M9.2 5.6 10.6 4h2.8l1.4 1.6h3.2A1.4 1.4 0 0 1 19.4 7v10.4a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4V7A1.4 1.4 0 0 1 6 5.6h3.2ZM12 8.4a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8Z"
                    fill="currentColor"
                  />
                </svg>
              )}
            </span>
          </button>

          <div className="me-profile__main">
            <p className="me-profile__name">{me.displayName}</p>
            {me.email ? <p className="me-profile__email">{me.email}</p> : null}
            <div className="me-account">
              <span className="me-account__label">账号号</span>
              <span className={cn('me-account__no', !accountNo && 'me-account__no--empty')}>
                {accountNo ?? '未分配'}
              </span>
              <button
                type="button"
                className="me-account__copy"
                onClick={() => void copyAccountNo()}
                disabled={!accountNo}
                aria-label="复制账号号"
              >
                复制
              </button>
              {avatarUrl ? <span className="me-account__dot" aria-hidden="true">·</span> : null}
              {avatarUrl ? (
                <button
                  type="button"
                  className="me-account__reset"
                  onClick={() => void clearAvatar()}
                  disabled={avatarBusy}
                >
                  恢复默认
                </button>
              ) : null}
            </div>
          </div>

          <input
            ref={avatarInputRef}
            className="me-avatar__file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => void handleAvatarFile(event)}
            tabIndex={-1}
            aria-hidden="true"
          />
        </section>

        {/* 邀请朋友：名额 / 一次性明文码 / 邀请人列表 / 吊销（后端 /api/invites/*） */}
        <InviteCard notify={notify} />

        <section className="me-card me-list">
          <button type="button" className="me-row me-row--link" onClick={() => setSub('agents')}>
            <span className="me-row__title">我的 AI</span>
            <span className="me-row__chev" aria-hidden="true">
              ›
            </span>
          </button>

          {verifyEnabled ? (
            <div className="me-row">
              <span className="me-row__text">
                <span className="me-row__title">邮箱验证</span>
                <span className="me-row__hint">
                  {emailVerified ? '已验证' : '未验证：点右侧发一封验证邮件'}
                </span>
              </span>
              {emailVerified ? (
                <span className="me-row__hint">✓</span>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={verifyBusy}
                  onClick={() => void sendVerifyMail()}
                >
                  {verifyBusy ? '发送中…' : verifySentTo ? '再发一封' : '发送验证邮件'}
                </button>
              )}
            </div>
          ) : null}

          <div className="me-row">
            <span className="me-row__title">允许通过号码找到我</span>
            <button
              type="button"
              role="switch"
              aria-checked={discoverable}
              aria-label="允许通过号码找到我"
              className={cn('switch', discoverable && 'switch--on')}
              onClick={() => void toggleDiscoverable()}
              disabled={discoverBusy}
            >
              <span className="switch__knob" aria-hidden="true" />
            </button>
          </div>

          <div className="me-row">
            <span className="me-row__title">消息音效</span>
            <button
              type="button"
              role="switch"
              aria-checked={!muted}
              aria-label="消息音效"
              className={cn('switch', !muted && 'switch--on')}
              onClick={toggleSound}
            >
              <span className="switch__knob" aria-hidden="true" />
            </button>
          </div>

          <div className="me-row">
            <div className="me-row__text">
              <span className="me-row__title">系统通知</span>
              <span className="me-row__hint">
                {pushSupported()
                  ? pushServerOn
                    ? '不在页面时也能收到（手机需添加到主屏）'
                    : '服务器未开启'
                  : '这个浏览器不支持'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={pushOn}
              aria-label="系统通知"
              className={cn('switch', pushOn && 'switch--on')}
              onClick={() => void togglePush()}
              disabled={pushBusy || !pushSupported() || !pushServerOn}
            >
              <span className="switch__knob" aria-hidden="true" />
            </button>
          </div>
        </section>

        <button
          type="button"
          className="me-meta"
          onClick={() => void copyMcp()}
          title={origin ? `点击复制 MCP 地址：${origin}/mcp` : '—'}
        >
          AIO {APP_VERSION} · {origin ? origin.replace(/^https?:\/\//, '') : '—'}
        </button>

        <button type="button" className="me-logout" onClick={() => setConfirmLogout(true)} disabled={busyLogout}>
          {busyLogout ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </div>
    {confirmLogout ? (
      <ConfirmDialog
        title="退出登录"
        danger
        busy={busyLogout}
        confirmText="退出"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false)
          void handleLogout()
        }}
      >
        <p>退出后需要重新输入邮箱和密码登录；未发送的草稿和正在上传的附件会丢失。</p>
      </ConfirmDialog>
    ) : null}
    </>
  )
}
