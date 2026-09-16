import type { World } from '../types'
import type { WorkspaceMode } from '@/stores/workspace-store'

interface ModeEntriesProps {
  world: World
  /**
   * 保留旧 props 仅用于兼容 WorldConsolePage 的现有调用。
   * 四个运行模式的唯一全局入口现在由 Workbench 顶栏负责；世界工作区不再重复渲染模式卡片。
   */
  confirmLeave: () => boolean
  onSetMode: (mode: WorkspaceMode) => void
  onQuickSwitchBook: (path: string) => Promise<boolean>
  onLaunchGame?: () => Promise<void>
  onOpenModule4?: () => void
  onCloseModule4?: () => void
}

/**
 * 世界工作区不是第五种运行模式。
 *
 * 这里过去会再次展示“写作 / 游戏 / 叙界 / 开放沙盒”四张入口卡，
 * 与 Workbench 顶栏的四模式切换重复，容易让用户误以为“梳理世界”本身
 * 也是一种运行模式。现在统一由顶栏承担模式导航；世界工作区只负责世界资料
 * 的创建、整理和 Context 配置。需要携带世界 Context 进入具体模式时，继续使用
 * World Context 面板里的显式交接动作。
 *
 * 暂时保留这个兼容组件，避免本次信息架构调整同时触碰 WorldConsolePage 的大型文件；
 * 后续清理调用点时可以直接删除该组件与旧 props。
 */
export function ModeEntries(_props: ModeEntriesProps) {
  return null
}
