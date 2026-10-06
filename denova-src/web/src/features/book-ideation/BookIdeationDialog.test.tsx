import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { BookIdeationDialog } from './BookIdeationDialog'
import { server } from '@/test/msw/server'

interface StoredDraft {
  id: string
  revision: string
  draft: Record<string, any>
}

const STORAGE_KEY = 'nova.book-ideation.draft-id.v1'
let drafts: Record<string, StoredDraft> = {}
let revisionCounter = 0
let forceStaleGenerate = false
const commitBodies: Array<Record<string, unknown>> = []
const requestLog: string[] = []

function stored(id: string) {
  return drafts[id]
}

function patchDraft(id: string, changes: Record<string, unknown>, mutate?: (draft: Record<string, any>) => void): StoredDraft | undefined {
  const current = stored(id)
  if (!current) return undefined
  revisionCounter += 1
  const draft = { ...(current.draft as Record<string, any>), ...changes, updated_at: new Date().toISOString() }
  if (mutate) mutate(draft)
  const next = { id, revision: `r${revisionCounter}`, draft }
  drafts[id] = next
  return next
}

function json(result: StoredDraft | undefined, extra: Record<string, unknown> = {}) {
  if (!result) return HttpResponse.json({ error: '构思草稿不存在', code: 'not_found' }, { status: 404 })
  return HttpResponse.json({ draft: result.draft, revision: result.revision, ...extra })
}

function installHandlers() {
  server.use(
    http.post('/api/book-ideation/drafts', async ({ request }) => {
      const body = (await request.json()) as { idea?: string }
      revisionCounter += 1
      const id = 'draft-abc'
      const draft = {
        id,
        status: 'ideating',
        created_at: '2026-10-05T00:00:00Z',
        updated_at: '2026-10-05T00:00:00Z',
        idea: body.idea ?? '',
        title: '',
        sources: [],
        turns: [],
        direction: { summary: '' },
        direction_revision: 0,
      }
      drafts[id] = { id, revision: `r${revisionCounter}`, draft }
      return json(drafts[id])
    }),
    http.get('/api/book-ideation/drafts/:draftId', ({ params }) => json(stored(String(params.draftId)))),
    http.patch('/api/book-ideation/drafts/:draftId', async ({ params, request }) => {
      requestLog.push('patch')
      const body = (await request.json()) as Record<string, unknown>
      return json(patchDraft(String(params.draftId), {
        title: body.title ?? stored(String(params.draftId))?.draft.title ?? '',
        idea: body.idea ?? stored(String(params.draftId))?.draft.idea ?? '',
      }))
    }),
    http.post('/api/book-ideation/drafts/:draftId/sources', async ({ params, request }) => {
      const body = (await request.json()) as { content?: string; file_name?: string }
      expect(body.content).toContain('第七灯塔')
      return json(
        patchDraft(String(params.draftId), {}, (draft) => {
          draft.sources = [
            {
              id: 's0',
              kind: 'lorebook',
              name: '雾港设定书',
              content_hash: 'sha256:x',
              added_at: '2026-10-05T00:00:00Z',
              entries: [
                { id: 's0-e0', name: '第七灯塔', content: '位于雾港北岬的石塔。', role: 'entry', keywords: ['灯塔'] },
                { id: 's0-e1', name: '锈潮钥', content: '开启旧港区水闸。', role: 'entry' },
              ],
            },
          ]
        }),
      )
    }),
    http.post('/api/book-ideation/drafts/:draftId/messages', async ({ params, request }) => {
      const body = (await request.json()) as { content?: string }
      return json(
        patchDraft(String(params.draftId), {}, (draft) => {
          draft.turns = [
            { role: 'user', content: body.content ?? '', at: '2026-10-05T00:00:01Z' },
            { role: 'assistant', content: '建议一：调查为主线。建议二：守灯人为线。', at: '2026-10-05T00:00:02Z', generated: true },
          ]
          draft.direction = { summary: '雨港悬疑，调查为主线', genre: '悬疑', cast: ['守灯人'], updated_by: 'agent' }
          draft.direction_revision = 1
        }),
      )
    }),
    http.post('/api/book-ideation/drafts/:draftId/generate', async ({ params, request }) => {
      const body = (await request.json()) as { base_revision?: string; scope?: string; refs?: string[] }
      expect(body.base_revision).toBeTruthy()
      requestLog.push('generate:' + (body.scope || 'all'))
      if (forceStaleGenerate) {
        forceStaleGenerate = false
        const current = stored(String(params.draftId))
        return HttpResponse.json(
          { error: '构思草稿已有更新，本次生成结果未覆盖当前内容', code: 'generation_stale', draft: current?.draft, revision: current?.revision },
          { status: 409 },
        )
      }
      // 与真实服务端一致：scope 之外的字段必须沿用草稿里已确认的内容。
      const scope = body.scope || 'all'
      return json(
        patchDraft(String(params.draftId), {}, (draft) => {
          const before = draft.candidates as Record<string, any> | undefined
          const fresh = {
            title: '雾港守灯人',
            book_name_suggestions: ['第七灯塔'],
            synopsis: '外乡人调查灯塔失踪案。',
            overview: '# 雾港 STUB_OVERVIEW 雨港悬疑世界。',
            items: [
              { ref: 'c1', name: '第七灯塔', type: 'location', content: '石塔，灯语三短一长。', load_mode: 'resident', origin: 'source', source_refs: ['s0-e0'] },
              { ref: 'c2', name: '守灯人', type: 'character', content: '世袭职位。', load_mode: 'manual', origin: 'source', source_refs: ['s0-e0'] },
              { ref: 'c3', name: '外乡调查者', type: 'character', content: '自称受托而来。', load_mode: 'manual', origin: 'ai', open_notes: '身份未经证实' },
            ],
            relations: [{ ref: 'r1', source_ref: 'c2', target_ref: 'c1', label: '驻守', origin: 'source' }],
            open_questions: ['锈潮钥的归属未说明'],
            keep_source_entries: ['s0-e0', 's0-e1'],
          }
          draft.candidates = {
            title: scope === 'all' ? fresh.title : before?.title ?? fresh.title,
            book_name_suggestions: scope === 'all' ? fresh.book_name_suggestions : before?.book_name_suggestions ?? [],
            synopsis: scope === 'all' || scope === 'overview' ? fresh.synopsis : before?.synopsis ?? '',
            overview: scope === 'all' || scope === 'overview' ? fresh.overview : before?.overview ?? '',
            items: scope === 'all' || scope === 'items'
              ? (scope === 'items'
                  ? (before?.items ?? []).map((item: Record<string, any>) => (body.refs?.includes(item.ref) ? { ...item, content: 'REWRITTEN_BY_STUB' } : item))
                  : fresh.items)
              : before?.items ?? [],
            relations: scope === 'all' || scope === 'relation' ? fresh.relations : before?.relations ?? [],
            keep_source_entries: before?.keep_source_entries ?? (scope === 'all' ? fresh.keep_source_entries : []),
            open_questions: before?.open_questions ?? [],
            revision: (before?.revision ?? 0) + 1,
            direction_revision: draft.direction_revision,
          }
        }),
      )
    }),
    http.put('/api/book-ideation/drafts/:draftId/candidates', async ({ params, request }) => {
      requestLog.push('candidates')
      const body = (await request.json()) as { package?: { items?: { ref: string; excluded?: boolean }[]; overview?: string } }
      return json(
        patchDraft(String(params.draftId), {}, (draft) => {
          const candidates = draft.candidates as Record<string, any>
          candidates.items = body.package?.items
          candidates.overview = body.package?.overview
          candidates.revision = (candidates.revision ?? 0) + 1
        }),
      )
    }),
    http.post('/api/book-ideation/drafts/:draftId/commit', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>
      commitBodies.push(body)
      requestLog.push('commit')
      const result = patchDraft(String(params.draftId), {}, (draft) => {
        draft.status = 'committed'
        draft.commit = {
          request_id: String(body.request_id ?? ''),
          title: '雾港守灯人',
          workspace_path: '/tmp/books/雾港守灯人',
          stages: [
            { name: 'book', status: 'done' },
            { name: 'overview', status: 'done' },
            { name: 'items', status: 'done' },
            { name: 'relations', status: 'done' },
          ],
          created_at: '2026-10-05T00:00:03Z',
        }
      })
      const committed = result?.draft
      return HttpResponse.json({
        receipt: {
          draft_id: String(params.draftId),
          status: 'complete',
          workspace_path: '/tmp/books/雾港守灯人',
          title: '雾港守灯人',
          stages: committed?.commit?.stages ?? [],
          message: '《雾港守灯人》已创建',
        },
        draft: committed,
      })
    }),
    http.post('/api/book-ideation/drafts/:draftId/abandon', ({ params }) => {
      requestLog.push('abandon')
      return json(patchDraft(String(params.draftId), {}, (draft) => {
        draft.status = 'abandoned'
      }))
    }),
  )
}

function renderDialog(onCreated: (path: string) => void = () => {}) {
  return render(<BookIdeationDialog open onOpenChange={() => {}} onCreated={onCreated} />)
}

beforeEach(() => {
  drafts = {}
  revisionCounter = 0
  forceStaleGenerate = false
  commitBodies.length = 0
  requestLog.length = 0
  localStorage.clear()
  installHandlers()
})

describe('BookIdeationDialog', () => {
  it('构思到确认建书全程只在最后一次写入正式书籍', async () => {
    const user = userEvent.setup()
    const created: string[] = []
    renderDialog((path) => created.push(path))

    await user.click(await screen.findByRole('button', { name: /开始构思/ }))

    await user.type(screen.getByTestId('ideation-source-text'), '【第七灯塔】位于雾港北岬的石塔。')
    await user.click(screen.getByRole('button', { name: /添加为来源/ }))
    await waitFor(() => expect(screen.getByText('雾港设定书')).toBeInTheDocument())
    expect(screen.getAllByText(/2 条原文条目/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.type(screen.getByTestId('ideation-chat-input'), '偏悬疑，少战斗')
    await user.click(screen.getByRole('button', { name: /发送/ }))
    await waitFor(() => expect(screen.getByText(/建议一：调查为主线/)).toBeInTheDocument())
    expect(screen.getByText('雨港悬疑，调查为主线')).toBeInTheDocument()

    await user.click(screen.getByTestId('ideation-generate'))
    const preview = await screen.findByTestId('ideation-preview')
    expect(within(preview).getAllByDisplayValue(/石塔|世袭职位|自称受托而来/).length).toBeGreaterThan(0)
    expect(within(preview).getAllByText('来源事实').length).toBeGreaterThan(0)
    expect(within(preview).getAllByText('AI 建议').length).toBeGreaterThan(0)
    // 确认之前：草稿只是草稿，正式书目不出现任何新书。
    expect(created).toHaveLength(0)

    await user.click(within(preview).getByTestId('ideation-item-keep-c3'))
    await user.click(within(preview).getByRole('button', { name: /保存预览修改/ }))
    await waitFor(() => expect(stored('draft-abc')?.draft.candidates.items[2].excluded).toBe(true))

    await user.click(within(preview).getByRole('button', { name: /创建书籍并保存资料/ }))
    await waitFor(() => expect(created).toEqual(['/tmp/books/雾港守灯人']))
    expect(commitBodies).toHaveLength(1)
    expect(commitBodies[0].request_id).toContain('ideation-draft-abc')
    expect(typeof commitBodies[0].base_revision).toBe('string')
    // 草稿 id 不再残留，避免下次打开继续指向已建成的书。
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('刷新后回到原来的草稿与阶段', async () => {
    const user = userEvent.setup()
    // 先跑到有候选包的状态，再模拟刷新（组件重新挂载，本地只剩草稿 id）。
    const first = renderDialog()
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    await user.type(screen.getByTestId('ideation-idea-edit'), '雾港灯塔失踪案')
    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.click(screen.getByTestId('ideation-generate'))
    await screen.findByTestId('ideation-preview')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('draft-abc')

    // 模拟刷新：只保留本地草稿 id，组件重新挂载后必须从服务端读回同一份草稿。
    first.unmount()
    const created: string[] = []
    renderDialog((path) => created.push(path))
    await waitFor(() => expect(screen.getByTestId('ideation-preview')).toBeInTheDocument())
    expect(created).toHaveLength(0)
  })

  it('只勾选排除、不点保存也要先写回草稿再创建', async () => {
    const user = userEvent.setup()
    const created: string[] = []
    renderDialog((path) => created.push(path))
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    await user.type(screen.getByTestId('ideation-idea-edit'), '雾港灯塔失踪案')
    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.click(screen.getByTestId('ideation-generate'))
    const preview = await screen.findByTestId('ideation-preview')

    await user.click(within(preview).getByTestId('ideation-item-keep-c3'))
    await user.click(within(preview).getByRole('button', { name: /创建书籍并保存资料/ }))

    await waitFor(() => expect(created).toHaveLength(1))
    // 确认创建必须晚于候选回写，否则预览里的“排除”不会进入服务端草稿。
    expect(requestLog.lastIndexOf('candidates')).toBeLessThan(requestLog.indexOf('commit'))
    expect(requestLog.filter((entry) => entry === 'commit')).toHaveLength(1)
    const items = stored('draft-abc')?.draft.candidates.items as { ref: string; excluded: boolean }[]
    expect(items.find((item) => item.ref === 'c3')?.excluded).toBe(true)
    expect(commitBodies).toHaveLength(1)
  })

  it('迟到的生成结果不覆盖新修改，并回到最新草稿', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    await user.type(screen.getByTestId('ideation-idea-edit'), '雾港灯塔失踪案')
    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.click(screen.getByTestId('ideation-generate'))
    await screen.findByTestId('ideation-preview')

    forceStaleGenerate = true
    await user.click(within(screen.getByTestId('ideation-preview')).getByRole('button', { name: /按当前方向重新生成/ }))

    const notice = await screen.findByTestId('ideation-notice')
    expect(notice.textContent).toContain('未覆盖')
    // 现有候选包保持不变，没有被迟到回复顶掉。
    expect(stored('draft-abc')?.draft.candidates.items).toHaveLength(3)
  })

  it('普通关闭保留草稿，只有主动放弃才写入 abandoned', async () => {
    const user = userEvent.setup()
    const first = renderDialog()
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    await user.type(screen.getByTestId('ideation-idea-edit'), '雾港灯塔失踪案')
    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.click(screen.getByTestId('ideation-generate'))
    await screen.findByTestId('ideation-preview')

    await user.click(screen.getByTestId('ideation-close'))
    await waitFor(() => expect(stored('draft-abc').draft.status).toBe('ideating'))
    expect(localStorage.getItem(STORAGE_KEY)).toBe('draft-abc')
    expect(requestLog).not.toContain('abandon')

    // 再打开：同一份草稿仍在，恢复指针没被清掉。
    first.unmount()
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('ideation-preview')).toBeInTheDocument())

    // 明确放弃才写 abandoned 并清指针。
    await user.click(screen.getByTestId('ideation-abandon'))
    await waitFor(() => expect(requestLog).toContain('abandon'))
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull())
    expect(stored('draft-abc').draft.status).toBe('abandoned')
  })

  it('局部重写前先把未保存编辑写回草稿，范围外内容不被覆盖', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    await user.type(screen.getByTestId('ideation-idea-edit'), '雾港灯塔失踪案')
    await user.click(screen.getByRole('button', { name: /下一步：确定方向/ }))
    await user.click(screen.getByTestId('ideation-generate'))
    const preview = await screen.findByTestId('ideation-preview')

    // 直接改总览且不点“保存”，随后只重写 c1。
    const overview = within(preview).getByTestId('ideation-overview')
    await user.click(overview)
    await user.type(overview, ' USER_EDITED_OVERVIEW')
    await user.click(within(preview).getAllByRole('button', { name: /只重写这条/ })[0])

    await waitFor(() => expect(requestLog).toContain('generate:items'))
    const patchIndex = requestLog.lastIndexOf('patch')
    const candidatesIndex = requestLog.lastIndexOf('candidates')
    const generateIndex = requestLog.indexOf('generate:items')
    expect(patchIndex).toBeLessThan(generateIndex)
    expect(candidatesIndex).toBeLessThan(generateIndex)
    expect(stored('draft-abc').draft.candidates.overview).toContain('USER_EDITED_OVERVIEW')
    // 范围外内容仍按草稿走：总览没有被 stub 顶掉。
    expect((within(preview).getByTestId('ideation-overview') as HTMLTextAreaElement).value).toContain('USER_EDITED_OVERVIEW')
    const items = stored('draft-abc').draft.candidates.items as { ref: string; content: string }[]
    expect(items.find((item) => item.ref === 'c1')?.content).toBe('REWRITTEN_BY_STUB')
    expect(items.find((item) => item.ref === 'c2')?.content).toBe('世袭职位。')
    expect(stored('draft-abc').draft.candidates.relations).toHaveLength(1)
  })

  it('一句话输入可继续编辑，刷新恢复后仍是自己写的版本', async () => {
    const user = userEvent.setup()
    const first = renderDialog()
    await user.click(await screen.findByRole('button', { name: /开始构思/ }))
    const edit = screen.getByTestId('ideation-idea-edit')
    await user.type(edit, '第一段想法')
    edit.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await waitFor(() => expect(stored('draft-abc').draft.idea).toBe('第一段想法'))
    // 输入框由本地状态驱动，不能因为草稿已有 idea 就把输入顶回去。
    expect((edit as HTMLTextAreaElement).value).toBe('第一段想法')
    await user.type(edit, '＋补充')
    expect((edit as HTMLTextAreaElement).value).toBe('第一段想法＋补充')

    first.unmount()
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('ideation-idea-edit')).toHaveValue('第一段想法'))
  })
})
