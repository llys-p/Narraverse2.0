import type { TimelineCategory, TimelineCategoryWire } from './types'

export function normalizeTimelineCategory(value: TimelineCategoryWire | null | undefined): TimelineCategory {
  switch (value) {
    case 'historical':
      return 'historical'
    case 'planned':
      return 'planned'
    case 'background':
      return 'background'
    case 'canon':
      return 'historical'
    default:
      return 'background'
  }
}

export function timelineCategoryWarning(value: TimelineCategoryWire | null | undefined): 'canon' | 'unknown' | null {
  if (value === 'canon') return 'canon'
  if (value === null || value === undefined || value === '' || value === 'background' || value === 'historical' || value === 'planned') {
    return null
  }
  return 'unknown'
}
