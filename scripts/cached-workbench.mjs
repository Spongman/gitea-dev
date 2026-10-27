// Installer options for development and test instances: the pinned workbench archive from the local
// download cache (npm run assets -- warm), so installs work offline; without it, a download.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function cachedWorkbench() {
  const pin = JSON.parse(readFileSync(new URL('../config/workbench.json', import.meta.url), 'utf8'));
  const archive = fileURLToPath(new URL(`../data/vscode-web/downloads/${pin.sha256}.tar.gz`, import.meta.url));
  return existsSync(archive) ? { workbench: 'local', workbenchArchive: archive } : { workbench: 'download' };
}
