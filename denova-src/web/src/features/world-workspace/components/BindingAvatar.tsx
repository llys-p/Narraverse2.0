import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { masterAvatarURL } from '../selectors'

interface BindingAvatarProps {
  masterItemId: string | undefined
  /** 控制外层尺寸与圆角，默认 size-10。 */
  className?: string
}

/**
 * 复用总库头像接口 GET /api/library/assets/:id/avatar；
 * 非 PNG/无头像/加载失败时回退图标，不复制头像文件、不建立世界头像系统。
 */
export function BindingAvatar({ masterItemId, className }: BindingAvatarProps) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [masterItemId])

  const boxCls = cn('shrink-0 overflow-hidden', className ?? 'size-10 rounded-[var(--radius-md)]')

  if (!masterItemId || failed) {
    return (
      <span className={cn('flex items-center justify-center bg-[var(--nova-surface-2)]', boxCls)}>
        <UserRound className="h-1/2 w-1/2 text-[var(--nova-text-muted)]" />
      </span>
    )
  }
  return (
    <img
      src={masterAvatarURL(masterItemId)}
      alt=""
      className={cn('object-cover', boxCls)}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
