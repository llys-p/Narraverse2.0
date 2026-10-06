import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const publicDirectory = path.resolve(repositoryRoot, 'web', 'public')
const targetDirectory = path.resolve(publicDirectory, 'narraverse')
const stagingDirectory = path.resolve(publicDirectory, '.narraverse-sync')
const sourceDirectory = path.resolve(process.env.NARRAVERSE_SOURCE_DIR || process.argv[2] || '')
const runtimeEntries = [
  'index.html',
  'ai-client.js',
  'app.js',
  'bridge.js',
  'book-context.js',
  'migration.html',
  'origin-migration.js',
  'game_engine.js',
  'presets.js',
  'redesign.css',
  'stickman.js',
  'stickman_actions.js',
  'stickman_stage.js',
  'style.css',
  'theme-neutral.css',
  'module4',
  'avatars',
  'packs',
]

if (!process.env.NARRAVERSE_SOURCE_DIR && !process.argv[2]) {
  console.error('请通过 NARRAVERSE_SOURCE_DIR 或首个参数指定叙界 app 目录。')
  process.exit(1)
}

const localLibraryOption = process.env.NARRAVERSE_INCLUDE_LOCAL_LIBRARY || ''
if (localLibraryOption !== '' && localLibraryOption !== '0' && localLibraryOption !== '1') {
  throw new Error('NARRAVERSE_INCLUDE_LOCAL_LIBRARY 只接受 0 或 1')
}
const includeLocalLibrary = localLibraryOption === '1'

if (path.dirname(targetDirectory) !== publicDirectory || path.basename(targetDirectory) !== 'narraverse') {
  throw new Error(`拒绝同步到意外目录：${targetDirectory}`)
}

await stat(path.join(sourceDirectory, 'index.html'))
if (includeLocalLibrary) await stat(path.join(sourceDirectory, 'local_library.js'))
await rm(stagingDirectory, { recursive: true, force: true })
await mkdir(stagingDirectory, { recursive: true })

const copied = []
for (const entry of runtimeEntries) {
  const source = path.join(sourceDirectory, entry)
  const target = path.join(stagingDirectory, entry)
  await stat(source)
  await cp(source, target, { recursive: true })
  copied.push(entry)
}

if (includeLocalLibrary) {
  await cp(path.join(sourceDirectory, 'local_library.js'), path.join(stagingDirectory, 'local_library.js'))
} else {
  await writeFile(
    path.join(stagingDirectory, 'local_library.js'),
    'window.LOCAL_LIBRARY = { books: [], cards: [] };\n',
    'utf8',
  )
}
copied.push('local_library.js')

const indexHtml = await readFile(path.join(stagingDirectory, 'index.html'), 'utf8')
if (!indexHtml.includes('app.js') || !indexHtml.includes('bridge.js')) {
  throw new Error('叙界 index.html 缺少必要运行时脚本引用。')
}

const missingReferences = []
for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1].split('?')[0].split('#')[0]
  if (!reference || /^(?:https?:|data:|about:|mailto:|javascript:|\/\/)/i.test(reference)) continue
  try {
    await stat(path.join(stagingDirectory, reference))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    missingReferences.push(reference)
  }
}
if (missingReferences.length) {
  throw new Error(`叙界页面引用了 ${missingReferences.length} 个未同步的文件，请补齐 runtimeEntries：${missingReferences.join(', ')}`)
}

await writeFile(path.join(stagingDirectory, 'narraverse-build.json'), `${JSON.stringify({
  source: 'Narraverse app runtime snapshot',
  syncedAt: new Date().toISOString(),
  files: copied,
  localLibraryMode: includeLocalLibrary ? 'private' : 'empty',
}, null, 2)}\n`, 'utf8')

await rm(targetDirectory, { recursive: true, force: true })
await rename(stagingDirectory, targetDirectory)

console.log(`叙界静态资源已同步到 ${targetDirectory}`)
console.log(`已同步：${copied.join(', ')}`)
