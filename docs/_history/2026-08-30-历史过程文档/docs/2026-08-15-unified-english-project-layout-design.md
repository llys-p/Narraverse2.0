# Narraverse Unified English Project Layout

## Goal

Place Narraverse, the Denova runtime, and the Denova source tree under one English-named root so launching, development, backup, and handoff no longer depend on scattered directories.

## Target Layout

```text
<project-root>\
├─ app\
├─ denova\
├─ denova-src\
├─ knowledge-base\
├─ tools\
├─ docs\
├─ Launch-Narraverse.cmd
├─ COLLABORATION_LOG.md
├─ CODE_GUIDE.md
└─ AI_COLLABORATION_GUIDE.md
```

## Rename Scope

- Rename the project root from `<external-text-adventure-project>` to `<project-root>`.
- Move `<external-denova-installation>` to `<project-root>\denova`.
- Move `<external-denova-source>` to `<project-root>\denova-src`.
- Rename structural project entries that are referenced by tools or maintainers:
  - `ai知识库` → `knowledge-base`
  - `启动叙界.cmd` → `Launch-Narraverse.cmd`
  - `项目协作日志.md` → `COLLABORATION_LOG.md`
  - `代码指南.md` → `CODE_GUIDE.md`
  - `AI协作规范提示词.md` → `AI_COLLABORATION_GUIDE.md`
- Keep user-facing role-card, lorebook, archive, and historical document filenames in Chinese. Their names are content titles and renaming them would damage display semantics and metadata links.

## Path Migration

- Replace active hard-coded `<external-text-adventure-project>` references with `<project-root>`.
- Replace active `<external-denova-source>` references with `<project-root>\denova-src`.
- Replace active `<external-denova-installation>` references with `<project-root>\denova`.
- Update launch scripts to resolve the Denova executable relative to the unified root instead of using a machine-specific absolute default.
- Update Denova `.denova\books.json` project paths after the runtime move.
- Update knowledge-base tools to use the renamed `knowledge-base` directory.
- Regenerate package-manager command shims after moving `denova-src`, because existing `node_modules\.bin` wrappers contain the old absolute source path.

## Migration Safety

- Stop if `<project-root>` already exists.
- Confirm all three source directories resolve exactly to the expected paths before moving.
- Move within drive `E:` so operations remain atomic directory renames where possible.
- Do not delete the installed frontend backup inside the Denova runtime.
- Verify file counts and key files after every move.
- If validation fails, move directories back to their original locations and restore rewritten path references from the migration backup manifest.

## Validation

- Parse `Launch-Narraverse.cmd` and `tools\start_narraverse.ps1` by executing the launcher in no-open mode.
- Run JavaScript syntax checks for Narraverse bridge/runtime files.
- Reinstall or relink Denova frontend dependencies, then run the existing targeted Narraverse tests and production build.
- Sync Narraverse static assets from `<project-root>\app` into `<project-root>\denova-src\web\public\narraverse`.
- Deploy the rebuilt frontend to `<project-root>\denova\web` while retaining the existing backup.
- Start the relocated Denova runtime and confirm `?mode=narraverse` responds from the release port.
- Search active code, scripts, guides, and skills for stale old absolute paths; historical logs may retain old paths as historical facts.

## Completion Criteria

- `<project-root>` is the only active project root.
- Both old Denova directories under `<external-tools-root>` no longer exist.
- Launching through `<project-root>\Launch-Narraverse.cmd` opens the relocated Denova runtime in Narraverse mode.
- Active scripts and documentation use the new English paths and filenames.
- Content-title filenames remain unchanged.
