// 三个隐藏的 file input：相册 / 拍摄（capture）/ 视频。
// 为什么拆：它们没有任何视觉，只是给 ref 一个落点；留在主文件里会隔着 ready 的排版
// 突然出现三段 <input>。ref 仍由 Composer 持有（「＋」面板和表情面板都要 .click() 它们）。
import type { ChangeEvent, RefObject } from 'react'

interface ComposerFilePickersProps {
  galleryRef: RefObject<HTMLInputElement | null>
  cameraRef: RefObject<HTMLInputElement | null>
  videoRef: RefObject<HTMLInputElement | null>
  onImageChange: (event: ChangeEvent<HTMLInputElement>) => void
  onVideoChange: (event: ChangeEvent<HTMLInputElement>) => void
}

export function ComposerFilePickers({ galleryRef, cameraRef, videoRef, onImageChange, onVideoChange }: ComposerFilePickersProps) {
  return (
    <>
      <input
        ref={galleryRef}
        className="composer__file"
        type="file"
        accept="image/*"
        onChange={onImageChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      <input
        ref={cameraRef}
        className="composer__file"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onImageChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      <input
        ref={videoRef}
        className="composer__file"
        type="file"
        accept="video/*"
        onChange={onVideoChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </>
  )
}
