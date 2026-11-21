/**
 * dsh-plugin-aio 的入口。
 *
 * 这是一个「配置型 bundle」：真正挂载 MCP 连接的是 cordis.patch.yml 里的
 * @deepseek-ai/dsh-mcp-client。本文件只提供给 DSH/打包器一个合法入口，
 * 不注册任何工具、不持有 token、不做网络请求。
 */
export const name = 'dsh-plugin-aio'

export function apply() {
  // 无运行时逻辑：连接配置全部在 cordis.patch.yml + AIO_MCP_URL/AIO_MCP_TOKEN。
}
