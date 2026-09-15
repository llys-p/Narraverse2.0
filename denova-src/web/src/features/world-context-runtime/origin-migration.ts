const MIGRATION_VERSION = 'narraverse-origin-migration/v1'
const MIGRATION_MAX_BYTES = 128 * 1024 * 1024
const MIGRATION_CHUNK_BYTES = 512 * 1024
const MIGRATION_PREFIXES = ['adventureAI_', 'narraverse:', 'og_ai_'] as const
const MIGRATION_MANIFEST_KEY = 'narraverse:origin-migration:manifest'

type MigrationPackage = {
  version: typeof MIGRATION_VERSION
  localStorage: Record<string, string>
  indexedDB: Array<[IDBValidKey, unknown]>
}

export type OriginMigrationResult = 'migrated' | 'empty' | 'target_conflict' | 'failed'

function openKVDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('adventureAI_db', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv')
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

async function narraverseDatabaseExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  if (typeof indexedDB.databases !== 'function') return true
  const databases = await indexedDB.databases()
  return databases.some((entry) => entry.name === 'adventureAI_db')
}

async function readKVEntries(): Promise<Array<[IDBValidKey, unknown]>> {
  if (!(await narraverseDatabaseExists())) return []
  const database = await openKVDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('kv', 'readonly')
    const store = transaction.objectStore('kv')
    const keys = store.getAllKeys()
    const values = store.getAll()
    transaction.oncomplete = () => {
      const entries = keys.result.map((key, index) => [key, values.result[index]] as [IDBValidKey, unknown])
      entries.sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      database.close()
      resolve(entries)
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error)
    }
  })
}

async function sourcePackage(): Promise<MigrationPackage> {
  const local: Record<string, string> = {}
  Object.keys(localStorage).sort().forEach((key) => {
    if (key !== MIGRATION_MANIFEST_KEY && MIGRATION_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      local[key] = localStorage.getItem(key) ?? ''
    }
  })
  return { version: MIGRATION_VERSION, localStorage: local, indexedDB: await readKVEntries() }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function migrationReceiverURL(): string {
  const url = new URL(window.location.href)
  url.hostname = 'localhost'
  url.pathname = '/narraverse/migration.html'
  url.search = `?host_origin=${encodeURIComponent(window.location.origin)}`
  url.hash = ''
  return url.toString()
}

export async function migrateNarraverseOrigin(): Promise<OriginMigrationResult> {
  const source = await sourcePackage()
  if (Object.keys(source.localStorage).length === 0 && source.indexedDB.length === 0) return 'empty'
  const bytes = new TextEncoder().encode(JSON.stringify(source))
  if (bytes.byteLength > MIGRATION_MAX_BYTES) return 'failed'
  const digest = await sha256Hex(bytes)

  return new Promise<OriginMigrationResult>((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.hidden = true
    iframe.setAttribute('aria-hidden', 'true')
    iframe.src = migrationReceiverURL()
    let settled = false
    const finish = (result: OriginMigrationResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      iframe.remove()
      resolve(result)
    }
    const timeout = window.setTimeout(() => finish('failed'), 15_000)
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== new URL(iframe.src).origin) return
      const data = event.data as { source?: string; version?: number; type?: string } | undefined
      if (!data || data.source !== 'narraverse-migration' || data.version !== 1 || data.type !== 'ready') return
      const channel = new MessageChannel()
      channel.port1.onmessage = (portEvent) => {
        const result = portEvent.data as { type?: string; digest?: string } | undefined
        channel.port1.close()
        if (result?.type === 'migration-complete' && result.digest === digest) finish('migrated')
        else if (result?.type === 'target-conflict') finish('target_conflict')
        else finish('failed')
      }
      iframe.contentWindow?.postMessage({
        source: 'denova', version: 1, type: 'migration-start',
        payload: { totalBytes: bytes.byteLength, chunks: Math.ceil(bytes.byteLength / MIGRATION_CHUNK_BYTES), digest },
      }, new URL(iframe.src).origin, [channel.port2])
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += MIGRATION_CHUNK_BYTES, index += 1) {
        const chunk = bytes.slice(offset, Math.min(offset + MIGRATION_CHUNK_BYTES, bytes.byteLength))
        channel.port1.postMessage({ type: 'migration-chunk', index, bytes: chunk.buffer }, [chunk.buffer])
      }
      channel.port1.postMessage({ type: 'migration-finish' })
    }
    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}

export const originMigrationContract = {
  version: MIGRATION_VERSION,
  maxBytes: MIGRATION_MAX_BYTES,
  chunkBytes: MIGRATION_CHUNK_BYTES,
  prefixes: MIGRATION_PREFIXES,
  manifestKey: MIGRATION_MANIFEST_KEY,
}
