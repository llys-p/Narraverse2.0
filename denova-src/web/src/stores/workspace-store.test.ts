import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore, WORKSPACE_FREE_MODES, type WorkspaceMode } from './workspace-store'

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

  it('worlds is a shared workspace mode and never overwrites the content mode', () => {
    useWorkspaceStore.getState().setMode('ide')
    expect(window.localStorage.getItem('nova:content-mode')).toBe('ide')

    useWorkspaceStore.getState().setMode('worlds')

    expect(useWorkspaceStore.getState().mode).toBe('worlds')
    expect(window.localStorage.getItem('nova:mode')).toBe('worlds')
    // worlds 不是内容模式，不得覆盖 nova:content-mode（关闭后仍回到写作）
    expect(window.localStorage.getItem('nova:content-mode')).toBe('ide')
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

describe('WORKSPACE_FREE_MODES (无书籍守卫白名单)', () => {
  // 无书籍守卫会用这份白名单决定「该模式能否在没有打开书籍时存活」。
  // 漏登记的症状是：入口点得动、页面也渲染了，但立刻被弹回书库——
  // 用户视角就是「点了没反应」，且不会有任何报错。因此这里锁死名单内容。

  it('keeps the library mode reachable without an open book', () => {
    // L1 交付目标：用户无需先建书就能进入作品设定库。
    expect(WORKSPACE_FREE_MODES).toContain('library')
  })

  it('keeps every self-contained shared mode reachable without an open book', () => {
    for (const mode of ['books', 'worlds', 'library', 'skills', 'agents', 'automations', 'narraverse'] as const) {
      expect(WORKSPACE_FREE_MODES).toContain(mode)
    }
  })

  it('still guards the modes that need a current book', () => {
    // 写作与游戏以当前书籍为上下文，无书籍时必须回落，不能被放进白名单。
    expect(WORKSPACE_FREE_MODES).not.toContain('ide')
    expect(WORKSPACE_FREE_MODES).not.toContain('interactive')
  })

  it('has no unknown or duplicate entries', () => {
    const allModes: WorkspaceMode[] = [
      'ide', 'interactive', 'narraverse', 'books', 'worlds', 'library', 'skills', 'agents', 'automations',
    ]
    for (const mode of WORKSPACE_FREE_MODES) expect(allModes).toContain(mode)
    expect(new Set(WORKSPACE_FREE_MODES).size).toBe(WORKSPACE_FREE_MODES.length)
  })
})
