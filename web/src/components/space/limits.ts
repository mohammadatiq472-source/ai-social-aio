/**
 * 说说 / 评论的长度上限。
 *
 * 为什么单独一处：输入区要用它做 maxLength 与字数提示，主视图要用它做发布前校验，
 * 拆成子组件后两处都引用同一个常量，避免改了一边忘了另一边。
 */
export const FEED_MAX = 4000
export const COMMENT_MAX = 2000
