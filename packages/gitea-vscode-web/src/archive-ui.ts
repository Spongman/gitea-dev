import * as vscode from 'vscode';

import { HttpGiteaRepository } from '../../gitea-repository/src/index.js';
import { ArchiveBackedRepository, createArchiveRepositoryFactory } from './archive-reader.js';
import { archiveSearchNotice, readArchiveSettings, type ArchiveSettings } from './archive-prefetch.js';
import { ArchiveStore } from './archive-store.js';
import type { Session, RepositoryFactory } from './session.js';

interface ArchiveSupport extends vscode.Disposable {
	createRepository: RepositoryFactory;
	/** Starts archive handling and the recursive tree prefetch for a session's repository. */
	attach(session: Session): void;
	/** Archive state name for status reporting; null when the session has no archive support. */
	stateOf(session: Session): string | null;
	/** Runs before a search; returns warnings for results that cannot come from the archive. */
	prepareSearch(session: Session, kind: 'file' | 'text', token: vscode.CancellationToken): Promise<string[]>;
}

/** Archive prefetch and recursive trees for sessions; falls back to plain blob reads without IndexedDB. */
export function createArchiveSupport(log: (message: string) => void): ArchiveSupport {
	const settings = (): ArchiveSettings => readArchiveSettings(vscode.workspace.getConfiguration('gitea.archive'));
	const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	const attached = new Set<ArchiveBackedRepository>();
	const subscriptions: vscode.Disposable[] = [];

	if (factory === undefined) {
		log('IndexedDB is unavailable; repository archives are disabled.');
		return {
			createRepository: (options) => new HttpGiteaRepository(options),
			attach: () => undefined,
			stateOf: () => null,
			prepareSearch: async () => [],
			dispose: () => undefined,
		};
	}
	const store = new ArchiveStore(factory);
	store.purgeIncomplete().then(
		(count) => {
			if (count > 0) log(`archive: removed ${count} incomplete archive(s)`);
			return store.evict(settings().cacheBytes);
		},
		(error: unknown) => log(`archive: startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
	).catch(() => undefined);
	const createRepository = createArchiveRepositoryFactory({ store, settings, log });

	const showProgress = (repo: ArchiveBackedRepository): void => {
		let finish: (() => void) | undefined;
		let report: ((value: { message: string }) => void) | undefined;
		subscriptions.push({
			dispose: repo.archive.onDidChange((state) => {
				const active = state.kind === 'checking' || state.kind === 'downloading';
				if (active && finish === undefined) {
					const gate = new Promise<void>((resolve) => {
						finish = resolve;
					});
					void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Gitea: caching repository' }, (progress) => {
						report = (value) => progress.report(value);
						return gate;
					});
				}
				if (state.kind === 'downloading' && state.total > 0) {
					report?.({ message: `${Math.min(100, Math.floor((state.bytes * 100) / state.total))}%` });
				}
				if (!active && finish !== undefined) {
					finish();
					finish = undefined;
					report = undefined;
				}
			}),
		});
	};

	return {
		createRepository,
		attach(session) {
			const repo = session.repository;
			if (!(repo instanceof ArchiveBackedRepository) || attached.has(repo)) return;
			attached.add(repo);
			showProgress(repo);
			void repo.archive.attach().catch((error: unknown) => log(`archive: ${error instanceof Error ? error.message : String(error)}`));
			void repo.readTree('').catch(() => undefined);
		},
		stateOf(session) {
			const repo = session.repository;
			return repo instanceof ArchiveBackedRepository ? repo.archive.state.kind : null;
		},
		async prepareSearch(session, kind, token) {
			const repo = session.repository;
			if (!(repo instanceof ArchiveBackedRepository)) return [];
			const controller = new AbortController();
			const listener = token.onCancellationRequested(() => controller.abort());
			try {
				await repo.readTree('', { signal: controller.signal });
			} catch {
				// Too large or unavailable: directory reads still work one at a time.
			} finally {
				listener.dispose();
			}
			if (kind === 'file' || settings().prefetch === 'off') return [];
			repo.archive.ensure();
			const notice = archiveSearchNotice(repo.archive.state);
			if (notice === undefined) return [];
			// The workbench drops TextSearchComplete.message from this provider API, so show it in the status bar too.
			vscode.window.setStatusBarMessage(notice, 10_000);
			return [notice];
		},
		dispose() {
			for (const repo of attached) repo.dispose();
			attached.clear();
			for (const subscription of subscriptions) subscription.dispose();
		},
	};
}
