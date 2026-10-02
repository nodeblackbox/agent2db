/**
 * Preload: exposes a small, typed API on `window.agent2db`. No raw ipcRenderer, no generic
 * invoke channel. Callbacks receive only payloads (never the IpcRendererEvent).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type Agent2DbApi, type BackendStatus, type RunEventEnvelope } from '../shared/types';

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
};

contextBridge.exposeInMainWorld('agent2db', api);
