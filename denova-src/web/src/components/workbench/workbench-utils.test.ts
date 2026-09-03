import { describe, expect, it } from 'vitest'
import { resolveCurrentBookName } from './workbench-utils'

describe('resolveCurrentBookName', () => {
  it('prefers the active bookshelf record over a stale summary title', () => {
    expect(resolveCurrentBookName(
      '/books/current',
      [{ name: '真实书名', path: '/books/current', author: '', last_opened_at: '' }],
      { title: '旧摘要标题', author: '', chapter_count: 0, chapters: [], chapter_plans: [], total_words: 0 },
      '未命名',
    )).toBe('真实书名')
  })

  it('falls back to the workspace basename when the shelf record is missing', () => {
    expect(resolveCurrentBookName(
      '/books/current',
      [],
      null,
      '未命名',
    )).toBe('current')
  })
})
