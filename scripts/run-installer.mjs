// Runs the release's install.sh (npm run build first) for development and test installs:
// install({ custom, rootUrl, ...options }) is the command line written as an object.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OPTIONS = {
  oauthClientId: '--oauth-client-id', webviews: '--webviews', connectSrc: '--connect-src', extensionsAllowlist: '--extensions-allowlist',
  gallery: '--gallery', workbench: '--workbench', workbenchArchive: '--workbench-archive', appIni: '--app-ini',
};

/** Installs into `custom`; rejects with the installer's messages when it refuses. `testMode` is --test-mode. */
export function install({ custom, rootUrl, testMode = false, from = fileURLToPath(new URL('../dist/gitea-dev', import.meta.url)), ...options }) {
  const unknown = Object.keys(options).filter(name => !OPTIONS[name]);
  if (unknown.length) throw new Error(`install(): unknown option ${unknown.join(', ')}`);
  const args = [`${from}/install.sh`, custom, rootUrl];
  for (const [name, flag] of Object.entries(OPTIONS)) if (options[name] !== undefined) args.push(`${flag}=${options[name]}`);
  if (testMode) args.push('--test-mode');
  return new Promise((resolve, reject) => {
    const child = spawn('sh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve() : reject(new Error(`install.sh exited with ${status}:\n${stderr}`)));
  });
}
