import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageView } from '@/lib/agent-message-view'
import { ConfigManagerChat } from './ConfigManagerChat'

const stream = vi.hoisted(() => ({ onView: null as ((view: AgentMessageView) => void) | null }))

vi.mock('@/hooks/useAgentUIMessageStream', () => ({
  createAgentDataMessage: vi.fn(),
  createAgentTextMessage: vi.fn(),
  useAgentUIMessageStream: ({ onView }: { onView: (view: AgentMessageView) => void }) => {
    stream.onView = onView
    return { messages: [], setMessages: vi.fn(), isStreaming: false, consumeAgentUIStream: vi.fn() }
  },
}))

vi.mock('@/hooks/useSkillCommands', () => ({ useSkillCommands: () => [] }))
vi.mock('@/components/Chat/InputArea', () => ({ InputArea: () => null }))
vi.mock('@/components/Chat/MessageList', () => ({ MessageList: () => null }))
vi.mock('@/lib/api', () => ({ getConfigManagerMessages: vi.fn().mockResolvedValue([]) }))

describe('ConfigManagerChat Lore writes', () => {
  beforeEach(() => {
    stream.onView = null
    vi.clearAllMocks()
  })

  it('refreshes Lore with the written item IDs from a successful relation write at any config-manager origin', () => {
    const loreUpdated = vi.fn()
    const onMutated = vi.fn()
    window.addEventListener('nova:lore-updated', loreUpdated)
    render(<ConfigManagerChat workspace="book-a" origin="agents" onMutated={onMutated} />)

    stream.onView?.(toolView(
      'write_lore_relations',
      'success',
      '设置朋友关系（更新1）\nitem_ids: ["a"]\ndeleted_ids: null\n\n[Denova tool result metadata]\nschema: tool_result.v1',
      'tool-result',
    ))

    expect(loreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nova:lore-updated',
      detail: { workspace: 'book-a', item_ids: ['a'], preserve_selection: true },
    }))
    expect(onMutated).not.toHaveBeenCalled()
    window.removeEventListener('nova:lore-updated', loreUpdated)
  })

  it('reconciles the book overview from a successful change receipt at any config-manager origin', () => {
    const workspaceChanged = vi.fn()
    const onMutated = vi.fn()
    window.addEventListener('nova:workspace-change', workspaceChanged)
    render(<ConfigManagerChat workspace="book-a" origin="master-library" onMutated={onMutated} />)

    stream.onView?.(toolView('write_book_overview', 'success', `${JSON.stringify({
      schema: 'workspace_change.tool_result.v1', status: 'applied', workspace: 'book-a',
      change_group_id: 'group-1', change_set_id: 'change-1', path: 'setting/book-overview.md',
    })}\n\n[Denova tool result metadata]\nschema: tool_result.v1`))

    expect(workspaceChanged).toHaveBeenCalledWith(expect.objectContaining({
      type: 'nova:workspace-change',
      detail: { workspace: 'book-a', path: 'setting/book-overview.md', paths: ['setting/book-overview.md'], change_group_id: 'group-1', change_set_id: 'change-1' },
    }))
    expect(onMutated).not.toHaveBeenCalled()
    window.removeEventListener('nova:workspace-change', workspaceChanged)
  })

  it('does not refresh for failed writes, malformed receipts, or similarly named tools', () => {
    const onMutated = vi.fn()
    render(<ConfigManagerChat workspace="book-a" origin="lore" onMutated={onMutated} />)

    stream.onView?.(toolView('write_lore_relations', 'error', { item_ids: ['a'] }))
    stream.onView?.(toolView('write_book_overview', 'success', {
      schema: 'workspace_change.tool_result.v1', status: 'error', workspace: 'book-a',
      change_group_id: 'group-1', change_set_id: 'change-1', path: 'setting/book-overview.md',
    }))
    stream.onView?.(toolView('write_lore_items_extra', 'success', { item_ids: ['a'] }))

    expect(onMutated).not.toHaveBeenCalled()
  })

  it('does not refresh Lore for unrelated or unsuccessful tool results at other origins', () => {
    const loreUpdated = vi.fn()
    window.addEventListener('nova:lore-updated', loreUpdated)
    const workspaceChanged = vi.fn()
    window.addEventListener('nova:workspace-change', workspaceChanged)
    render(<ConfigManagerChat workspace="book-a" origin="master-library" />)

    stream.onView?.(toolView('write_lore_items_extra', 'success', { item_ids: ['a'] }))
    stream.onView?.(toolView('write_lore_relations', 'error', { item_ids: ['a'] }))
    stream.onView?.(toolView('write_lore_relations', 'success', { message: 'done' }))
    stream.onView?.(toolView('write_book_overview', 'success', {
      schema: 'workspace_change.tool_result.v1', status: 'error', workspace: 'book-a',
      change_group_id: 'group-1', change_set_id: 'change-1', path: 'setting/book-overview.md',
    }))

    expect(loreUpdated).not.toHaveBeenCalled()
    expect(workspaceChanged).not.toHaveBeenCalled()
    window.removeEventListener('nova:lore-updated', loreUpdated)
    window.removeEventListener('nova:workspace-change', workspaceChanged)
  })
})

function toolView(toolName: string, status: 'success' | 'error', output: unknown, kind: 'tool' | 'tool-result' = 'tool'): AgentMessageView {
  return {
    kind, messageId: 'message-1', partId: `part-${toolName}`, status,
    key: `tool:${toolName}`, partIndex: 0, ref: { messageId: 'message-1', partId: `part-${toolName}`, partIndex: 0, type: 'dynamic-tool' },
    message: {} as AgentMessageView['message'], part: {} as AgentMessageView['part'], metadata: {}, data: {},
    content: toolName, streaming: false, toolName, output,
  }
}
