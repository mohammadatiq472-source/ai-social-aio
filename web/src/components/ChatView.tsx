import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { Conversation, LocalMessage, Member, Me, Notify } from '../types'
import { cn } from '../utils'
import { useChatStream } from '../hooks/useChatStream'
import { useComposer } from '../hooks/useComposer'
import { normalizeConversation, sortConversations } from '../lib/chat'
import { Composer } from './Composer'
import { ChatAnnouncement } from './ChatAnnouncement'
import { ConversationList } from './ConversationList'
import { CreateGroupDialog } from './CreateGroupDialog'
import { AiSafetyNote } from './AiSafetyNote'
import { DiscoverGroupsDialog } from './DiscoverGroupsDialog'
import { MemberPanel } from './MemberPanel'
import { MemberProfile } from './MemberProfile'
import { MessageList } from './MessageList'

// 群设置只在点「⋯」时用得上，静态 import 会把 ~18KB（改群名/公告/管理员/解散群）
// 塞进聊天首屏 chunk。改成打开那一刻才拉；弹窗自己的焦点陷阱/关闭行为与之前完全一致。
const GroupSettingsDialog = lazy(() =>
  import('./GroupSettingsDialog').then((mod) => ({ default: mod.GroupSettingsDialog })),
)

export type { Notify }

interface ChatViewProps {
  me: Me
  onLogout: () => void
  notify: Notify
  /** 手机端是否停在会话里（列表 ↔ 聊天推入状态），外壳据此决定底部是 Tab 还是输入栏 */
  onMobilePaneChange?: (focused: boolean) => void
}

/**
 * 聊天主视图：只负责布局与交互。
 * 数据（会话列表/消息缓存/WS/断线补齐）在 useChatStream；发送/重试在 useComposer。
 */
export function ChatView({ me, onLogout, notify, onMobilePaneChange }: ChatViewProps) {
  const [activeId, setActiveId] = useState<number | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list')
  // 桌面：成员列默认收起，点过之后记住（不再白占 288px）。
  // 只在 ≥1024px 时恢复记忆：手机上 showMembers=true 会直接弹浮层，不能沿用。
  const [showMembers, setShowMembers] = useState(() => {
    if (typeof window === 'undefined') return false
    if (window.innerWidth < 1024) return false
    try {
      return window.localStorage.getItem('qqmini.membersOpen') === '1'
    } catch {
      return false
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  // 提示条只在本次「打开会话」里可关；切走/再进来会重新出现（用户明确要求不是常驻）
  const [safetyClosed, setSafetyClosed] = useState(false)
  // 成员主页（点成员头像/名字打开）
  const [profileId, setProfileId] = useState<number | null>(null)
  // 从「TA 最近说的话」跳到某条消息：先切会话，再由 MessageList 滚到该 seq
  const [jumpSeq, setJumpSeq] = useState<number | null>(null)
  const [directoryOwned, setDirectoryOwned] = useState<Record<number, boolean>>({})

  const {
    conversations,
    setConversations,
    messages,
    status,
    typing,
    notifyTyping,
    loadingMessages,
    membersLoading,
    writeMessages,
    seedConversation,
    markRead,
    loadMessages,
    loadAroundSeq,
    loadOlder,
    resetOlderFlag,
    loadConversations,
    loadMoreConversations,
    hasMoreConversations,
    conversationsError,
    ensureMembers,
    messagesRef,
    lastSeqRef,
    activeIdRef,
  } = useChatStream({ me, activeId, notify })

  const { replyTo, setReplyTo, handleSend, handleRetry } = useComposer({
    me,
    notify,
    activeIdRef,
    lastSeqRef,
    messagesRef,
    writeMessages,
    setConversations,
  })

  const activeConversation = useMemo(
    () => conversations.find((conv) => conv.id === activeId) ?? null,
    [conversations, activeId],
  )

  // 未读数进标题：切到别的标签页/别的应用时也能看出有没有人说话。
  // 走事件而不是把 unread 提到 App：ChatView 卸载后（切到空间/我的）标题不该立刻归零。
  useEffect(() => {
    const total = conversations.reduce((sum, conv) => sum + (conv.unread > 0 ? conv.unread : 0), 0)
    window.dispatchEvent(new CustomEvent('aio:unread', { detail: { total } }))
  }, [conversations])

  /**
   * 私聊对端是不是 AI（决定要不要在会话顶部挂「对方是 AI」提示条）。
   * 只在 c2c 且能确定对端身份时返回对端，其余一律 null —— 宁缺勿错：
   * - 群聊：人在一条消息流里，成员复杂，按会话打「对方是 AI」会误伤人类成员，所以不提示；
   * - members 为空 / 只有自己：说不清对端是谁，不提示；
   * - 对端是 user：人对人私聊，再挂一条 AI 提示就是噪音。
   * 用 me.id 找对端，不按 type 反查（“找到一个 agent 成员”在数据异常时会张冠李戴）。
   */
  useEffect(() => {
    // 会话切换 = 重新打开，提示条恢复
    setSafetyClosed(false)
  }, [activeId])

  useEffect(() => {
    const onRefresh = () => void loadConversations()
    window.addEventListener('aio:refresh-conversations', onRefresh)
    return () => window.removeEventListener('aio:refresh-conversations', onRefresh)
  }, [loadConversations])

  const aiPeer = useMemo(() => {
    const myId = me?.id
    if (!activeConversation || activeConversation.type !== 'c2c') return null
    const members = activeConversation.members
    if (!Array.isArray(members) || members.length === 0) return null
    const peer = members.find((item) => item.id !== myId)
    return peer != null && peer.type === 'agent' ? peer : null
  }, [activeConversation, me?.id])

  // 点系统通知打开的是 /?c=<会话 id>：会话列表到了以后再切过去，然后把参数清掉
  // （不直接读 URL 立刻切：那时 conversations 还没到，selectConversation 找不到标题）
  const pendingConversationRef = useRef<number | null>(null)
  useEffect(() => {
    const c = Number(new URLSearchParams(window.location.search).get('c'))
    if (Number.isInteger(c) && c > 0) pendingConversationRef.current = c
  }, [])
  useEffect(() => {
    const target = pendingConversationRef.current
    if (target == null || conversations.length === 0) return
    if (!conversations.some((conv) => conv.id === target)) return
    pendingConversationRef.current = null
    selectConversation(target)
    window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations])

  // 手机端「列表 ↔ 聊天」的推入状态同步给外壳：决定底部是 Tab 栏还是输入栏
  useEffect(() => {
    onMobilePaneChange?.(mobilePane === 'chat')
  }, [mobilePane, onMobilePaneChange])

  // 成员抽屉支持 Esc 关闭（桌面），手机端用下滑手势或遮罩关闭
  useEffect(() => {
    if (!showMembers) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowMembers(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showMembers])

  /* ---------------- 首次加载 ---------------- */

  useEffect(() => {
    void loadConversations()
    // 只拉自己的 AI 判断「由你创建」，不再拉全站通讯录
    api
      .agents()
      .then((list) => {
        const map: Record<number, boolean> = {}
        for (const agent of list) map[agent.id] = true
        setDirectoryOwned(map)
      })
      .catch(() => {
        // 只影响「由谁创建」提示，失败静默
      })
  }, [loadConversations])

  /** 退群：成功后清空当前会话并刷新列表（别人再发消息也不会再出现在我这边） */
  async function leaveActiveConversation() {
    if (!activeConversation) return
    const convId = activeConversation.id
    try {
      await api.leaveConversation(convId)
      notify('已退出这个群', 'success')
      setShowMembers(false)
      // 本地收尾：把会话从列表移除并取消选中（列表以服务端为准，下次刷新也不会再出现）
      setConversations((prev) => prev.filter((conv) => conv.id !== convId))
      setActiveId(null)
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '退群失败，请重试', 'error')
    }
  }

  /* ---------------- 撤回 / 举报（长按菜单） ---------------- */

  const handleRecallMessage = useCallback(
    async (message: LocalMessage) => {
      const convId = activeIdRef.current
      if (convId == null || message.seq == null) return
      try {
        await api.recallMessage(convId, message.seq)
        writeMessages(convId, (prev) =>
          prev.map((item) =>
            item.seq === message.seq
              ? { ...item, recalledAt: new Date().toISOString(), body: '', parts: [] }
              : item,
          ),
        )
        notify('已撤回', 'success')
      } catch (err) {
        if (err instanceof ApiError && err.code === 'unauthorized') return
        notify(err instanceof ApiError ? err.message : '撤回失败，请重试', 'error')
      }
    },
    [activeIdRef, notify, writeMessages],
  )

  const handleReportMessage = useCallback(
    async (message: LocalMessage, reason: string) => {
      const seq = message.seq
      const convId = activeIdRef.current
      if (seq == null || convId == null) return
      try {
        // 带上会话 id：seq 只在会话内唯一，站务要据此定位是哪条消息
        await api.report({ targetType: 'message', targetId: seq, reason, conversationId: convId })
        notify('已举报', 'success')
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          notify('你已举报过这条', 'info')
          return
        }
        if (err instanceof ApiError && err.code === 'unauthorized') return
        notify(err instanceof ApiError ? err.message : '举报失败，请重试', 'error')
      }
    },
    [activeIdRef, notify],
  )

  /* ---------------- 交互 ---------------- */

  function selectConversation(id: number) {
    setActiveId(id)
    setMobilePane('chat')
    setReplyTo(null)
    const conv = conversations.find((item) => item.id === id)
    // 重新打开会话：清掉「已翻到最早」的标记（可能已经被清空/重建过窗口）
    if (messagesRef.current[id] == null) {
      resetOlderFlag(id)
      void loadMessages(id)
    } else {
      void markRead(id, Math.max(lastSeqRef.current[id] ?? 0, conv?.lastSeq ?? 0))
    }
    // 大群：进来就把成员补齐（小群 membersComplete !== false，直接 no-op）
    void ensureMembers(id)
  }

  function onGroupCreated(raw: Conversation) {
    const conversation = normalizeConversation(raw)
    setGroupOpen(false)
    setConversations((prev) => sortConversations([conversation, ...prev.filter((item) => item.id !== conversation.id)]))
    setActiveId(conversation.id)
    setMobilePane('chat')
    setReplyTo(null)
    seedConversation(conversation)
  }

  const agentOwnerOf = useCallback(
    (principalId: number) => {
      const member: Member | undefined = activeConversation?.members.find((item) => item.id === principalId)
      const withOwner = member as (Member & { ownerName?: string; ownerDisplayName?: string }) | undefined
      const explicit = withOwner?.ownerName ?? withOwner?.ownerDisplayName
      if (explicit) return explicit
      if (directoryOwned[principalId]) return '你'
      return null
    },
    [activeConversation, directoryOwned],
  )

  // 大群（membersComplete === false）用后端给的总数；小群照旧数 members
  const membersIncomplete = activeConversation != null && activeConversation.membersComplete === false
  const memberTotal = activeConversation
    ? membersIncomplete
      ? (activeConversation.memberCount ?? activeConversation.members.length)
      : activeConversation.members.length
    : 0
  const agentCount = activeConversation
    ? (activeConversation.agentCount ?? activeConversation.members.filter((m) => m.type === 'agent').length)
    : 0
  const currentMessages = activeId != null ? (messages[activeId] ?? []) : []
  const canSend = activeConversation != null

  return (
    <div className={cn('chat', showMembers && 'chat--members-open', mobilePane === 'chat' && 'chat--chat')}>
      <ConversationList
        me={me}
        conversations={conversations}
        activeId={activeId}
        wsStatus={status}
        loadError={conversationsError}
        onRetryLoad={() => void loadConversations()}
        onSelect={selectConversation}
        onLoadMoreConversations={loadMoreConversations}
        hasMoreConversations={hasMoreConversations}
        onCreateGroup={() => setGroupOpen(true)}
        onDiscoverGroups={() => setDiscoverOpen(true)}
        onLogout={onLogout}
        onSearchPick={(conversationId, seq) => {
          // 搜索结果可能落在本地还没加载的历史区段：先补一窗，再让 MessageList 滚过去
          selectConversation(conversationId)
          void loadAroundSeq(conversationId, seq).then((found) => {
            if (!found) {
              notify('这条消息可能已被撤回或删除', 'info')
              return
            }
            setJumpSeq(seq)
          })
        }}
      />

      <main className="chat__main">
        <header className="chat__head">
          <button
            type="button"
            className="icon-btn chat__back"
            onClick={() => setMobilePane('list')}
            aria-label="返回会话列表"
            title="返回会话列表"
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 5 8 12l7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="chat__title-block">
            <h1 className="chat__title">
              {activeConversation ? activeConversation.title || '未命名群' : 'AIO'}
            </h1>
            <p className="chat__subtitle">
              {activeConversation ? `${memberTotal} 位成员 · ${agentCount} 个 AI` : '选一个会话开始'}
            </p>
          </div>
          <div className="chat__head-actions">
            {activeConversation && (activeConversation.role === 'owner' || activeConversation.role === 'admin') ? (
              // 「⋯」是「这个会话还能做什么」的入口，群设置只是其中一项；
              // 群名保持纯文字（点群名不该等于改设置）
              <button
                type="button"
                className="icon-btn chat__more"
                onClick={() => setSettingsOpen(true)}
                aria-label="群设置"
                title="群设置（群主/管理员）"
              >
                <span className="chat__more-dots" aria-hidden="true">⋯</span>
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn chat__members-btn"
              onClick={() => {
                const next = !showMembers
                setShowMembers(next)
                try {
                  window.localStorage.setItem('qqmini.membersOpen', next ? '1' : '0')
                } catch {
                  /* 隐私模式写不了，忽略 */
                }
                // 大群还没拉全成员时，打开面板顺手补一次（失败过也能在这里重试）
                if (next && activeConversation) void ensureMembers(activeConversation.id)
              }}
              aria-label={showMembers ? '收起成员' : '查看成员'}
              aria-expanded={showMembers}
              title={showMembers ? '收起成员' : '查看成员'}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="9" cy="8" r="3.2" />
                <path d="M3.6 19c0-2.9 2.5-4.7 5.4-4.7s5.4 1.8 5.4 4.7" strokeLinecap="round" />
                <path d="M16 5.4a3.1 3.1 0 0 1 0 6.1M17.4 14.9c2 .5 3.4 2 3.4 4.1" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* 群公告：只读、可折叠；编辑只在群设置（群主/管理员）。
            和 AiSafetyNote 一样放在 .messages 外面，消息区的贴底/翻历史逻辑不受影响。 */}
        <ChatAnnouncement
          announcement={activeConversation?.announcement}
          updatedAt={activeConversation?.announcementUpdatedAt}
        />

        {/* 会话级 AI 提示：群里不打这个标（成员复杂），只有人机私聊才挂。
            注意：它必须在 .messages 外面、正常文档流里 —— 消息区是 flex:1 + overflow-y:auto，
            多这一块只会让 clientHeight 变小，贴底与翻历史逻辑一个字都不用改。 */}
        {aiPeer && !safetyClosed ? (
          <AiSafetyNote variant="chat" onClose={() => setSafetyClosed(true)}>
            对方是 AI 成员，回复可能由其主人或模型生成
          </AiSafetyNote>
        ) : null}

        {status !== 'online' ? (
          <div className="banner banner--warn" role="status">
            <span className="banner__spinner" aria-hidden="true" />
            {status === 'connecting' ? '正在连接服务器…' : '正在重连…'}
            <span className="banner__hint">消息已先行上屏，恢复后会自动按 since_seq 补齐</span>
          </div>
        ) : null}

        <MessageList
          me={me}
          conversation={activeConversation}
          messages={currentMessages}
          loading={loadingMessages}
          typingNames={(activeId != null ? typing[activeId] : undefined)?.map((item) => item.name) ?? []}
          onLoadOlder={activeId != null ? () => loadOlder(activeId) : undefined}
          onRetry={handleRetry}
          onReply={(message) => {
            setReplyTo(message)
            document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus()
          }}
          onRecallMessage={(message) => void handleRecallMessage(message)}
          onReportMessage={handleReportMessage}
          onOpenProfile={(id) => setProfileId(id)}
          jumpSeq={jumpSeq}
          onJumped={() => setJumpSeq(null)}
          notify={notify}
        />

        {activeConversation ? (
          <Composer
            conversationId={activeConversation.id}
            members={activeConversation.members}
            replyTo={replyTo}
            disabled={!canSend}
            notify={notify}
            onCancelReply={() => setReplyTo(null)}
            onSend={handleSend}
            onTyping={() => {
              if (activeConversation) notifyTyping(activeConversation.id)
            }}
          />
        ) : null}
      </main>

      <div className={cn('chat__members-wrap', showMembers && 'chat__members-wrap--open')}>
        <div className="chat__members-backdrop" onClick={() => setShowMembers(false)} aria-hidden="true" />
        <MemberPanel
          conversation={activeConversation}
          canLeave={Boolean(
            activeConversation
            && activeConversation.type !== 'c2c'
            && activeConversation.role !== 'owner',
          )}
          onLeave={() => void leaveActiveConversation()}
          loading={membersIncomplete && activeConversation != null && membersLoading[activeConversation.id] === true}
          onRetryMembers={() => {
            if (activeConversation) void ensureMembers(activeConversation.id)
          }}
          ownerNameOf={agentOwnerOf}
          meName={me.displayName}
          onOpenProfile={(id) => setProfileId(id)}
          onClose={() => setShowMembers(false)}
        />
      </div>

      {profileId != null ? (
        <MemberProfile
          principalId={profileId}
          me={me}
          notify={notify}
          onClose={() => setProfileId(null)}
          onOpenConversation={(conversationId, seq) => {
            setProfileId(null)
            setShowMembers(false)
            selectConversation(conversationId)
            if (seq != null) setJumpSeq(seq)
          }}
        />
      ) : null}

      {discoverOpen ? (
        <DiscoverGroupsDialog
          notify={notify}
          onClose={() => setDiscoverOpen(false)}
          onJoined={(conversationId, joined) => {
            void loadConversations()
            if (joined) void selectConversation(conversationId)
          }}
        />
      ) : null}

      {settingsOpen && activeConversation ? (
        <Suspense fallback={null}>
          <GroupSettingsDialog
            conversationId={activeConversation.id}
            conversationTitle={activeConversation.title || '未命名群'}
            myRole={activeConversation.role}
            myId={me?.id ?? 0}
            notify={notify}
            announcement={activeConversation.announcement ?? ''}
            announcementUpdatedAt={activeConversation.announcementUpdatedAt ?? null}
            onAnnouncementSaved={(announcement, announcementUpdatedAt) => {
              // 公告不做实时推送：保存后只更新本地这一条会话，聊天页公告条立即跟着变
              setConversations((prev) =>
                prev.map((item) =>
                  item.id === activeConversation.id ? { ...item, announcement, announcementUpdatedAt } : item,
                ),
              )
            }}
            onClose={() => setSettingsOpen(false)}
            onDissolved={() => {
              setActiveId(null)
              setMobilePane('list')
              void loadConversations()
            }}
          />
        </Suspense>
      ) : null}

      {groupOpen ? (
        <CreateGroupDialog
          onClose={() => setGroupOpen(false)}
          onCreated={onGroupCreated}
          notify={notify}
        />
      ) : null}
    </div>
  )
}
