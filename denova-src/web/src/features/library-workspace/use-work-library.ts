import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createWorkLibrary,
  createWorkLibraryItem,
  createWorkLibraryRelation,
  deleteWorkLibrary,
  deleteWorkLibraryItem,
  deleteWorkLibraryRelation,
  fetchWorkLibraryVocabulary,
  getWorkLibrary,
  getWorkLibraryTimeline,
  listWorkLibraries,
  updateWorkLibraryItem,
  updateWorkLibraryMeta,
  updateWorkLibraryRelation,
  type WorkLibrary,
  type WorkLibraryImpact,
  type WorkLibraryItem,
  type WorkLibraryItemInput,
  type WorkLibraryListEnvelope,
  type WorkLibraryMetaPatch,
  type WorkLibraryRelation,
  type WorkLibraryRelationInput,
  type WorkLibrarySummary,
  type WorkLibraryTimelineEntry,
  type WorkLibraryVocabulary,
} from '@/lib/api-client'
import {
  classifyWorkLibraryError,
  workLibraryErrorMessage,
  workLibraryErrorImpact,
} from './library-errors'
import { removeItemLocal, removeRelationLocal, upsertItem, upsertRelation } from './library-draft'

// 设定库的数据访问层：列表、单个库的加载与全部写操作。
//
// 并发冲突（409 revision_conflict）在这里被统一收敛为 `conflict` 状态：
// 组件据此「保留草稿 + 提供重新加载」，而不是把草稿丢掉。服务端返回的数据
// 在冲突时保持不变，本地草稿也保持不变——两边都不丢。

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface WorkLibraryConflict {
  /** 触发冲突的操作范围，用于文案与重新加载后的定位。 */
  scope: 'meta' | 'item' | 'relation'
  message: string
}

export interface WorkLibraryListState {
  status: LoadStatus
  libraries: WorkLibrarySummary[]
  warnings: { file: string; id?: string; reason: string }[]
  error: string | null
  reload: () => void
}

/** 列表：扫描派生的摘要；损坏文件以 warnings 返回，不静默丢弃。 */
export function useWorkLibraryList(reloadToken = 0): WorkLibraryListState {
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [envelope, setEnvelope] = useState<WorkLibraryListEnvelope>({ libraries: [], warnings: [] })
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    listWorkLibraries()
      .then((data) => {
        if (cancelled) return
        setEnvelope({ libraries: data.libraries ?? [], warnings: data.warnings ?? [] })
        setError(null)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(workLibraryErrorMessage(err) ?? 'list_failed')
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken, token])

  const reload = useCallback(() => setToken((value) => value + 1), [])
  return { status, libraries: envelope.libraries, warnings: envelope.warnings, error, reload }
}

export interface WorkLibraryDeleteOutcome {
  status: 'deleted' | 'in_use' | 'failed'
  impact?: WorkLibraryImpact
  message?: string
}

export interface WorkLibraryEditorState {
  status: LoadStatus
  error: string | null
  library: WorkLibrary | null
  revision: string
  timeline: WorkLibraryTimelineEntry[]
  conflict: WorkLibraryConflict | null
  dismissConflict: () => void
  /** 重新加载最新版本：会丢弃本地草稿（调用方需先确认）。 */
  reload: () => Promise<void>
  saveMeta: (patch: WorkLibraryMetaPatch) => Promise<boolean>
  createItem: (input: WorkLibraryItemInput) => Promise<WorkLibraryItem | null>
  saveItem: (itemId: string, input: WorkLibraryItemInput) => Promise<WorkLibraryItem | null>
  deleteItem: (itemId: string, cascade: boolean) => Promise<WorkLibraryDeleteOutcome>
  createRelation: (input: WorkLibraryRelationInput) => Promise<WorkLibraryRelation | null>
  saveRelation: (relationId: string, input: WorkLibraryRelationInput) => Promise<WorkLibraryRelation | null>
  deleteRelation: (relationId: string) => Promise<boolean>
  lastError: { kind: string; message: string } | null
  clearLastError: () => void
}

/** 编辑器：加载单个库并承载全部写操作，统一处理并发冲突。 */
export function useWorkLibraryEditor(libraryId: string | null): WorkLibraryEditorState {
  const [status, setStatus] = useState<LoadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [library, setLibrary] = useState<WorkLibrary | null>(null)
  const [revision, setRevision] = useState('')
  const [timeline, setTimeline] = useState<WorkLibraryTimelineEntry[]>([])
  const [conflict, setConflict] = useState<WorkLibraryConflict | null>(null)
  const [lastError, setLastError] = useState<{ kind: string; message: string } | null>(null)

  // 冲突与错误状态在多次请求间必须是最新的，用 ref 避免闭包读到旧值。
  const revisionRef = useRef('')
  revisionRef.current = revision

  const load = useCallback(async (id: string) => {
    setStatus('loading')
    try {
      const envelope = await getWorkLibrary(id)
      setLibrary(envelope.library)
      setRevision(envelope.revision)
      setError(null)
      setConflict(null)
      setStatus('ready')
      try {
        setTimeline(await getWorkLibraryTimeline(id))
      } catch {
        // 时间线是派生视图，读不到不应让整个编辑器失败。
        setTimeline([])
      }
    } catch (err: unknown) {
      setError(workLibraryErrorMessage(err) ?? 'load_failed')
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!libraryId) {
      setStatus('idle')
      setLibrary(null)
      setRevision('')
      setTimeline([])
      return
    }
    void load(libraryId)
  }, [libraryId, load])

  const syncTimeline = useCallback(async (id: string) => {
    try {
      setTimeline(await getWorkLibraryTimeline(id))
    } catch {
      setTimeline([])
    }
  }, [])

  const handleFailure = useCallback((err: unknown, scope: WorkLibraryConflict['scope']) => {
    const kind = classifyWorkLibraryError(err)
    if (kind === 'conflict') {
      // 关键：不改动 library / revision，草稿留在组件里，服务端数据也不动。
      setConflict({ scope, message: workLibraryErrorMessage(err) ?? 'revision_conflict' })
      return
    }
    setLastError({ kind, message: workLibraryErrorMessage(err) ?? '' })
  }, [])

  const reload = useCallback(async () => {
    if (!libraryId) return
    setConflict(null)
    await load(libraryId)
  }, [libraryId, load])

  const saveMeta = useCallback(async (patch: WorkLibraryMetaPatch) => {
    if (!libraryId) return false
    try {
      const envelope = await updateWorkLibraryMeta(libraryId, revisionRef.current, patch)
      setLibrary(envelope.library)
      setRevision(envelope.revision)
      setConflict(null)
      return true
    } catch (err: unknown) {
      handleFailure(err, 'meta')
      return false
    }
  }, [libraryId, handleFailure])

  const createItem = useCallback(async (input: WorkLibraryItemInput) => {
    if (!libraryId) return null
    try {
      const result = await createWorkLibraryItem(libraryId, input)
      setLibrary((current) => (current ? upsertItem(current, result.item) : current))
      setRevision(result.revision)
      setConflict(null)
      void syncTimeline(libraryId)
      return result.item
    } catch (err: unknown) {
      handleFailure(err, 'item')
      return null
    }
  }, [libraryId, handleFailure, syncTimeline])

  const saveItem = useCallback(async (itemId: string, input: WorkLibraryItemInput) => {
    if (!libraryId) return null
    try {
      const result = await updateWorkLibraryItem(libraryId, itemId, input)
      setLibrary((current) => (current ? upsertItem(current, result.item) : current))
      setRevision(result.revision)
      setConflict(null)
      void syncTimeline(libraryId)
      return result.item
    } catch (err: unknown) {
      handleFailure(err, 'item')
      return null
    }
  }, [libraryId, handleFailure, syncTimeline])

  const deleteItem = useCallback(async (itemId: string, cascade: boolean): Promise<WorkLibraryDeleteOutcome> => {
    if (!libraryId) return { status: 'failed' }
    try {
      const result = await deleteWorkLibraryItem(libraryId, itemId, cascade)
      setLibrary((current) => (current
        ? removeItemLocal(current, result.deletedId, result.removedRelationIds ?? [], result.updatedEventIds ?? [])
        : current))
      setRevision(result.revision)
      setConflict(null)
      void syncTimeline(libraryId)
      return { status: 'deleted' }
    } catch (err: unknown) {
      const kind = classifyWorkLibraryError(err)
      if (kind === 'item_in_use') {
        // 被引用不是失败：把影响交给 UI 展示，由用户决定是否级联。
        return { status: 'in_use', impact: workLibraryErrorImpact(err) ?? undefined, message: workLibraryErrorMessage(err) ?? '' }
      }
      handleFailure(err, 'item')
      return { status: 'failed', message: workLibraryErrorMessage(err) ?? '' }
    }
  }, [libraryId, handleFailure, syncTimeline])

  const createRelation = useCallback(async (input: WorkLibraryRelationInput) => {
    if (!libraryId) return null
    try {
      const result = await createWorkLibraryRelation(libraryId, input)
      setLibrary((current) => (current ? upsertRelation(current, result.relation) : current))
      setRevision(result.revision)
      setConflict(null)
      return result.relation
    } catch (err: unknown) {
      handleFailure(err, 'relation')
      return null
    }
  }, [libraryId, handleFailure])

  const saveRelation = useCallback(async (relationId: string, input: WorkLibraryRelationInput) => {
    if (!libraryId) return null
    try {
      const result = await updateWorkLibraryRelation(libraryId, relationId, input)
      setLibrary((current) => (current ? upsertRelation(current, result.relation) : current))
      setRevision(result.revision)
      setConflict(null)
      return result.relation
    } catch (err: unknown) {
      handleFailure(err, 'relation')
      return null
    }
  }, [libraryId, handleFailure])

  const deleteRelation = useCallback(async (relationId: string) => {
    if (!libraryId) return false
    try {
      const result = await deleteWorkLibraryRelation(libraryId, relationId)
      setLibrary((current) => (current ? removeRelationLocal(current, relationId) : current))
      setRevision(result.revision)
      setConflict(null)
      return true
    } catch (err: unknown) {
      handleFailure(err, 'relation')
      return false
    }
  }, [libraryId, handleFailure])

  return {
    status,
    error,
    library,
    revision,
    timeline,
    conflict,
    dismissConflict: () => setConflict(null),
    reload,
    saveMeta,
    createItem,
    saveItem,
    deleteItem,
    createRelation,
    saveRelation,
    deleteRelation,
    lastError,
    clearLastError: () => setLastError(null),
  }
}

/** 词表：由服务端下发，前端不硬编码，避免“UI 能选但保存被拒”。 */
export function useWorkLibraryVocabulary(): WorkLibraryVocabulary | null {
  const [vocabulary, setVocabulary] = useState<WorkLibraryVocabulary | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchWorkLibraryVocabulary()
      .then((data) => {
        if (!cancelled) setVocabulary(data)
      })
      .catch(() => {
        if (!cancelled) setVocabulary(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return vocabulary
}

/** 新建库并返回它的 id（失败返回 null）；创建不需要先有书。 */
export function useWorkLibraryCreation(): {
  creating: boolean
  create: (input: { name: string; summary?: string; purpose?: string }) => Promise<string | null>
  error: string | null
} {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = useCallback(async (input: { name: string; summary?: string; purpose?: string }) => {
    setCreating(true)
    setError(null)
    try {
      const envelope = await createWorkLibrary(input)
      return envelope.library.id
    } catch (err: unknown) {
      setError(workLibraryErrorMessage(err) ?? 'create_failed')
      return null
    } finally {
      setCreating(false)
    }
  }, [])
  return { creating, create, error }
}

/** 删除整个库（需要当前 revision）。 */
export function useWorkLibraryRemoval(): (id: string, revision: string) => Promise<boolean> {
  return useCallback(async (id: string, revision: string) => {
    try {
      await deleteWorkLibrary(id, revision)
      return true
    } catch {
      return false
    }
  }, [])
}

/** 便捷：把词表里的值翻成 key，缺失时回落到原值本身。 */
export function useVocabularyLabels(vocabulary: WorkLibraryVocabulary | null) {
  return useMemo(() => vocabulary, [vocabulary])
}
