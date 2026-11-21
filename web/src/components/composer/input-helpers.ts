// 输入栏里不依赖 React 的纯函数：草稿键、图片白名单、拖拽判定、@ 补全探测。
// 为什么搬出来：Composer 只剩「状态编排 + 事件处理」，
// 这些规则（草稿 key 前缀、24 字符内才算 @ 触发词）跟 UI 无关，混在组件里没人找得到。
import { ALLOWED_IMAGE_MIMES } from '../../parts'

export const MAX_LENGTH = 4000

export interface MentionState {
  active: boolean
  query: string
  atIndex: number
  caret: number
}

export const EMPTY_MENTION: MentionState = { active: false, query: '', atIndex: -1, caret: -1 }

export function draftKey(conversationId: number): string {
  return `qqmini:draft:${conversationId}`
}

export function isAllowedImage(mime: string): boolean {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)
}

export function firstImageFile(files: FileList | null | undefined): File | null {
  if (!files) return null
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    if (file && file.type.toLowerCase().startsWith('image/')) return file
  }
  return null
}

export function hasFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false
  const types = Array.from(data.types ?? [])
  return types.includes('Files')
}

/** 从光标位置往前找最近一个未被空格隔断的 @，作为补全触发词。 */
export function detectMention(text: string, caret: number): MentionState {
  let index = caret - 1
  while (index >= 0) {
    const char = text[index]
    if (char === '@') {
      const before = index === 0 ? ' ' : text[index - 1]
      if (/\s|^$/.test(before) || index === 0) {
        return { active: true, query: text.slice(index + 1, caret), atIndex: index, caret }
      }
      return EMPTY_MENTION
    }
    if (/\s/.test(char)) return EMPTY_MENTION
    if (caret - index > 24) return EMPTY_MENTION
    index -= 1
  }
  return EMPTY_MENTION
}
