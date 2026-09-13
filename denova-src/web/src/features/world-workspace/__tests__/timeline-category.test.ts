import { describe, expect, it } from 'vitest'
import {
  isWritableTimelineCategory,
  normalizeTimelineCategory,
  timelineCategoryLabelKey,
  timelineCategoryWarning,
} from '../timeline-category'
import type { TimelineCategoryWire } from '../types'

describe('timeline-category compatibility', () => {
  it.each([
    ['background', 'background', 'background', null],
    ['historical', 'historical', 'historical', null],
    ['planned', 'planned', 'planned', null],
    ['canon', 'historical', 'legacyCanon', 'canon'],
    ['legacy-value', 'background', 'legacyUnknown', 'unknown'],
    ['', 'background', 'background', null],
    [null, 'background', 'background', null],
    [undefined, 'background', 'background', null],
  ] as const)('maps %s to its display contract', (value, category, labelKey, warning) => {
    expect(normalizeTimelineCategory(value)).toBe(category)
    expect(timelineCategoryLabelKey(value)).toBe(labelKey)
    expect(timelineCategoryWarning(value)).toBe(warning)
  })

  it.each([
    ['background', true],
    ['historical', true],
    ['planned', true],
    ['canon', false],
    ['legacy-value', false],
    ['', false],
    [null, false],
    [undefined, false],
  ] as const)('allows only the three current categories for writes: %s', (value, expected) => {
    expect(isWritableTimelineCategory(value)).toBe(expected)
  })

  it('derives display data without changing the raw category value', () => {
    const rawValue = 'canon'

    expect(normalizeTimelineCategory(rawValue)).toBe('historical')
    expect(rawValue).toBe('canon')
  })

  it('treats a missing category field as ordinary background', () => {
    const entry: { category?: TimelineCategoryWire | null } = {}

    expect(normalizeTimelineCategory(entry.category)).toBe('background')
    expect(timelineCategoryLabelKey(entry.category)).toBe('background')
    expect(timelineCategoryWarning(entry.category)).toBeNull()
  })
})
