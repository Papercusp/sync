import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageManifest = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
};

describe('@papercusp/sync package manifest', () => {
  it('declares the runtime dependencies used by its public virtualizer export', () => {
    expect(packageManifest.dependencies?.['@tanstack/react-virtual']).toBe('^3.13.23');
    expect(packageManifest.dependencies?.['@tanstack/virtual-core']).toBe('^3.13.23');
  });
});
