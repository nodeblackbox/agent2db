import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendClient, RunStreams } from './api';
import { BackendProcess, generateToken, resolveLaunchSpec } from './backend';
import { DEV_CSP, PROD_CSP } from './csp';
import { findRepoRoot } from './repoRoot';
import {
  IPC,
  ValidationError,
  validateNumericId,
  validateQuery,
  validateResumeRunArgs,
  validateRunId,
  validateSessionId,
  validateStartRunArgs,
  validateTableName,
  type BackendStatus,
  type RunEventEnvelope,
  type WindowState,
} from '../shared/types';

const log = (msg: string): void => console.log(`[agent2db] ${msg}`);

const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
const rendererIndex = path.join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;
let backend: BackendProcess | null = null;
let client: BackendClient | null = null;
let status: BackendStatus = { state: 'starting' };
let healthTimer: NodeJS.Timeout | null = null;
let quitting = false;

const runStreams = new RunStreams(
  () => client,
  (env: RunEventEnvelope) => sendToRenderer(IPC.runEvent, env),
  log,
);

// ---------- renderer messaging ----------

function sendToRenderer(channel: string, payload: unknown): void {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

function setStatus(next: BackendStatus): void {
  status = next;
  sendToRenderer(IPC.statusChanged, status);
}

function windowState(): WindowState {
  return { maximized: mainWindow?.isMaximized() ?? false, focused: mainWindow?.isFocused() ?? true };
}

function sendWindowState(): void {
  sendToRenderer(IPC.windowState, windowState());
}

// ---------- backend lifecycle ----------

async function refreshHealth(): Promise<void> {
  if (!client) return;
  try {
    const health = await client.health();
    if (client) setStatus({ state: 'ready', health });
  } catch (e) {
    log(`health check failed: ${(e as Error).message}`);
  }
}

async function startBackend(): Promise<void> {
  setStatus({ state: 'starting' });
  const repoRoot = findRepoRoot(app.getAppPath(), existsSync, process.env.AGENT2DB_REPO_ROOT)
    ?? findRepoRoot(__dirname, existsSync);
  if (!repoRoot) {
    setStatus({ state: 'error', message: 'Could not locate the Agent2DB repository root. Set AGENT2DB_REPO_ROOT.' });
    return;
  }
  const token = generateToken();
  const spec = resolveLaunchSpec(repoRoot, token, process.env);
  const proc = new BackendProcess(spec, (stream, line) => console.log(`[backend:${stream}] ${line}`));
  backend = proc;
  proc.onUnexpectedExit = (message) => {
    if (backend !== proc) return;
    client = null;
    stopHealthPolling();
    runStreams.failAll('The backend stopped unexpectedly.');
    setStatus({ state: 'error', message });
  };
  try {
    const port = await proc.start();
    if (backend !== proc || quitting) {
      proc.stop();
      return;
    }
    client = new BackendClient(port, token);
    log(`backend ready on 127.0.0.1:${port}`);
    try {
      const health = await client.health();
      setStatus({ state: 'ready', health });
    } catch (e) {
      setStatus({ state: 'error', message: `Backend started but /health failed: ${(e as Error).message}` });
      return;
    }
    stopHealthPolling();
    healthTimer = setInterval(() => void refreshHealth(), 30_000);
  } catch (e) {
    if (backend !== proc) return;
    log(`backend failed: ${(e as Error).message}`);
    setStatus({ state: 'error', message: (e as Error).message });
  }
}

function stopHealthPolling(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function stopBackend(): void {
  stopHealthPolling();
  runStreams.stopAll();
  client = null;
  const proc = backend;
  backend = null;
  proc?.stop();
}

// ---------- IPC ----------

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const wc = mainWindow?.webContents;
  return !!wc && event.sender === wc && event.senderFrame === wc.mainFrame;
}

/** Register an invoke handler that rejects untrusted senders and validation errors cleanly. */
function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error('Unauthorized IPC sender');
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ValidationError) log(`IPC ${channel} rejected: ${e.message}`);
      // Re-throw a plain message; never include the token or headers.
      throw new Error((e as Error).message);
    }
  });
}

function requireClient(): BackendClient {
  if (!client) throw new Error('Backend is not ready.');
  return client;
}

function registerIpc(): void {
  handle(IPC.getStatus, () => status);

  handle(IPC.restartBackend, async (...args) => {
    if (args.length !== 0) throw new ValidationError('restartBackend takes no arguments');
    stopBackend();
    void startBackend();
  });

  handle(IPC.startRun, async (raw) => {
    const args = validateStartRunArgs(raw);
    const result = await requireClient().startRun(args);
    void runStreams.follow(result.runId);
    return result;
  });

  handle(IPC.resumeRun, async (raw) => {
    const args = validateResumeRunArgs(raw);
    const result = await requireClient().resumeRun(args);
    void runStreams.follow(args.runId);
    return result;
  });

  handle(IPC.cancelRun, async (raw) => requireClient().cancelRun(validateRunId(raw)));

  // Persisted data. Responses are validated into plain shapes by the client before they reach here.
  handle(IPC.listSessions, async () => requireClient().listSessions());
  handle(IPC.sessionHistory, async (raw) => requireClient().sessionHistory(validateSessionId(raw)));
  handle(IPC.deleteSession, async (raw) => requireClient().deleteSession(validateSessionId(raw)));
  handle(IPC.schemaTables, async () => requireClient().schemaTables());
  handle(IPC.schemaSearch, async (raw) => requireClient().schemaSearch(validateQuery(raw)));
  handle(IPC.schemaTable, async (raw) => requireClient().schemaTable(validateTableName(raw)));
  handle(IPC.schemaReindex, async () => requireClient().schemaReindex());
  handle(IPC.listFacts, async () => requireClient().listFacts());
  handle(IPC.deleteFact, async (raw) => requireClient().deleteFact(validateNumericId(raw)));
  handle(IPC.listSavedQueries, async () => requireClient().listSavedQueries());
  handle(IPC.deleteSavedQuery, async (raw) => requireClient().deleteSavedQuery(validateNumericId(raw)));
  handle(IPC.listApprovals, async () => requireClient().listApprovals());

  // Window controls for the frameless window.
  handle(IPC.windowMinimize, () => mainWindow?.minimize());
  handle(IPC.windowMaximize, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handle(IPC.windowClose, () => mainWindow?.close());
}

// ---------- window & security ----------

function isAppUrl(url: string): boolean {
  if (devServerUrl) return url.startsWith(new URL(devServerUrl).origin + '/');
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.normalize(fileURLToPath(u)) === path.normalize(rendererIndex);
  } catch {
    return false;
  }
}

function openExternalSafely(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      void shell.openExternal(u.toString());
    } else {
      log(`blocked external URL with protocol ${u.protocol}`);
    }
  } catch {
    log('blocked malformed external URL');
  }
}

function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const csp = devServerUrl ? DEV_CSP : PROD_CSP;
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: 'Agent2DB',
    backgroundColor: '#09090b',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', () => {
    log('renderer loaded');
    sendToRenderer(IPC.statusChanged, status);
    sendWindowState();
  });
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur'] as const) mainWindow.on(ev, sendWindowState);
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') log(`renderer ${e.level}: ${e.message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log(`renderer failed to load: ${code} ${desc}`));
  mainWindow.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason}`));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(rendererIndex);
  }
}

// ---------- app lifecycle ----------

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents));

  app.whenReady().then(() => {
    hardenSession();
    registerIpc();
    createWindow();
    void startBackend();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackend();
  });

  // Last-chance cleanup if the process exits some other way.
  process.on('exit', () => backend?.stop());
}
