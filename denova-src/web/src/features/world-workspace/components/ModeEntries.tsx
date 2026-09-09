import { useState } from 'react'
import { Boxes, Gamepad2, Loader2, PenLine, Globe2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { selectInteractiveStory } from '@/features/interactive/api'
import type { WorkspaceMode } from '@/stores/workspace-store'
import { cn } from '@/lib/utils'
import type { World } from '../types'

interface ModeEntriesProps {
  world: World
  onSetMode: (mode: WorkspaceMode) => void
  onQuickSwitchBook: (path: string) => Promise<boolean>
  onOpenModule4?: () => void
  onCloseModule4?: () => void
}

type Pending = 'writing' | 'game' | null

export function ModeEntries({ world, onSetMode, onQuickSwitchBook, onOpenModule4, onCloseModule4 }: ModeEntriesProps) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Pending>(null)

  const enterWriting = async () => {
    if (!world.primaryBookPath) { toast.error(t('worldWorkspace.modes.noPrimaryBook')); return }
    setPending('writing')
    // 必须先成功切换主书，再离开世界页；失败则留在原页。
    const ok = await onQuickSwitchBook(world.primaryBookPath)
    if (ok) { onSetMode('ide'); return }
    setPending(null)
    toast.error(t('worldWorkspace.modes.switchBookFailed'))
  }

  const enterGame = async () => {
    if (!world.primaryInteractiveStoryId) { toast.error(t('worldWorkspace.modes.noPrimaryStory')); return }
    setPending('game')
    try {
      await selectInteractiveStory(world.primaryInteractiveStoryId)
      onSetMode('interactive')
    } catch {
      setPending(null)
      toast.error(t('worldWorkspace.modes.loadStoryFailed'))
    }
  }

  const enterNarraverse = () => {
    // 叙界是独立入口，进入前确保关闭 Module4 叠层。
    onCloseModule4?.()
    onSetMode('narraverse')
  }

  const enterSandbox = () => {
    // Module4 现有协议不支持携带世界/冒险 id，这里仅打开沙盒。
    onOpenModule4?.()
  }

  const cards = [
    { key: 'writing', icon: PenLine, title: t('worldWorkspace.modes.writing'), hint: t('worldWorkspace.modes.writingHint'), onClick: () => void enterWriting(), busy: pending === 'writing' },
    { key: 'game', icon: Gamepad2, title: t('worldWorkspace.modes.game'), hint: t('worldWorkspace.modes.gameHint'), onClick: () => void enterGame(), busy: pending === 'game' },
    { key: 'narraverse', icon: Globe2, title: t('worldWorkspace.modes.narraverse'), hint: t('worldWorkspace.modes.narraverseHint'), onClick: enterNarraverse, busy: false },
    { key: 'sandbox', icon: Boxes, title: t('worldWorkspace.modes.sandbox'), hint: t('worldWorkspace.modes.sandboxHint'), onClick: enterSandbox, busy: false },
  ] as const

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-[var(--nova-text-muted)]">{t('worldWorkspace.console.modes')}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {cards.map(({ key, icon: Icon, title, hint, onClick, busy }) => (
          <button
            key={key}
            type="button"
            onClick={onClick}
            disabled={busy}
            className={cn(
              'flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--nova-border)] bg-[var(--nova-surface)] p-3 text-left transition-colors hover:border-[var(--nova-ring)]',
              busy && 'cursor-wait opacity-70',
            )}
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--nova-surface-2)]">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{title}</span>
              <span className="mt-0.5 block text-[11px] leading-5 text-[var(--nova-text-muted)]">{hint}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--nova-text-muted)]">{t('worldWorkspace.modes.sandboxPhaseHint')}</p>
    </section>
  )
}
