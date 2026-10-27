import type { VfsFileSystem } from './fs.js';

type PathIndex = Pick<VfsFileSystem<unknown>, 'learn' | 'forget' | 'reset'>;

/** The slice of a session the path index reads. */
export interface PathIndexSource {
	baseCommit: string;
	repository: { readTree?(path: string): Promise<{ path: string }[]> };
	overlay: {
		list(): { path: string; status: string; previousPath?: string }[];
		onDidChange(listener: (event: { changes: { type: string; path: string }[] }) => void): () => void;
	};
}

/**
 * Seeds the path index for getAllPaths from the recursive tree listing (which also warms the
 * directory cache) and keeps it current with overlay changes and base commit changes.
 * Returns a disposer.
 */
export function indexPaths(session: PathIndexSource, fs: PathIndex): () => void {
	let seeded = session.baseCommit;
	const apply = () => {
		for (const change of session.overlay.list()) {
			if (change.status === 'deleted') fs.forget(change.path);
			else fs.learn([change.path]);
			if (change.previousPath !== undefined) fs.forget(change.previousPath);
		}
	};
	const seed = (replace: boolean) => {
		const base = session.baseCommit;
		seeded = base;
		void (async () => {
			const paths = (await session.repository.readTree?.('') ?? []).map((entry) => entry.path);
			if (base !== session.baseCommit) return;
			if (replace) fs.reset();
			fs.learn(paths);
			apply();
		})().catch(() => undefined);
	};
	seed(false);
	return session.overlay.onDidChange((event) => {
		for (const change of event.changes) {
			if (change.type === 'deleted') fs.forget(change.path);
			else fs.learn([change.path]);
		}
		if (session.baseCommit !== seeded) seed(true);
	});
}
