import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const emptyLocalLibrary = 'window.LOCAL_LIBRARY = { books: [], cards: [] };\n'

// A direct Vite build must not silently publish a previously staged private library.
export async function assertSafeLocalLibraryAsset(publicDirectory, includePrivate) {
  const narraverseDirectory = path.join(publicDirectory, 'narraverse')
  let localLibrary
  try {
    localLibrary = await readFile(path.join(narraverseDirectory, 'local_library.js'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await stat(path.join(narraverseDirectory, 'index.html'))
      } catch (indexError) {
        if (indexError.code === 'ENOENT') return // No embedded Narraverse snapshot in this build.
        throw indexError
      }
      throw new Error('叙界资源缺少 local_library.js；请先运行 sync:narraverse')
    }
    throw error
  }
  if (!includePrivate && localLibrary !== emptyLocalLibrary) {
    throw new Error('拒绝公开构建：叙界资源含本地资料；请先运行 sync:narraverse（默认生成空库）')
  }
}
