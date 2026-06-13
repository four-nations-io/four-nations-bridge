// Copies static setup-ui assets (HTML / CSS / JS) into dist/ so Express
// can serve them from the same relative paths the TS compiler outputs to.
// tsc only handles .ts; this script handles the rest.
//
// Kept in scripts/ (excluded from tsc compilation) so the build pipeline is
// `tsc && node scripts/copy-public-assets.mjs` — both run in package.json's
// `npm run build`.

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function copyTree(rel) {
  const src = join(root, 'src', rel);
  const dst = join(root, 'dist', rel);
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, filter: (p) => !p.endsWith('.ts') });
}

await copyTree('setup-ui/public');
console.log('setup-ui assets copied to dist/setup-ui/public/');
