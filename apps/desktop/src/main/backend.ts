/**
 * Spawns and supervises the Python agent backend (or the mock backend).
 * Deliberately free of Electron imports so it can be exercised from Vitest.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { LineSplitter, parseReadyLine } from '../shared/readyLine';

export const READY_TIMEOUT_MS = 90_000;

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Decide what to run. `AGENT2DB_BACKEND_CMD=mock` runs the Node mock backend;
 * anything else runs the real backend through uv. The token and port=0 are the
 * only additions to the inherited environment; no secrets are passed from here.
 */
export function resolveLaunchSpec(repoRoot: string, token: string, baseEnv: NodeJS.ProcessEnv): LaunchSpec {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    AGENT2DB_PORT: '0',
    AGENT2DB_TOKEN: token,
    PYTHONUNBUFFERED: '1',
  };
  if (baseEnv.AGENT2DB_BACKEND_CMD === 'mock') {
    return {
      command: 'node',
      args: [path.join('apps', 'desktop', 'scripts', 'mock-backend.mjs')],
      cwd: repoRoot,
      env,
      label: 'mock backend',
    };
  }
  return {
    command: 'uv',
    args: ['run', '--project', 'services/agent', 'agent2db-backend'],
    cwd: repoRoot,
    env,
    label: 'uv backend',
  };
}

export type LogFn = (stream: 'stdout' | 'stderr' | 'info', line: string) => void;

export class BackendProcess {
  private child: ChildProcess | null = null;
  private stopping = false;
  private recentStderr: string[] = [];
  /** Called if the process exits after it became ready. */
  onUnexpectedExit: ((message: string) => void) | null = null;

  constructor(
    private readonly spec: LaunchSpec,
    private readonly log: LogFn,
    private readonly readyTimeoutMs = READY_TIMEOUT_MS,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn and resolve with the port from the ready line. Rejects on timeout, spawn error or early exit. */
  start(): Promise<number> {
    if (this.child) return Promise.reject(new Error('backend already started'));
    this.stopping = false;
    this.recentStderr = [];
    const { command, args, cwd, env, label } = this.spec;
    this.log('info', `starting ${label}: ${command} ${args.join(' ')} (cwd ${cwd})`);

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const settle = (err: Error | null, port?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.stop();
          reject(err);
        } else {
          resolve(port as number);
        }
      };

      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // On POSIX put the backend in its own process group so we can kill the tree.
        detached: process.platform !== 'win32',
      });
      this.child = child;

      const timer = setTimeout(() => {
        settle(new Error(`Backend did not report ready within ${Math.round(this.readyTimeoutMs / 1000)}s.${this.stderrTail()}`));
      }, this.readyTimeoutMs);

      const out = new LineSplitter();
      const err = new LineSplitter();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        for (const line of out.feed(chunk)) {
          const info = !ready ? parseReadyLine(line) : null;
          if (info) {
            ready = true;
            this.log('info', `ready line parsed: port ${info.port}`);
            settle(null, info.port);
          } else if (line.trim().length > 0) {
            this.log('stdout', line);
          }
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        for (const line of err.feed(chunk)) {
          if (line.trim().length === 0) continue;
          this.recentStderr.push(line);
          if (this.recentStderr.length > 8) this.recentStderr.shift();
          this.log('stderr', line);
        }
      });
      // Writes to stdin after exit raise EPIPE; ignore.
      child.stdin?.on('error', () => undefined);

      child.on('error', (e: NodeJS.ErrnoException) => {
        const hint = e.code === 'ENOENT' ? ` ('${command}' not found on PATH)` : '';
        settle(new Error(`Failed to start backend: ${e.message}${hint}`));
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        const msg = `Backend exited (${signal ? `signal ${signal}` : `code ${code}`}).${this.stderrTail()}`;
        if (!settled) {
          settle(new Error(msg));
        } else if (!this.stopping) {
          this.log('info', msg);
          this.onUnexpectedExit?.(msg);
        }
      });
    });
  }

  /** Kill the backend and its whole process tree. Synchronous so it is safe during app quit. */
  stop(): void {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    this.stopping = true;
    const pid = child.pid;
    this.log('info', `stopping backend (pid ${pid})`);
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch (e) {
      this.log('info', `failed to stop backend: ${(e as Error).message}`);
    }
    this.child = null;
  }

  private stderrTail(): string {
    if (this.recentStderr.length === 0) return '';
    const tail = this.recentStderr.slice(-5).join('\n');
    return `\n${tail.length > 800 ? tail.slice(-800) : tail}`;
  }
}
