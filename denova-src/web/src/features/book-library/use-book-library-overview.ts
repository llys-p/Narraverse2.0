import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { APIError, readFile } from '@/lib/api'
import { BOOK_OVERVIEW_PATH } from '@/features/interactive/components/setting-panel/BookOverviewPanel'
import { useWorkspaceFileAutosave } from '@/features/interactive/components/setting-panel/use-workspace-file-autosave'

export interface BookOverviewDraft {
  content: string
  setContent: (value: string) => void
  revision: string
  loading: boolean
  error: string | null
  dirty: boolean
  status: ReturnType<typeof useWorkspaceFileAutosave>['status']
  saveStatusError: string | null
  /** 由调用方在总览可见时置为 active；离开前必须先 flush，不能让草稿随视图一起消失。 */
  setActive: (active: boolean) => void
  /** 返回 true 表示已落盘或本来就没有改动；false 表示保存失败，调用方必须留在原视图。 */
  flush: () => Promise<boolean>
  reload: () => Promise<void>
}

/**
 * 书籍总览草稿的所有权。
 *
 * 状态挂在工作台而不是总览视图上，所以切页不会丢内容；每次离开都先落盘，
 * 落盘失败时保留草稿并让调用方留在编辑态。作用域仍是当前书的 workspace 身份，
 * 切书时旧草稿不会写进新书。
 */
export function useBookOverview(workspace: string): BookOverviewDraft {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [revision, setRevision] = useState('')
  const [fileWorkspace, setFileWorkspace] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(false)

  const scopeRef = useRef(workspace)
  const epochRef = useRef(0)
  const baselineRef = useRef('')
  scopeRef.current = workspace

  const loaded = Boolean(fileWorkspace && revision)

  const autosave = useWorkspaceFileAutosave({
    path: BOOK_OVERVIEW_PATH,
    content,
    revision,
    fileWorkspace,
    active: active && loaded,
    scopeKey: workspace,
    onSaved: (saved, submitted) => {
      if (saved.workspace !== scopeRef.current) return
      baselineRef.current = saved.content
      setContent((current) => (current === submitted.content ? saved.content : current))
      setRevision(saved.updated_at || '')
    },
    onAutoSaveError: (cause) => {
      console.error('[book-library] failed to autosave book overview', cause)
      toast.error((cause as Error).message || t('editor.saveFailed'))
    },
  })

  const resetBaseline = autosave.resetBaseline

  const reload = useCallback(async () => {
    const scope = workspace
    const epoch = epochRef.current + 1
    epochRef.current = epoch
    setContent('')
    setRevision('')
    setFileWorkspace('')
    baselineRef.current = ''
    setError(null)
    if (!scope) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const file = await readFile(BOOK_OVERVIEW_PATH)
      if (epochRef.current !== epoch || scopeRef.current !== scope) return
      if (file.workspace !== scope) return
      baselineRef.current = file.content
      setContent(file.content)
      setRevision(file.revision || '')
      setFileWorkspace(file.workspace)
      resetBaseline({ id: BOOK_OVERVIEW_PATH, content: file.content, workspace: file.workspace, updated_at: file.revision || '' })
    } catch (cause) {
      if (epochRef.current !== epoch || scopeRef.current !== scope) return
      const missing = cause instanceof APIError && cause.status === 404
      if (missing) {
        baselineRef.current = ''
        setRevision('missing')
        setFileWorkspace(scope)
        resetBaseline({ id: BOOK_OVERVIEW_PATH, content: '', workspace: scope, updated_at: 'missing' })
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (epochRef.current === epoch && scopeRef.current === scope) setLoading(false)
    }
  }, [resetBaseline, workspace])

  // 切书：先弃用旧草稿再重读，旧书的编辑不会带进新书。
  useEffect(() => {
    epochRef.current += 1
    setActive(false)
    setContent('')
    setRevision('')
    setFileWorkspace('')
    baselineRef.current = ''
    void reload()
  }, [reload])

  /** 与最近一次落盘/读取的内容比较；baselineRef 在每次保存成功后前移。 */
  const dirty = loaded && content !== baselineRef.current

  /** 保存失败（抛错）时返回 false，调用方据此留在原视图并保留草稿。 */
  const flush = useCallback(async () => {
    if (!loaded) return true
    try {
      const pending = autosave.flushPending()
      if (pending) await pending
      else if (dirty) await autosave.saveNow('manual')
      return true
    } catch (cause) {
      console.error('[book-library] failed to flush book overview', cause)
      toast.error((cause as Error)?.message || t('editor.saveFailed'))
      return false
    }
  }, [autosave, dirty, loaded, t])

  return {
    content,
    setContent,
    revision,
    loading,
    error,
    dirty,
    status: autosave.status,
    saveStatusError: autosave.error,
    setActive,
    flush,
    reload,
  }
}
