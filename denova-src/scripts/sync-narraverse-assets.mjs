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
  'app.js',
  'bridge.js',
  'game_engine.js',
  'local_library.js',
  'presets.js',
  'redesign.css',
  'stickman.js',
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

if (path.dirname(targetDirectory) !== publicDirectory || path.basename(targetDirectory) !== 'narraverse') {
  throw new Error(`拒绝同步到意外目录：${targetDirectory}`)
}

await stat(path.join(sourceDirectory, 'index.html'))
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

const indexHtml = await readFile(path.join(stagingDirectory, 'index.html'), 'utf8')
if (!indexHtml.includes('app.js') || !indexHtml.includes('bridge.js')) {
  throw new Error('叙界 index.html 缺少必要运行时脚本引用。')
}

await writeFile(path.join(stagingDirectory, 'narraverse-build.json'), `${JSON.stringify({
  source: 'Narraverse app runtime snapshot',
  syncedAt: new Date().toISOString(),
  files: copied,
}, null, 2)}\n`, 'utf8')

await rm(targetDirectory, { recursive: true, force: true })
await rename(stagingDirectory, targetDirectory)

console.log(`叙界静态资源已同步到 ${targetDirectory}`)
console.log(`已同步：${copied.join(', ')}`)
