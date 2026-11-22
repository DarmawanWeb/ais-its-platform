#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { USAGE, parseArguments } from './cli/args.js';
import { execute } from './cli/execute.js';
import { createOutput } from './cli/output.js';
import { EXIT_CODES, UsageError, errorMessage } from './util/errors.js';

const output = createOutput({ quiet: process.argv.includes('--quiet') });
const controller = new AbortController();
let interrupts = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(EXIT_CODES.interrupted);
    output.warn(
      `${signal}: stopping after the current batch (press Ctrl+C again to abort at once)`,
    );
    controller.abort();
  });

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === 'help') output.result(USAGE);
  else if (args.command === 'version') {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    output.result(pkg.version);
  } else
    process.exitCode = await execute(
      args,
      process.env,
      output,
      controller.signal,
    );
} catch (error) {
  if (error instanceof UsageError) {
    output.error(error.message);
    output.result(USAGE);
    process.exitCode = EXIT_CODES.usage;
  } else {
    output.error(errorMessage(error));
    process.exitCode = EXIT_CODES.failed;
  }
}
