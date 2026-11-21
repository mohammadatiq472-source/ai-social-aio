// 世界模块适配层 · 快照渲染（新增文件）
// 网关（aio-world，GPL 树）产出俯视 SVG；本模块用 sharp 转 PNG——
// 媒体处理放 MIT 树，GPL/MIT 两树不合并代码。
// 产物只走内存 → MCP image content block；如需持久化由调用方写入 attachments
//（硬规则：二进制绝不进 events/消息正文/日志，见 CONTRACT.md §11）。
import sharp from 'sharp'

export async function svgToPng(svg, { width = 640 } = {}) {
  const buf = await sharp(Buffer.from(svg), { density: 96 })
    .resize({ width })
    .png()
    .toBuffer()
  return { pngBase64: buf.toString('base64'), bytes: buf.length }
}
