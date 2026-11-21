// 发送/重试：乐观气泡、幂等 client_msg_id、服务端 seq 归位、失败标记。
// 从 ChatView 抽出来的目的：发送链路（含富内容 parts）有明确的输入输出，便于单独测。
import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { api, ApiError, submitReasonText } from '../api'
import type { Conversation, LocalMessage, Me, MessagePart, Notify } from '../types'
import { makeClientMsgId } from '../utils'
import { normalizeParts, previewOf } from '../parts'
import { sortMessages } from '../lib/chat'
import { play } from '../sound'

interface UseComposerOptions {
  me: Me
  notify: Notify
  /** 当前打开的会话（用 ref 读，避免回调闭包过期） */
  activeIdRef: { current: number | null }
  lastSeqRef: { current: Record<number, number> }
  messagesRef: { current: Record<number, LocalMessage[]> }
  writeMessages: (convId: number, updater: (list: LocalMessage[]) => LocalMessage[]) => void
  setConversations: Dispatch<SetStateAction<Conversation[]>>
}

export function useComposer({
  me,
  notify,
  activeIdRef,
  lastSeqRef,
  messagesRef,
  writeMessages,
  setConversations,
}: UseComposerOptions) {
  const [replyTo, setReplyTo] = useState<LocalMessage | null>(null)

  const deliver = useCallback(
    async (
      convId: number,
      body: string,
      clientMsgId: string,
      replyToSeq: number | null,
      mentions: number[],
      parts?: MessagePart[],
      onDelivered?: () => void,
    ) => {
      try {
        const res = await api.sendMessage(convId, { body, parts, clientMsgId, replyToSeq, mentions })
        if (!res.accepted) {
          writeMessages(convId, (prev) =>
            prev.map((item) => (item.clientMsgId === clientMsgId ? { ...item, optimistic: false, failed: true } : item)),
          )
          notify(submitReasonText(res.reason), 'error')
          play('error')
          return
        }
        // 服务端已收下：通知调用方（例如把表情写进「最近使用」）
        onDelivered?.()
        if (typeof res.seq === 'number') {
          const serverSeq = res.seq
          writeMessages(convId, (prev) => {
            const cleaned = prev.filter((item) => item.seq !== serverSeq || item.clientMsgId === clientMsgId)
            const index = cleaned.findIndex((item) => item.clientMsgId === clientMsgId)
            if (index < 0) return cleaned
            const next = [...cleaned]
            next[index] = { ...next[index], seq: serverSeq, eventId: res.event_id ?? 0, optimistic: false, failed: false }
            return sortMessages(next)
          })
          lastSeqRef.current[convId] = Math.max(lastSeqRef.current[convId] ?? 0, serverSeq)
          setConversations((prev) =>
            prev.map((conv) =>
              conv.id === convId
                ? {
                    ...conv,
                    lastSeq: Math.max(conv.lastSeq, serverSeq),
                    lastMessagePreview: previewOf(parts ?? [], body),
                    lastMessageAt: new Date().toISOString(),
                  }
                : conv,
            ),
          )
          play('send')
        }
        // 契约里 seq 可选：没有 seq 时保持「发送中…」，等 WS event 归位
      } catch (err) {
        writeMessages(convId, (prev) =>
          prev.map((item) => (item.clientMsgId === clientMsgId ? { ...item, optimistic: false, failed: true } : item)),
        )
        notify(err instanceof ApiError ? err.message : '发送失败，请重试', 'error')
        play('error')
      }
    },
    [lastSeqRef, notify, setConversations, writeMessages],
  )

  const handleSend = useCallback(
    (body: string, mentions: number[], replyToSeq: number | null, parts?: MessagePart[], onDelivered?: () => void) => {
      const convId = activeIdRef.current
      if (convId == null) return
      const clientMsgId = makeClientMsgId()
      const optimistic: LocalMessage = {
        seq: null,
        eventId: 0,
        senderId: me.id,
        senderType: 'user',
        senderName: me.displayName,
        avatarHue: me.avatarHue,
        avatarUrl: me.avatarUrl,
        body,
        parts: parts && parts.length > 0 ? parts : undefined,
        replyToSeq,
        mentions,
        createdAt: new Date().toISOString(),
        optimistic: true,
        failed: false,
        clientMsgId,
      }
      writeMessages(convId, (prev) => sortMessages([...prev, optimistic]))
      setReplyTo(null)
      void deliver(convId, body, clientMsgId, replyToSeq, mentions, parts, onDelivered)
    },
    [activeIdRef, deliver, me, writeMessages],
  )

  const handleRetry = useCallback(
    (clientMsgId: string) => {
      const convId = activeIdRef.current
      if (convId == null) return
      const target = (messagesRef.current[convId] ?? []).find((item) => item.clientMsgId === clientMsgId)
      if (!target) return
      writeMessages(convId, (prev) =>
        prev.map((item) => (item.clientMsgId === clientMsgId ? { ...item, failed: false, optimistic: true } : item)),
      )
      // 幂等：复用同一个 client_msg_id，服务端按 (actor_id, client_msg_id) 去重
      // 富内容消息重试时连同 parts 一起重发（附件已经上传过，不会重复上传）
      const parts = target.parts ? normalizeParts(target.parts, target.body) : undefined
      void deliver(convId, target.body, clientMsgId, target.replyToSeq ?? null, target.mentions, parts)
    },
    [activeIdRef, deliver, messagesRef, writeMessages],
  )

  return { replyTo, setReplyTo, handleSend, handleRetry }
}
