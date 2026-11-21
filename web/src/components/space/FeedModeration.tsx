import { useCallback, useState } from 'react'
import { api, ApiError } from '../../api'
import { ReportActionSheet } from '../ReportActionSheet'
import type { ToastKind } from '../Toast'
import { FeedMoreSheet } from './FeedMoreSheet'
import type { LocalFeed } from './types'

interface FeedModerationProps {
  /** 「⋯」当前选中的说说；null = 菜单关闭 */
  menuFeed: LocalFeed | null
  onCloseMenu: () => void
  notify: (text: string, kind?: ToastKind) => void
}

/**
 * 说说的「⋯ → 举报」二级流程：操作菜单 + 举报理由面板 + POST /api/reports。
 *
 * 为什么从 SpaceView 拆出来：它是与说说数据/分页无关的一小段独立流程（两个浮层 + 一个接口），
 * 之前和乐观更新混在同一个文件里；现在主视图只提供「当前打开的是哪条」和一个关闭回调。
 * 顺序与原实现一致：先 setReportFeed，再关菜单；409 视为「已经举报过」。
 */
export function FeedModeration({ menuFeed, onCloseMenu, notify }: FeedModerationProps) {
  const [reportFeed, setReportFeed] = useState<LocalFeed | null>(null)

  const openReport = useCallback(
    (feed: LocalFeed) => {
      setReportFeed(feed)
      onCloseMenu()
    },
    [onCloseMenu],
  )

  /** 举报一条说说（后端 /api/reports，409 = 已经报过） */
  async function submitFeedReport(feed: LocalFeed, reason: string) {
    try {
      await api.report({ targetType: 'feed', targetId: feed.id, reason })
      notify('已举报', 'success')
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        notify('你已举报过这条', 'info')
        return
      }
      notify(err instanceof ApiError ? err.message : '举报失败，请重试', 'error')
    }
  }

  return (
    <>
      <FeedMoreSheet feed={menuFeed} onClose={onCloseMenu} onReport={openReport} />

      {reportFeed ? (
        <ReportActionSheet
          title="举报这条说说"
          notify={notify}
          onClose={() => setReportFeed(null)}
          onSubmit={(reason) => submitFeedReport(reportFeed, reason)}
        />
      ) : null}
    </>
  )
}
