import { useState } from 'react'
import { Library } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { LibraryEditorPanel } from './components/LibraryEditorPanel'
import { LibraryListPanel } from './components/LibraryListPanel'
import { useWorkLibraryCreation, useWorkLibraryEditor, useWorkLibraryList, useWorkLibraryVocabulary } from './use-work-library'

// 作品设定库页面：列表 ↔ 编辑器。
//
// 刻意不接收 workspace：设定库必须能在“还没有书”的状态下创建与编辑，
// 这是 L1 的核心要求（后端对应路由也不要求 workspace）。

interface LibraryWorkspacePageProps {
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
}

export function LibraryWorkspacePage({ onClose, onDirtyChange }: LibraryWorkspacePageProps) {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const [listToken, setListToken] = useState(0)
  const [dirty, setDirty] = useState(false)

  const list = useWorkLibraryList(listToken)
  const vocabulary = useWorkLibraryVocabulary()
  const creation = useWorkLibraryCreation()
  const editor = useWorkLibraryEditor(openId)

  return (
    <FeaturePageShell
      icon={Library}
      title={t('workLibrary.title')}
      subtitle={t('workLibrary.subtitle')}
      onClose={() => {
        if (dirty && !window.confirm(t('workLibrary.reloadConfirm'))) return
        setDirty(false)
        onDirtyChange?.(false)
        onClose()
      }}
    >
      {openId ? (
        <LibraryEditorPanel
          editor={editor}
          vocabulary={vocabulary}
          onDirtyChange={(value) => {
            setDirty(value)
            onDirtyChange?.(value)
          }}
          onBack={() => {
            setDirty(false)
            onDirtyChange?.(false)
            setOpenId(null)
            setListToken((value) => value + 1)
          }}
        />
      ) : (
        <LibraryListPanel
          status={list.status}
          error={list.error}
          onRetry={list.reload}
          libraries={list.libraries}
          warnings={list.warnings}
          creating={creation.creating}
          vocabulary={vocabulary}
          onOpen={setOpenId}
          onCreate={async (input) => {
            const id = await creation.create(input)
            if (!id) return false
            setListToken((value) => value + 1)
            setOpenId(id)
            return true
          }}
        />
      )}
      {creation.error ? (
        <p className="shrink-0 border-t border-[var(--nova-border)] px-3 py-1.5 text-[11px] text-[var(--nova-danger)]">
          {t('workLibrary.create.error')}
        </p>
      ) : null}
    </FeaturePageShell>
  )
}
