import type { FileNode } from '@/hooks/useWorkspace'
import type { BookRecord, WorkspaceSummary } from '@/lib/api'

export function flattenFileTree(nodes: FileNode[], basePath = ''): string[] {
  return nodes.flatMap((node) => {
    const path = basePath ? `${basePath}/${node.name}` : node.name
    if (node.type === 'file') return [path]
    return flattenFileTree(node.children || [], path)
  })
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function resolveCurrentBookName(
  workspace: string,
  books: BookRecord[],
  summary: WorkspaceSummary | null,
  fallbackLabel: string,
) {
  return books.find((book) => book.path === workspace)?.name?.trim() ||
    summary?.title?.trim() ||
    workspace.replace(/\/+$/, '').split('/').pop() ||
    fallbackLabel
}
