import { spawn } from 'node:child_process';

/** The fleet importer's own report (`pnpm registry:import`, `RegistryImportReport`). */
export interface RegistryImportReport {
  readonly read: number;
  readonly inserted: number;
  readonly updated: number;
  readonly rejected: number;
  readonly rejections: readonly {
    readonly index: number;
    readonly reason: string;
  }[];
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs the fleet service's own registry importer (the owning service keeps
 * the SecondaryShip mapping and writes with its own role): the command of
 * `FLEET_REGISTRY_IMPORT_CMD` with `{file}` replaced by the NDJSON export
 * (or the file appended when there is no placeholder), e.g.
 * `docker compose exec -T fleet node dist/registry-import.js /dev/stdin < {file}`
 * or `node ../services/fleet/dist/registry-import.js {file}`. The importer
 * logs its report as a pino JSON line.
 */
export async function runRegistryImport(
  command: string,
  file: string,
  timeoutMs = 15 * 60_000,
): Promise<RegistryImportReport> {
  const commandLine = command.includes('{file}')
    ? command.replaceAll('{file}', shellQuote(file))
    : `${command} ${shellQuote(file)}`;
  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(commandLine, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let out = '';
    let err = '';
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => (out += chunk));
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ code: exitCode, stdout: out, stderr: err });
    });
  });
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { report?: RegistryImportReport };
      if (
        parsed.report !== undefined &&
        typeof parsed.report.read === 'number'
      ) {
        if (code !== 0)
          throw new Error(`registry importer exited with ${String(code)}`);
        return parsed.report;
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  const tail = `${stderr}\n${stdout}`.trim().split('\n').slice(-5).join('\n');
  throw new Error(
    `registry importer exited with ${String(code)} without a report:\n${tail}`,
  );
}
