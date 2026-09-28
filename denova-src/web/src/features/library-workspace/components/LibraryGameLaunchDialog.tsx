import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useGameLibraryContextLaunch, type GameLibraryContextLaunch } from '@/features/library-context-runtime/GameLibraryContextLaunchProvider'
import { useInteractiveStore } from '@/features/interactive/stores/interactive-store'
import { getInteractiveBranches, getInteractiveStories, selectInteractiveStory, switchInteractiveBranch } from '@/features/interactive/api'
import type { BranchSummary, StorySummary } from '@/features/interactive/types'

interface LibraryGameLaunchDialogProps {
  /** 已保存库的 Ref 与展示摘要（不含目标故事/分支——由本对话框内显式选择）。 */
  launch: Omit<GameLibraryContextLaunch, 'storyId' | 'branchId' | 'launchedAt'>
  onClose: () => void
  /** 选择成功并写入一次性交接后由上层切换到游戏模式。 */
  onLaunchGame?: () => void
}

/**
 * B3b：库工作区「带入游戏」的目标选择对话框。
 * 复用既有故事/分支选择 API 与 interactive store，不新建第二套故事管理；取消或
 * 加载/切换失败时不写一次性交接、不切模式，游戏侧当前背景保持不变。
 */
export function LibraryGameLaunchDialog({ launch, onClose, onLaunchGame }: LibraryGameLaunchDialogProps) {
  const { t } = useTranslation()
  const { launchGameLibrary } = useGameLibraryContextLaunch()
  const [stories, setStories] = useState<StorySummary[] | null>(null)
  const [storiesError, setStoriesError] = useState(false)
  const [storyId, setStoryId] = useState('')
  const [branches, setBranches] = useState<BranchSummary[] | null>(null)
  const [branchesError, setBranchesError] = useState(false)
  const [branchId, setBranchId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setStoriesError(false)
    getInteractiveStories()
      .then((index) => { if (mounted.current) setStories(index.stories || []) })
      .catch(() => { if (mounted.current) setStoriesError(true) })
  }, [])

  useEffect(() => {
    setBranches(null)
    setBranchesError(false)
    setBranchId('')
    if (!storyId) return
    getInteractiveBranches(storyId)
      .then((list) => {
        if (!mounted.current) return
        const all: BranchSummary[] = list || []
        // 主分支不在服务端列表时补上，保证任何故事都有可确认的默认分支。
        const withMain = all.some((branch) => branch.id === 'main') ? all : [{ id: 'main', head: '', created_at: '', current: false }, ...all]
        setBranches(withMain)
        setBranchId(withMain.find((branch) => branch.current)?.id || 'main')
      })
      .catch(() => { if (mounted.current) setBranchesError(true) })
  }, [storyId])

  const confirm = async () => {
    if (submitting || !storyId || !branchId) return
    setSubmitting(true)
    setSubmitError('')
    try {
      // 复用既有选择流程：服务端选中故事 → 服务端切换分支 → 本地 store 同步，
      // 之后 InteractiveLayout 按同一 store 状态加载快照，不产生第二套选择状态。
      await selectInteractiveStory(storyId)
      await switchInteractiveBranch(storyId, branchId)
      useInteractiveStore.getState().setCurrentStoryId(storyId)
      useInteractiveStore.getState().setCurrentBranchId(branchId)
      launchGameLibrary({ ...launch, storyId, branchId, launchedAt: Date.now() })
      onClose()
      onLaunchGame?.()
    } catch {
      if (mounted.current) setSubmitError(t('workLibrary.preview.launchGameSwitchFailed'))
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[min(88dvh,560px)] max-w-[min(calc(100vw-2rem),460px)] gap-0 overflow-hidden border border-[var(--nova-border)] bg-[var(--nova-surface)] p-0 text-[var(--nova-text)]"
      >
        <DialogHeader className="relative border-b border-[var(--nova-border)] px-4 py-3 pr-12 text-left">
          <DialogTitle>{t('workLibrary.preview.launchGameTitle')}</DialogTitle>
          <DialogDescription>{t('workLibrary.preview.launchGameDescription', { name: launch.libraryName })}</DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute right-2 top-2"
            disabled={submitting}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('workLibrary.preview.launchGameStoryLabel')}</span>
            <select
              value={storyId}
              disabled={submitting}
              className="w-full rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2"
              onChange={(event) => setStoryId(event.target.value)}
            >
              <option value="">{t('workLibrary.preview.launchGameStoryPlaceholder')}</option>
              {(stories || []).map((story) => <option key={story.id} value={story.id}>{story.title}</option>)}
            </select>
          </label>
          {storiesError ? <ErrorNote text={t('workLibrary.preview.launchGameLoadFailed')} /> : null}
          {!storiesError && stories !== null && stories.length === 0 ? (
            <p role="status" className="text-xs text-[var(--nova-text-muted)]">{t('workLibrary.preview.launchGameNoStory')}</p>
          ) : null}
          {storyId ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('workLibrary.preview.launchGameBranchLabel')}</span>
              <select
                value={branchId}
                disabled={submitting || branches === null}
                className="w-full rounded border border-[var(--nova-border)] bg-[var(--nova-surface-2)] p-2"
                onChange={(event) => setBranchId(event.target.value)}
              >
                {branches === null ? <option value="">{t('workLibrary.loading')}</option> : null}
                {(branches || []).map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.title ? `${branch.title} · ${branch.id}` : branch.id}</option>
                ))}
              </select>
            </label>
          ) : null}
          {branchesError ? <ErrorNote text={t('workLibrary.preview.launchGameBranchLoadFailed')} /> : null}
          {submitError ? <ErrorNote text={submitError} /> : null}
        </div>

        <DialogFooter className="border-[var(--nova-border)] bg-[var(--nova-surface-2)]">
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            {t('workLibrary.cancel')}
          </Button>
          <Button type="button" disabled={submitting || !storyId || !branchId} onClick={() => void confirm()}>
            {submitting ? t('workLibrary.preview.launchGamePreparing') : t('workLibrary.preview.launchGameConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ErrorNote({ text }: { text: string }) {
  return (
    <div role="alert" className="rounded-md border border-[var(--nova-danger-border)] bg-[var(--nova-danger-bg)] px-3 py-2 text-xs text-[var(--nova-danger)]">
      {text}
    </div>
  )
}
