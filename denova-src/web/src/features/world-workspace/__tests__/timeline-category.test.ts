import { describe, expect, it } from 'vitest'
import { normalizeTimelineCategory, timelineCategoryWarning } from '../timeline-category'

describe('timeline-category compatibility', () => {
  it.each([
    ['background', 'background'],
    ['historical', 'historical'],
    ['planned', 'planned'],
    ['canon', 'historical'],
    ['legacy-value', 'background'],
    ['', 'background'],
    [null, 'background'],
    [undefined, 'background'],
  ] as const)('normalizes %s for display as %s', (value, expected) => {
    expect(normalizeTimelineCategory(value)).toBe(expected)
  })

  it('marks only legacy non-empty values with a warning', () => {
    expect(timelineCategoryWarning('canon')).toBe('canon')
    expect(timelineCategoryWarning('legacy-value')).toBe('unknown')
    expect(timelineCategoryWarning(null)).toBeNull()
    expect(timelineCategoryWarning(undefined)).toBeNull()
    expect(timelineCategoryWarning('background')).toBeNull()
  })
})
