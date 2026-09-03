# Narraverse 2.0

Narraverse 2.0 is a Denova-hosted creative platform with four user-facing modules:

1. Writing Mode — long-form writing.
2. Game Mode — structured interactive game flow.
3. Narraverse — conversational text adventure.
4. Open Sandbox — the independent Module4 open-sandbox runtime.

## Quick start on Windows

Install the following first:

- Python 3.10+
- Node.js 20+
- pnpm 8+
- Go 1.26.5+
- Git Bash (the `bash` command must be available)

Clone this private repository, then double-click `Launch-Narraverse.cmd`, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup_narraverse2.ps1
```

The setup entry point generates the local library, synchronizes Narraverse assets into the Denova web source, installs frontend dependencies, runs the existing Denova build script, starts the generated executable, and opens the local page. It does not modify system-wide PATH or create a second API configuration.

For a build-only/start-without-browser run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\setup_narraverse2.ps1 -NoOpen
```

Generated files are intentionally excluded from Git: `app/local_library.js`, `denova-src/web/public/narraverse/`, `denova-src/web/dist/`, `denova-src/output/`, and runtime data. They are recreated by the setup/build flow.

For static frontend inspection without the Denova host, generate the local library and serve `app/` on port 5174:

```powershell
python tools/gen_local_library_v2.py
python -m http.server 5174 --directory app
```

Open `http://127.0.0.1:5174/?mode=narraverse`. This mode does not provide the Denova Go backend or `/api/status`; use the setup script for the complete executable flow.

Port reminder: `5174` is the standalone static frontend, `5173` is the optional Denova Vite development frontend, and `8080` is the usual Denova backend/formal executable entry. If Denova reports another available port, use the printed URL. See `docs/交付/Narraverse2.0交接指南.md` for the complete port table and second-computer deployment checklist.

## Shared model settings

Open Denova's existing shared Settings page and enter the endpoint, model, and API key on each computer. Narraverse and Module4 use the shared `window.callLLM()` path and `state.apiConfig`; there is no Module4-specific API setting. A non-secret OpenAI-compatible example is `https://api.deepseek.com` with model `deepseek-v4-flash`. Never commit an API key or local runtime configuration.

## Repository map

- `app/` — Narraverse standalone frontend, including `app/module4/`.
- `denova-src/` — Denova frontend and Go backend source.
- `knowledge-base/` — source worldbooks and character cards.
- `tools/` — library generation, asset synchronization, setup, and validation helpers.
- `docs/` — architecture, plans, handoff notes, and delivery records.

The source materials remain separate from Module4 runtime state. Module4 stores its own world/runtime data in browser storage and reads source cards through the generated local library; it does not copy Module3's gameplay engine.

## Other AI and private repository access

The repository is private. An AI assistant or another computer must be granted access to `llys-p/Narraverse2.0` through the appropriate GitHub account or organization permission before cloning. Start by reading this README, `docs/交付/Narraverse2.0交接指南.md`, `DESIGN.md`, `代码指南.md`, `平台模块功能总览.md`, and the current delivery record under `docs/交付/`.

## Source-only delivery

This repository intentionally ships reproducible source rather than a precompiled Windows package. A network connection is required for dependency installation and Go modules on a new computer. See `docs/交付/Narraverse2.0交付清单.md` for the exact delivery scope and validation checklist.
