// 输入栏与「＋」面板共用的图标。
// 为什么单独一个文件：同一枚图标原来在 Composer 和 PlusPanel 各抄了一份，
// 改一个 path 要改两处、还容易改漏；收拢成一份 SVG，视觉只有一处真相。
// 约定：这里只放纯图形（成员名后缀 Icon），不带布局类名，尺寸/颜色交给外层 CSS。
export const ImageIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3.2" />
    <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none" />
    <path d="m4.2 17 4.8-4.6 3.4 3.2 2.8-2.6 4.6 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const SmileIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="8.2" />
    <circle cx="9.2" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
    <path d="M8.6 14.2c.9 1.3 2.1 1.9 3.4 1.9s2.5-.6 3.4-1.9" strokeLinecap="round" />
  </svg>
)

export const MicIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="9" y="3.2" width="6" height="10.4" rx="3" />
    <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8V21" strokeLinecap="round" />
  </svg>
)

export const CameraIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path
      d="M4.4 8.6h2.7l1.3-2.1h7.2l1.3 2.1h2.7a1.8 1.8 0 0 1 1.8 1.8v7.1a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8v-7.1a1.8 1.8 0 0 1 1.8-1.8Z"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="13.4" r="3.4" />
  </svg>
)

export const VideoIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="2.8" y="6.4" width="12.6" height="11.2" rx="2.2" />
    <path d="M15.4 10.6l4.4-2.4a.8.8 0 0 1 1.2.7v6.2a.8.8 0 0 1-1.2.7l-4.4-2.4z" strokeLinejoin="round" />
  </svg>
)

/* 手机端输入栏左侧的「＋」：展开相册/拍摄/语音/表情 */
export const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 5.6v12.8M5.6 12h12.8" strokeLinecap="round" />
  </svg>
)

/* 面板展开时「＋」变「⌨」：收起面板、回到键盘 */
export const KeyboardIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="2.8" y="6.4" width="18.4" height="11.2" rx="3" />
    <path d="M6.6 9.8h.01M9.8 9.8h.01M13 9.8h.01M16.2 9.8h.01M6.6 12.6h.01M9.8 12.6h.01M13 12.6h.01M16.2 12.6h.01M8.6 15.4h6.8" strokeLinecap="round" />
  </svg>
)
