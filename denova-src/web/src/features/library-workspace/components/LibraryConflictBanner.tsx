import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { WorkLibraryConflict } from '../use-work-library'

// 并发保存冲突横幅。
//
// 关键行为（L1.2 验收要求）：冲突时**不清空草稿**。横幅只提供两个出口：
//   - 重新加载最新版本（用户确认后丢弃本地草稿）；
//   - 保留草稿继续编辑（仅收起提示，草稿原样保留）。
// 服务端此时也没有被覆盖，两边都不丢。

interface LibraryConflictBannerProps {
  conflict: WorkLibraryConflict
  onReload: () => void
  onDismiss: () => void
}

export function LibraryConflictBanner({ conflict, onReload, onDismiss }: LibraryConflictBannerProps) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-3.5" />
        {t('workLibrary.conflict.title')}
        <span className="font-normal text-amber-700/80 dark:text-amber-400/80">
          {conflict.scope === 'meta' ? t('workLibrary.tab.overview') : t(`workLibrary.tab.${conflict.scope === 'item' ? 'items' : 'relations'}`)}
        </span>
      </div>
      <p className="mt-0.5 leading-5">{t('workLibrary.conflict.body')}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          <RefreshCw className="size-3.5" />
          {t('workLibrary.conflict.reload')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          {t('workLibrary.conflict.dismiss')}
        </Button>
      </div>
    </div>
  )
}
