import { constants } from 'node:fs';
import { open, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	AssetError,
	DEFAULT_LIMITS,
	MANIFEST_NAME,
	type ArchiveLimits,
	type WorkbenchManifest,
} from './types.js';

// Browser-only subset of the official vscode-web (standalone) archive.
// The workbench entry is either the public or the "internal" bundle.
const WORKBENCH_BUNDLES = [
	'out/vs/workbench/workbench.web.main.internal.js',
	'out/vs/workbench/workbench.web.main.js',
];

export const REQUIRED_FILES = [
	'package.json',
	'out/nls.messages.js',
	'out/vs/workbench/api/worker/extensionHostWorkerMain.js',
	'out/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',
	'out/vs/workbench/contrib/webview/browser/pre/index.html',
	'node_modules/vscode-oniguruma/release/main.js',
	'node_modules/vscode-oniguruma/release/onig.wasm',
	'node_modules/vscode-textmate/release/main.js',
	'node_modules/@vscode/codicons/dist/codicon.ttf',
];

// First path segment that only exists in server distributions.
const FORBIDDEN_ROOT = new Set([
	'bin',
	'node',
	'node.exe',
	'server.sh',
	'server.cmd',
	'code-server',
	'code-server.cmd',
	'code-server.sh',
]);

// File basenames of the remote agent, at any depth.
const FORBIDDEN_BASENAMES = new Set([
	'server-cli.js',
	'server-main.js',
	'bootstrap-fork.js',
	'bootstrap-server.js',
	'bootstrap-node.js',
]);

const FORBIDDEN_PREFIXES = [
	'out/vs/server',
	'node_modules/node-pty',
	'node_modules/@vscode/ripgrep',
	'node_modules/@parcel/watcher',
	'node_modules/@vscode/spdlog',
	'node_modules/native-watchdog',
];

const NATIVE_EXT_RE = /\.(?:node|exe|dll|dylib|so(?:\.\d+)*)$/i;

// ELF, Mach-O (32/64, both endians, fat).
const NATIVE_MAGIC = new Set(['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe']);

// Why a tree-relative path is not allowed in a client-only workbench, if so.
export function forbiddenReason(relPath: string, isDir: boolean): string | undefined {
	const segments = relPath.split('/');
	const base = segments[segments.length - 1]!;
	if (FORBIDDEN_ROOT.has(segments[0]!)) return `server layout entry "${segments[0]}"`;
	for (const prefix of FORBIDDEN_PREFIXES) {
		if (relPath === prefix || relPath.startsWith(`${prefix}/`)) {
			return `server layout path "${prefix}"`;
		}
	}
	if (!isDir && FORBIDDEN_BASENAMES.has(base)) return `server file "${base}"`;
	if (!isDir && NATIVE_EXT_RE.test(base)) return `native binary "${base}"`;
	if (relPath === MANIFEST_NAME) return `reserved name "${MANIFEST_NAME}"`;
	return undefined;
}

const HEX40 = /^[0-9a-f]{40}$/;
const INTEGRITY_RE = /^sha256:[0-9a-f]{64}$/;

interface Expected {
	version?: string;
	commit?: string;
	integrity?: string;
}

interface ValidateOptions {
	expected?: Expected;
	limits?: Pick<ArchiveLimits, 'maxUnpackedBytes' | 'maxEntries'>;
}

const invalid = (message: string): never => {
	throw new AssetError('invalid-layout', message);
};

export async function writeManifest(root: string, manifest: WorkbenchManifest): Promise<void> {
	await writeFile(join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, '\t')}\n`, { flag: 'wx' });
}

export async function readManifest(root: string): Promise<WorkbenchManifest> {
	let text: string;
	try {
		text = await readFile(join(root, MANIFEST_NAME), 'utf8');
	} catch (error) {
		throw new AssetError('invalid-layout', `${root}: missing ${MANIFEST_NAME}`, { cause: error });
	}
	if (text.length > 64 * 1024) invalid(`${MANIFEST_NAME} too large`);
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new AssetError('invalid-layout', `${MANIFEST_NAME} is not valid JSON`, { cause: error });
	}
	if (json.schema !== 1) invalid(`${MANIFEST_NAME}: unsupported schema`);
	if (json.clientOnly !== true) invalid(`${MANIFEST_NAME}: clientOnly must be true`);
	const { version, commit, integrity } = json;
	if (typeof version !== 'string' || !version) invalid(`${MANIFEST_NAME}: bad version`);
	if (typeof commit !== 'string' || !HEX40.test(commit)) invalid(`${MANIFEST_NAME}: bad commit`);
	if (typeof integrity !== 'string' || !INTEGRITY_RE.test(integrity)) {
		invalid(`${MANIFEST_NAME}: bad integrity`);
	}
	return json as unknown as WorkbenchManifest;
}

// Checks a directory is a complete client-only workbench with a trusted
// manifest. Never executes anything. Throws AssetError('invalid-layout').
export async function validateAssets(root: string, options: ValidateOptions = {}): Promise<WorkbenchManifest> {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const rootStat = await lstat(root).catch(() => undefined);
	if (!rootStat) return invalid(`${root}: does not exist`);
	if (!rootStat.isDirectory()) return invalid(`${root}: not a directory`);

	const manifest = await readManifest(root);
	const expected = options.expected ?? {};
	for (const key of ['version', 'commit', 'integrity'] as const) {
		const want = expected[key];
		if (want !== undefined && manifest[key] !== want) {
			invalid(`${root}: manifest ${key} ${manifest[key]} != expected ${want}`);
		}
	}

	let entries = 0;
	let bytes = 0;
	const stack: string[] = [''];
	while (stack.length > 0) {
		const rel = stack.pop()!;
		const dirents = await readdir(join(root, rel), { withFileTypes: true });
		const files: string[] = [];
		for (const dirent of dirents) {
			const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
			if (++entries > limits.maxEntries) invalid(`${root}: too many entries`);
			if (dirent.isSymbolicLink()) invalid(`${relPath}: symlink not allowed`);
			const isDir = dirent.isDirectory();
			if (!isDir && !dirent.isFile()) invalid(`${relPath}: not a regular file or directory`);
			if (relPath !== MANIFEST_NAME) {
				const reason = forbiddenReason(relPath, isDir);
				if (reason) invalid(`${relPath}: ${reason}`);
			}
			if (isDir) stack.push(relPath);
			else files.push(relPath);
		}
		for (let i = 0; i < files.length; i += FILE_BATCH) {
			const sizes = await Promise.all(files.slice(i, i + FILE_BATCH).map((relPath) => inspectFile(root, relPath)));
			for (const size of sizes) {
				bytes += size;
				if (bytes > limits.maxUnpackedBytes) {
					throw new AssetError('limit', `${root}: unpacked size exceeds limit`);
				}
			}
		}
	}

	for (const required of REQUIRED_FILES) await requireFile(root, required);
	const bundle = await firstFile(root, WORKBENCH_BUNDLES);
	if (!bundle) invalid(`${root}: missing workbench bundle (${WORKBENCH_BUNDLES.join(' or ')})`);
	await requireFile(root, `${bundle!.replace(/\.js$/, '')}.css`);

	// The official archive's own package.json carries the release version.
	let pkg: { version?: unknown };
	try {
		pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown };
	} catch (error) {
		throw new AssetError('invalid-layout', 'package.json is not valid JSON', { cause: error });
	}
	if (pkg.version !== manifest.version) {
		invalid(`package.json version ${String(pkg.version)} != manifest version ${manifest.version}`);
	}

	return manifest;
}

// Files inspected concurrently per directory.
const FILE_BATCH = 64;

// Size of a regular file, after rejecting native executable content. One
// open (never following a symlink swapped in since readdir), no lstat.
async function inspectFile(root: string, relPath: string): Promise<number> {
	const handle = await open(join(root, relPath), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ELOOP') return invalid(`${relPath}: symlink not allowed`);
		throw error;
	});
	try {
		const { size } = await handle.stat();
		const magic = Buffer.alloc(4);
		const { bytesRead } = await handle.read(magic, 0, 4, 0);
		if (bytesRead === 4 && NATIVE_MAGIC.has(magic.toString('hex'))) {
			invalid(`${relPath}: native executable content`);
		}
		return size;
	} finally {
		await handle.close();
	}
}

async function requireFile(root: string, rel: string): Promise<void> {
	const stat = await lstat(join(root, rel)).catch(() => undefined);
	if (!stat?.isFile()) invalid(`${root}: missing required file ${rel}`);
}

async function firstFile(root: string, candidates: string[]): Promise<string | undefined> {
	for (const rel of candidates) {
		if ((await lstat(join(root, rel)).catch(() => undefined))?.isFile()) return rel;
	}
	return undefined;
}
