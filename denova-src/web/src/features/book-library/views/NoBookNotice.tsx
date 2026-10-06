import { BookX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/common/EmptyState'

/**
 * 没有当前书籍时的本书分区提示。
 *
 * 这里不放示例书或演示条目：工作台的作用域就是真实 workspace 身份，
 * 作品设定库与公共素材仍可在无书状态下正常使用（由上层分区标签提供）。
 */
export function NoBookNotice() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[var(--nova-bg)] p-6">
      <EmptyState
        variant="page"
        icon={BookX}
        title={t('bookLibrary.noBook.title')}
        description={t('bookLibrary.noBook.description')}
      />
    </div>
  )
}
