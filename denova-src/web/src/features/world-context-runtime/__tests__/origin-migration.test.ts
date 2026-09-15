import { beforeEach, describe, expect, it } from 'vitest'
import { migrateNarraverseOrigin, originMigrationContract } from '../origin-migration'

describe('origin migration sender', () => {
  beforeEach(() => localStorage.clear())

  it('does not create a receiver or storage when the approved source set is empty', async () => {
    await expect(migrateNarraverseOrigin()).resolves.toBe('empty')
    expect(document.querySelector('iframe[src*="migration.html"]')).toBeNull()
  })

  it('freezes the approved prefixes, cap, chunk size, and manifest key', () => {
    expect(originMigrationContract.prefixes).toEqual(['adventureAI_', 'narraverse:', 'og_ai_'])
    expect(originMigrationContract.maxBytes).toBe(128 * 1024 * 1024)
    expect(originMigrationContract.chunkBytes).toBe(512 * 1024)
    expect(originMigrationContract.manifestKey).toBe('narraverse:origin-migration:manifest')
  })
})
