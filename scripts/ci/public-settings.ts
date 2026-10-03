#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { publicSettingsFromStackOutputs } from '../package-artifacts.js';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, environment, output] = process.argv.slice(2);
  if (input === undefined || environment === undefined || output === undefined) {
    throw new Error('Usage: public-settings <stack-outputs.json> <environment> <output.json>.');
  }
  const settings = publicSettingsFromStackOutputs(
    JSON.parse(await readFile(input, 'utf8')) as unknown,
    environment,
  );
  await writeFile(output, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
