import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertSafeLocalLibraryAsset } from './check-narraverse-local-library.mjs'

async function publicDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narraverse-build-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('build accepts an absent Narraverse snapshot', async (t) => {
  const root = await publicDirectory(t)
  await assert.doesNotReject(assertSafeLocalLibraryAsset(root, false))
})

test('public build accepts only the empty local library', async (t) => {
  const root = await publicDirectory(t)
  const target = path.join(root, 'narraverse')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<script src="local_library.js"></script>')
  await writeFile(path.join(target, 'local_library.js'), 'window.LOCAL_LIBRARY = { books: [], cards: [] };\n')
  await assert.doesNotReject(assertSafeLocalLibraryAsset(root, false))
})

test('public build rejects a stale private library without reading it into the error', async (t) => {
  const root = await publicDirectory(t)
  const target = path.join(root, 'narraverse')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<script src="local_library.js"></script>')
  await writeFile(path.join(target, 'local_library.js'), 'PRIVATE_SENTINEL')
  await assert.rejects(assertSafeLocalLibraryAsset(root, false), (error) => {
    assert.match(error.message, /sync:narraverse/)
    assert.equal(error.message.includes('PRIVATE_SENTINEL'), false)
    return true
  })
})

test('public build also rejects a stray private library without an index page', async (t) => {
  const root = await publicDirectory(t)
  const target = path.join(root, 'narraverse')
  await mkdir(target)
  await writeFile(path.join(target, 'local_library.js'), 'PRIVATE_SENTINEL')
  await assert.rejects(assertSafeLocalLibraryAsset(root, false), /sync:narraverse/)
})

test('private build requires explicit opt-in and a local library file', async (t) => {
  const root = await publicDirectory(t)
  const target = path.join(root, 'narraverse')
  await mkdir(target)
  await writeFile(path.join(target, 'index.html'), '<script src="local_library.js"></script>')
  await assert.rejects(assertSafeLocalLibraryAsset(root, true), /local_library\.js/)
  await writeFile(path.join(target, 'local_library.js'), 'PRIVATE_SENTINEL')
  await assert.doesNotReject(assertSafeLocalLibraryAsset(root, true))
})
