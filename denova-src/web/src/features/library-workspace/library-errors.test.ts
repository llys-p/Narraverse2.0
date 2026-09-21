import { describe, expect, it } from 'vitest'
import { APIError } from '@/lib/api-client'
import {
  classifyWorkLibraryError,
  formatListInput,
  parseEventOrder,
  parseListInput,
  fieldsToRows,
  rowsToFields,
  shouldOfferReload,
  workLibraryErrorCode,
  workLibraryErrorImpact,
} from './library-errors'

// 错误分类决定“保留草稿 + 重新加载”还是普通报错，属于 L1.2 验收的关键路径，
// 因此用真实 APIError 直接覆盖，不做模块级 mock。

function apiError(status: number, body: Record<string, unknown>): APIError {
  const code = typeof body.code === 'string' ? body.code : undefined
  return new APIError(String(body.error ?? 'error'), { status, code, payload: body })
}

describe('classifyWorkLibraryError', () => {
  it('把带 code 的 409 revision_conflict 判为并发冲突', () => {
    const error = apiError(409, { error: '版本冲突', code: 'revision_conflict' })
    expect(workLibraryErrorCode(error)).toBe('revision_conflict')
    expect(classifyWorkLibraryError(error)).toBe('conflict')
    expect(shouldOfferReload(error)).toBe(true)
  })

  it('把无 code 的 409 也判为并发冲突（兼容旧服务端）', () => {
    expect(classifyWorkLibraryError(apiError(409, { error: 'conflict' }))).toBe('conflict')
  })

  it('item_in_use 不得被判成并发冲突', () => {
    // 这条最容易出错：都是 409，但前端不能自动重试，必须走影响确认流程。
    const error = apiError(409, { error: '条目仍被引用', code: 'item_in_use' })
    expect(classifyWorkLibraryError(error)).toBe('item_in_use')
    expect(shouldOfferReload(error)).toBe(false)
  })

  it('识别只读引用与其他业务拒绝', () => {
    expect(classifyWorkLibraryError(apiError(400, { error: 'x', code: 'reference_read_only' }))).toBe('reference_read_only')
    expect(classifyWorkLibraryError(apiError(400, { error: 'x', code: 'validation_failed' }))).toBe('validation')
    expect(classifyWorkLibraryError(apiError(404, { error: 'x', code: 'not_found' }))).toBe('not_found')
    expect(classifyWorkLibraryError(apiError(400, { error: 'x', code: 'duplicate_relation' }))).toBe('duplicate_relation')
    expect(classifyWorkLibraryError(apiError(400, { error: 'x', code: 'self_relation' }))).toBe('self_relation')
  })

  it('未知错误归为 unknown 而不是静默忽略', () => {
    expect(classifyWorkLibraryError(new Error('boom'))).toBe('unknown')
    expect(classifyWorkLibraryError(apiError(500, { error: 'x', code: 'library_invalid' }))).toBe('unknown')
  })
})

describe('workLibraryErrorImpact', () => {
  it('从 item_in_use 响应中取出影响明细', () => {
    const error = apiError(409, {
      error: '仍被引用',
      code: 'item_in_use',
      impact: {
        itemId: 'linchong',
        itemName: '林冲',
        relations: [{ id: 'rel-1', fromItemId: 'linchong', toItemId: 'luzhishen', kind: 'ally' }],
        events: [{ itemId: 'evt-1', title: '火并王伦' }],
      },
    })
    const impact = workLibraryErrorImpact(error)
    expect(impact?.itemName).toBe('林冲')
    expect(impact?.relations).toHaveLength(1)
    expect(impact?.events).toHaveLength(1)
  })

  it('没有 impact 时返回 null，不伪造空影响', () => {
    expect(workLibraryErrorImpact(apiError(409, { error: 'x', code: 'revision_conflict' }))).toBeNull()
    expect(workLibraryErrorImpact(new Error('x'))).toBeNull()
  })
})

describe('输入转换', () => {
  it('列表输入按中英文逗号/顿号/换行切分并去重去空', () => {
    expect(parseListInput('林冲, 鲁智深， 林冲、宋江\n  ')).toEqual(['林冲', '鲁智深', '宋江'])
    expect(parseListInput('')).toEqual([])
  })

  it('列表输出为逗号分隔文本，空值安全', () => {
    expect(formatListInput(['a', 'b'])).toBe('a, b')
    expect(formatListInput(null)).toBe('')
  })

  it('字段行与结构化字段可互相往返，空键被丢弃', () => {
    const rows = fieldsToRows({ weapon: '丈八蛇矛', camp: '' })
    expect(rows).toEqual([{ key: 'weapon', value: '丈八蛇矛' }, { key: 'camp', value: '' }])
    expect(rowsToFields(rows)).toEqual({ weapon: '丈八蛇矛', camp: '' })
    expect(rowsToFields([{ key: '  ', value: 'x' }])).toBeNull()
    expect(rowsToFields([])).toBeNull()
  })

  it('事件顺序解析为有界整数，非法输入不产生 NaN', () => {
    expect(parseEventOrder('3')).toBe(3)
    expect(parseEventOrder('-2')).toBe(-2)
    expect(parseEventOrder('abc')).toBe(0)
    expect(parseEventOrder('99999999')).toBe(1000000)
    expect(parseEventOrder('-99999999')).toBe(-1000000)
  })
})
