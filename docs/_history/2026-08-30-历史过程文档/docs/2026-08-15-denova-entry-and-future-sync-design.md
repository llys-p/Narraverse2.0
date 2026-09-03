# Denova Entry and Future Narraverse Sync Design

## Goal

Make Denova the only normal entry point for Narraverse, start required local bridge services before opening the UI, and synchronize data created after this feature without migrating legacy Narraverse adventures.

## Scope

- Existing adventures without a sync identifier remain local-only and are never migrated automatically.
- Adventures created after this feature receive a stable sync identifier and participate in synchronization automatically.
- Shared data includes title, adventure setup, player identity, character cards, lorebooks, plot summary, generated novel chapters, and Denova-readable setting documents.
- Narraverse-only runtime data remains local: conversation history, combat state, UI state, snapshots, branches, API credentials, and transient generation state.

## Entry Flow

`Launch-Narraverse.cmd` remains the user-facing entry and calls `tools/start_narraverse.ps1`.

The PowerShell preflight performs these steps in order:

1. Resolve every executable and script relative to `<project-root>`.
2. Probe the Denova data bridge on `127.0.0.1:8097`.
3. Start `tools/denova_bridge.py` hidden when the health endpoint is unavailable, with logs written under `tools/logs/`.
4. Probe the Pixiv bridge on `127.0.0.1:8098`; start it only when `pixiv_config.json` exists and `pixivpy3` imports successfully.
5. Start Denova when no Denova process is running.
6. Detect the actual Denova frontend port in `8080..8090` and open `/?mode=narraverse`.

An unavailable optional Pixiv bridge does not block entry. An unavailable Denova data bridge is reported but does not prevent playing; synchronization status becomes retryable in the UI.

## Adventure Sync Identity

New adventures add:

```js
syncMeta: {
  id: "stable-uuid",
  enabled: true,
  projectName: "",
  lastPushAt: "",
  lastPullAt: "",
  lastRemoteRevision: "",
  status: "pending|synced|error",
  error: ""
}
```

Legacy adventures have no `syncMeta` and remain untouched.

The bridge stores a durable index at `denova/.denova/narraverse-sync-index.json`, mapping the stable sync ID to one Denova project directory. Renaming an adventure changes its display title but not its mapped directory.

## Bridge API

### Health

`GET /api/denova/health`

Returns bridge version, Denova data-root availability, and synchronization capability.

### Push

`POST /api/denova/sync`

Accepts the stable sync ID and the bounded shared-data payload. It creates the Denova project on first push, then updates managed files on later pushes.

Managed files:

- `.narraverse/sync.json`
- `CREATOR.md`
- `setting/world.md`
- `setting/outline.md`
- `setting/character-states.md`
- `chapters/v00001-第一卷/*.md`
- `.denova/lore/items.json`

Before overwriting an existing managed file, the bridge writes the previous copy under `.narraverse/backups/`.

### Pull

`GET /api/denova/sync?id=<sync-id>`

Returns only the shared fields and a remote revision hash. The bridge reads the managed Denova files so edits made in Denova can flow back into Narraverse.

## Frontend Sync Flow

- `createAdventure()` assigns `syncMeta` only to newly created adventures, saves locally first, then schedules the first push.
- `saveState()` never performs network work directly. A separate debounced sync scheduler observes the current synced adventure and pushes at most once per short quiet period.
- Adventure switching, iframe visibility restoration, and explicit retry trigger a pull.
- Pull applies only when the remote revision differs from `lastRemoteRevision`.
- Sync failure never blocks local saves or gameplay. The adventure keeps an error status and can retry later.
- Existing manual “导出 Denova” remains available for legacy adventures and explicit full exports.

## Conflict Rule

Synchronization uses last-write-wins per managed shared section, based on bridge revisions and timestamps. Every overwritten remote managed file receives a backup first. Narraverse-only fields are never replaced by a pull.

## Compatibility

- No automatic scan, conversion, or upload of existing Narraverse adventures.
- Existing Denova projects remain registered and unchanged.
- The standalone Narraverse shell remains a compatibility path, but normal use enters through Denova and therefore does not require configuring a frontend URL.
- The old `POST /api/denova/export`, project listing, lore loading, and knowledge-base import endpoints remain available.

## Validation

- Preflight starts only missing services and does not create duplicate Python or Denova processes.
- With 8097 stopped, the launcher starts it and health returns HTTP 200.
- With Pixiv unavailable, Denova and Narraverse still open normally.
- A newly created adventure creates one mapped Denova project and receives `synced` status.
- Repeated saves update the same project rather than creating duplicates.
- Editing a managed Denova chapter and returning to Narraverse updates the linked generated chapter.
- An old adventure without `syncMeta` produces no automatic bridge request.
- Targeted frontend tests, Python tests, JavaScript syntax checks, i18n checks, production build, and actual installed-runtime HTTP checks pass.

## Completion Criteria

- Users launch only `<project-root>\Launch-Narraverse.cmd` and enter Narraverse from Denova.
- Required bridge startup is automatic and duplicate-safe.
- Future adventures synchronize shared data in both directions.
- Legacy adventure data remains untouched.
