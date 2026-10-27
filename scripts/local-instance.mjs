import { randomBytes } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { install } from './run-installer.mjs';
import { ensurePinnedBinary } from './pinned-binary.mjs';

process.umask(0o077);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const home = join(root, 'data/local-gitea');
const binary = join(home, 'bin/gitea');
const config = join(home, 'conf/app.ini');
const stateFile = join(home, 'instance.json');
const credentialsFile = join(home, 'credentials.json');
const origin = 'http://localhost:3000';
// Gitea serves the editor itself; no proxy or editor process.
const giteaPort = 3000;
// Name for a new administrator; an existing instance keeps the one in credentials.json.
const defaultAdmin = 'admin';
const pin = JSON.parse(await readFile(join(root, 'config/gitea-instance.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const common = ['--config', config, '--work-path', home, '--custom-path', join(home, 'custom')];
// Browsers on the CDN extension host call Gitea cross-origin (README "Gitea settings").
const corsSection = `[cors]
ENABLED = true
ALLOW_DOMAIN = https://*.vscode-cdn.net
METHODS = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
HEADERS = Content-Type,User-Agent,Authorization
ALLOW_CREDENTIALS = false
`;
const environment = { ...process.env, GITEA_WORK_DIR: home, GITEA_CUSTOM: join(home, 'custom'), HOME: join(home, 'home') };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const saveJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

// The demo instance runs the Gitea in config/gitea-instance.json. The integration tests pin a different
// release on purpose (scripts/test-gitea.mjs), so each can change without retesting the other.
const ensureBinary = () => ensurePinnedBinary({ binary, url: pin.url, sha256: pin.sha256, mode: 0o700 });

function cli(args, label) {
  const result = spawnSync(binary, [...args, ...common], { cwd: home, env: environment, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`Gitea ${label} failed; configuration is ${config}.`);
  return result.stdout;
}

async function initialize() {
  for (const path of ['conf', 'home', 'logs', 'repos']) await mkdir(join(home, path), { recursive: true });
  await chmod(home, 0o700);
  await ensureBinary();
  try { await readFile(config); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = () => randomBytes(32).toString('base64url');
    await writeFile(config, `APP_NAME = Gitea Web IDE
RUN_MODE = prod
RUN_USER = ${userInfo().username}
WORK_PATH = ${home}

[database]
DB_TYPE = sqlite3
PATH = ${home}/gitea.db

[repository]
ROOT = ${home}/repos

[server]
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${giteaPort}
DOMAIN = localhost
ROOT_URL = ${origin}/
LOCAL_ROOT_URL = http://127.0.0.1:${giteaPort}/
DISABLE_SSH = true
START_SSH_SERVER = false
OFFLINE_MODE = true
LFS_START_SERVER = false

[security]
INSTALL_LOCK = true
SECRET_KEY = ${secret()}
INTERNAL_TOKEN = ${secret()}
PASSWORD_HASH_ALGO = pbkdf2

[oauth2]
JWT_SECRET = ${secret()}

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = false
DEFAULT_KEEP_EMAIL_PRIVATE = true

[actions]
ENABLED = false

[packages]
ENABLED = false

[indexer]
REPO_INDEXER_ENABLED = false

[mailer]
ENABLED = false

[log]
MODE = console
LEVEL = Info

${corsSection}`, { mode: 0o600, flag: 'wx' });
  }
  const ini = await readFile(config, 'utf8');
  const withCors = /^\[cors\]/m.test(ini) ? ini : `${ini.trimEnd()}\n\n${corsSection}`;
  const listening = withCors.replace(/^HTTP_PORT = .*$/m, `HTTP_PORT = ${giteaPort}`)
    .replace(/^LOCAL_ROOT_URL = .*$/m, `LOCAL_ROOT_URL = http://127.0.0.1:${giteaPort}/`);
  if (listening !== ini) await writeFile(config, listening, { mode: 0o600 });
  cli(['migrate'], 'database migration');
  let credentials = await readJson(credentialsFile).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!credentials) {
    const output = cli(['admin', 'user', 'create', '--username', defaultAdmin, '--email', `${defaultAdmin}@localhost.invalid`,
      '--admin', '--random-password', '--random-password-length', '32', '--must-change-password=false'], 'administrator creation');
    const password = /generated random password is '([^']+)'/.exec(output)?.[1];
    if (!password) throw new Error('Gitea did not return a generated administrator password.');
    credentials = { url: origin, username: defaultAdmin, password };
    await saveJson(credentialsFile, credentials);
  }
  return credentials;
}

async function state() {
  const value = await readJson(stateFile).catch(() => undefined);
  if (!value?.pid) return undefined;
  const cmdline = await readFile(`/proc/${value.pid}/cmdline`, 'utf8').catch(() => '');
  return cmdline.includes(binary) && cmdline.includes('web') ? value : undefined;
}

async function healthy(url, processHandle) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (processHandle && processHandle.exitCode !== null) throw new Error('Gitea exited. Check data/local-gitea/logs/gitea.log.');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await wait(100);
  }
  throw new Error(`Local service did not become ready: ${url}`);
}

// Installs the static editor (npm run build) into the instance's custom directory.
async function installEditor(oauthClientId) {
  const custom = join(home, 'custom');
  // This instance owns its custom directory, so the current template and shortcut replace the installed ones.
  for (const path of ['templates/custom/extra_tabs.tmpl', 'public/assets/gitea-dev/shortcut.js']) await rm(join(custom, path), { force: true });
  await mkdir(custom, { recursive: true });
  // The editor loads the workbench from Microsoft's CDN, as released. testMode lets cdn mode use this http loopback address.
  await install({ custom, rootUrl: origin, oauthClientId, appIni: config, workbench: 'cdn', testMode: true });
}

async function start() {
  const credentials = await initialize();
  const configured = await readJson(join(home, 'custom/public/assets/gitea-dev/configuration.json')).catch(() => undefined);
  await installEditor(configured?.oauthClientId ?? undefined);
  const fd = openSync(join(home, 'logs/gitea.log'), 'a', 0o600);
  const gitea = spawn(binary, ['web', ...common], { cwd: home, env: environment, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  gitea.unref();
  await saveJson(stateFile, { status: 'starting', pid: gitea.pid, url: origin, version: pin.version });
  await healthy(`http://127.0.0.1:${giteaPort}/api/healthz`, gitea);
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  async function api(method, path, body) {
    const response = await fetch(`http://127.0.0.1:${giteaPort}/api/v1${path}`, {
      method, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Gitea setup ${method} ${path} returned HTTP ${response.status}.`);
    return response.status === 204 ? undefined : response.json();
  }
  const applications = await api('GET', '/user/applications/oauth2');
  let oauth = applications.find(app => app.name === 'Gitea Web IDE');
  const callback = `${origin}/assets/gitea-dev/oauth-callback.html`;
  // skip_secondary_authorization: after one consent, the editor signs in silently from the Gitea session.
  const registration = { name: 'Gitea Web IDE', confidential_client: false, skip_secondary_authorization: true, redirect_uris: [callback] };
  if (!oauth) oauth = await api('POST', '/user/applications/oauth2', registration);
  else if (oauth.skip_secondary_authorization !== true || !oauth.redirect_uris.includes(callback)) {
    oauth = await api('PATCH', `/user/applications/oauth2/${oauth.id}`, { ...registration, redirect_uris: [...new Set([...oauth.redirect_uris, callback])] });
  }
  for (const [name, isPrivate] of [['web-ide-demo', false], ['private-demo', true]]) {
    const exists = await fetch(`http://127.0.0.1:${giteaPort}/api/v1/repos/${credentials.username}/${name}`, { headers: { Authorization: authorization } });
    if (exists.status === 404) {
      await api('POST', '/user/repos', { name, private: isPrivate, auto_init: true, default_branch: 'main', description: 'Browser Web IDE demonstration' });
      await api('POST', `/repos/${credentials.username}/${name}/contents`, { branch: 'main', message: 'Add Web IDE examples', files: [
        { operation: 'create', path: 'hello.txt', content: Buffer.from('Edit this file, save locally, then commit explicitly.\n').toString('base64') },
        { operation: 'create', path: 'src/value.ts', content: Buffer.from('export const answer = 42;\n').toString('base64') },
        { operation: 'create', path: 'src/main.ts', content: Buffer.from("import { answer } from './value';\nconsole.log(answer);\n").toString('base64') },
      ] });
    } else if (!exists.ok) throw new Error('Could not inspect the demo repository.');
  }
  // Static files are read per request, so a new client id needs no restart.
  if (configured?.oauthClientId !== oauth.client_id) await installEditor(oauth.client_id);
  const ready = {
    status: 'running', pid: gitea.pid, version: pin.version, url: origin, repository: `${origin}/${credentials.username}/web-ide-demo`,
    privateRepository: `${origin}/${credentials.username}/private-demo`, oauthClientId: oauth.client_id,
  };
  await saveJson(stateFile, ready);
  return ready;
}

const command = process.argv[2] ?? 'status';
if (command === 'start') {
  const active = await state();
  if (active) console.log(`Already running: ${active.url}`);
  else {
    await mkdir(join(home, 'logs'), { recursive: true });
    await chmod(home, 0o700);
    await readFile(join(root, 'dist/gitea-dev/VERSION'));
    const ready = await start().catch(async error => {
      const pid = (await readJson(stateFile).catch(() => undefined))?.pid;
      if (pid && await state()) process.kill(pid, 'SIGTERM');
      await saveJson(stateFile, { status: 'stopped', url: origin });
      throw error;
    });
    console.log(`Gitea ${pin.version} with Web IDE is ready at ${origin}`);
    console.log(`Repository: ${ready.repository}\nPrivate repository: ${ready.privateRepository}\nCredentials: ${credentialsFile}`);
  }
} else if (command === 'stop') {
  const active = await state();
  if (active) {
    process.kill(active.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 100 && await state(); attempt++) await wait(100);
    if (await state()) throw new Error('Instance is still stopping.');
    await saveJson(stateFile, { status: 'stopped', url: origin });
  }
  console.log('Local Gitea instance stopped; data preserved.');
} else if (command === 'status') {
  console.log(JSON.stringify(await state() ?? { status: 'stopped', url: origin }, null, 2));
} else throw new Error('Commands: start, stop, status');
