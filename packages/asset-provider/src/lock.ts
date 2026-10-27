import { randomBytes } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AssetError, DEFAULT_DOWNLOAD_TIMEOUT_MS } from './types.js';

export interface LockOptions {
	timeoutMs: number;
	// A lock whose heartbeat is older than this is considered abandoned.
	staleMs: number;
	pollMs: number;
}

// Time allowed for unpacking after a download, on top of the download timeout.
export const EXTRACT_ALLOWANCE_MS = 300_000;

// A waiter outlasts the holder's longest legitimate install.
export const DEFAULT_LOCK: LockOptions = {
	timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS + EXTRACT_ALLOWANCE_MS,
	staleMs: 30_000,
	pollMs: 100,
};

interface Owner {
	pid: number;
	host: string;
	// Boot and pid namespace of the owner; absent in locks from older versions.
	scope?: string;
	token: string;
}

// pids are only comparable within one boot and pid namespace. Hostnames can
// repeat across containers sharing the cache directory.
const SCOPE = (() => {
	const read = (path: string): string => {
		try {
			return readFileSync(path, 'utf8').trim();
		} catch {
			return '';
		}
	};
	const namespace = (() => {
		try {
			return readlinkSync('/proc/self/ns/pid');
		} catch {
			return '';
		}
	})();
	return `${read('/proc/sys/kernel/random/boot_id')}:${namespace}`;
})();

const OWNER_FILE = 'owner.json';

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

async function readOwner(lockDir: string): Promise<Owner | undefined> {
	try {
		const owner = JSON.parse(await readFile(join(lockDir, OWNER_FILE), 'utf8')) as Owner;
		return typeof owner.token === 'string' ? owner : undefined;
	} catch {
		return undefined;
	}
}

async function ageMs(path: string): Promise<number | undefined> {
	try {
		return Date.now() - (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

// Held lock has a stale heartbeat or a dead same-host owner.
async function isStale(lockDir: string, staleMs: number): Promise<{ stale: boolean; token?: string }> {
	const owner = await readOwner(lockDir);
	const age = await ageMs(owner ? join(lockDir, OWNER_FILE) : lockDir);
	if (age === undefined) return { stale: false };
	const local = owner && owner.host === hostname() && (owner.scope === undefined || owner.scope === SCOPE);
	if (owner && local && !isAlive(owner.pid)) return { stale: true, token: owner.token };
	return { stale: age > staleMs, token: owner?.token };
}

// Removes an abandoned lock. Serialized by a second mkdir mutex so a slow
// breaker cannot remove a lock that was re-acquired after it checked.
async function breakStale(lockDir: string, options: LockOptions): Promise<void> {
	const breakDir = `${lockDir}.break`;
	try {
		await mkdir(breakDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		const age = await ageMs(breakDir);
		if (age !== undefined && age > options.staleMs) await rm(breakDir, { recursive: true, force: true });
		return;
	}
	try {
		// Re-read the owner so a lock re-acquired since our check is spared.
		const { stale, token } = await isStale(lockDir, options.staleMs);
		const current = await readOwner(lockDir);
		if (stale && current?.token === token) {
			const trash = `${lockDir}.dead-${randomBytes(6).toString('hex')}`;
			await rename(lockDir, trash).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') throw error;
			});
			await rm(trash, { recursive: true, force: true });
		}
	} finally {
		await rm(breakDir, { recursive: true, force: true });
	}
}

// Runs fn while holding a cross-process mkdir lock. Throws
// AssetError('lock-timeout') if it cannot be acquired in time. While waiting,
// `ready` is polled; a defined result is returned without taking the lock.
//
// Advisory only, for processes sharing a local filesystem. Ownership is a
// heartbeat, not a fencing token: a holder suspended for longer than staleMs
// can lose the lock and another process may install meanwhile. fn gets
// `held()`, which throws AssetError('lock-lost') if the lock was broken; call
// it right before each destructive step. A tiny window between that check and
// the step remains.
export async function withLock<T>(
	lockDir: string,
	fn: (held: () => Promise<void>) => Promise<T>,
	partial: Partial<LockOptions> = {},
	ready?: () => Promise<T | undefined>,
): Promise<T> {
	const options = { ...DEFAULT_LOCK, ...partial };
	await mkdir(dirname(lockDir), { recursive: true });
	const owner: Owner = { pid: process.pid, host: hostname(), scope: SCOPE, token: randomBytes(12).toString('hex') };
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		try {
			await mkdir(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		const done = await ready?.();
		if (done !== undefined) return done;
		await breakStale(lockDir, options);
		if (Date.now() >= deadline) {
			throw new AssetError('lock-timeout', `timed out waiting for lock ${lockDir}`);
		}
		await sleep(options.pollMs);
	}
	const ownerFile = join(lockDir, OWNER_FILE);
	await writeFile(ownerFile, JSON.stringify(owner));
	const heartbeat = setInterval(() => {
		const now = new Date();
		utimes(ownerFile, now, now).catch(() => undefined);
	}, Math.max(50, Math.floor(options.staleMs / 4)));
	heartbeat.unref();
	const held = async (): Promise<void> => {
		if ((await readOwner(lockDir))?.token !== owner.token) {
			throw new AssetError('lock-lost', `lock ${lockDir} was broken while held`);
		}
	};
	try {
		return await fn(held);
	} finally {
		clearInterval(heartbeat);
		// Only remove the lock if it is still ours (it may have been broken).
		if ((await readOwner(lockDir))?.token === owner.token) {
			const trash = `${lockDir}.rel-${randomBytes(6).toString('hex')}`;
			await rename(lockDir, trash).then(
				() => rm(trash, { recursive: true, force: true }),
				() => undefined,
			);
		}
	}
}
