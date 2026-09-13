import type { TimelineCategory, TimelineCategoryWire } from './types'

export type TimelineCategoryWarning = 'canon' | 'unknown'
export type TimelineCategoryLabelKey = TimelineCategory | 'legacyCanon' | 'legacyUnknown'

const WRITABLE_TIMELINE_CATEGORIES = ['background', 'historical', 'planned'] as const satisfies readonly TimelineCategory[]

/** New and explicitly edited entries may only use the current three values. */
export function isWritableTimelineCategory(value: unknown): value is TimelineCategory {
  return typeof value === 'string' && WRITABLE_TIMELINE_CATEGORIES.includes(value as TimelineCategory)
}

/**
 * Normalizes only the value used by the UI. Callers must keep the original
 * wire value when saving so legacy and empty forms remain lossless.
 */
export function normalizeTimelineCategory(value: TimelineCategoryWire | null | undefined): TimelineCategory {
  if (value === 'canon') return 'historical'
  return isWritableTimelineCategory(value) ? value : 'background'
}

/** Returns the i18n suffix for the raw value's display label. */
export function timelineCategoryLabelKey(value: TimelineCategoryWire | null | undefined): TimelineCategoryLabelKey {
  if (value === 'canon') return 'legacyCanon'
  if (isWritableTimelineCategory(value)) return value
  if (value === null || value === undefined || value === '') return 'background'
  return 'legacyUnknown'
}

export function timelineCategoryWarning(value: TimelineCategoryWire | null | undefined): TimelineCategoryWarning | null {
  switch (timelineCategoryLabelKey(value)) {
    case 'legacyCanon':
      return 'canon'
    case 'legacyUnknown':
      return 'unknown'
    default:
      return null
  }
}
