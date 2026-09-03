import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from './workspace-store'

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useWorkspaceStore.setState({
      mode: 'ide',
      selectedProjectId: undefined,
      selectedChapterId: undefined,
      rightPanel: 'ai',
      bottomPanel: null,
      commandOpen: false,
    })
  })

  it('updates selectedChapterId', () => {
    useWorkspaceStore.getState().setSelectedChapterId('chapters/ch01.md')

    expect(useWorkspaceStore.getState().selectedChapterId).toBe('chapters/ch01.md')
  })

  it('keeps the bottom panel closed by default', () => {
    expect(useWorkspaceStore.getInitialState().bottomPanel).toBeNull()
  })

  it('persists the visible top-level mode and writing-side panel', () => {
    useWorkspaceStore.getState().setMode('interactive')
    useWorkspaceStore.getState().setMode('agents')
    useWorkspaceStore.getState().setRightPanel('versions')

    expect(window.localStorage.getItem('nova:mode')).toBe('agents')
    expect(window.localStorage.getItem('nova:content-mode')).toBe('interactive')
    expect(window.localStorage.getItem('nova:right-panel')).toBe('versions')

    useWorkspaceStore.getState().setRightPanel(null)
    expect(window.localStorage.getItem('nova:right-panel')).toBeNull()
  })

  it('migrates the legacy change-review right panel back to the Agent panel', async () => {
    window.localStorage.setItem('nova:right-panel', 'review')
    vi.resetModules()
    const { useWorkspaceStore: reloadedStore } = await import('./workspace-store')

    expect(reloadedStore.getInitialState().rightPanel).toBe('ai')
  })
})

describe('useWorkspaceStore narraverse (Denova 第三模式)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useWorkspaceStore.setState({
      mode: 'ide',
      selectedProjectId: undefined,
      selectedChapterId: undefined,
      rightPanel: 'ai',
      bottomPanel: null,
      commandOpen: false,
    })
  })

  it('treats narraverse as a persisted content mode alongside ide/interactive', () => {
    useWorkspaceStore.getState().setMode('narraverse')

    expect(useWorkspaceStore.getState().mode).toBe('narraverse')
    expect(window.localStorage.getItem('nova:mode')).toBe('narraverse')
    // 内容模式同步写入，供共享页面关闭后返回叙界
    expect(window.localStorage.getItem('nova:content-mode')).toBe('narraverse')
  })

  it('does not persist the ?mode=narraverse deep link over the user’s last mode', async () => {
    // 用户上次真实模式为写作
    window.localStorage.setItem('nova:mode', 'ide')
    window.history.replaceState({}, '', '?mode=narraverse')
    try {
      vi.resetModules()
      const { useWorkspaceStore: reloadedStore } = await import('./workspace-store')

      // 本次启动进入叙界
      expect(reloadedStore.getInitialState().mode).toBe('narraverse')
      // 但深链接不写入持久存储，普通启动仍恢复用户上次模式
      expect(window.localStorage.getItem('nova:mode')).toBe('ide')
    } finally {
      window.history.replaceState({}, '', '')
    }
  })
})
