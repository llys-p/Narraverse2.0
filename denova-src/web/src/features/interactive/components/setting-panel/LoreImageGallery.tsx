import { useState } from 'react'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ImagePreviewDialog } from '@/components/common/ImagePreviewDialog'
import { Button } from '@/components/ui/button'
import { workspaceAssetURL, type LoreItemImage } from '@/lib/api'

export function LoreImageGallery({
  itemName,
  aiImage,
  uploadedImages,
  onRemove,
  disabled,
}: {
  itemName: string
  aiImage?: LoreItemImage
  uploadedImages: LoreItemImage[]
  onRemove: (imagePath: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const images = [
    ...(aiImage?.image_path ? [{ image: aiImage, kind: 'ai' as const }] : []),
    ...uploadedImages.map((image) => ({ image, kind: 'uploaded' as const })),
  ]
  const [activePath, setActivePath] = useState(images[0]?.image.image_path || '')
  const matchedIndex = images.findIndex(({ image }) => image.image_path === activePath)
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0
  const current = images[activeIndex]

  if (!current) {
    return <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-[var(--nova-border)] bg-[var(--nova-surface-2)] text-center text-[11px] text-[var(--nova-text-faint)]">{t('settingPanel.loreImage.empty')}</div>
  }

  const { image, kind } = current
  const src = workspaceAssetURL(image.image_path)
  const uploadedIndex = kind === 'uploaded' ? uploadedImages.findIndex((entry) => entry.image_path === image.image_path) + 1 : 0
  const title = kind === 'ai' ? t('settingPanel.loreImage.aiImage') : t('settingPanel.loreImage.uploadedImage', { index: uploadedIndex })
  const showPrevious = () => setActivePath(images[(activeIndex - 1 + images.length) % images.length].image.image_path)
  const showNext = () => setActivePath(images[(activeIndex + 1) % images.length].image.image_path)

  return (
    <div className="grid aspect-[16/10] min-w-0 grid-rows-[minmax(0,1fr)_2.25rem] overflow-hidden rounded-lg border border-[var(--nova-border)] bg-black/90 shadow-sm" aria-roledescription="carousel" aria-label={itemName}>
      <div className="grid min-h-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem]">
        <div className="flex items-center justify-center border-r border-white/10 bg-black/45">
          {images.length > 1 ? <Button type="button" variant="ghost" size="icon-lg" className="rounded-full text-white hover:bg-white/15 hover:text-white" onClick={showPrevious} aria-label={t('settingPanel.loreImage.previous')} title={t('settingPanel.loreImage.previous')}><ChevronLeft /></Button> : null}
        </div>
        <ImagePreviewDialog src={src} title={itemName} alt={image.alt_text || itemName}>
          <button type="button" className="min-h-0 min-w-0 overflow-hidden" aria-label={t('settingPanel.loreImage.openPreview')} title={t('settingPanel.loreImage.openPreview')}>
            <img key={image.image_path} src={src} alt={image.alt_text || itemName} className="h-full w-full object-contain" />
          </button>
        </ImagePreviewDialog>
        <div className="flex items-center justify-center border-l border-white/10 bg-black/45">
          {images.length > 1 ? <Button type="button" variant="ghost" size="icon-lg" className="rounded-full text-white hover:bg-white/15 hover:text-white" onClick={showNext} aria-label={t('settingPanel.loreImage.next')} title={t('settingPanel.loreImage.next')}><ChevronRight /></Button> : null}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-white/10 bg-black/70 px-2.5 text-white">
        <span className="min-w-0 truncate text-[11px] font-medium">{title}</span>
        {images.length > 1 && images.length <= 10 ? <div className="flex items-center justify-center gap-1" role="group" aria-label={t('settingPanel.loreImage.pagination')}>
          {images.map((entry, index) => (
            <button key={`${entry.kind}:${entry.image.image_path}`} type="button" className={`h-1.5 rounded-full transition-all ${index === activeIndex ? 'w-4 bg-white' : 'w-1.5 bg-white/45 hover:bg-white/75'}`} onClick={() => setActivePath(entry.image.image_path)} aria-label={t('settingPanel.loreImage.goTo', { index: index + 1 })} aria-current={index === activeIndex ? 'true' : undefined} />
          ))}
        </div> : <span />}
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {images.length > 1 ? <span className="shrink-0 text-[10px] tabular-nums text-white/80">{activeIndex + 1} / {images.length}</span> : null}
          {kind === 'uploaded' ? <Button type="button" variant="ghost" size="icon-xs" className="rounded-full text-white/80 hover:bg-red-600 hover:text-white" disabled={disabled} onClick={() => onRemove(image.image_path)} aria-label={t('settingPanel.loreImage.removeUploadedImage', { name: title })} title={t('settingPanel.loreImage.removeUploadedImage', { name: title })}><Trash2 /></Button> : null}
        </div>
      </div>
    </div>
  )
}
