import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CachedDownloadAssets } from '../packages/asset-provider/src/index.js';

const [command = 'status', argument] = process.argv.slice(2);
const pin = JSON.parse(await readFile(process.env.WORKBENCH_PIN ?? 'config/workbench.json', 'utf8'));
const provider = new CachedDownloadAssets({ cacheDir: resolve(process.env.WORKBENCH_CACHE ?? 'data/vscode-web'), pin });
switch (command) {
  case 'warm': case 'upgrade':
    console.log(JSON.stringify(await provider.warm(), null, 2)); break;
  case 'status':
    console.log(JSON.stringify(await provider.status(), null, 2)); break;
  case 'validate':
    console.log(JSON.stringify(await provider.validate(), null, 2)); break;
  case 'rollback':
    if (!argument) throw new Error('Usage: npm run assets -- rollback <installed-commit>');
    console.log(JSON.stringify(await provider.rollback(argument), null, 2)); break;
  case 'prune':
    console.log(JSON.stringify(await provider.prune(), null, 2)); break;
  case 'bundle':
    if (!argument) throw new Error('Usage: npm run assets -- bundle <output-directory>');
    console.log(`Bundled validated workbench at ${(await provider.bundle(argument)).root}`);
    break;
  default: throw new Error('Commands: status, warm, upgrade, validate, rollback, prune, bundle');
}
