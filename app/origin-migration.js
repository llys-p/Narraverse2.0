(function () {
  'use strict';

  var VERSION = 'narraverse-origin-migration/v1';
  var MAX_BYTES = 128 * 1024 * 1024;
  var MAX_CHUNK = 512 * 1024;
  var PREFIXES = ['adventureAI_', 'narraverse:', 'og_ai_'];
  var MANIFEST_KEY = 'narraverse:origin-migration:manifest';
  var params = new URLSearchParams(location.search);
  var hostOrigin = params.get('host_origin') || '';

  function validHostOrigin(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === location.port && url.origin === value;
    } catch (_) {
      return false;
    }
  }

  function openStore() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('adventureAI_db', 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv');
      };
      request.onerror = function () { reject(request.error); };
      request.onsuccess = function () { resolve(request.result); };
    });
  }

  function databaseExists() {
    if (typeof indexedDB.databases !== 'function') return Promise.resolve(true);
    return indexedDB.databases().then(function (items) {
      return items.some(function (item) { return item.name === 'adventureAI_db'; });
    });
  }

  function readEntries() {
    return databaseExists().then(function (exists) {
      if (!exists) return [];
      return openStore().then(function (database) {
        return new Promise(function (resolve, reject) {
          var store = database.transaction('kv', 'readonly').objectStore('kv');
          var keys = store.getAllKeys();
          var values = store.getAll();
          var left = 2;
          function done() {
            left -= 1;
            if (left) return;
            var entries = keys.result.map(function (key, index) { return [key, values.result[index]]; });
            entries.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
            database.close();
            resolve(entries);
          }
          keys.onsuccess = done;
          values.onsuccess = done;
          keys.onerror = values.onerror = function () { database.close(); reject(keys.error || values.error); };
        });
      });
    });
  }

  function putEntries(entries) {
    return openStore().then(function (database) {
      return new Promise(function (resolve, reject) {
        var tx = database.transaction('kv', 'readwrite');
        var store = tx.objectStore('kv');
        entries.forEach(function (entry) { store.put(entry[1], entry[0]); });
        tx.oncomplete = function () { database.close(); resolve(); };
        tx.onerror = function () { database.close(); reject(tx.error); };
      });
    });
  }

  function deleteEntries(entries) {
    if (!entries.length) return Promise.resolve();
    return openStore().then(function (database) {
      return new Promise(function (resolve) {
        var tx = database.transaction('kv', 'readwrite');
        var store = tx.objectStore('kv');
        entries.forEach(function (entry) { store.delete(entry[0]); });
        tx.oncomplete = tx.onerror = function () { database.close(); resolve(); };
      });
    });
  }

  function hasTargetData() {
    var local = Object.keys(localStorage).some(function (key) {
      return key === MANIFEST_KEY || PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; });
    });
    if (local) return Promise.resolve(true);
    return readEntries().then(function (entries) { return entries.length > 0; });
  }

  function sourceShape(pkg) {
    var local = {};
    Object.keys(pkg.localStorage || {}).sort().forEach(function (key) { local[key] = localStorage.getItem(key); });
    return readEntries().then(function (entries) {
      return { version: pkg.version, localStorage: local, indexedDB: entries };
    });
  }

  function sha256Hex(bytes) {
    var copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return crypto.subtle.digest('SHA-256', copy.buffer).then(function (digest) {
      return Array.from(new Uint8Array(digest), function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    });
  }

  if (!validHostOrigin(hostOrigin) || parent === window) return;

  window.addEventListener('message', function (event) {
    if (event.source !== parent || event.origin !== hostOrigin || !event.ports[0]) return;
    var message = event.data || {};
    if (message.source !== 'denova' || message.version !== 1 || message.type !== 'migration-start') return;
    var meta = message.payload || {};
    var port = event.ports[0];
    if (!Number.isInteger(meta.totalBytes) || meta.totalBytes < 1 || meta.totalBytes > MAX_BYTES ||
        !Number.isInteger(meta.chunks) || meta.chunks < 1 || typeof meta.digest !== 'string') {
      port.postMessage({ type: 'migration-failed' });
      return;
    }
    hasTargetData().then(function (occupied) {
      if (occupied) {
        port.postMessage({ type: 'target-conflict' });
        return;
      }
      var chunks = [];
      var received = 0;
      var next = 0;
      port.onmessage = function (portEvent) {
        var part = portEvent.data || {};
        if (part.type === 'migration-chunk') {
          var bytes = new Uint8Array(part.bytes || new ArrayBuffer(0));
          if (part.index !== next || bytes.byteLength > MAX_CHUNK || received + bytes.byteLength > meta.totalBytes) {
            port.postMessage({ type: 'migration-failed' });
            port.close();
            return;
          }
          chunks.push(bytes); received += bytes.byteLength; next += 1;
          return;
        }
        if (part.type !== 'migration-finish' || received !== meta.totalBytes || next !== meta.chunks) return;
        var merged = new Uint8Array(received);
        var offset = 0;
        chunks.forEach(function (chunk) { merged.set(chunk, offset); offset += chunk.byteLength; });
        sha256Hex(merged).then(function (actualDigest) {
          if (actualDigest !== meta.digest) throw new Error('digest mismatch');
          var pkg = JSON.parse(new TextDecoder().decode(merged));
          if (!pkg || pkg.version !== VERSION || typeof pkg.localStorage !== 'object' || !Array.isArray(pkg.indexedDB)) {
            throw new Error('invalid package');
          }
          localStorage.setItem(MANIFEST_KEY, JSON.stringify({ version: VERSION, state: 'incomplete' }));
          Object.keys(pkg.localStorage).forEach(function (key) {
            if (!PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; }) || key === MANIFEST_KEY) throw new Error('invalid key');
            localStorage.setItem(key, String(pkg.localStorage[key]));
          });
          return putEntries(pkg.indexedDB).then(function () { return sourceShape(pkg); }).then(function (written) {
            var verifyBytes = new TextEncoder().encode(JSON.stringify(written));
            return sha256Hex(verifyBytes).then(function (writtenDigest) {
              if (writtenDigest !== meta.digest) throw new Error('write verification failed');
              localStorage.setItem(MANIFEST_KEY, JSON.stringify({
                version: VERSION, state: 'complete', digest: writtenDigest,
                localKeys: Object.keys(pkg.localStorage).length, indexedKeys: pkg.indexedDB.length,
              }));
              port.postMessage({ type: 'migration-complete', digest: writtenDigest });
              port.close();
            });
          });
        }).catch(function () {
          var pkg;
          try { pkg = JSON.parse(new TextDecoder().decode((function () {
            var all = new Uint8Array(received); var at = 0;
            chunks.forEach(function (chunk) { all.set(chunk, at); at += chunk.byteLength; }); return all;
          }()))); } catch (_) { pkg = { localStorage: {}, indexedDB: [] }; }
          Object.keys(pkg.localStorage || {}).forEach(function (key) { localStorage.removeItem(key); });
          deleteEntries(Array.isArray(pkg.indexedDB) ? pkg.indexedDB : []).then(function () {
            localStorage.removeItem(MANIFEST_KEY);
            port.postMessage({ type: 'migration-failed' });
            port.close();
          });
        });
      };
    }).catch(function () { port.postMessage({ type: 'migration-failed' }); });
  });

  parent.postMessage({ source: 'narraverse-migration', version: 1, type: 'ready' }, hostOrigin);
}());
