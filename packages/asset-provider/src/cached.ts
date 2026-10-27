import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { downloadVerified } from './download.js';
import { installArchive, removeTree, sha256File } from './install.js';
import { EXTRACT_ALLOWANCE_MS, withLock, type LockOptions } from './lock.js';
import { parsePin } from './pin.js';
import {
	AssetError,
	DEFAULT_DOWNLOAD_TIMEOUT_MS,
	DEFAULT_LIMITS,
	integrityOf,
	type ArchiveLimits,
	type AssetPin,
	type WorkbenchAssets,
	type WorkbenchAssetsResult,
	type WorkbenchManifest,
} from './types.js';
import { REQUIRED_FILES, readManifest, validateAssets } from './validate.js';

export interface CachedDownloadAssetsOptions {
	// Cache root, e.g. data/vscode-web.
	cacheDir: string;
	pin: AssetPin;
	// file:// pins: tests and offline imports only.
	allowFileUrls?: boolean;
	// Serve the last validated install when the pinned one cannot be
	// installed. The result carries `fallback`. Default true.
	fallback?: boolean;
	limits?: Partial<ArchiveLimits>;
	lock?: Partial<LockOptions>;
	downloadTimeoutMs?: number;
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

export interface CacheStatus {
	pin: AssetPin;
	current?: { commit: string; version: string; root: string };
	pinInstalled: boolean;
	installed: { commit: string; version?: string; valid: boolean; error?: string }[];
}

const HEX40 = /^[0-9a-f]{40}$/;

export class CachedDownloadAssets implements WorkbenchAssets {
	private readonly cacheDir: string;
	private readonly pin: AssetPin;
	private readonly limits: ArchiveLimits;
	private readonly verified = new Set<string>();

	constructor(private readonly options: CachedDownloadAssetsOptions) {
		this.cacheDir = resolve(options.cacheDir);
		this.pin = parsePin(options.pin, { allowFileUrls: options.allowFileUrls });
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
	}

	async ensure(version: string): Promise<WorkbenchAssetsResult> {
		return this.resolve(version, this.options.fallback ?? true);
	}

	// Explicit warm-up: installs the pin or throws; never falls back.
	warm(): Promise<WorkbenchAssetsResult> {
		return this.resolve(this.pin.version, false);
	}

	async validate(): Promise<WorkbenchManifest> {
		return validateAssets(this.versionDir(this.pin.commit), { expected: this.expected(), limits: this.limits });
	}

	// Points `current` at an already-installed, valid version. `current` is
	// only the fallback target: the next ensure()/warm() installs or revalidates
	// the configured pin and repoints it there. To roll a deployment back,
	// restore the previous pin in config and rebuild; its install is still cached.
	async rollback(commit: string): Promise<WorkbenchAssetsResult> {
		if (!HEX40.test(commit)) throw new AssetError('not-installed', `bad commit ${commit}`);
		return this.locked(async (held) => {
			const root = this.versionDir(commit);
			const manifest = await validateAssets(root, { limits: this.limits }).catch((error: Error) => {
				throw new AssetError('not-installed', `${commit} is not a valid install: ${error.message}`, {
					cause: error,
				});
			});
			await held();
			await this.point(commit);
			return this.result(root, manifest);
		});
	}

	// Copies the validated pinned workbench to a new directory: staged beside
	// it, revalidated, then renamed into place.
	async bundle(destination: string): Promise<WorkbenchAssetsResult> {
		const target = resolve(destination);
		if (await lstat(target).catch(() => undefined)) {
			throw new AssetError('destination-exists', `${target} already exists`);
		}
		return this.locked(async (held) => {
			const installed = await this.install(held);
			const staging = `${target}.partial-${randomBytes(6).toString('hex')}`;
			try {
				await cp(installed.root, staging, { recursive: true });
				await validateAssets(staging, { expected: this.expected(), limits: this.limits });
				await held();
				await rename(staging, target);
			} catch (error) {
				await removeTree(staging);
				throw error;
			}
			return { ...installed, root: target };
		});
	}

	async status(): Promise<CacheStatus> {
		const installed: CacheStatus['installed'] = [];
		for (const commit of await this.commits()) {
			try {
				const manifest = await validateAssets(this.versionDir(commit), { limits: this.limits });
				installed.push({ commit, version: manifest.version, valid: true });
			} catch (error) {
				installed.push({ commit, valid: false, error: (error as Error).message });
			}
		}
		const current = await this.currentCommit();
		const manifest = current ? await readManifest(this.versionDir(current)).catch(() => undefined) : undefined;
		return {
			pin: this.pin,
			current: current && manifest ? { commit: current, version: manifest.version, root: this.versionDir(current) } : undefined,
			pinInstalled: installed.some((entry) => entry.commit === this.pin.commit && entry.valid),
			installed,
		};
	}

	// Removes installs other than current (the fallback target) and the pin,
	// leftover staging dirs, and downloads other than the pin's.
	async prune(): Promise<string[]> {
		return this.locked(async () => {
			const removed: string[] = [];
			const keep = new Set([this.pin.commit, await this.currentCommit()]);
			for (const name of await this.readdirSafe('versions')) {
				if (!keep.has(name)) {
					await removeTree(join(this.cacheDir, 'versions', name));
					removed.push(`versions/${name}`);
				}
			}
			for (const name of await this.readdirSafe('downloads')) {
				if (name !== this.archiveName()) {
					await removeTree(join(this.cacheDir, 'downloads', name));
					removed.push(`downloads/${name}`);
				}
			}
			return removed;
		});
	}

	private async resolve(version: string, allowFallback: boolean): Promise<WorkbenchAssetsResult> {
		if (version !== this.pin.version) {
			throw new AssetError(
				'version-mismatch',
				`requested ${version} but the configured pin is ${this.pin.version}`,
			);
		}
		const hit = await this.hit();
		if (hit) return hit;
		try {
			return await this.locked((held) => this.install(held), () => this.hit());
		} catch (error) {
			const fallback = allowFallback ? await this.fallbackResult(version, error as Error) : undefined;
			if (fallback) return fallback;
			throw error;
		}
	}

	private versionDir(commit: string): string {
		return join(this.cacheDir, 'versions', commit);
	}

	private archiveName(): string {
		return `${this.pin.sha256}.tar.gz`;
	}

	private expected() {
		return { version: this.pin.version, commit: this.pin.commit, integrity: integrityOf(this.pin.sha256) };
	}

	private result(root: string, manifest: WorkbenchManifest): WorkbenchAssetsResult {
		return { root, version: manifest.version, commit: manifest.commit, integrity: manifest.integrity };
	}

	// Waiters outlast the holder's download and extraction, and return at once
	// when the holder's install makes the pin current.
	private locked<T>(fn: (held: () => Promise<void>) => Promise<T>, ready?: () => Promise<T | undefined>): Promise<T> {
		const timeoutMs = (this.options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS) + EXTRACT_ALLOWANCE_MS;
		return withLock(join(this.cacheDir, 'locks', 'install.lock'), fn, { timeoutMs, ...this.options.lock }, ready);
	}

	// Pinned install is present, valid and current. Full validation runs once
	// per instance; later calls only re-check manifest and required files.
	private async hit(): Promise<WorkbenchAssetsResult | undefined> {
		const root = this.versionDir(this.pin.commit);
		try {
			if ((await this.currentCommit()) !== this.pin.commit) return undefined;
			if (this.verified.has(root)) {
				const manifest = await readManifest(root);
				for (const file of REQUIRED_FILES) await lstat(join(root, file));
				if (manifest.commit === this.pin.commit && manifest.integrity === this.expected().integrity) {
					return this.result(root, manifest);
				}
				return undefined;
			}
			const manifest = await validateAssets(root, { expected: this.expected(), limits: this.limits });
			this.verified.add(root);
			return this.result(root, manifest);
		} catch {
			this.verified.delete(root);
			return undefined;
		}
	}

	private async install(held: () => Promise<void>): Promise<WorkbenchAssetsResult> {
		const root = this.versionDir(this.pin.commit);
		const existing = await validateAssets(root, { expected: this.expected(), limits: this.limits }).catch(
			() => undefined,
		);
		if (existing) {
			await held();
			await this.point(this.pin.commit);
			this.verified.add(root);
			return this.result(root, existing);
		}

		await mkdir(join(this.cacheDir, 'versions'), { recursive: true });
		await mkdir(join(this.cacheDir, 'downloads'), { recursive: true });
		// Holding the lock means any staging dir or partial download is from a crashed install.
		for (const name of await this.readdirSafe('versions')) {
			if (name.startsWith('.')) await removeTree(join(this.cacheDir, 'versions', name));
		}
		for (const name of await this.readdirSafe('downloads')) {
			if (name.endsWith('.part')) await removeTree(join(this.cacheDir, 'downloads', name));
		}

		const archive = join(this.cacheDir, 'downloads', this.archiveName());
		const reusable = (await lstat(archive).catch(() => undefined))?.isFile()
			? (await sha256File(archive)) === this.pin.sha256
			: false;
		if (!reusable) {
			await rm(archive, { force: true });
			const part = join(this.cacheDir, 'downloads', `${this.pin.sha256}.${randomBytes(6).toString('hex')}.part`);
			this.log(`downloading workbench ${this.pin.version}`);
			await downloadVerified({
				url: this.pin.url,
				sha256: this.pin.sha256,
				dest: part,
				limits: this.limits,
				allowFileUrls: this.options.allowFileUrls,
				fetch: this.options.fetch,
				timeoutMs: this.options.downloadTimeoutMs,
			});
			await rename(part, archive);
		}

		const staging = join(this.cacheDir, 'versions', `.staging-${this.pin.commit}-${randomBytes(6).toString('hex')}`);
		try {
			const manifest = await installArchive(archive, this.pin, staging, { limits: this.limits });
			await held();
			// A broken install under the final name is moved aside, never merged.
			if (await lstat(root).catch(() => undefined)) {
				const aside = join(this.cacheDir, 'versions', `.invalid-${this.pin.commit}-${randomBytes(6).toString('hex')}`);
				await rename(root, aside);
				await removeTree(aside);
			}
			await rename(staging, root);
			await held();
			await this.point(this.pin.commit);
			this.verified.add(root);
			return this.result(root, manifest);
		} catch (error) {
			await removeTree(staging);
			throw error;
		}
	}

	// Atomically repoints `current` (relative symlink) at versions/<commit>.
	private async point(commit: string): Promise<void> {
		const tmp = join(this.cacheDir, `.current-${randomBytes(6).toString('hex')}`);
		await symlink(join('versions', commit), tmp, 'dir');
		try {
			await rename(tmp, join(this.cacheDir, 'current'));
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
	}

	private async currentCommit(): Promise<string | undefined> {
		try {
			const target = await readlink(join(this.cacheDir, 'current'));
			const [dir, commit, ...rest] = target.split(/[\\/]/);
			return dir === 'versions' && commit && HEX40.test(commit) && rest.length === 0 ? commit : undefined;
		} catch {
			return undefined;
		}
	}

	private async commits(): Promise<string[]> {
		return (await this.readdirSafe('versions')).filter((name) => HEX40.test(name));
	}

	private async readdirSafe(sub: string): Promise<string[]> {
		return readdir(join(this.cacheDir, sub)).catch(() => []);
	}

	// Last validated install, served only with explicit fallback metadata.
	private async fallbackResult(requested: string, cause: Error): Promise<WorkbenchAssetsResult | undefined> {
		const commit = await this.currentCommit();
		if (!commit) return undefined;
		const root = this.versionDir(commit);
		try {
			const manifest = await validateAssets(root, { limits: this.limits });
			this.log(`refresh failed (${cause.message}); serving last validated ${manifest.version} (${commit})`);
			return { ...this.result(root, manifest), fallback: { requestedVersion: requested, reason: cause.message } };
		} catch {
			return undefined;
		}
	}

	private log(message: string): void {
		this.options.log?.(message);
	}
}
