import { create } from 'zustand'

export type RightPanel = 'ai' | 'lore' | 'creator' | 'teller' | 'outline' | 'characters' | 'versions' | null
type BottomPanel = 'versions' | 'problems' | null
/**
 * 顶层工作区模式。其中 ide / interactive / narraverse 为「内容模式」——
 * 它们各自占据主内容区，并作为共享页面（设置/书库/技能等）关闭后的返回目标。
 * books / library / skills / agents / automations 为共享/菜单模式。
 */
export type WorkspaceMode = 'ide' | 'interactive' | 'narraverse' | 'books' | 'worlds' | 'library' | 'skills' | 'agents' | 'automations'
/** 内容模式：写作、游戏、叙界三选一的顶层导航目标。 */
export type ContentMode = 'ide' | 'interactive' | 'narraverse'
/**
 * 不依赖「当前书籍」即可进入的模式。
 *
 * books / worlds / library / skills / agents / automations 都是自包含的共享模式：
 * 它们管理的是各自的独立资料（书库、世界、作品设定库、技能、智能体、自动化），
 * 没有打开任何书籍时也能正常使用。narraverse 同理，是自包含的内容模式。
 * 其余模式（ide / interactive）以当前书籍为上下文，无书籍时需要回落到 books。
 *
 * 无书籍守卫（App.tsx）依赖此常量：新增「不依赖书籍」的模式时必须同步登记，
 * 否则该模式会在无书籍状态下被静默弹回 books，入口看上去「点了没反应」。
 */
export const WORKSPACE_FREE_MODES: readonly WorkspaceMode[] = [
  'books', 'worlds', 'library', 'skills', 'agents', 'automations', 'narraverse',
]

const MODE_STORAGE_KEY = 'nova:mode'
const CONTENT_MODE_STORAGE_KEY = 'nova:content-mode'
const RIGHT_PANEL_STORAGE_KEY = 'nova:right-panel'

function readInitialMode(): WorkspaceMode {
  if (typeof window === 'undefined') return 'ide'
  // 深链接：?mode=narraverse 等仅覆盖本次启动模式，不写入持久存储，
  // 不带参数的普通启动仍恢复用户上次模式。
  const params = new URLSearchParams(window.location.search)
  const urlMode = params.get('mode')
  if (isWorkspaceMode(urlMode)) return urlMode
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY)
  return isWorkspaceMode(stored) ? stored : 'ide'
}

function readInitialRightPanel(): RightPanel {
  if (typeof window === 'undefined') return 'ai'
  const stored = window.localStorage.getItem(RIGHT_PANEL_STORAGE_KEY)
  if (stored === null) return 'ai'
  // Beta migration: Change Review moved from the right panel into the editor.
  if (stored === 'review') return 'ai'
  return isRightPanel(stored) ? stored : 'ai'
}

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === 'ide' || value === 'interactive' || value === 'narraverse' || value === 'books' || value === 'worlds' || value === 'library' || value === 'skills' || value === 'agents' || value === 'automations'
}

function isRightPanel(value: unknown): value is RightPanel {
  return value === 'ai' || value === 'lore' || value === 'creator' || value === 'teller' || value === 'outline' || value === 'characters' || value === 'versions' || value === null
}

function persistMode(mode: WorkspaceMode) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MODE_STORAGE_KEY, mode)
  // 内容模式（写作/游戏/叙界）同步写入，作为共享页面关闭后的返回目标。
  if (mode === 'ide' || mode === 'interactive' || mode === 'narraverse') window.localStorage.setItem(CONTENT_MODE_STORAGE_KEY, mode)
}

function persistRightPanel(panel: RightPanel) {
  if (typeof window === 'undefined') return
  if (panel === null) {
    window.localStorage.removeItem(RIGHT_PANEL_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, panel)
}

type WorkspaceStore = {
  mode: WorkspaceMode
  selectedProjectId?: string
  selectedChapterId?: string
  rightPanel: RightPanel
  bottomPanel: BottomPanel
  commandOpen: boolean
  setMode: (mode: WorkspaceMode) => void
  setSelectedProjectId: (id?: string) => void
  setSelectedChapterId: (id?: string) => void
  setRightPanel: (panel: RightPanel) => void
  setBottomPanel: (panel: BottomPanel) => void
  setCommandOpen: (open: boolean) => void
}

/** 工作区 UI 状态 Store，仅保存本地界面状态，不存放服务端数据。 */
export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  mode: readInitialMode(),
  selectedProjectId: undefined,
  selectedChapterId: undefined,
  rightPanel: readInitialRightPanel(),
  bottomPanel: null,
  commandOpen: false,
  setMode: (mode) => {
    persistMode(mode)
    set({ mode })
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSelectedChapterId: (id) => set({ selectedChapterId: id }),
  setRightPanel: (panel) => {
    persistRightPanel(panel)
    set({ rightPanel: panel })
  },
  setBottomPanel: (panel) => set({ bottomPanel: panel }),
  setCommandOpen: (open) => set({ commandOpen: open }),
}))
