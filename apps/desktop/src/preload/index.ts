/**
 * Preload: exposes a small, typed API on `window.agent2db`. No raw ipcRenderer, no generic
 * invoke channel. Callbacks receive only payloads (never the IpcRendererEvent).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type Agent2DbApi, type BackendStatus, type RunEventEnvelope, type WindowState } from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: Agent2DbApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  restartBackend: () => ipcRenderer.invoke(IPC.restartBackend),
  onStatus: (cb) => subscribe<BackendStatus>(IPC.statusChanged, cb),
  startRun: (args) => ipcRenderer.invoke(IPC.startRun, args),
  resumeRun: (runId, decision, feedback) => ipcRenderer.invoke(IPC.resumeRun, { runId, decision, feedback }),
  cancelRun: (runId) => ipcRenderer.invoke(IPC.cancelRun, runId),
  onRunEvent: (cb) => subscribe<RunEventEnvelope>(IPC.runEvent, cb),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  sessionHistory: (sessionId) => ipcRenderer.invoke(IPC.sessionHistory, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  schemaTables: () => ipcRenderer.invoke(IPC.schemaTables),
  schemaSearch: (query) => ipcRenderer.invoke(IPC.schemaSearch, query),
  schemaTable: (name) => ipcRenderer.invoke(IPC.schemaTable, name),
  schemaReindex: () => ipcRenderer.invoke(IPC.schemaReindex),
  listFacts: () => ipcRenderer.invoke(IPC.listFacts),
  deleteFact: (id) => ipcRenderer.invoke(IPC.deleteFact, id),
  listSavedQueries: () => ipcRenderer.invoke(IPC.listSavedQueries),
  deleteSavedQuery: (id) => ipcRenderer.invoke(IPC.deleteSavedQuery, id),
  listApprovals: () => ipcRenderer.invoke(IPC.listApprovals),
  listDocuments: () => ipcRenderer.invoke(IPC.listDocuments),
  uploadDocumentsDialog: () => ipcRenderer.invoke(IPC.uploadDocumentsDialog),
  uploadDocument: (payload) => ipcRenderer.invoke(IPC.uploadDocument, payload),
  documentDetail: (id) => ipcRenderer.invoke(IPC.documentDetail, id),
  deleteDocument: (id) => ipcRenderer.invoke(IPC.deleteDocument, id),
  searchDocuments: (query) => ipcRenderer.invoke(IPC.searchDocuments, query),
  setRag: (enabled) => ipcRenderer.invoke(IPC.setRag, enabled),
  dbRows: (query) => ipcRenderer.invoke(IPC.dbRows, query),
  dbQuery: (sql) => ipcRenderer.invoke(IPC.dbQuery, sql),
  dbErd: () => ipcRenderer.invoke(IPC.dbErd),
  windowMinimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  windowMaximize: () => ipcRenderer.invoke(IPC.windowMaximize),
  windowClose: () => ipcRenderer.invoke(IPC.windowClose),
  onWindowState: (cb) => subscribe<WindowState>(IPC.windowState, cb),
};

contextBridge.exposeInMainWorld('agent2db', api);
