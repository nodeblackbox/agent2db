# Frontend (Electron + TypeScript)

> Status: proposed (planning). Last updated 2026-10-02.

## Stack

| Concern | Choice |
|---|---|
| Package manager | pnpm workspaces |
| Build | electron-vite (Vite for main, preload, renderer) |
| UI | React + TypeScript |
| State | Zustand (client state) + TanStack Query (server state) |
| SQL editor | Monaco |
| Data grid | TanStack Table (virtualised) |
| API types | generated from backend OpenAPI into `packages/shared-types` |
| Packaging | electron-builder |
| Tests | Vitest (unit), Playwright for Electron (end-to-end) |

## Security baseline (non-negotiable)

The renderer displays LLM output and database contents, so it is treated as untrusted.

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- Preload exposes a small typed API via `contextBridge` — no raw `ipcRenderer`, no generic
  "invoke anything" channel. Every IPC handler validates its arguments.
- Strict Content-Security-Policy; no remote scripts; block `window.open` and navigation to
  external URLs (open them in the system browser instead).
- Render model output as sanitised Markdown; never `dangerouslySetInnerHTML` raw model text.
- Secrets stay in the main process (OS keychain via Electron `safeStorage`). The renderer never
  sees API keys or DB passwords; it only sees whether a key is set.
- Enable Electron fuses for production builds (disable `RunAsNode`, enable ASAR integrity).

## Main process responsibilities

- Spawn the Python backend with a random port and token; restart on crash; stop on quit.
- Proxy renderer requests to the backend (renderer never knows the token).
- Keychain read/write for provider keys and DB passwords.
- Auto-update (later).

## Screens (v1)

1. **Connections** — add a Postgres connection, test it, run role setup helper, build schema index.
2. **Chat** — streamed agent run with collapsible tool calls, SQL blocks, result grids, charts.
3. **Approval dialog** — exact SQL/command, affected-row estimate, approve / edit / reject.
4. **Schema browser** — tables, columns, keys; "ask about this table".
5. **Snippets & saved queries** — search, view, run, edit.
6. **Skills** — list, enable/disable, view SKILL.md.
7. **Settings** — providers and models, MCP servers (edit config with validation), budgets.

## Debugging

- DevTools in development only; React DevTools via electron-devtools-installer.
- Backend logs and run traces are viewable in an in-app "Run inspector" (from `run_events`).

## Open Questions

1. Component library: shadcn/ui + Tailwind, or Ant Design (as Chat2DB uses)?
2. Code signing for Windows/macOS before the first public build?
