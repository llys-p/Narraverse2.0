import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('./sync-narraverse-assets.mjs', import.meta.url))
const entries = [
  'ai-client.js', 'app.js', 'bridge.js', 'migration.html', 'origin-migration.js',
  'game_engine.js', 'presets.js', 'redesign.css', 'stickman.js', 'style.css',
  'theme-neutral.css',
]

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'narraverse-sync-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const script = path.join(root, 'denova-src', 'scripts', 'sync-narraverse-assets.mjs')
  const target = path.join(root, 'denova-src', 'web', 'public', 'narraverse')
  await mkdir(path.dirname(script), { recursive: true })
  await mkdir(source, { recursive: true })
  await copyFile(scriptPath, script)
  await writeFile(path.join(source, 'index.html'), '<script src="app.js"></script><script src="bridge.js"></script>')
  for (const name of entries) await writeFile(path.join(source, name), `/* ${name} */`)
  for (const name of ['module4', 'avatars', 'packs']) {
    const directory = path.join(source, name)
    await mkdir(directory)
    await writeFile(path.join(directory, 'fixture.txt'), name)
  }
  return { source, script, target }
}

function sync({ source, script }, includeLocalLibrary) {
  return spawnSync(process.execPath, [script, source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NARRAVERSE_SOURCE_DIR: '',
      NARRAVERSE_INCLUDE_LOCAL_LIBRARY: includeLocalLibrary ? '1' : '',
    },
  })
}

test('public sync builds a clean checkout with an empty local library', async (t) => {
  const paths = await fixture(t)
  const result = sync(paths, false)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    await readFile(path.join(paths.target, 'local_library.js'), 'utf8'),
    'window.LOCAL_LIBRARY = { books: [], cards: [] };\n',
  )
  const manifest = JSON.parse(await readFile(path.join(paths.target, 'narraverse-build.json'), 'utf8'))
  assert.equal(manifest.localLibraryMode, 'empty')
})

test('public sync replaces a previously private staged library', async (t) => {
  const paths = await fixture(t)
  await mkdir(paths.target, { recursive: true })
  await writeFile(path.join(paths.target, 'local_library.js'), 'PRIVATE_OLD_CONTENT')
  const result = sync(paths, false)
  assert.equal(result.status, 0, result.stderr)
  const output = await readFile(path.join(paths.target, 'local_library.js'), 'utf8')
  assert.equal(output, 'window.LOCAL_LIBRARY = { books: [], cards: [] };\n')
  assert.equal(output.includes('PRIVATE_OLD_CONTENT'), false)
})

test('private local library is copied only on explicit opt-in', async (t) => {
  const paths = await fixture(t)
  await writeFile(path.join(paths.source, 'local_library.js'), 'window.LOCAL_LIBRARY = { books: ["PRIVATE_TEST"] };\n')
  const result = sync(paths, true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    await readFile(path.join(paths.target, 'local_library.js'), 'utf8'),
    'window.LOCAL_LIBRARY = { books: ["PRIVATE_TEST"] };\n',
  )
  const manifest = JSON.parse(await readFile(path.join(paths.target, 'narraverse-build.json'), 'utf8'))
  assert.equal(manifest.localLibraryMode, 'private')
})

test('public sync ignores a private source file even when it exists', async (t) => {
  const paths = await fixture(t)
  await writeFile(path.join(paths.source, 'local_library.js'), 'PRIVATE_SOURCE_CONTENT')
  const result = sync(paths, false)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    await readFile(path.join(paths.target, 'local_library.js'), 'utf8'),
    'window.LOCAL_LIBRARY = { books: [], cards: [] };\n',
  )
})

test('private opt-in without a source fails without replacing the existing target', async (t) => {
  const paths = await fixture(t)
  await mkdir(paths.target, { recursive: true })
  await writeFile(path.join(paths.target, 'sentinel.txt'), 'existing target')
  const result = sync(paths, true)
  assert.notEqual(result.status, 0)
  assert.equal(await readFile(path.join(paths.target, 'sentinel.txt'), 'utf8'), 'existing target')
})
