//go:build windows

package securityprobe

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestC0LoopbackOriginIsolation is an isolated browser proof for the Phase
// 3.2-C0 design. It deliberately does not use production handlers or user
// browser profiles. The fixture proves the trust primitive before production
// routes exist: 127.0.0.1 host + HttpOnly SameSite=Strict cookie versus a
// localhost iframe on the same listener and port.
func TestC0LoopbackOriginIsolation(t *testing.T) {
	edge := edgePath(t)
	secret := randomToken(t)
	sessionToken := randomToken(t)
	reportNonce := randomToken(t)

	type report struct {
		HashCleared          bool   `json:"hashCleared"`
		SecondBootstrap403   bool   `json:"secondBootstrap403"`
		CookieHiddenFromJS   bool   `json:"cookieHiddenFromJS"`
		ReloadSessionActive  bool   `json:"reloadSessionActive"`
		FrameAActiveBefore   bool   `json:"frameAActiveBefore"`
		FrameBActiveBefore   bool   `json:"frameBActiveBefore"`
		FrameARevoked        bool   `json:"frameARevoked"`
		FrameBStillActive    bool   `json:"frameBStillActive"`
		FrameOrigin          string `json:"frameOrigin"`
		ParentAccessBlocked  bool   `json:"parentAccessBlocked"`
		HostLocalStorageGone bool   `json:"hostLocalStorageGone"`
		HostIndexedDBGone    bool   `json:"hostIndexedDBGone"`
		FrameCookieEmpty     bool   `json:"frameCookieEmpty"`
		FrameLocalGone       bool   `json:"frameLocalGone"`
		FrameIndexedDBGone   bool   `json:"frameIndexedDBGone"`
		MigrationLSCopied    bool   `json:"migrationLSCopied"`
		MigrationIDBCopied   bool   `json:"migrationIDBCopied"`
		MigrationSourceKept  bool   `json:"migrationSourceKept"`
		MigrationSkipped     bool   `json:"migrationUnrelatedSkipped"`
		MigrationDigestMatch bool   `json:"migrationDigestMatch"`
		MigrationTargetEmpty bool   `json:"migrationTargetStartedEmpty"`
		RestartInvalidated   bool   `json:"restartInvalidated"`
	}

	var (
		mu                   sync.Mutex
		secretUsed           bool
		sessions             = map[string]bool{}
		bindings             = map[string]map[string]bool{}
		frameDirectSeen      bool
		frameDirectHadCookie bool
		frameDirectOrigin    string
		receivedReport       report
		reportDone           = make(chan struct{}, 1)
	)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	hostOrigin := fmt.Sprintf("http://127.0.0.1:%d", port)
	frameOrigin := fmt.Sprintf("http://localhost:%d", port)

	sessionHash := func(raw string) string {
		sum := sha256.Sum256([]byte(raw))
		return hex.EncodeToString(sum[:])
	}
	validSession := func(r *http.Request) (string, bool) {
		if r.Header.Get("Origin") != hostOrigin {
			return "", false
		}
		cookie, cookieErr := r.Cookie("denova_host_session")
		if cookieErr != nil {
			return "", false
		}
		hash := sessionHash(cookie.Value)
		mu.Lock()
		defer mu.Unlock()
		return hash, sessions[hash]
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/host", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(strings.NewReplacer(
			"__HOST_ORIGIN__", hostOrigin,
			"__FRAME_ORIGIN__", frameOrigin,
			"__REPORT_NONCE__", reportNonce,
		).Replace(hostPage)))
	})
	mux.HandleFunc("/frame", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(strings.NewReplacer(
			"__HOST_ORIGIN__", hostOrigin,
		).Replace(framePage)))
	})
	mux.HandleFunc("/api/world-context/host/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Host != fmt.Sprintf("127.0.0.1:%d", port) || r.Header.Get("Origin") != hostOrigin {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		var body struct {
			Secret string `json:"secret"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
			http.Error(w, "invalid_request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		if secretUsed || body.Secret != secret {
			mu.Unlock()
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		secretUsed = true
		hash := sessionHash(sessionToken)
		sessions[hash] = true
		bindings[hash] = map[string]bool{}
		mu.Unlock()
		http.SetCookie(w, &http.Cookie{
			Name:     "denova_host_session",
			Value:    sessionToken,
			Path:     "/api/world-context/host",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("/api/world-context/host/bind", func(w http.ResponseWriter, r *http.Request) {
		hash, ok := validSession(r)
		if !ok {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		var body struct {
			Frame string `json:"frame"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Frame == "" {
			http.Error(w, "invalid_request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		bindings[hash][body.Frame] = true
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/world-context/host/revoke", func(w http.ResponseWriter, r *http.Request) {
		hash, ok := validSession(r)
		if !ok {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		var body struct {
			Frame string `json:"frame"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		delete(bindings[hash], body.Frame)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/world-context/host/call", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == frameOrigin {
			mu.Lock()
			frameDirectSeen = true
			frameDirectOrigin = r.Header.Get("Origin")
			_, cookieErr := r.Cookie("denova_host_session")
			frameDirectHadCookie = cookieErr == nil
			mu.Unlock()
		}
		hash, ok := validSession(r)
		if !ok {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		var body struct {
			Frame string `json:"frame"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		active := bindings[hash][body.Frame]
		mu.Unlock()
		if !active {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/world-context/host/simulate-restart", func(w http.ResponseWriter, r *http.Request) {
		_, ok := validSession(r)
		if !ok {
			http.Error(w, "consumer_not_trusted", http.StatusForbidden)
			return
		}
		mu.Lock()
		sessions = map[string]bool{}
		bindings = map[string]map[string]bool{}
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/report", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-C0-Report") != reportNonce {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&receivedReport); err != nil {
			http.Error(w, "bad report", http.StatusBadRequest)
			return
		}
		select {
		case reportDone <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	})

	server := &http.Server{Handler: mux}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})

	profile := t.TempDir()
	cmd := exec.Command(edge,
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--user-data-dir="+profile,
		fmt.Sprintf("%s/host#denova-host-bootstrap=%s", hostOrigin, secret),
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start Edge: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	})

	select {
	case <-reportDone:
	case <-time.After(25 * time.Second):
		t.Fatal("timed out waiting for browser security report")
	}

	mu.Lock()
	directSeen := frameDirectSeen
	directCookie := frameDirectHadCookie
	directOrigin := frameDirectOrigin
	mu.Unlock()

	checks := map[string]bool{
		"fragment cleared":                        receivedReport.HashCleared,
		"one-time secret rejects reuse":           receivedReport.SecondBootstrap403,
		"HttpOnly cookie hidden from host JS":     receivedReport.CookieHiddenFromJS,
		"session survives top-level reload":       receivedReport.ReloadSessionActive,
		"frame A initially active":                receivedReport.FrameAActiveBefore,
		"frame B initially active":                receivedReport.FrameBActiveBefore,
		"revoke isolates frame A":                 receivedReport.FrameARevoked,
		"revoke preserves frame B":                receivedReport.FrameBStillActive,
		"cross-origin parent access blocked":      receivedReport.ParentAccessBlocked,
		"host localStorage absent in frame":       receivedReport.HostLocalStorageGone,
		"host IndexedDB absent in frame":          receivedReport.HostIndexedDBGone,
		"host cookie absent in frame JS":          receivedReport.FrameCookieEmpty,
		"frame localStorage absent in host":       receivedReport.FrameLocalGone,
		"frame IndexedDB absent in host":          receivedReport.FrameIndexedDBGone,
		"allowlisted localStorage migrated":       receivedReport.MigrationLSCopied,
		"Narraverse IndexedDB migrated":           receivedReport.MigrationIDBCopied,
		"migration preserves source data":         receivedReport.MigrationSourceKept,
		"migration skips unrelated storage":       receivedReport.MigrationSkipped,
		"migration aggregate digest matches":      receivedReport.MigrationDigestMatch,
		"migration target started empty":          receivedReport.MigrationTargetEmpty,
		"process restart invalidates session":     receivedReport.RestartInvalidated,
		"iframe direct privileged call observed":  directSeen,
		"iframe direct call omitted host cookie":  !directCookie,
		"iframe direct call carried frame origin": directOrigin == frameOrigin,
	}
	for name, ok := range checks {
		if !ok {
			t.Errorf("C0 proof failed: %s", name)
		}
	}
	if receivedReport.FrameOrigin != frameOrigin {
		t.Errorf("frame origin = %q, want %q", receivedReport.FrameOrigin, frameOrigin)
	}
}

func edgePath(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	t.Skip("Microsoft Edge is not installed")
	return ""
}

func randomToken(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("random token: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

const hostPage = `<!doctype html><meta charset="utf-8"><script>
const hostOrigin = '__HOST_ORIGIN__';
const frameOrigin = '__FRAME_ORIGIN__';
const reportNonce = '__REPORT_NONCE__';
const api = '/api/world-context/host/';
const allowedPrefixes = ['adventureAI_', 'narraverse:', 'og_ai_'];
const openStore = (name) => new Promise((resolve, reject) => {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
  };
  open.onerror = () => reject(open.error);
  open.onsuccess = () => resolve(open.result);
});
const idbRead = async (name, key) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
};
const idbWrite = async (name, key, value) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
};
const idbEntries = async (name) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const store = db.transaction('kv', 'readonly').objectStore('kv');
    const keys = store.getAllKeys();
    const values = store.getAll();
    let left = 2;
    const done = () => {
      if (--left) return;
      const entries = keys.result.map((key, index) => [key, values.result[index]]);
      entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      db.close(); resolve(entries);
    };
    keys.onsuccess = done; values.onsuccess = done;
    keys.onerror = values.onerror = () => { db.close(); reject(keys.error || values.error); };
  });
};
const digest = async (value) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
};
const migrationSource = async () => {
  const local = {};
  Object.keys(localStorage).sort().forEach((key) => {
    if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) local[key] = localStorage.getItem(key);
  });
  return {version:'narraverse-origin-migration/v1', localStorage:local, indexedDB:await idbEntries('adventureAI_db')};
};
const runMigration = () => new Promise((resolve, reject) => {
  const iframe = document.createElement('iframe');
  iframe.src = frameOrigin + '/frame';
  const timeout = setTimeout(() => reject(new Error('migration timeout')), 10000);
  const onMessage = async (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== frameOrigin || !event.data || event.data.type !== 'migration-ready') return;
    window.removeEventListener('message', onMessage);
    const source = await migrationSource();
    const sourceDigest = await digest(source);
    const channel = new MessageChannel();
    channel.port1.onmessage = async ({data}) => {
      clearTimeout(timeout); iframe.remove(); channel.port1.close();
      const sourceAfter = await migrationSource();
      resolve(Object.assign({}, data.payload, {
        migrationDigestMatch:data.digest === sourceDigest,
        migrationSourceKept:JSON.stringify(sourceAfter) === JSON.stringify(source)
      }));
    };
    iframe.contentWindow.postMessage({type:'migration-package', payload:source}, frameOrigin, [channel.port2]);
  };
  window.addEventListener('message', onMessage);
  document.body.appendChild(iframe);
});
const post = (path, body) => fetch(api + path, {
  method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body || {})
});

(async () => {
  const phase = new URLSearchParams(location.search).get('phase');
  if (!phase) {
    const secret = new URLSearchParams(location.hash.slice(1)).get('denova-host-bootstrap') || '';
    history.replaceState(null, '', '/host?phase=initial');
    localStorage.setItem('c0-host-only', 'host');
    localStorage.setItem('adventureAI_state', '{"chapter":7}');
    localStorage.setItem('narraverse:module4:state', '{"clock":12}');
    localStorage.setItem('og_ai_demo', 'legacy');
    localStorage.setItem('do-not-migrate', 'private');
    await idbWrite('c0-origin-probe', 'host', 'host');
    await idbWrite('adventureAI_db', 'state', {chapter:7});
    await idbWrite('adventureAI_db', 'state_bak', {chapter:6});
    await idbWrite('adventureAI_db', 'conversationArchive:v1:demo:meta', {turns:3});
    const migration = await runMigration();
    const first = await post('bootstrap', {secret});
    const second = await post('bootstrap', {secret});
    const a = await post('bind', {frame:'frame-a'});
    const b = await post('bind', {frame:'frame-b'});
    const callA = await post('call', {frame:'frame-a'});
    const callB = await post('call', {frame:'frame-b'});
    await post('revoke', {frame:'frame-a'});
    const revokedA = await post('call', {frame:'frame-a'});
    const activeB = await post('call', {frame:'frame-b'});
    sessionStorage.setItem('c0-initial', JSON.stringify(Object.assign({}, migration, {
      hashCleared: location.hash === '',
      secondBootstrap403: first.ok && second.status === 403,
      cookieHiddenFromJS: !document.cookie.includes('denova_host_session='),
      frameAActiveBefore: a.ok && callA.ok,
      frameBActiveBefore: b.ok && callB.ok,
      frameARevoked: revokedA.status === 403,
      frameBStillActive: activeB.ok
    })));
    location.replace('/host?phase=reload');
    return;
  }
  const result = JSON.parse(sessionStorage.getItem('c0-initial') || '{}');
  result.reloadSessionActive = (await post('call', {frame:'frame-b'})).ok;
  result.frameLocalGone = localStorage.getItem('c0-frame-only') === null;
  result.frameIndexedDBGone = (await idbRead('c0-origin-probe', 'frame')) === undefined;
  await post('simulate-restart', {});
  result.restartInvalidated = (await post('call', {frame:'frame-b'})).status === 403;
  await fetch('/report', {
    method:'POST', headers:{'Content-Type':'application/json','X-C0-Report':reportNonce}, body:JSON.stringify(result)
  });
})().catch(async (error) => {
  await fetch('/report', {
    method:'POST', headers:{'Content-Type':'application/json','X-C0-Report':reportNonce},
    body:JSON.stringify({fatal:String(error && error.message || error)})
  });
});
</script>`

const framePage = `<!doctype html><meta charset="utf-8"><script>
const hostOrigin = '__HOST_ORIGIN__';
const allowedPrefixes = ['adventureAI_', 'narraverse:', 'og_ai_'];
const openStore = (name) => new Promise((resolve, reject) => {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
  };
  open.onerror = () => reject(open.error);
  open.onsuccess = () => resolve(open.result);
});
const idbRead = async (name, key) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
};
const idbWrite = async (name, key, value) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
};
const idbEntries = async (name) => {
  const db = await openStore(name);
  return new Promise((resolve, reject) => {
    const store = db.transaction('kv', 'readonly').objectStore('kv');
    const keys = store.getAllKeys();
    const values = store.getAll();
    let left = 2;
    const done = () => {
      if (--left) return;
      const entries = keys.result.map((key, index) => [key, values.result[index]]);
      entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      db.close(); resolve(entries);
    };
    keys.onsuccess = done; values.onsuccess = done;
    keys.onerror = values.onerror = () => { db.close(); reject(keys.error || values.error); };
  });
};
const digest = async (value) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
};

(async () => {
  let parentAccessBlocked = false;
  try { void parent.document.body; } catch (_) { parentAccessBlocked = true; }
  const hostLocalStorageGone = localStorage.getItem('c0-host-only') === null;
  const hostIndexedDBGone = (await idbRead('c0-origin-probe', 'host')) === undefined;
  parent.postMessage({type:'migration-ready'}, hostOrigin);
  window.addEventListener('message', async (event) => {
    if (event.source !== parent || event.origin !== hostOrigin || !event.data || event.data.type !== 'migration-package' || !event.ports[0]) return;
    const port = event.ports[0];
    const source = event.data.payload;
    const existingLocal = Object.keys(localStorage).some((key) => allowedPrefixes.some((prefix) => key.startsWith(prefix)));
    const existingIDB = (await idbEntries('adventureAI_db')).length > 0;
    const targetStartedEmpty = !existingLocal && !existingIDB;
    if (!targetStartedEmpty) throw new Error('target not empty');
    Object.entries(source.localStorage).forEach(([key, value]) => localStorage.setItem(key, value));
    for (const [key, value] of source.indexedDB) await idbWrite('adventureAI_db', key, value);
    const targetLocal = {};
    Object.keys(localStorage).sort().forEach((key) => {
      if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) targetLocal[key] = localStorage.getItem(key);
    });
    const target = {version:source.version, localStorage:targetLocal, indexedDB:await idbEntries('adventureAI_db')};
    localStorage.setItem('c0-frame-only', 'frame');
    await idbWrite('c0-origin-probe', 'frame', 'frame');
    await fetch(hostOrigin + '/api/world-context/host/call', {
      method:'POST', credentials:'include', headers:{'Content-Type':'text/plain'}, body:'frame-b'
    }).catch(() => {});
    port.postMessage({
      digest:await digest(target),
      payload:{
        frameOrigin:location.origin,
        parentAccessBlocked,
        hostLocalStorageGone,
        hostIndexedDBGone,
        frameCookieEmpty:!document.cookie.includes('denova_host_session='),
        migrationLSCopied:JSON.stringify(target.localStorage) === JSON.stringify(source.localStorage),
        migrationIDBCopied:JSON.stringify(target.indexedDB) === JSON.stringify(source.indexedDB),
        migrationUnrelatedSkipped:localStorage.getItem('do-not-migrate') === null,
        migrationTargetStartedEmpty:targetStartedEmpty
      }
    });
  }, {once:true});
})().catch((error) => parent.postMessage({type:'migration-failed',message:String(error && error.message || error)}, hostOrigin));
</script>`
