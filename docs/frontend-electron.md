# Frontend (Electron + TypeScript)

> Status: proposed (planning). Last updated 2026-10-02.

## Stack

| Concern | Choice |
|---|---|
| Package manager | pnpm workspaces |
| Build | electron-vite (Vite for main, preload, renderer) |
| UI | React + TypeScript, Tailwind CSS v4, lucide-react icons (implemented) |
| State | A tested reducer for the chat (`renderer/src/state.ts`), React state for UI chrome; Zustand/TanStack Query not needed so far |
| SQL display | Own tokenizer + highlighter (`shared/sql.ts`), no Monaco yet |
| Data grid | Own sticky-header grid with numeric alignment, paging and CSV/JSON copy (`components/DataGrid.tsx`) |
| API types | hand-written validators in `shared/types.ts` (every backend payload is parsed before use) |
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

## Layout (implemented 2026-10-02)

Frameless window with a custom title bar, then: an icon rail (Chats, Schema, Tools & MCP, Memory,
Approvals, Settings), a collapsible chat list, the main area, and an optional right drawer
(Schema / Memory / Approvals tabs). Visual language follows the AgentHarness app: zinc dark
palette, rounded cards, 13px UI type, mono for identifiers.

## Screens

1. **Chat** (done) — user bubbles, streamed Markdown answers, tool cards. SQL cards show the verb,
   a one-line summary, the server tag, highlighted SQL with copy, and the result as a grid (NULLs
   muted, numbers right-aligned, "show more" paging, CSV/JSON copy) or text. Memory tool calls
   render as one-line notices; schema tool calls as collapsible cards.
2. **Approval** (done) — inline bar on the tool card: statement-type and table tags, the planner
   estimate, warnings, Approve and run / Reject with feedback. Reopening a chat that is waiting
   for approval restores the bar.
3. **Chat list** (done) — persisted sessions from the backend with age, turn count and cost;
   open (history replayed through the same reducer), new, delete, filter.
4. **Schema browser** (done, drawer + full panel) — all indexed tables, ranked search, table DDL,
   rebuild index.
5. **Memory** (done) — facts and saved queries with delete.
6. **Approvals** (done) — audit log of every write decision.
7. **Tools & MCP** (done) — servers with status and the tools each exposes.
8. **Settings** (done, read-only) — backend, model, fallbacks, store, checkpointer, schema index;
   restart backend. Editing `.env` from the UI is not implemented.
9. **Database** (done) — table list grouped by schema; Data tab with paging, column sorting and a
   WHERE filter; Structure tab (columns, keys, DDL); Query tab (read-only SQL, Ctrl+Enter, 500-row
   cap); Diagram tab (Mermaid ER diagram rendered in-app with zoom/pan, copy Mermaid source or SVG).
   "Ask the agent about this table" jumps to chat with a prompt.
10. **Documents (RAG)** (done) — add files via the OS picker or drag and drop, ingestion status
    with polling, chunk preview per document, a search box that shows what the agent would
    retrieve, delete, and the RAG switch (also on the composer). Uploads go renderer → main →
    backend; the renderer never sees file paths.
11. **Connections**, **Skills**, charts — not started.

## Browser preview

With no Electron preload present (plain browser at the Vite dev URL, `http://localhost:5173`
while `pnpm dev` runs), `renderer/src/devBridge.ts` installs a scripted `window.agent2db` with
demo sessions, a read run with a result grid and a write run that needs approval. Use it to
iterate on the UI and take screenshots without the backend. It is only imported in dev builds.

## Debugging

- DevTools in development only; React DevTools via electron-devtools-installer.
- Backend logs and run traces are viewable in an in-app "Run inspector" (from `run_events`).

## Open Questions

1. ~~Component library~~ Decided: Tailwind v4 with our own small primitives (no shadcn/Ant).
2. Code signing for Windows/macOS before the first public build?

## Running the desktop app (v1 scaffold)

Code lives in `apps/desktop` (electron-vite + React + TS). From the repo root:

| Command | What it does |
|---|---|
| `pnpm install` | Install workspace deps. If `apps/desktop/node_modules/electron/dist` is missing afterwards, run `node apps/desktop/node_modules/electron/install.js` (pnpm 10 may skip Electron's download script). |
| `pnpm dev` | Start the app in dev mode. Main spawns the backend with `uv run --project services/agent agent2db-backend` from the repo root. |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | TS check (main+preload and renderer configs), Vitest, production build to `apps/desktop/out`. |

Run against the mock backend (no Python needed): `AGENT2DB_BACKEND_CMD=mock pnpm dev` in Git Bash, or
`$env:AGENT2DB_BACKEND_CMD='mock'; pnpm dev` in PowerShell. The mock is
`apps/desktop/scripts/mock-backend.mjs`. It streams a run that does a read tool call, then asks for
approval of an `UPDATE`. Include "fail" in a message to get a failed run.

Environment variables read by the main process:

- `AGENT2DB_BACKEND_CMD=mock`: use the mock backend instead of `uv`.
- `AGENT2DB_REPO_ROOT`: override the repo root used as the backend's cwd. By default it is the
  nearest ancestor of the app that contains `pnpm-workspace.yaml`.

The backend gets `AGENT2DB_PORT=0` and a fresh `AGENT2DB_TOKEN` on every launch. It has to print
`{"ready": true, "port": N}` within 90 s. Main keeps the token and does all HTTP and SSE work. The
renderer only sees `window.agent2db` (see `Agent2DbApi` in `shared/types.ts`): backend status,
runs (`startRun`, `resumeRun`, `cancelRun`, `onRunEvent`), sessions (`listSessions`,
`sessionHistory`, `deleteSession`), schema (`schemaTables`, `schemaSearch`, `schemaTable`,
`schemaReindex`), memory (`listFacts`, `deleteFact`, `listSavedQueries`, `deleteSavedQuery`),
`listApprovals`, and window controls for the frameless window. Every argument is validated in
main and every response is parsed into a plain shape before it reaches the renderer. On quit,
main kills the backend's process tree (`taskkill /T /F` on Windows).

Not done yet: Electron fuses and packaging (electron-builder), keychain storage, connection
management, skills, charts, Monaco.
