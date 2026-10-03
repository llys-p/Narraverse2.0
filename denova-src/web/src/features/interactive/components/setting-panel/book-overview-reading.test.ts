import { describe, expect, it } from 'vitest'
import { parseOverview } from './book-overview-reading'

describe('book overview reading projection', () => {
  it('preserves every introductory paragraph and nested heading', () => {
    const view = parseOverview('# 标题\n\n> 一句话\n\n第二段不可丢\n\n### 补充\n第三段\n\n## 世界概况\n正文')
    expect(view.title).toBe('标题')
    expect(view.lede).toBe('> 一句话\n\n第二段不可丢\n\n### 补充\n第三段')
    expect(view.blocks).toEqual([{ heading: '世界概况', body: '正文' }])
  })

  it('recognizes a starting section and preserves repeated unknown sections', () => {
    expect(parseOverview('## 其他\r\n第一段\r\n## 其他\r\n第二段').blocks).toEqual([
      { heading: '其他', body: '第一段' }, { heading: '其他', body: '第二段' },
    ])
  })

  it('does not treat fenced Markdown examples as sections', () => {
    const example = '```md\n## 假标题\n示例\n```'
    const view = parseOverview(example + '\n## 真标题\n实际正文')
    expect(view.lede).toBe(example)
    expect(view.blocks).toEqual([{ heading: '真标题', body: '实际正文' }])
  })
})
