import { useTranslation } from 'react-i18next'
import { BookGraphView } from '@/features/interactive/components/setting-panel/BookGraphView'
import type { LoreItem } from '@/lib/api'
import { EmptyState } from '@/components/common/EmptyState'

interface RelationsViewProps {
  /** 当前书的真实条目；图谱节点与边全部由 deriveLoreGraph 从这份数据派生。 */
  items: LoreItem[]
  /** 按书重挂载，避免上一本书的聚焦节点残留在视图里。 */
  workspace: string
  onOpenItem: (id: string) => void
}

export function RelationsView({ items, workspace, onOpenItem }: RelationsViewProps) {
  const { t } = useTranslation()

  if (!items.length) {
    return (
      <EmptyState
        variant="page"
        title={t('bookLibrary.graph.emptyTitle')}
        description={t('bookLibrary.graph.emptyDesc')}
      />
    )
  }

  return (
    <div className="bl-graph-host">
      <div className="bl-graph-layout">
        <BookGraphView key={workspace} items={items} onOpenItem={onOpenItem} />
      </div>
    </div>
  )
}
