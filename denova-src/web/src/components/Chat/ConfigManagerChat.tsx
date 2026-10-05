import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InputArea } from './InputArea'
import { MessageList } from './MessageList'
import { clearConfigManagerSession, getConfigManagerMessages, runConfigManagerStream } from '@/lib/api'
import type { ConfigManagerRunRequest } from '@/lib/api'
import { useSkillCommands } from '@/hooks/useSkillCommands'
import { selectAgentTokenUsageRecords, type AgentMessageView } from '@/lib/agent-message-view'
import { createAgentDataMessage, createAgentTextMessage, useAgentUIMessageStream } from '@/hooks/useAgentUIMessageStream'

interface ConfigManagerChatProps {
  workspace?: string
  origin: string
  resourceId?: string
  storyId?: string
  branchId?: string
  context?: Record<string, string>
  onMutated?: (mutation?: { toolName: string; itemIds?: string[] }) => void
  className?: string
}

export function ConfigManagerChat({ workspace = '', origin, resourceId, storyId, branchId, context, onMutated, className = '' }: ConfigManagerChatProps) {
  const { t } = useTranslation()
  const activeKeyRef = useRef('')
  const handledToolViewsRef = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)
  const [inputAreaHeight, setInputAreaHeight] = useState(0)
  const skills = useSkillCommands({ agentKey: 'config_manager', workspace, fallbackEnabled: true })
  const scope = useMemo(() => ({
    origin,
    resource_id: resourceId,
    story_id: storyId,
    branch_id: branchId,
  }), [branchId, origin, resourceId, storyId])
  const chatKey = useMemo(() => [
    'config-manager',
    workspace,
    origin,
    resourceId || '',
    storyId || '',
    branchId || '',
  ].join(':'), [branchId, origin, resourceId, storyId, workspace])
  const handleStreamView = useCallback((view: AgentMessageView) => {
    if ((view.kind !== 'tool' && view.kind !== 'tool-result') || view.status !== 'success') return
    const key = `${view.messageId}:${view.partId}:${view.status}`
    if (handledToolViewsRef.current.has(key)) return
    handledToolViewsRef.current.add(key)
    const output = parseToolOutput(view.output)
    const itemIds = parseItemIDs(output?.item_ids)
    if (view.toolName === 'write_book_overview') {
      const receipt = parseChangeReceipt(output, workspace)
      if (receipt) {
        window.dispatchEvent(new CustomEvent('nova:workspace-change', {
          detail: { ...receipt, workspace, paths: [receipt.path] },
        }))
      }
      return
    }
    if (view.toolName === 'write_lore_relations') {
      if (!itemIds) return
      window.dispatchEvent(new CustomEvent('nova:lore-updated', {
        detail: { workspace, item_ids: itemIds, preserve_selection: true },
      }))
      return
    }
    if (origin === 'lore' && view.toolName !== 'write_lore_items') return
    onMutated?.({ toolName: view.toolName || '', itemIds })
  }, [onMutated, origin, workspace])
  const {
    messages,
    setMessages,
    isStreaming: running,
    consumeAgentUIStream,
  } = useAgentUIMessageStream({ onView: handleStreamView })
  const tokenUsageMessages = useMemo(
    () => selectAgentTokenUsageRecords(messages),
    [messages],
  )
  const messageListBottomPadding = inputAreaHeight > 0 ? inputAreaHeight + 20 : undefined

  const loadMessages = useCallback(() => {
    if (!workspace) {
      setMessages([])
      return
    }
    getConfigManagerMessages(scope)
      .then(setMessages)
      .catch((err) => setError(err instanceof Error ? err.message : t('configManager.historyLoadFailed')))
  }, [scope, t, workspace])

  useEffect(() => {
    activeKeyRef.current = chatKey
    setError(null)
    handledToolViewsRef.current = new Set()
    loadMessages()
  }, [chatKey, loadMessages])

  const appendErrorMessage = (content: string) => {
    setMessages((current) => [...current, createAgentDataMessage('agent-error', { content })])
  }

  const send = async (message: string) => {
    const instruction = message.trim()
    if (!instruction || running) return
    if (instruction === '/clear') {
      setError(null)
      try {
        await clearConfigManagerSession(scope)
        setMessages([createAgentDataMessage('agent-clear', { created_at: new Date().toISOString() })])
      } catch (err) {
        appendErrorMessage(err instanceof Error ? err.message : t('configManager.clearFailed'))
      }
      return
    }
    setMessages((current) => [...current, createAgentTextMessage('user', instruction)])
    setError(null)
    const activeChatKey = chatKey
    try {
      const req: ConfigManagerRunRequest = {
        instruction,
        ...scope,
        context,
      }
      const stream = await runConfigManagerStream(req)
      await consumeAgentUIStream(stream, { shouldContinue: () => activeKeyRef.current === activeChatKey })
    } catch (err) {
      if (activeKeyRef.current === activeChatKey) appendErrorMessage(err instanceof Error ? err.message : t('configManager.runFailed'))
    }
  }

  return (
    <div className={`relative flex h-full min-h-0 flex-col overflow-hidden ${className}`}>
      {error && <div className="border-b border-[var(--nova-border)] px-3 py-2 text-xs text-red-400">{error}</div>}
      <MessageList
        messages={messages}
        isStreaming={running}
        activityContent=""
        scrollResetKey={chatKey}
        bottomPaddingClassName="pb-36"
        bottomPaddingPx={messageListBottomPadding}
        collapseTraceGroups
      />
      <InputArea
        onSend={(value) => void send(value)}
        disabled={running}
        draftKey={chatKey}
        skills={skills}
        commandScope="all"
        builtinCommands={['/clear']}
        placeholder={t('configManager.placeholder')}
        disabledPlaceholder={t('configManager.executing')}
        tokenUsageMessages={tokenUsageMessages}
        agentKey="config_manager"
        workspace={workspace}
        floating
        onHeightChange={setInputAreaHeight}
      />
    </div>
  )
}

function parseToolOutput(output: unknown): Record<string, unknown> | null {
  if (typeof output === 'string') {
    const body = output.split('\n\n[Denova tool result metadata]')[0].trim()
    try {
      return parseToolOutput(JSON.parse(body))
    } catch {
      // Lore write receipts are human-readable text followed by an exact JSON ID line.
      const idsLine = body.split(/\r?\n/).find((line) => line.startsWith('item_ids: '))
      const itemIds = idsLine && parseItemIDs(idsLine.slice('item_ids: '.length))
      return itemIds ? { item_ids: itemIds } : null
    }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  return output as Record<string, unknown>
}

function parseItemIDs(value: unknown): string[] | undefined {
  let ids = value
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return undefined
  return ids
}

function parseChangeReceipt(output: Record<string, unknown> | null, workspace: string) {
  const receipt = parseToolOutput(output?.change_receipt) || output
  if (
    receipt?.schema !== 'workspace_change.tool_result.v1'
    || receipt.status !== 'applied'
    || receipt.workspace !== workspace
    || receipt.path !== 'setting/book-overview.md'
    || typeof receipt.change_group_id !== 'string'
    || typeof receipt.change_set_id !== 'string'
  ) return null
  return {
    path: receipt.path,
    change_group_id: receipt.change_group_id,
    change_set_id: receipt.change_set_id,
  }
}
