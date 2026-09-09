// Phase 2A 绑定健康与刷新的纯逻辑层：不依赖 DOM/网络，便于单测。
// 健康态只在运行时推导，不持久化；落库的只有 binding 的 nameSnapshot/tagsSnapshot/masterRevision。
import type { BindingHealthState, World, WorldAssetBinding } from './types'

/** 一次按需“检查”的结果。检查只读，绝不修改 world。 */
export type BindingCheckOutcome =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; status?: number }
  | { phase: 'ok'; currentRevision?: string }

/**
 * 判定绑定健康状态。优先级（经审查确认，顺序不可调换）：
 * loading（checking）→ error（404=missing，其它=unavailable）
 * → 当前 revision 缺失=unavailable → 存储 masterRevision 为空=unchecked
 * → 与当前相等=latest / 不等=stale。
 * 因此“旧绑定存储版本为空、但原件 404”会判为 missing（error 优先于 unchecked）。
 */
export function classifyBindingHealth(
  binding: WorldAssetBinding | undefined,
  outcome: BindingCheckOutcome,
): BindingHealthState {
  if (outcome.phase === 'loading') return 'checking'
  if (outcome.phase === 'error') return outcome.status === 404 ? 'missing' : 'unavailable'
  if (outcome.phase === 'ok') {
    const current = outcome.currentRevision ?? ''
    if (!current) return 'unavailable'
    const stored = binding?.masterRevision ?? ''
    if (!stored) return 'unchecked'
    return stored === current ? 'latest' : 'stale'
  }
  // 尚未发起检查：旧绑定（无基线版本）显示“尚未检查”。
  return 'unchecked'
}

/** 刷新后写入绑定的薄摘要；不含正文。 */
export interface RefreshedSnapshot {
  name: string
  tags: string[]
  masterRevision: string
}

/**
 * 返回新 World：仅替换目标绑定的 nameSnapshot/tagsSnapshot/masterRevision。
 * characters/locations/factions/timeline 及其余绑定保持同一引用（刷新绝不触碰角色世界内数据）。
 * 找不到目标 bindingId 时原样返回同一 world 引用。
 */
export function applyRefreshedBinding(world: World, bindingId: string, next: RefreshedSnapshot): World {
  let changed = false
  const bindings = world.bindings.map((b) => {
    if (b.bindingId !== bindingId) return b
    changed = true
    return {
      ...b,
      nameSnapshot: next.name,
      tagsSnapshot: next.tags,
      masterRevision: next.masterRevision,
    }
  })
  if (!changed) return world
  return { ...world, bindings }
}

/** 主书/主故事等“入口目标”的列表加载状态。 */
export type TargetLoadState = 'loading' | 'ok' | 'failed'

/** 入口目标有效性：未选择 / 检查中 / 暂时无法检查 / 可进入 / 已失效。 */
export type TargetValidity = 'none' | 'checking' | 'unavailable' | 'enterable' | 'invalid'

/**
 * 用控制台已一次性加载的 books/stories 列表判定有效性，不额外发请求。
 * 列表加载失败（failed）判“暂时无法检查”，绝不误判为已失效。
 */
export function classifyTargetValidity(
  selected: string | undefined,
  present: boolean,
  loadState: TargetLoadState,
): TargetValidity {
  if (!selected) return 'none'
  if (loadState === 'loading') return 'checking'
  if (loadState === 'failed') return 'unavailable'
  return present ? 'enterable' : 'invalid'
}
