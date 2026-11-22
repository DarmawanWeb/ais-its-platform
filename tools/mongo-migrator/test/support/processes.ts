import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** A free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A v2 service started from its built `dist/`. */
export interface RunningService {
  readonly name: string;
  readonly url: string;
  readonly logs: string[];
  stop(): Promise<void>;
}

/**
 * Starts `node <entry>` in `cwd` with `env` and waits until
 * `GET /health/ready` answers 200 (the kit's readiness: database and NATS).
 */
export async function startService(
  name: string,
  cwd: string,
  entry: string,
  env: Record<string, string>,
  port: number,
  timeoutMs = 120_000,
): Promise<RunningService> {
  const logs: string[] = [];
  const child: ChildProcess = spawn(
    process.execPath,
    ['--enable-source-maps', entry],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...env,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const keep = (chunk: Buffer) => {
    logs.push(chunk.toString('utf8'));
    if (logs.length > 200) logs.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const state: { exited?: number | null } = {};
  child.on('exit', (code) => {
    state.exited = code;
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (state.exited !== undefined)
      throw new Error(
        `${name} exited with ${String(state.exited)} during start:\n${logs.join('').slice(-4000)}`,
      );
    try {
      const response = await fetch(`${url}/health/ready`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `${name} not ready after ${timeoutMs} ms:\n${logs.join('').slice(-4000)}`,
      );
    }
    await sleep(500);
  }
  return {
    name,
    url,
    logs,
    stop: async () => {
      // A function, so that the compiler does not narrow the flag set by the exit handler.
      const running = () => state.exited === undefined;
      if (!running()) return;
      child.kill('SIGTERM');
      for (let waited = 0; waited < 10_000 && running(); waited += 100)
        await sleep(100);
      if (running()) child.kill('SIGKILL');
    },
  };
}

/**
 * Runs a command; resolves with its exit code and output (never rejects on a
 * non-zero exit). `signalWhen` sends a signal once stderr matches a pattern
 * (an operator pressing Ctrl+C at a known point of the run).
 */
export async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly signalWhen?: {
      readonly stderr: RegExp;
      readonly signal: NodeJS.Signals;
    };
  } = {},
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  signalled: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 300_000,
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      const trigger = options.signalWhen;
      if (trigger !== undefined && !signalled && trigger.stderr.test(stderr)) {
        signalled = true;
        child.kill(trigger.signal);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, signalled });
    });
  });
}
