// Packs the release tree (npm run build) into dist/gitea-dev-<version>.tar.gz plus a sha256sum file.
// Operators extract it and run gitea-dev/install.sh; no Node is needed.
import { create } from 'tar';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const version = (await readFile('dist/gitea-dev/VERSION', 'utf8')).trim();
const output = resolve(process.argv[2] ?? `dist/gitea-dev-${version}.tar.gz`);
await create({ gzip: true, file: output, cwd: 'dist', portable: true }, ['gitea-dev']);
const hash = createHash('sha256');
for await (const bytes of createReadStream(output)) hash.update(bytes);
await writeFile(`${output}.sha256`, `${hash.digest('hex')}  ${basename(output)}\n`);
console.log(`Packaged ${output}`);
