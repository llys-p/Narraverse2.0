import { useState } from 'react'
import { Globe2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceMode } from '@/stores/workspace-store'
import { FeaturePageShell } from '@/components/layout/feature-page-shell'
import { WorldListPage } from './pages/WorldListPage'
import { WorldCreatePage } from './pages/WorldCreatePage'
import { WorldConsolePage } from './pages/WorldConsolePage'
import { CharacterProfile } from './components/CharacterProfile'
import type { WorldView } from './types'

export interface WorldWorkspaceProps {
  /** 返回进入世界工作区之前的内容模式（由 ModeRouter 提供）。 */
  onClose: () => void
  onSetMode: (mode: WorkspaceMode) => void
  onQuickSwitchBook: (path: string) => Promise<boolean>
  onOpenModule4?: () => void
  onCloseModule4?: () => void
}

export function WorldWorkspace({
  onClose,
  onSetMode,
  onQuickSwitchBook,
  onOpenModule4,
  onCloseModule4,
}: WorldWorkspaceProps) {
  const { t } = useTranslation()
  // 创世草稿只存在于组件状态；这里的视图状态同样不落 localStorage。
  const [view, setView] = useState<WorldView>({ name: 'list' })
  const [listReloadToken, setListReloadToken] = useState(0)

  const reloadList = () => setListReloadToken((n) => n + 1)

  let body
  if (view.name === 'list') {
    body = (
      <WorldListPage
        reloadToken={listReloadToken}
        onCreate={() => setView({ name: 'create' })}
        onOpen={(id) => setView({ name: 'console', id })}
      />
    )
  } else if (view.name === 'create') {
    body = (
      <WorldCreatePage
        onCancel={() => setView({ name: 'list' })}
        onCreated={(id) => {
          reloadList()
          setView({ name: 'console', id })
        }}
      />
    )
  } else if (view.name === 'console') {
    body = (
      <WorldConsolePage
        key={view.id}
        worldId={view.id}
        onBack={() => { reloadList(); setView({ name: 'list' }) }}
        onOpenCharacter={(characterId) => setView({ name: 'character', id: view.id, characterId })}
        onWorldChanged={reloadList}
        onSetMode={onSetMode}
        onQuickSwitchBook={onQuickSwitchBook}
        onOpenModule4={onOpenModule4}
        onCloseModule4={onCloseModule4}
      />
    )
  } else {
    body = (
      <CharacterProfile
        worldId={view.id}
        characterId={view.characterId}
        onBack={() => setView({ name: 'console', id: view.id })}
      />
    )
  }

  // 列表页自带页面框架；其余子页各自使用 FeaturePageShell，这里仅提供全高容器。
  if (view.name !== 'list') {
    return <div className="h-full min-h-0 w-full overflow-hidden">{body}</div>
  }

  return (
    <FeaturePageShell
      icon={Globe2}
      title={t('worldWorkspace.title')}
      subtitle={t('worldWorkspace.subtitle')}
      onClose={onClose}
    >
      {body}
    </FeaturePageShell>
  )
}
