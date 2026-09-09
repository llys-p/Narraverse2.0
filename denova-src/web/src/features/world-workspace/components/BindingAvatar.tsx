import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BindingAvatarProps {
  /** 仅当总资料库摘要返回可用本地 avatar_url 时传入；为空则不发起头像请求、直接回退图标。 */
  avatarUrl?: string
  /** 用于在切换条目时重置失败态；不单独据此发起 /avatar 请求。 */
  masterItemId?: string
  /** 控制外层尺寸与圆角，默认 size-10。 */
  className?: string
}

/**
 * 头像单一契约：是否有本地头像由总资料库摘要 avatar_url 决定（后端仅对已归档 PNG 生成）。
 * 无 avatar_url（JSON 卡/远程卡/未知）时不盲目请求 /avatar，直接显示图标回退；
 * 不复制头像文件、不建立世界头像系统、不抓取不受信任远程 URL。
 */
export function BindingAvatar({ avatarUrl, masterItemId, className }: BindingAvatarProps) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [avatarUrl, masterItemId])

  const boxCls = cn('shrink-0 overflow-hidden', className ?? 'size-10 rounded-[var(--radius-md)]')
  const canShow = !!avatarUrl && !failed

  if (!canShow) {
    return (
      <span className={cn('flex items-center justify-center bg-[var(--nova-surface-2)]', boxCls)}>
        <UserRound className="h-1/2 w-1/2 text-[var(--nova-text-muted)]" />
      </span>
    )
  }
  return (
    <img
      src={avatarUrl}
      alt=""
      className={cn('object-cover', boxCls)}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
