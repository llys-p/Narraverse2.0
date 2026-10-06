import { describe, expect, it } from 'vitest'
import type { LoreItem } from '@/lib/api'
import { KNOWLEDGE_SECTIONS, sectionItems } from './knowledge-sections'

const people = [
 { id: 'hero', name: '主角', type: 'character', character_tier: 'major', importance: 'minor', load_mode: 'manual' },
 { id: 'guest', name: '配角', type: 'character', character_tier: 'minor', load_mode: 'resident' },
 { id: 'old', name: '旧人物', type: 'character', importance: 'major', load_mode: 'auto' },
 { id: 'place', name: '旧城', type: 'location', load_mode: 'auto' },
] as LoreItem[]

describe('character directory tiers', () => {
 it('partitions all characters once without inferring importance or load mode', () => {
  const sections = KNOWLEDGE_SECTIONS.filter((section) => section.createType === 'character')
  expect(sections).toHaveLength(3)
  expect(sections.map((section) => sectionItems(people, section).map((item) => item.id))).toEqual([['hero'], ['guest'], ['old']])
  expect(sections[1].defaultCollapsed).toBe(true)
  expect(sections[0].defaultCollapsed).toBe(false)
 })
 it('composes tier grouping with search and existing loading filters without mutation', () => {
  const before = JSON.stringify(people)
  const primary = KNOWLEDGE_SECTIONS.find((section) => section.characterTier === 'major')!
  const secondary = KNOWLEDGE_SECTIONS.find((section) => section.characterTier === 'minor')!
  expect(sectionItems(people, primary, '主角', 'on_demand').map((item) => item.id)).toEqual(['hero'])
  expect(sectionItems(people, primary, '', 'resident')).toEqual([])
  expect(sectionItems(people, secondary, '', 'resident').map((item) => item.id)).toEqual(['guest'])
  expect(JSON.stringify(people)).toBe(before)
 })
})
