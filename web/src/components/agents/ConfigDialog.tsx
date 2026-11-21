import type { AgentMcpConfig } from '../../types'
import { Modal } from '../Modal'

/** 接入配置弹窗的数据（创建成功 / 已有 AI 的配置两种形态共用） */
export type ConfigDetail =
  | {
      kind: 'created'
      name: string
      token: string
      accountNo: number | null
      password: string | null
      config: AgentMcpConfig | null
      loading: boolean
    }
  | { kind: 'config'; name: string; token: null; config: AgentMcpConfig | null; loading: boolean }

interface ConfigDialogProps {
  detail: ConfigDetail
  onClose: () => void
  onCopy: (text: string, label: string) => void
}

/** MCP 客户端接入片段：这几家是已验证常用的写法，顺序固定 */
const SNIPPET_LABELS: Array<{ key: 'claudeCode' | 'cursor' | 'codex'; title: string; hint: string }> = [
  { key: 'claudeCode', title: 'Claude Code', hint: '放进 .mcp.json 或 claude mcp add 的等价配置' },
  { key: 'cursor', title: 'Cursor', hint: 'Cursor → Settings → MCP → 粘贴 JSON' },
  { key: 'codex', title: 'Codex', hint: '写入 Codex 的 MCP server 配置段' },
]

function mcpUrlOf(config: AgentMcpConfig | null): string {
  if (config?.mcp?.url) return config.mcp.url
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/mcp`
}

/** 一次性接入信息：MCP 地址 + Bearer token + 号码 + 登录密码 */
function buildAccessInfo(
  config: AgentMcpConfig | null,
  token: string,
  accountNo: number | null,
  password: string | null,
): string {
  const lines = [`MCP 地址: ${mcpUrlOf(config)}`, `Authorization: Bearer ${token}`]
  if (accountNo != null) lines.push(`账号号: ${accountNo}`)
  if (password) lines.push(`登录密码: ${password}`)
  return lines.join('\n')
}

/**
 * 「创建成功 / 接入配置」弹窗。从 AgentsView 里拆出来：这里只做展示，
 * 复制动作由父组件的 onCopy 注入（父组件统一走 toast）。
 */
export function ConfigDialog({ detail, onClose, onCopy }: ConfigDialogProps) {
  return (
    <Modal
      title={detail.kind === 'created' ? `「${detail.name}」创建成功` : `「${detail.name}」的接入配置`}
      onClose={onClose}
      wide
      footer={
        <div className="modal__foot-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      }
    >
      {detail.kind === 'created' ? (
        <div className="token-box">
          <p className="token-box__warn">⚠ token / 号码 / 密码只显示这一次，请立即保存。</p>
          <code className="token-box__value">{detail.token}</code>
          {detail.accountNo != null || detail.password ? (
            <dl className="token-box__rows">
              {detail.accountNo != null ? (
                <div className="token-box__row">
                  <dt>账号号</dt>
                  <dd>
                    <code>{detail.accountNo}</code>
                  </dd>
                </div>
              ) : null}
              {detail.password ? (
                <div className="token-box__row">
                  <dt>登录密码</dt>
                  <dd>
                    <code>{detail.password}</code>
                    <span className="token-box__once">只显示这一次</span>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="token-box__actions">
            <button type="button" className="btn btn--primary" onClick={() => onCopy(detail.token, 'token')}>
              复制 token
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                onCopy(
                  buildAccessInfo(detail.config, detail.token, detail.accountNo, detail.password),
                  '接入信息',
                )
              }
            >
              复制接入信息
            </button>
          </div>
        </div>
      ) : null}

      {detail.loading ? <p className="card__hint">正在读取 MCP 配置…</p> : null}

      {detail.config ? (
        <>
          <div className="mcp-endpoint">
            <span className="mcp-endpoint__label">MCP 地址</span>
            <code>{detail.config.mcp.url}</code>
            <button type="button" className="btn btn--sm" onClick={() => onCopy(detail.config?.mcp.url ?? '', 'MCP 地址')}>
              复制
            </button>
          </div>

          {SNIPPET_LABELS.map((snippet) => {
            const text = detail.config ? detail.config.snippets?.[snippet.key] ?? '' : ''
            return (
              <section key={snippet.key} className="snippet">
                <header className="snippet__head">
                  <div>
                    <h3 className="snippet__title">{snippet.title}</h3>
                    <p className="snippet__hint">{snippet.hint}</p>
                  </div>
                  <button type="button" className="btn btn--sm" onClick={() => onCopy(text, snippet.title)}>
                    一键复制
                  </button>
                </header>
                <pre className="snippet__code">
                  <code>{text || '（后端未返回该客户端的片段）'}</code>
                </pre>
              </section>
            )
          })}
        </>
      ) : null}

      {!detail.loading && !detail.config ? (
        <p className="form-error">没能读到 MCP 配置，请稍后重试。</p>
      ) : null}
    </Modal>
  )
}
