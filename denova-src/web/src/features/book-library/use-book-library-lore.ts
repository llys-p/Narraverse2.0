import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  clearLoreItemImage,
  createLoreItem,
  deleteLoreItem,
  generateLoreItemImage,
  getLoreItems,
  removeLoreItemImage,
  updateLoreItem,
  uploadLoreItemImages,
} from '@/lib/api'
import type { LoreItem } from '@/lib/api'
import { rebaseJSONValue } from '@/lib/three-way-rebase'
import { rebaseJSONWithRecovery } from '@/lib/autosave/rebase-with-recovery'
import {
  loreAutosaveDraft,
  loreResourceSignature,
  useLoreItemAutosave,
  type LoreAutosaveDraft,
} from '@/features/interactive/components/setting-panel/use-lore-item-autosave'
import { firstVisibleLoreItemId } from '@/features/interactive/components/setting-panel/knowledge-sections'

const UTF8_ENCODER = new TextEncoder()

export type CharacterTierValue = NonNullable<LoreItem['character_tier']>

export interface NewEntryInput {
  name: string
  type: LoreItem['type']
  brief_description?: string
}

/**
 * 本书资料工作台的条目控制器（T1）。
 *
 * 作用域是「当前书的真实 workspace 身份」：每次读取记住发起时所属的书，迟到的
 * A 书响应不会在切到 B 之后写入视图；写入沿用既有 revision/autosave 通道，
 * 批量与图片写入额外带上 workspace 以便服务端在切书时返回冲突而不是误写。
 */
export function useBookLibraryLore(workspace: string) {
  const { t } = useTranslation()
  const [items, setItems] = useState<LoreItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState('')
  const [draft, setDraftState] = useState<LoreItem | null>(null)
  const [tagDraft, setTagDraftState] = useState('')
  const [imageGenerating, setImageGenerating] = useState(false)
  const [imageUploading, setImageUploading] = useState(false)

  const scopeRef = useRef(workspace)
  const loadEpochRef = useRef(0)
  const batchSeqRef = useRef(0)
  const rebaseSeqRef = useRef(0)
  // 写代次：切书即自增。任何异步写在每个 await 之后、发请求之前都必须在同一代次里，
  // 否则这条写作废，不能靠「响应回来后再比一次书」——那时写入已经发生。
  const writeGenerationRef = useRef(0)
  const activeIdRef = useRef(activeId)
  const draftRef = useRef<LoreItem | null>(null)
  const tagDraftRef = useRef('')
  const baselineRef = useRef<LoreAutosaveDraft | null>(null)
  const autosaveRef = useRef<{ resetBaseline: (draft: LoreAutosaveDraft | null) => void } | null>(null)

  scopeRef.current = workspace
  activeIdRef.current = activeId

  /** 发起一次写操作时捕获的身份快照；后续每一步都用 isLive 核对。 */
  const captureTarget = useCallback((id: string) => ({
    id,
    scope: scopeRef.current,
    generation: writeGenerationRef.current,
  }), [])

  const isLive = useCallback((target: { scope: string; generation: number }) => (
    scopeRef.current === target.scope
    && writeGenerationRef.current === target.generation
  ), [])

  const isCurrentTarget = useCallback((target: { id: string; scope: string; generation: number }) => (
    isLive(target)
    && activeIdRef.current === target.id
    && draftRef.current?.id === target.id
  ), [isLive])

  const baseline = useMemo<LoreAutosaveDraft | null>(() => {
    const item = items.find((entry) => entry.id === activeId)
    return item ? loreAutosaveDraft(item) : null
  }, [activeId, items])

  const autosave = useLoreItemAutosave({
    draft,
    tagDraft,
    baseline,
    active: Boolean(draft) && Boolean(workspace),
    workspace,
    onSaved: (saved, submitted) => {
      setItems((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)))
      const currentDraft = draftRef.current
      const savedBaseline = loreAutosaveDraft(saved)
      const local = currentDraft?.id === saved.id
        ? { ...currentDraft, tags: [...(currentDraft.tags || [])], tag_draft: tagDraftRef.current }
        : submitted
      const rebased = rebaseJSONValue(submitted, local, savedBaseline)
      const { tag_draft: nextTagDraft, ...nextDraft } = rebased
      draftRef.current = nextDraft
      tagDraftRef.current = nextTagDraft
      baselineRef.current = savedBaseline
      setDraftState(nextDraft)
      setTagDraftState(nextTagDraft)
    },
    onAutoSaveError: (cause) => {
      console.warn('[book-library] failed to autosave lore item', cause)
      toast.error(cause instanceof Error ? cause.message : t('editor.saveFailed'))
    },
  })
  autosaveRef.current = autosave

  const loadItems = useCallback(async () => {
    const scope = workspace
    const epoch = loadEpochRef.current + 1
    loadEpochRef.current = epoch
    if (!scope) {
      setItems([])
      setActiveId('')
      setDraftState(null)
      setTagDraftState('')
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getLoreItems()
      // A→B→A：迟到的列表只允许落回发起它的那本书。
      if (loadEpochRef.current !== epoch || scopeRef.current !== scope) return
      setItems(data)
    } catch (cause) {
      if (loadEpochRef.current !== epoch || scopeRef.current !== scope) return
      setItems([])
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (loadEpochRef.current === epoch && scopeRef.current === scope) setLoading(false)
    }
  }, [workspace])

  // 切书：立刻清空视图，并使上一本书的所有在途写作作废。
  useEffect(() => {
    loadEpochRef.current += 1
    rebaseSeqRef.current += 1
    batchSeqRef.current += 1
    writeGenerationRef.current += 1
    setItems([])
    setActiveId('')
    setDraftState(null)
    setTagDraftState('')
    setError(null)
    baselineRef.current = null
    draftRef.current = null
    tagDraftRef.current = ''
    setImageGenerating(false)
    setImageUploading(false)
    void loadItems()
  }, [loadItems])

  // 首屏加载后落到第一个可见条目，与既有资料库目录行为一致。
  useEffect(() => {
    if (!items.length || activeIdRef.current) return
    const first = firstVisibleLoreItemId(items)
    if (first) setActiveId(first)
  }, [activeId, items])

  // 选中条目变化：草稿切到新的服务端记录；只有仍属于同一条目的未提交编辑才三方合并回去。
  useEffect(() => {
    const sequence = rebaseSeqRef.current + 1
    rebaseSeqRef.current = sequence
    const scope = workspace
    const item = items.find((entry) => entry.id === activeId) || null
    const nextBaseline = item ? loreAutosaveDraft(item) : null
    const previousBaseline = baselineRef.current
    const currentDraft = draftRef.current
    const sameItem = Boolean(item && currentDraft && currentDraft.id === item.id)
    const local = sameItem && currentDraft
      ? { ...currentDraft, tags: [...(currentDraft.tags || [])], tag_draft: tagDraftRef.current }
      : null
    void (async () => {
      let nextDraft: LoreItem | null = nextBaseline ? withoutTagDraft(nextBaseline) : null
      let nextTagDraft = nextBaseline?.tag_draft ?? ''
      if (item && local && nextBaseline) {
        const rebased = await rebaseJSONWithRecovery<LoreAutosaveDraft>({
          resource: 'lore_item',
          scope,
          id: item.id,
          baseline: { revision: previousBaseline?.updated_at || nextBaseline.updated_at || '', value: previousBaseline || nextBaseline },
          local: { revision: local.updated_at || '', value: local },
          external: { revision: nextBaseline.updated_at || '', value: nextBaseline },
        })
        const { tag_draft: rebasedTag, ...rebasedDraft } = rebased
        nextDraft = rebasedDraft
        nextTagDraft = rebasedTag
      }
      if (rebaseSeqRef.current !== sequence || scopeRef.current !== scope) return
      baselineRef.current = nextBaseline
      draftRef.current = nextDraft
      tagDraftRef.current = nextTagDraft
      setDraftState(nextDraft)
      setTagDraftState(nextTagDraft)
      autosaveRef.current?.resetBaseline(nextBaseline)
    })()
  }, [activeId, items, workspace])

  useEffect(() => {
    draftRef.current = draft
    tagDraftRef.current = tagDraft
  }, [draft, tagDraft])

  const notifyLoreUpdated = useCallback((ids?: string[]) => {
    window.dispatchEvent(new CustomEvent('nova:lore-updated', {
      detail: { workspace: scopeRef.current, item_ids: ids },
    }))
  }, [])

  // 外部写入（管理 Agent、总览、翻译队列）后重读当前书的列表。
  useEffect(() => {
    const onLoreUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace?: string }>).detail
      if (detail?.workspace && detail.workspace !== scopeRef.current) return
      void loadItems()
    }
    window.addEventListener('nova:lore-updated', onLoreUpdated)
    return () => window.removeEventListener('nova:lore-updated', onLoreUpdated)
  }, [loadItems])

  const flushPending = useCallback(async () => {
    const pending = autosave.flushPending()
    if (pending) return await pending
    if (autosave.status === 'error') return await autosave.saveNow('manual')
    return null
  }, [autosave])

  const selectItem = useCallback(async (id: string) => {
    if (id === activeIdRef.current) return
    const target = captureTarget(id)
    try {
      await flushPending()
      // flush 期间可能已经换书：这条选择属于旧书，直接作废。
      if (!isLive(target)) return
      setActiveId(id)
    } catch (cause) {
      if (!isLive(target)) return
      console.error('[book-library] failed to flush autosave before switching entries', cause)
      toast.error(cause instanceof Error ? cause.message : t('editor.saveFailed'))
    }
  }, [captureTarget, flushPending, isLive, t])

  const saveNow = useCallback(async () => {
    try {
      const saved = await autosave.saveNow('manual')
      if (saved) notifyLoreUpdated([saved.id])
      return true
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('editor.saveFailed'))
      return false
    }
  }, [autosave, notifyLoreUpdated, t])

  const mergeSavedItem = useCallback((saved: LoreItem, target: { id: string; scope: string; generation: number }, baselineOverride?: LoreAutosaveDraft | null) => {
    if (!isCurrentTarget(target) || saved.id !== target.id) return false
    setItems((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)))
    const currentDraft = draftRef.current
    if (currentDraft?.id === saved.id) {
      const savedBaseline = loreAutosaveDraft(saved)
      const local = { ...currentDraft, tags: [...(currentDraft.tags || [])], tag_draft: tagDraftRef.current }
      const rebased = rebaseJSONValue(baselineOverride || baselineRef.current || savedBaseline, local, savedBaseline)
      const { tag_draft: nextTagDraft, ...nextDraft } = rebased
      draftRef.current = nextDraft
      tagDraftRef.current = nextTagDraft
      baselineRef.current = savedBaseline
      setDraftState(nextDraft)
      setTagDraftState(nextTagDraft)
    }
    return true
  }, [isCurrentTarget])

  /** 新建只写用户填的字段，并把目标书籍身份交给服务端写入边界核对。 */
  const createItem = useCallback(async (input: NewEntryInput) => {
    const target = captureTarget('')
    if (!target.scope) return null
    try {
      const created = await createLoreItem({
        enabled: true,
        type: input.type,
        name: input.name.trim(),
        importance: input.type === 'character' ? 'major' : 'important',
        load_mode: input.type === 'character' ? 'resident' : 'auto',
        brief_description: input.brief_description?.trim() || '',
        content: `## ${input.name.trim()}\n\n`,
      }, target.scope)
      await loadItems()
      if (!isLive(target)) return created
      activeIdRef.current = created.id
      setActiveId(created.id)
      notifyLoreUpdated([created.id])
      return created
    } catch (cause) {
      if (!isLive(target)) return null
      toast.error(cause instanceof Error ? cause.message : t('bookLibrary.entry.createFailed'))
      return null
    }
  }, [captureTarget, isLive, loadItems, notifyLoreUpdated, t])

  /**
   * 删除必须先落盘未保存编辑，再在「仍是发起时那本书」的前提下发请求，
   * 并把目标书籍身份交给服务端在写入边界复核：切书之后不得继续删另一本书的同 ID 条目。
   */
  const removeItem = useCallback(async (id: string) => {
    const target = captureTarget(id)
    try {
      await flushPending()
      if (!isLive(target)) return false
      await deleteLoreItem(id, target.scope)
      if (!isLive(target)) {
        await loadItems()
        return false
      }
      if (activeIdRef.current === id) {
        activeIdRef.current = ''
        setActiveId('')
      }
      await loadItems()
      notifyLoreUpdated([id])
      return true
    } catch (cause) {
      if (!isLive(target)) return false
      toast.error(cause instanceof Error ? cause.message : t('bookLibrary.entry.deleteFailed'))
      return false
    }
  }, [captureTarget, flushPending, isLive, loadItems, notifyLoreUpdated, t])

  /**
   * 层级批改沿用既有语义：先 flush，再逐条按最新记录做完整 payload + CAS + workspace
   * 校验；只改展示分组，不触碰 load_mode 或 importance。
   */
  const updateTierBatch = useCallback(async (ids: string[], tier: CharacterTierValue) => {
    const target = captureTarget('')
    const scope = target.scope
    const request = batchSeqRef.current + 1
    batchSeqRef.current = request
    const changed: string[] = []
    let failed = 0
    await flushPending()
    let latest: LoreItem[]
    try {
      latest = await getLoreItems()
    } catch {
      return { changed, failed: ids.length }
    }
    if (!isLive(target) || batchSeqRef.current !== request) {
      return { changed: [], failed: ids.length }
    }
    for (const id of ids) {
      if (!isLive(target) || batchSeqRef.current !== request) {
        return { changed, failed: ids.length - changed.length }
      }
      const item = latest.find((entry) => entry.id === id)
      if (!item || item.type !== 'character') {
        failed += 1
        continue
      }
      const { created_at: _createdAt, updated_at: _updatedAt, ...input } = item
      try {
        const saved = await updateLoreItem(id, { ...input, character_tier: tier }, item.updated_at, scope)
        if (!isLive(target) || batchSeqRef.current !== request) return { changed, failed: failed + 1 }
        changed.push(id)
        latest = latest.map((entry) => (entry.id === saved.id ? saved : entry))
        setItems((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)))
        if (isCurrentTarget({ id: saved.id, scope, generation: target.generation })) {
          mergeSavedItem(saved, { id: saved.id, scope, generation: target.generation })
        }
      } catch {
        failed += 1
      }
    }
    if (changed.length) notifyLoreUpdated(changed)
    return { changed, failed }
  }, [captureTarget, flushPending, isCurrentTarget, isLive, mergeSavedItem, notifyLoreUpdated])

  const runImageAction = useCallback(async (options: {
    busy: 'generate' | 'upload'
    run: (target: { id: string; scope: string; generation: number }) => Promise<LoreItem>
  }) => {
    if (!draft) return
    const target = captureTarget(draft.id)
    const setBusy = options.busy === 'upload' ? setImageUploading : setImageGenerating
    setBusy(true)
    try {
      const saved = await flushPending()
      if (!isCurrentTarget(target)) return
      const baselineOverride = saved ? loreAutosaveDraft(saved) : baselineRef.current
      const result = await options.run(target)
      // 迟到的图片结果只有在同一本书、同一代次、仍是当前条目时才允许并回视图。
      if (!isCurrentTarget(target) || !mergeSavedItem(result, target, baselineOverride)) return
      notifyLoreUpdated([result.id])
    } catch (cause) {
      if (isLive(target)) toast.error(cause instanceof Error ? cause.message : t('settingPanel.loreImage.failed'))
    } finally {
      if (isLive(target)) setBusy(false)
    }
  }, [captureTarget, draft, flushPending, isCurrentTarget, isLive, mergeSavedItem, notifyLoreUpdated, t])

  const generateImage = useCallback((instruction: string, presetId: string) => (
    runImageAction({
      busy: 'generate',
      run: (target) => generateLoreItemImage(target.id, { instruction, image_preset_id: presetId }, target.scope),
    })
  ), [runImageAction])

  const clearImage = useCallback(() => (
    runImageAction({ busy: 'generate', run: (target) => clearLoreItemImage(target.id, target.scope) })
  ), [runImageAction])

  const uploadImages = useCallback((files: File[]) => (
    runImageAction({
      busy: 'upload',
      run: (target) => uploadLoreItemImages(target.id, target.scope, files),
    })
  ), [runImageAction])

  const removeImage = useCallback((imagePath: string) => (
    runImageAction({
      busy: 'upload',
      run: (target) => removeLoreItemImage(target.id, target.scope, imagePath),
    })
  ), [runImageAction])

  const residentTotalBytes = useMemo(() => (
    items
      .filter((item) => item.enabled !== false && item.load_mode === 'resident' && item.id !== draft?.id)
      .reduce((total, item) => total + UTF8_ENCODER.encode((item.content || '').trim()).length, 0)
    + (draft && draft.enabled !== false && draft.load_mode === 'resident'
      ? UTF8_ENCODER.encode((draft.content || '').trim()).length
      : 0)
  ), [draft, items])

  /** 未保存草稿判定：签名差异或保存通道仍有排队工作，两者任一成立都需要确认。 */
  const dirty = useMemo(() => {
    if (!draft || !baseline || baseline.id !== draft.id) return false
    if (loreResourceSignature({ ...draft, tag_draft: tagDraft } as LoreAutosaveDraft)
      !== loreResourceSignature(baseline)) return true
    return autosave.status === 'pending' || autosave.status === 'saving' || autosave.status === 'blocked'
  }, [autosave.status, baseline, draft, tagDraft])

  return {
    items,
    loading,
    error,
    activeId,
    draft,
    tagDraft,
    dirty,
    autosaveStatus: autosave.status,
    autosaveError: autosave.error,
    residentTotalBytes,
    selectItem,
    setDraft: (item: LoreItem | null) => {
      draftRef.current = item
      setDraftState(item)
    },
    setTagDraft: (value: string) => {
      tagDraftRef.current = value
      setTagDraftState(value)
    },
    reload: loadItems,
    saveNow,
    flushPending,
    createItem,
    removeItem,
    updateTierBatch,
    generateImage,
    clearImage,
    uploadImages,
    removeImage,
    imageBusy: { generating: imageGenerating, uploading: imageUploading },
  }
}

export type BookLibraryLore = ReturnType<typeof useBookLibraryLore>

function withoutTagDraft(draft: LoreAutosaveDraft): LoreItem {
  const { tag_draft: _tagDraft, ...item } = draft
  return item
}
