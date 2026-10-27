import { gitBlobSha, mayBeLfsPointer } from '../../gitea-repository/src/bytes.js';
import type {
	EntryType,
	GiteaRepository,
	RepositoryChange,
	RepositoryEntry,
} from '../../gitea-repository/src/types.js';
import type {
	FileRecord,
	OverlayRecord,
	OverlayStorage,
	StoredKey,
	StoredRecord,
} from './storage.js';
import { parentOf } from './util.js';

export type BaseReader = Pick<GiteaRepository, 'getEntry' | 'readDirectory' | 'readFile'>;

export interface OverlayKey {
	instance: string;
	owner: string;
	repository: string;
	ref: string;
	baseCommit: string;
}

type OverlayErrorCode =
	| 'NotFound'
	| 'Exists'
	| 'IsDirectory'
	| 'NotDirectory'
	| 'NotEmpty'
	| 'ReadOnly'
	| 'Protected'
	| 'Unsupported'
	| 'BrokenLink'
	| 'Invalid'
	| 'Conflict'
	| 'NoChanges';

export class OverlayError extends Error {
	readonly code: OverlayErrorCode;
	readonly conflicts: Conflict[];

	constructor(code: OverlayErrorCode, message: string, conflicts: Conflict[] = []) {
		super(message);
		this.name = 'OverlayError';
		this.code = code;
		this.conflicts = conflicts;
	}
}

/** What a symlink points at inside the repository; undefined when it cannot be resolved. */
export type LinkTarget = 'file' | 'directory';

interface EntryStat {
	type: EntryType;
	/** For a symlink, the type of its target, whose size `size` then is. */
	target?: LinkTarget;
	size: number;
	ctime: number;
	mtime: number;
	/** Symlinks, submodules, Git LFS files and anything reached through a symlink are never editable. */
	readonly: boolean;
}

interface DirectoryItem {
	name: string;
	type: EntryType;
	target?: LinkTarget;
}

export type ChangeType = 'created' | 'changed' | 'deleted';

export interface FileChange {
	path: string;
	type: ChangeType;
}

export interface OverlayEvent {
	/** 'reload': records changed in storage, by another tab or a transfer back. */
	reason: 'edit' | 'discard' | 'commit' | 'rebase' | 'conflicts' | 'reload';
	changes: FileChange[];
}

export interface PendingChange {
	path: string;
	status: 'added' | 'modified' | 'deleted' | 'renamed';
	previousPath?: string;
	size: number;
}

export interface Conflict {
	path: string;
	kind: 'modified' | 'deleted' | 'created' | 'type';
	message: string;
}

interface WriteOptions {
	create: boolean;
	overwrite: boolean;
}

interface CommitRequest {
	baseCommit: string;
	changes: RepositoryChange[];
}

export interface CommitOptions {
	/** Reads the current remote head, which may be newer than the overlay base. */
	head: BaseReader;
	headCommit: string;
	/** Only these pending paths (by their change path; a rename takes both of its records) are committed. Default: all. */
	paths?: readonly string[];
	/** Sends the commit and repoints the filesystem base at `base`, by default the new commit. */
	submit(request: CommitRequest): Promise<{ sha: string; base?: string }>;
}

/** Tabs with the same overlay identity tell each other through this to reload records; a BroadcastChannel in browsers. */
export type OverlayChannel = (name: string, receive: (data: unknown) => void) => { post(data: unknown): void; close(): void };

export function broadcastChannel(): OverlayChannel | undefined {
	if (typeof BroadcastChannel !== 'function') return undefined;
	return (name, receive) => {
		const channel = new BroadcastChannel(name);
		channel.onmessage = (event) => receive(event.data);
		return { post: (data) => channel.postMessage(data), close: () => channel.close() };
	};
}

const MAX_PARALLEL_READS = 8;
/** Linux stops following symlinks after 40 levels; a repository needs far fewer. */
const MAX_LINK_HOPS = 16;
const CONTROL_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Gitea turns committed content into an LFS object only when its LFS server is on and the path
 * matches .gitattributes at commit time, which the editor cannot see; otherwise the pointer
 * would be replaced by the raw content. LFS files can be deleted but not edited or renamed.
 */
const LFS_READ_ONLY = (path: string) => `${path} is stored in Git LFS and cannot be edited or renamed here; change it with git and git-lfs`;

/** A symlink that cannot be followed, or the path that failed while following one. */
type LinkFailure = 'outside the repository' | 'invalid path' | 'too many levels of links' | 'missing target';

type Resolution =
	| { kind: 'ok'; found: Projected; /** Real path, with every symlink replaced by its target. */ path: string; viaLink: boolean }
	| { kind: 'missing' }
	| { kind: 'not-directory'; path: string }
	| { kind: 'broken'; link: string; text: string; reason: LinkFailure };

export function normalizePath(input: string): string {
	const trimmed = input.replace(/^\/+/, '').replace(/\/+$/, '');
	if (trimmed === '') return '';
	const segments = trimmed.split('/');
	for (const segment of segments) {
		if (
			segment === '' ||
			segment === '.' ||
			segment === '..' ||
			segment.toLowerCase() === '.git' ||
			CONTROL_CHARS.test(segment)
		) {
			throw new OverlayError('Invalid', `Invalid path: ${input}`);
		}
	}
	return segments.join('/');
}

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function join(dir: string, name: string): string {
	return dir === '' ? name : `${dir}/${name}`;
}

function isUnder(path: string, dir: string): boolean {
	return dir === '' ? path !== '' : path.startsWith(`${dir}/`);
}

function ancestorsOf(path: string): string[] {
	const out: string[] = [];
	for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) out.push(dir);
	return out;
}

export function overlayIdentity(key: Omit<OverlayKey, 'baseCommit'>): string {
	return JSON.stringify([key.instance, key.owner, key.repository, key.ref]);
}

/** Whether content is the blob with this sha. */
async function isBlob(content: Uint8Array, sha: string): Promise<boolean> {
	return (await gitBlobSha(content, sha.length)) === sha;
}

/** Sha of the base file a record deletes: a deletion, or a directory that replaced the file. */
function deletedSha(record: OverlayRecord | undefined): string | undefined {
	return record?.kind === 'deleted' || record?.kind === 'directory' ? record.originalSha : undefined;
}

function isNotADirectory(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'not-a-directory';
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const e = error as { code?: unknown; status?: unknown; name?: unknown; kind?: unknown };
	const text = [e.code, e.name, e.kind].filter((v) => typeof v === 'string').join(' ');
	return e.status === 404 || /not[-_ ]?found|ENOENT/i.test(text);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface Projected {
	name: string;
	path: string;
	type: EntryType;
	size: number;
	/** Blob sha at the base commit, when the file exists there. */
	baseSha?: string;
	record?: OverlayRecord;
}

/** Per directory: names of children holding live records, and counts of live and deleted records below. */
class RecordIndex {
	readonly children = new Map<string, Set<string>>();
	readonly live = new Map<string, number>();
	readonly deleted = new Map<string, number>();

	constructor(records: ReadonlyMap<string, OverlayRecord>) {
		for (const [path, record] of records) {
			const isLive = record.kind !== 'deleted';
			const counts = isLive ? this.live : this.deleted;
			for (let child = path, dir = parentOf(path); ; child = dir, dir = parentOf(dir)) {
				counts.set(dir, (counts.get(dir) ?? 0) + 1);
				if (isLive) {
					const names = this.children.get(dir) ?? new Set<string>();
					names.add(nameOf(child));
					this.children.set(dir, names);
				}
				if (dir === '') break;
			}
		}
	}
}

class Draft {
	readonly next: Map<string, OverlayRecord>;
	readonly puts = new Set<string>();
	readonly removes = new Set<string>();
	readonly extra: FileChange[] = [];

	constructor(readonly before: ReadonlyMap<string, OverlayRecord>) {
		this.next = new Map(before);
	}

	get(path: string): OverlayRecord | undefined {
		return this.next.get(path);
	}

	set(path: string, record: OverlayRecord): void {
		this.next.set(path, record);
		this.puts.add(path);
		this.removes.delete(path);
	}

	remove(path: string): void {
		if (!this.next.delete(path)) return;
		this.puts.delete(path);
		this.removes.add(path);
	}

	event(path: string, type: ChangeType): void {
		this.extra.push({ path, type });
	}

	get dirty(): boolean {
		return this.puts.size > 0 || this.removes.size > 0;
	}
}

type Link = { renamedFrom?: string; originalSha?: string };

interface OverlayOptions {
	storage: OverlayStorage;
	base: BaseReader;
	now?: () => number;
	/** Repoints `base` at a commit; called whenever the overlay base moves, so both move together. */
	moveReader?: (commit: string) => Promise<void>;
	channel?: OverlayChannel;
}

export class ChangeOverlay {
	readonly #storage: OverlayStorage;
	readonly #base: BaseReader;
	readonly #now: () => number;
	readonly #baseTime: number;
	readonly #listeners = new Set<(event: OverlayEvent) => void>();
	readonly #moveReader: ((commit: string) => Promise<void>) | undefined;
	readonly #channel: { post(data: unknown): void } | undefined;
	/** Base sha of each file handed out by readFile, by real path; editors may hold that content. */
	readonly #served = new Map<string, string | undefined>();
	/** Mtime of base files that changed under a reader since this overlay opened. */
	readonly #mtimes = new Map<string, number>();
	/** Base commits this overlay has left; another tab announcing one is behind. */
	readonly #visited = new Set<string>();
	#key: OverlayKey;
	#records: Map<string, OverlayRecord>;
	#index: RecordIndex;
	#conflicts: Conflict[] = [];
	#tail: Promise<unknown> = Promise.resolve();

	private constructor(key: OverlayKey, records: Map<string, OverlayRecord>, options: OverlayOptions) {
		this.#key = key;
		this.#storage = options.storage;
		this.#base = options.base;
		this.#records = records;
		this.#index = new RecordIndex(records);
		this.#now = options.now ?? Date.now;
		this.#baseTime = this.#now();
		this.#moveReader = options.moveReader;
		this.#channel = options.channel?.(`gitea-dev-overlay:${overlayIdentity(key)}`, (data) => {
			const baseCommit = (data as { baseCommit?: unknown } | null)?.baseCommit;
			if (typeof baseCommit === 'string') void this.#reload(baseCommit).catch(() => undefined);
		});
	}

	/**
	 * Loads pending changes for the key. Overlays saved against other base commits of the
	 * same repository ref are adopted into this base; their original shas are kept, so
	 * remote changes surface as conflicts at commit time instead of being lost.
	 */
	static async open(options: OverlayOptions & { key: OverlayKey }): Promise<ChangeOverlay> {
		return new ChangeOverlay(options.key, await ChangeOverlay.#load(options.storage, options.key), options);
	}

	static async #load(storage: OverlayStorage, key: OverlayKey): Promise<Map<string, OverlayRecord>> {
		const identity = overlayIdentity(key);
		const stored = await storage.loadIdentity(identity);
		const records = new Map<string, OverlayRecord>();
		const groups = new Map<string, StoredRecord[]>();
		for (const row of stored) {
			if (row.baseCommit === key.baseCommit) records.set(row.path, row.record);
			else groups.set(row.baseCommit, [...(groups.get(row.baseCommit) ?? []), row]);
		}
		const newest = (rows: StoredRecord[]) => Math.max(...rows.map((r) => r.record.mtime));
		const adopted = new Map<string, OverlayRecord>();
		for (const rows of [...groups.values()].sort((a, b) => newest(a) - newest(b))) {
			for (const row of rows) adopted.set(row.path, row.record);
		}
		const puts: StoredRecord[] = [];
		for (const [path, record] of adopted) {
			if (records.has(path)) continue;
			records.set(path, record);
			puts.push({ identity, baseCommit: key.baseCommit, path, record });
		}
		const deletes: StoredKey[] = stored
			.filter((row) => row.baseCommit !== key.baseCommit)
			.map((row) => ({ identity, baseCommit: row.baseCommit, path: row.path }));
		await storage.apply(puts, deletes);
		return records;
	}

	get key(): OverlayKey {
		return this.#key;
	}

	get baseCommit(): string {
		return this.#key.baseCommit;
	}

	get conflicts(): readonly Conflict[] {
		return this.#conflicts;
	}

	onDidChange(listener: (event: OverlayEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(event: OverlayEvent): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// A failing listener must not break other listeners or the mutation.
			}
		}
	}

	// Reads

	/**
	 * Symlinks follow the convention of VS Code's disk provider: the stat of a link is its
	 * target's type combined with SymbolicLink, and reads go to the target. Links never leave
	 * the repository; a link that cannot be followed stats as an unknown-type link and fails to read.
	 */
	async stat(path: string): Promise<EntryStat> {
		const normalized = normalizePath(path);
		const own = await this.#resolve(normalized, false);
		if (own.kind === 'missing') throw new OverlayError('NotFound', `Not found: ${path}`);
		if (own.kind === 'not-directory') throw new OverlayError('NotDirectory', `Not a directory: ${own.path}`);
		if (own.kind === 'broken') throw this.#broken(own);
		const { found } = own;
		if (found.type !== 'symlink') {
			const lfs = !found.record && found.type === 'file' && mayBeLfsPointer(found.size) && (await this.#isLfs(found.path));
			return this.#statOf(found, own.viaLink || lfs);
		}
		const target = await this.#resolve(normalized, true);
		if (target.kind !== 'ok' || (target.found.type !== 'file' && target.found.type !== 'directory')) {
			return this.#statOf(found, true);
		}
		return { ...this.#statOf(target.found, true), type: 'symlink', target: target.found.type };
	}

	/** The commit a submodule entry points at; undefined for any other path. Reads only the tree. */
	async submoduleCommit(path: string): Promise<string | undefined> {
		const found = await this.#lookup(normalizePath(path)).catch(() => undefined);
		return found?.type === 'submodule' ? found.baseSha : undefined;
	}

	async readDirectory(path: string): Promise<DirectoryItem[]> {
		const target = await this.#resolveOrThrow(normalizePath(path), path);
		if (target.found.type !== 'directory') throw new OverlayError('NotDirectory', `Not a directory: ${path}`);
		const children = await this.#children(target.path);
		return mapLimit(children, MAX_PARALLEL_READS, async ({ name, type, path: childPath }) => {
			if (type !== 'symlink') return { name, type };
			const resolved = await this.#resolve(childPath, true);
			const kind = resolved.kind === 'ok' ? resolved.found.type : undefined;
			return kind === 'file' || kind === 'directory' ? { name, type, target: kind } : { name, type };
		});
	}

	/** `lfs: 'pointer'` returns a Git LFS pointer as stored instead of downloading its object. */
	async readFile(path: string, options: { lfs?: 'resolve' | 'pointer' } = {}): Promise<Uint8Array> {
		const { found, path: real } = await this.#resolveOrThrow(normalizePath(path), path);
		if (found.type === 'directory') throw new OverlayError('IsDirectory', `Is a directory: ${path}`);
		if (found.type === 'submodule') {
			throw new OverlayError('Unsupported', `Submodule ${path} is at commit ${found.baseSha ?? 'unknown'}; its contents are not available`);
		}
		if (found.record?.kind === 'file') return found.record.content.slice();
		const content = (await this.#base.readFile(real, options)).content.slice();
		if (options.lfs !== 'pointer') this.#served.set(real, found.baseSha);
		return content;
	}

	// Mutations

	writeFile(path: string, content: Uint8Array, options: WriteOptions): Promise<void> {
		const bytes = content.slice();
		return this.#mutate(async (draft) => {
			const target = normalizePath(path);
			if (target === '') throw new OverlayError('IsDirectory', 'Is a directory: /');
			await this.#requireDirectoryAncestors(target);
			const current = await this.#lookup(target);
			if (current?.type === 'directory') throw new OverlayError('IsDirectory', `Is a directory: ${path}`);
			if (current && !options.overwrite) throw new OverlayError('Exists', `File exists: ${path}`);
			if (!current && !options.create) throw new OverlayError('NotFound', `Not found: ${path}`);
			if (current && current.type !== 'file') this.#readOnly(current);
			const record = draft.get(target);
			const now = this.#now();
			let link: Link = {};
			let originalSha: string | undefined;
			let state: FileRecord['state'] = 'created';
			if (record?.kind === 'file') {
				state = record.state;
				originalSha = record.originalSha;
				link = { renamedFrom: record.renamedFrom, originalSha: record.originalSha };
			} else if (record?.kind === 'deleted') {
				state = 'modified';
				originalSha = record.originalSha;
			} else if (current) {
				if ((await this.#base.readFile(target, { lfs: 'pointer' })).lfs) {
					throw new OverlayError('ReadOnly', LFS_READ_ONLY(path));
				}
				state = 'modified';
				originalSha = current.baseSha;
			}
			const ctime = record ? record.ctime : now;
			if (state === 'modified') {
				if (originalSha !== undefined && (await isBlob(bytes, originalSha))) {
					draft.remove(target);
					return;
				}
				draft.set(target, { kind: 'file', state, content: bytes, originalSha, ctime, mtime: now });
				return;
			}
			draft.set(target, { kind: 'file', state, content: bytes, ...link, ctime, mtime: now });
		}, 'edit');
	}

	createDirectory(path: string): Promise<void> {
		return this.#mutate(async (draft) => {
			const target = normalizePath(path);
			if (target === '') throw new OverlayError('Exists', 'File exists: /');
			await this.#requireDirectoryAncestors(target);
			if (await this.#lookup(target)) throw new OverlayError('Exists', `File exists: ${path}`);
			this.#placeDirectory(draft, target, this.#now());
		}, 'edit');
	}

	delete(path: string, options: { recursive: boolean }): Promise<void> {
		return this.#mutate(async (draft) => {
			const target = normalizePath(path);
			if (target === '') throw new OverlayError('Invalid', 'Cannot delete the repository root');
			const found = await this.#lookup(target);
			if (!found) throw new OverlayError('NotFound', `Not found: ${path}`);
			if (found.type === 'directory' && !options.recursive && (await this.#children(target)).length > 0) {
				throw new OverlayError('NotEmpty', `Directory not empty: ${path}`);
			}
			await this.#deleteInDraft(draft, found);
		}, 'edit');
	}

	rename(from: string, to: string, options: { overwrite: boolean }): Promise<void> {
		return this.#mutate(async (draft) => {
			const source = normalizePath(from);
			const target = normalizePath(to);
			if (source === '' || target === '') throw new OverlayError('Invalid', 'Cannot rename the repository root');
			if (source === target) return;
			if (isUnder(target, source)) throw new OverlayError('Invalid', 'Cannot move a directory into itself');
			if (isUnder(source, target)) throw new OverlayError('Invalid', 'Cannot replace a parent of the source');
			const found = await this.#lookup(source);
			if (!found) throw new OverlayError('NotFound', `Not found: ${from}`);
			await this.#requireDirectoryAncestors(target);
			const existing = await this.#lookup(target);
			if (existing && !options.overwrite) throw new OverlayError('Exists', `File exists: ${to}`);

			const isDirectory = found.type === 'directory';
			const files = isDirectory ? await this.#walkFiles(source) : [found];
			for (const file of files) if (file.type !== 'file') this.#readOnly(file);
			const contents = await mapLimit(files, MAX_PARALLEL_READS, async (file) => {
				if (file.record?.kind === 'file') return file.record.content;
				const read = await this.#base.readFile(file.path, { lfs: 'pointer' });
				if (read.lfs) throw new OverlayError('ReadOnly', LFS_READ_ONLY(file.path));
				return read.content;
			});

			const directories = [...this.#records]
				.filter(([p, r]) => r.kind === 'directory' && (p === source || isUnder(p, source)))
				.map(([p]) => p);
			if (existing) await this.#deleteInDraft(draft, existing);
			const now = this.#now();
			for (const [index, file] of files.entries()) {
				const newPath = target + file.path.slice(source.length);
				let link: Link;
				const record = file.record;
				if (record?.kind === 'file' && record.state === 'created') {
					link = { renamedFrom: record.renamedFrom, originalSha: record.originalSha };
					draft.remove(file.path);
				} else {
					const originalSha = record?.kind === 'file' ? record.originalSha : file.baseSha;
					link = { renamedFrom: file.path, originalSha };
					draft.set(file.path, { kind: 'deleted', originalSha: originalSha!, ctime: now, mtime: now });
				}
				await this.#place(draft, newPath, contents[index].slice(), link, now);
			}
			for (const dir of directories) {
				this.#removeDirectory(draft, dir, now);
				this.#placeDirectory(draft, target + dir.slice(source.length), now);
			}
			if (isDirectory) {
				draft.event(source, 'deleted');
				draft.event(target, 'created');
			}
		}, 'edit');
	}

	/** Discards one file or a whole subtree; '' discards everything. */
	discard(path: string): Promise<void> {
		return this.#mutate(async (draft) => {
			const target = normalizePath(path);
			const links = this.#validRenames(draft.before);
			const victims = [...draft.before.keys()].filter((p) => p === target || isUnder(p, target));
			for (const victim of victims) {
				const source = links.get(victim);
				if (source !== undefined) draft.remove(source);
				draft.remove(victim);
			}
		}, 'discard');
	}

	discardAll(): Promise<void> {
		return this.discard('');
	}

	// Pending state

	get size(): number {
		return this.list().length;
	}

	list(): PendingChange[] {
		const links = this.#validRenames(this.#records);
		const consumed = new Set(links.values());
		const out: PendingChange[] = [];
		for (const path of [...this.#records.keys()].sort()) {
			const record = this.#records.get(path)!;
			if (record.kind !== 'file') {
				if (deletedSha(record) !== undefined && !consumed.has(path)) out.push({ path, status: 'deleted', size: 0 });
			} else if (record.state === 'modified') {
				out.push({ path, status: 'modified', size: record.content.length });
			} else if (links.has(path)) {
				out.push({ path, status: 'renamed', previousPath: links.get(path), size: record.content.length });
			} else {
				out.push({ path, status: 'added', size: record.content.length });
			}
		}
		return out;
	}

	#validRenames(records: ReadonlyMap<string, OverlayRecord>): Map<string, string> {
		const out = new Map<string, string>();
		const used = new Set<string>();
		for (const path of [...records.keys()].sort()) {
			const record = records.get(path)!;
			if (record.kind !== 'file' || record.state !== 'created' || !record.renamedFrom) continue;
			const sourceSha = deletedSha(records.get(record.renamedFrom));
			if (sourceSha === undefined || used.has(record.renamedFrom)) continue;
			if (sourceSha !== record.originalSha) continue;
			used.add(record.renamedFrom);
			out.set(path, record.renamedFrom);
		}
		return out;
	}

	// Commit

	/**
	 * Compares pending changes with the remote head and builds the commit.
	 * Never modifies overlay state.
	 */
	async prepareCommit(head: BaseReader, paths?: readonly string[]): Promise<{ changes: RepositoryChange[]; conflicts: Conflict[] }> {
		const records = new Map(this.#records);
		const links = this.#validRenames(records);
		const selected = this.#selection(links, paths);
		const consumed = new Set(links.values());
		const remote = new Map<string, Promise<RepositoryEntry | undefined>>();
		const getRemote = (path: string) => {
			let cached = remote.get(path);
			if (!cached) {
				cached = head.getEntry(path).then(
					(entry) => entry,
					(error: unknown) => {
						// A path below a directory that became a file or link does not exist.
						if (isNotFound(error) || isNotADirectory(error)) return undefined;
						throw error;
					},
				);
				remote.set(path, cached);
			}
			return cached;
		};
		type Source = 'ok' | 'gone' | 'conflict';
		const checkSource = async (conflicts: Conflict[], path: string, originalSha: string, content?: Uint8Array): Promise<Source> => {
			const entry = await getRemote(path);
			if (!entry) {
				if (content !== undefined) {
					conflicts.push({ path, kind: 'deleted', message: 'Deleted on the remote branch.' });
					return 'conflict';
				}
				return 'gone';
			}
			if (entry.type !== 'file') {
				conflicts.push({ path, kind: 'type', message: `Remote entry is a ${entry.type}.` });
				return 'conflict';
			}
			if (entry.sha === originalSha) return 'ok';
			if (content !== undefined && (await isBlob(content, entry.sha))) return 'gone';
			conflicts.push({ path, kind: 'modified', message: 'Changed on the remote branch.' });
			return 'conflict';
		};
		type Target = 'create' | 'same' | 'conflict';
		const checkTarget = async (conflicts: Conflict[], path: string, content: Uint8Array): Promise<Target> => {
			for (const ancestor of ancestorsOf(path)) {
				if (records.get(ancestor)?.kind === 'file') {
					conflicts.push({ path, kind: 'type', message: `${ancestor} is also a pending file.` });
					return 'conflict';
				}
				const entry = await getRemote(ancestor);
				if (entry && entry.type !== 'directory') {
					conflicts.push({ path, kind: 'type', message: `${ancestor} is a ${entry.type} on the remote branch.` });
					return 'conflict';
				}
			}
			const entry = await getRemote(path);
			if (!entry) return 'create';
			if (entry.type === 'file' && (await isBlob(content, entry.sha))) return 'same';
			conflicts.push({ path, kind: 'created', message: 'Already exists on the remote branch.' });
			return 'conflict';
		};

		const checked = [...records.keys()].sort().filter((path) => !selected || selected.has(path));
		// Paths are checked in parallel; results keep path order.
		const results = await mapLimit(checked, MAX_PARALLEL_READS, async (path) => {
			const changes: RepositoryChange[] = [];
			const conflicts: Conflict[] = [];
			const record = records.get(path)!;
			if (record.kind !== 'file') {
				const originalSha = deletedSha(record);
				if (originalSha !== undefined && !consumed.has(path) && (await checkSource(conflicts, path, originalSha)) === 'ok') {
					changes.push({ type: 'delete', path, originalSha });
				}
			} else if (record.state === 'modified') {
				if ((await checkSource(conflicts, path, record.originalSha!, record.content)) === 'ok') {
					changes.push({ type: 'update', path, content: record.content, originalSha: record.originalSha });
				}
			} else if (links.has(path)) {
				const previousPath = links.get(path)!;
				const source = await checkSource(conflicts, previousPath, record.originalSha!);
				const target = await checkTarget(conflicts, path, record.content);
				if (source === 'ok' && target === 'create') {
					changes.push({
						type: 'update',
						path,
						previousPath,
						content: record.content,
						originalSha: record.originalSha,
					});
				} else if (source === 'ok' && target === 'same') {
					changes.push({ type: 'delete', path: previousPath, originalSha: record.originalSha });
				} else if (source === 'gone' && target === 'create') {
					changes.push({ type: 'create', path, content: record.content });
				}
			} else if ((await checkTarget(conflicts, path, record.content)) === 'create') {
				changes.push({ type: 'create', path, content: record.content });
			}
			return { changes, conflicts };
		});
		return { changes: results.flatMap((r) => r.changes), conflicts: results.flatMap((r) => r.conflicts) };
	}

	/** Record paths for the given change paths, closed over rename pairs; undefined means everything. */
	#selection(links: Map<string, string>, paths: readonly string[] | undefined): Set<string> | undefined {
		if (paths === undefined) return undefined;
		const out = new Set(paths.map(normalizePath));
		for (const [target, source] of links) {
			if (out.has(target) || out.has(source)) {
				out.add(target);
				out.add(source);
			}
		}
		return out;
	}

	/** Refreshes the stored conflict list against the remote head. */
	async detectConflicts(head: BaseReader): Promise<Conflict[]> {
		const { conflicts } = await this.prepareCommit(head);
		await this.#exclusive(async () => {
			// Changes discarded meanwhile have no conflict.
			this.#conflicts = conflicts.filter((c) => this.#records.has(c.path));
			this.#emit({ reason: 'conflicts', changes: [] });
		});
		return conflicts;
	}

	/**
	 * Validates against the remote head, sends one commit, then clears the overlay and
	 * moves it to the new base commit. Mutations wait while the commit is in flight so no
	 * save can be lost. Conflicts leave all local changes in place. With `paths`, only those
	 * changes are checked and cleared; the rest stay pending on the new base. When the head
	 * already has every selected change, as after a commit whose response was lost, nothing
	 * is sent and the overlay moves to the head.
	 */
	commit(options: CommitOptions): Promise<{ sha: string; changes: number }> {
		return this.#exclusive(async () => {
			const { changes, conflicts } = await this.prepareCommit(options.head, options.paths);
			const selected = this.#selection(this.#validRenames(this.#records), options.paths);
			this.#conflicts = selected ? [...this.#conflicts.filter((c) => !selected.has(c.path)), ...conflicts] : conflicts;
			if (conflicts.length > 0) {
				this.#emit({ reason: 'conflicts', changes: [] });
				throw new OverlayError('Conflict', `${conflicts.length} conflicting change(s).`, conflicts);
			}
			const committed = new Map([...this.#records].filter(([path]) => !selected || selected.has(path)));
			if (changes.length === 0 && ![...committed.values()].some((r) => r.kind !== 'directory' || r.originalSha !== undefined)) {
				throw new OverlayError('NoChanges', 'No changes to commit.');
			}
			const result: { sha: string; base?: string } = changes.length === 0
				? { sha: options.headCommit }
				: await options.submit({ baseCommit: options.headCommit, changes });
			// A partial commit keeps local directories; one that replaced a committed deletion becomes plain.
			const kept = new Map<string, OverlayRecord>();
			if (selected) {
				for (const [path, record] of this.#records) {
					if (!selected.has(path)) kept.set(path, record);
					else if (record.kind === 'directory') kept.set(path, { kind: 'directory', ctime: record.ctime, mtime: record.mtime });
				}
			}
			const events = this.#pendingEvents(committed, true);
			events.push(...(await this.#moveBase(result.base ?? result.sha, kept)));
			this.#emit({ reason: 'commit', changes: events });
			return { sha: result.sha, changes: changes.length };
		});
	}

	/** Moves every pending change to another ref of this repository, keeping the base commit. */
	transferTo(ref: string): Promise<void> {
		return this.#exclusive(async () => {
			const identity = overlayIdentity(this.#key);
			const target = overlayIdentity({ ...this.#key, ref });
			const { baseCommit } = this.#key;
			const puts = [...this.#records].map(([path, record]) => ({ identity: target, baseCommit, path, record }));
			const deletes = [...this.#records.keys()].map((path) => ({ identity, baseCommit, path }));
			await this.#storage.apply(puts, deletes);
			const before = this.#records;
			this.#setRecords(new Map());
			this.#conflicts = [];
			this.#post();
			this.#emit({ reason: 'discard', changes: this.#transitions(before, this.#records) });
		});
	}

	/** Takes back the changes `transferTo(ref)` moved away, if they are still at this base commit. */
	transferFrom(ref: string): Promise<void> {
		return this.#exclusive(async () => {
			const identity = overlayIdentity(this.#key);
			const source = overlayIdentity({ ...this.#key, ref });
			const { baseCommit } = this.#key;
			const rows = (await this.#storage.loadIdentity(source)).filter((row) => row.baseCommit === baseCommit);
			const puts = rows.map((row) => ({ ...row, identity }));
			const deletes = rows.map((row) => ({ identity: source, baseCommit, path: row.path }));
			await this.#storage.apply(puts, deletes);
			const before = this.#records;
			const next = new Map(before);
			for (const row of rows) next.set(row.path, row.record);
			this.#setRecords(next);
			this.#post();
			this.#emit({ reason: 'reload', changes: this.#transitions(before, next) });
		});
	}

	/** Moves pending changes to a newer base commit, keeping original shas. */
	rebase(baseCommit: string): Promise<void> {
		return this.#exclusive(async () => {
			if (baseCommit === this.#key.baseCommit) return;
			const records = this.#records;
			const changed = await this.#moveBase(baseCommit, records);
			this.#emit({ reason: 'rebase', changes: [...this.#pendingEvents(records, false), ...changed] });
		});
	}

	/** Moves the reader and the stored records together; returns events for read files that changed. */
	async #moveBase(baseCommit: string, records: Map<string, OverlayRecord>): Promise<FileChange[]> {
		const identity = overlayIdentity(this.#key);
		const old = this.#key.baseCommit;
		const deletes = [...this.#records.keys()].map((path) => ({ identity, baseCommit: old, path }));
		const puts = [...records].map(([path, record]) => ({ identity, baseCommit, path, record }));
		await this.#moveReader?.(baseCommit);
		try {
			await this.#storage.apply(puts, deletes);
		} catch (error) {
			await this.#moveReader?.(old).catch(() => undefined);
			throw error;
		}
		const before = this.#records;
		this.#visited.add(old);
		this.#key = { ...this.#key, baseCommit };
		this.#setRecords(new Map(records));
		this.#conflicts = this.#conflicts.filter((c) => records.has(c.path));
		this.#post();
		return this.#baseChanged(before);
	}

	/**
	 * After a base move: files handed out by readFile whose content changed get an event and a
	 * newer mtime, so a clean editor reloads and a dirty one cannot save over the change unnoticed.
	 * Files that were just committed only update what was handed out.
	 */
	async #baseChanged(before: ReadonlyMap<string, OverlayRecord>): Promise<FileChange[]> {
		const committed = [...before].filter(([path, record]) => record.kind === 'file' && !this.#records.has(path)).map(([path]) => path);
		const paths = [...new Set([...this.#served.keys(), ...committed])].filter((path) => !this.#records.has(path));
		const now = this.#now();
		const out: FileChange[] = [];
		await mapLimit(paths, MAX_PARALLEL_READS, async (path) => {
			let found: Projected | undefined | null;
			try {
				found = await this.#lookup(path);
			} catch {
				found = null;
			}
			const sha = found?.type === 'file' ? found.baseSha : undefined;
			if (!before.has(path) && (found === null || sha !== this.#served.get(path))) {
				out.push({ path, type: found === undefined ? 'deleted' : 'changed' });
				this.#mtimes.set(path, now);
			}
			if (sha === undefined) this.#served.delete(path);
			else this.#served.set(path, sha);
		});
		return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}

	/** Another tab stored changes; follows its base when it moved forward. */
	#reload(baseCommit: string): Promise<void> {
		return this.#exclusive(async () => {
			const target = this.#visited.has(baseCommit) ? this.#key.baseCommit : baseCommit;
			const moved = target !== this.#key.baseCommit;
			if (moved) await this.#moveReader?.(target);
			const records = await ChangeOverlay.#load(this.#storage, { ...this.#key, baseCommit: target });
			if (moved) {
				this.#visited.add(this.#key.baseCommit);
				this.#key = { ...this.#key, baseCommit: target };
			}
			const before = this.#records;
			this.#setRecords(records);
			this.#conflicts = this.#conflicts.filter((c) => records.has(c.path));
			const changes = this.#transitions(before, records);
			if (moved) changes.push(...(await this.#baseChanged(before)));
			this.#emit({ reason: 'reload', changes });
		});
	}

	#post(): void {
		this.#channel?.post({ baseCommit: this.#key.baseCommit });
	}

	#setRecords(records: Map<string, OverlayRecord>): void {
		this.#records = records;
		this.#index = new RecordIndex(records);
	}

	// Internals

	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(fn);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Serialized; state changes only after the storage write succeeds, and events follow it. */
	#mutate(fn: (draft: Draft) => Promise<void>, reason: OverlayEvent['reason']): Promise<void> {
		return this.#exclusive(async () => {
			const draft = new Draft(this.#records);
			await fn(draft);
			if (!draft.dirty) return;
			const identity = overlayIdentity(this.#key);
			const baseCommit = this.#key.baseCommit;
			const puts = [...draft.puts].map((path) => ({ identity, baseCommit, path, record: draft.next.get(path)! }));
			const deletes = [...draft.removes].map((path) => ({ identity, baseCommit, path }));
			await this.#storage.apply(puts, deletes);
			const before = this.#records;
			this.#setRecords(draft.next);
			this.#conflicts = this.#conflicts.filter((c) => draft.next.has(c.path));
			this.#post();
			const changed = new Set([...draft.puts, ...draft.removes]);
			const events = this.#transitions(before, draft.next, changed);
			for (const extra of draft.extra) if (!events.some((e) => e.path === extra.path)) events.push(extra);
			this.#emit({ reason, changes: events });
		});
	}

	/** Events for every pending path when the base moves under it. */
	#pendingEvents(records: ReadonlyMap<string, OverlayRecord>, committed: boolean): FileChange[] {
		const out: FileChange[] = [];
		for (const [path, record] of records) {
			if (record.kind === 'directory') continue;
			out.push({ path, type: record.kind === 'deleted' && committed ? 'deleted' : 'changed' });
		}
		return out;
	}

	#transitions(
		before: ReadonlyMap<string, OverlayRecord>,
		after: ReadonlyMap<string, OverlayRecord>,
		only?: Set<string>,
	): FileChange[] {
		const baseHas = (r?: OverlayRecord) => deletedSha(r) !== undefined || (r?.kind === 'file' && r.state === 'modified');
		const out: FileChange[] = [];
		for (const path of only ?? new Set([...before.keys(), ...after.keys()])) {
			const b = before.get(path);
			const a = after.get(path);
			if (b === a) continue;
			const existedBefore = b ? b.kind !== 'deleted' : baseHas(a);
			const existsAfter = a ? a.kind !== 'deleted' : baseHas(b);
			if (!existedBefore && existsAfter) out.push({ path, type: 'created' });
			else if (existedBefore && !existsAfter) out.push({ path, type: 'deleted' });
			else if (existedBefore && existsAfter) out.push({ path, type: 'changed' });
		}
		return out;
	}

	#readOnly(entry: Projected): never {
		throw new OverlayError('ReadOnly', `${entry.type} is read-only: ${entry.path}`);
	}

	#statOf(entry: Projected, readonly = false): EntryStat {
		const record = entry.record;
		return {
			type: entry.type,
			size: entry.type === 'directory' ? 0 : entry.size,
			ctime: record ? record.ctime : this.#baseTime,
			mtime: record ? record.mtime : (this.#mtimes.get(entry.path) ?? this.#baseTime),
			readonly: readonly || entry.type === 'symlink' || entry.type === 'submodule',
		};
	}

	/** Whether a base file is a Git LFS pointer; a failed probe counts as no, writes check again. */
	async #isLfs(path: string): Promise<boolean> {
		try {
			return (await this.#base.readFile(path, { lfs: 'pointer' })).lfs !== undefined;
		} catch {
			return false;
		}
	}

	async #resolveOrThrow(path: string, display: string): Promise<Extract<Resolution, { kind: 'ok' }>> {
		const resolved = await this.#resolve(path, true);
		if (resolved.kind === 'ok') return resolved;
		if (resolved.kind === 'missing') throw new OverlayError('NotFound', `Not found: ${display}`);
		if (resolved.kind === 'not-directory') throw new OverlayError('NotDirectory', `Not a directory: ${resolved.path}`);
		throw this.#broken(resolved);
	}

	#broken(failure: Extract<Resolution, { kind: 'broken' }>): OverlayError {
		return new OverlayError('BrokenLink', `Broken symlink ${failure.link} -> ${failure.text}: ${failure.reason}`);
	}

	/**
	 * Resolves a path like realpath: every symlink on the way, and the last one when
	 * `followFinal`, is replaced by its target, which is read relative to the link's directory.
	 * Absolute targets and targets that climb above the repository root are refused, so
	 * nothing outside the repository is ever looked up.
	 */
	async #resolve(path: string, followFinal: boolean): Promise<Resolution> {
		try {
			// A lookup only succeeds through real directories, so this path holds no symlink but possibly the last.
			const direct = await this.#lookup(path);
			if (!direct) return { kind: 'missing' };
			if (direct.type !== 'symlink' || !followFinal) return { kind: 'ok', found: direct, path, viaLink: false };
		} catch (error) {
			if (!isNotADirectory(error)) throw error;
		}
		// `fromLink` marks segments that came from a link target rather than from the requested path.
		let pending = path === '' ? [] : path.split('/').map((name) => ({ name, fromLink: false }));
		let resolved = '';
		let hops = 0;
		let viaLink = false;
		let link: { link: string; text: string } | undefined;
		const broken = (reason: LinkFailure): Resolution => ({ kind: 'broken', link: link!.link, text: link!.text, reason });
		while (pending.length > 0) {
			const { name, fromLink } = pending[0];
			pending = pending.slice(1);
			if (name === '' || name === '.') continue;
			if (name === '..') {
				if (resolved === '') return broken('outside the repository');
				resolved = parentOf(resolved);
				continue;
			}
			if (fromLink && (name.toLowerCase() === '.git' || CONTROL_CHARS.test(name))) return broken('invalid path');
			const candidate = join(resolved, name);
			const found = await this.#lookup(candidate);
			if (!found) return fromLink ? broken('missing target') : { kind: 'missing' };
			if (found.type === 'symlink' && (pending.length > 0 || followFinal)) {
				if (++hops > MAX_LINK_HOPS) return broken('too many levels of links');
				const text = new TextDecoder().decode((await this.#base.readFile(candidate, { lfs: 'pointer' })).content);
				link = { link: candidate, text };
				viaLink = true;
				if (text === '' || text.startsWith('/')) return broken('outside the repository');
				pending = [...text.split('/').map((part) => ({ name: part, fromLink: true })), ...pending];
				continue;
			}
			if (found.type !== 'directory' && pending.some((p) => p.name !== '' && p.name !== '.')) return { kind: 'not-directory', path: candidate };
			resolved = candidate;
		}
		const found = await this.#lookup(resolved);
		return found ? { kind: 'ok', found, path: resolved, viaLink } : { kind: 'missing' };
	}

	#blocked(path: string): boolean {
		return ancestorsOf(path).some((a) => this.#records.get(a)?.kind === 'file');
	}

	#hasLiveUnder(path: string): boolean {
		return (this.#index.live.get(path) ?? 0) > 0;
	}

	#hasDeletedUnder(path: string): boolean {
		return (this.#index.deleted.get(path) ?? 0) > 0;
	}

	async #baseEntry(path: string): Promise<RepositoryEntry | undefined> {
		try {
			return await this.#base.getEntry(path);
		} catch (error) {
			if (isNotFound(error)) return undefined;
			// Below a base file that is pending deletion, nothing exists in the projection.
			if (isNotADirectory(error) && ancestorsOf(path).some((a) => deletedSha(this.#records.get(a)) !== undefined)) return undefined;
			throw error;
		}
	}

	#fromRecord(path: string, record: OverlayRecord): Projected {
		const name = nameOf(path);
		if (record.kind === 'directory') return { name, path, type: 'directory', size: 0, record };
		if (record.kind === 'deleted') throw new Error('unreachable');
		return { name, path, type: 'file', size: record.content.length, baseSha: record.originalSha, record };
	}

	async #lookup(path: string): Promise<Projected | undefined> {
		if (path === '') return { name: '', path, type: 'directory', size: 0 };
		if (this.#blocked(path)) return undefined;
		const record = this.#records.get(path);
		if (record && record.kind !== 'deleted') return this.#fromRecord(path, record);
		if (this.#hasLiveUnder(path)) return { name: nameOf(path), path, type: 'directory', size: 0 };
		if (record) return undefined;
		const entry = await this.#baseEntry(path);
		if (!entry) return undefined;
		if (entry.type === 'directory' && this.#hasDeletedUnder(path) && (await this.#children(path)).length === 0) {
			return undefined;
		}
		return { name: nameOf(path), path, type: entry.type, size: entry.size, baseSha: entry.sha };
	}

	async #children(dir: string): Promise<Projected[]> {
		const out = new Map<string, Projected>();
		const own = this.#records.get(dir);
		// A deleted base file, or a directory that replaced one, hides the base path.
		if (own === undefined || (own.kind === 'directory' && own.originalSha === undefined)) {
			let entries: RepositoryEntry[] = [];
			try {
				entries = await this.#base.readDirectory(dir);
			} catch (error) {
				if (!isNotFound(error) && !isNotADirectory(error)) throw error;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				const record = this.#records.get(path);
				if (record?.kind === 'deleted' || record?.kind === 'file') continue;
				if (entry.type === 'directory' && this.#hasDeletedUnder(path) && (await this.#children(path)).length === 0) {
					continue;
				}
				out.set(entry.name, { name: entry.name, path, type: entry.type, size: entry.size, baseSha: entry.sha });
			}
		}
		for (const name of this.#index.children.get(dir) ?? []) {
			const path = join(dir, name);
			const record = this.#records.get(path);
			if (record && record.kind !== 'deleted') out.set(name, this.#fromRecord(path, record));
			else if (!out.has(name)) out.set(name, { name, path, type: 'directory', size: 0 });
		}
		return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async #walkFiles(dir: string): Promise<Projected[]> {
		const files: Projected[] = [];
		for (const child of await this.#children(dir)) {
			if (child.type === 'directory') files.push(...(await this.#walkFiles(child.path)));
			else files.push(child);
		}
		return files;
	}

	async #requireDirectoryAncestors(path: string): Promise<void> {
		for (const ancestor of ancestorsOf(path).reverse()) {
			const found = await this.#lookup(ancestor);
			if (found?.type === 'symlink') {
				throw new OverlayError('ReadOnly', `${ancestor} is a symlink; nothing below it can be changed here`);
			}
			if (found && found.type !== 'directory') {
				throw new OverlayError('NotDirectory', `Not a directory: ${ancestor}`);
			}
		}
	}

	async #deleteInDraft(draft: Draft, found: Projected): Promise<void> {
		const files = found.type === 'directory' ? await this.#walkFiles(found.path) : [found];
		for (const file of files) if (file.type !== 'file') this.#readOnly(file);
		const now = this.#now();
		for (const file of files) {
			const record = file.record;
			if (record?.kind === 'file' && record.state === 'created') {
				draft.remove(file.path);
				continue;
			}
			const originalSha = record?.kind === 'file' ? record.originalSha : file.baseSha;
			draft.set(file.path, { kind: 'deleted', originalSha: originalSha!, ctime: now, mtime: now });
		}
		for (const [path, record] of this.#records) {
			if (record.kind === 'directory' && (path === found.path || isUnder(path, found.path))) this.#removeDirectory(draft, path, now);
		}
		if (found.type === 'directory') draft.event(found.path, 'deleted');
	}

	/** A directory over a deleted base file keeps the deletion. */
	#placeDirectory(draft: Draft, path: string, now: number): void {
		const originalSha = deletedSha(draft.get(path));
		draft.set(path, { kind: 'directory', ...(originalSha === undefined ? {} : { originalSha }), ctime: now, mtime: now });
	}

	/** Removing a directory that replaced a base file leaves the file deleted. */
	#removeDirectory(draft: Draft, path: string, now: number): void {
		const originalSha = deletedSha(draft.get(path));
		if (originalSha === undefined) draft.remove(path);
		else draft.set(path, { kind: 'deleted', originalSha, ctime: now, mtime: now });
	}

	/** Places moved content at a path; replaces a deletion with a modification. */
	async #place(draft: Draft, path: string, content: Uint8Array, link: Link, now: number): Promise<void> {
		const existing = draft.get(path);
		if (existing?.kind === 'deleted') {
			if (await isBlob(content, existing.originalSha)) {
				draft.remove(path);
				return;
			}
			draft.set(path, { kind: 'file', state: 'modified', content, originalSha: existing.originalSha, ctime: now, mtime: now });
			return;
		}
		draft.set(path, { kind: 'file', state: 'created', content, ...link, ctime: now, mtime: now });
	}
}
