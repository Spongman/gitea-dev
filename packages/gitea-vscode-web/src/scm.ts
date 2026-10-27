import * as vscode from 'vscode';
import { refKindOf, shortRef } from './branches.js';
import { BASE_SCHEME, descriptorIdentity, identityForUri } from './descriptor.js';
import { vfsUri } from './filesystem.js';
import type { Conflict, PendingChange } from './overlay.js';
import type { Session } from './session.js';
import type { StagedStore } from './staged.js';
import { messageOf, pathOf } from './util.js';

export interface PendingCounts {
	added: number;
	modified: number;
	deleted: number;
	renamed: number;
	conflicts: number;
}

const BADGES: Record<PendingChange['status'], { badge: string; color: string; label: string }> = {
	added: { badge: 'A', color: 'charts.green', label: 'Added' },
	modified: { badge: 'M', color: 'charts.yellow', label: 'Modified' },
	deleted: { badge: 'D', color: 'charts.red', label: 'Deleted' },
	renamed: { badge: 'R', color: 'charts.blue', label: 'Renamed' },
};

/** Source control view for one session. */
export class SessionScm implements vscode.Disposable {
	readonly session: Session;
	readonly sourceControl: vscode.SourceControl;
	readonly #staged: vscode.SourceControlResourceGroup;
	readonly #changes: vscode.SourceControlResourceGroup;
	readonly #conflicts: vscode.SourceControlResourceGroup;
	readonly #disposables: vscode.Disposable[] = [];
	readonly #decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
	readonly #store: StagedStore | undefined;
	readonly #identity: string;
	/** Settles once the persisted staged set is loaded. */
	readonly loaded: Promise<void>;
	#pending = new Map<string, PendingChange>();
	#conflictByPath = new Map<string, Conflict>();
	#stagedPaths = new Set<string>();
	#loadFailed = false;
	readonly #canCommit: boolean;
	#buttonEnabled: boolean | undefined;

	/** `store` keeps the staged set across reloads. */
	constructor(session: Session, store?: StagedStore, log?: (message: string) => void) {
		this.session = session;
		this.#store = store;
		this.#identity = descriptorIdentity(session.descriptor);
		const { owner, repository } = session.descriptor;
		const name = shortRef(session.descriptor);
		this.#canCommit = refKindOf(session.descriptor) === 'branch' && !session.readonlyHint;
		const root = vfsUri(session, '');
		this.sourceControl = vscode.scm.createSourceControl('gitea', `Gitea ${owner}/${repository}`, root);
		this.sourceControl.inputBox.placeholder = `Message (Ctrl+Enter to commit to ${name})`;
		this.sourceControl.inputBox.validateInput = (value) => this.#validate(value, name);
		this.sourceControl.acceptInputCommand = {
			command: 'gitea.commit',
			title: 'Commit',
			arguments: [this.sourceControl],
		};
		this.sourceControl.quickDiffProvider = {
			provideOriginalResource: (uri) => this.#original(uri),
		};
		this.#conflicts = this.sourceControl.createResourceGroup('conflicts', 'Conflicts');
		this.#staged = this.sourceControl.createResourceGroup('staged', 'Staged Changes');
		this.#changes = this.sourceControl.createResourceGroup('changes', 'Changes');
		this.#conflicts.hideWhenEmpty = true;
		this.#staged.hideWhenEmpty = true;
		this.#disposables.push(
			this.sourceControl,
			this.#staged,
			this.#changes,
			this.#conflicts,
			this.#decorationsChanged,
			{ dispose: session.overlay.onDidChange(() => this.refresh()) },
		);
		this.refresh();
		this.loaded = (store?.load(this.#identity) ?? Promise.resolve([])).then(
			(paths) => {
				for (const path of paths) if (this.#pending.has(path)) this.#stagedPaths.add(path);
				this.refresh();
			},
			(error: unknown) => {
				this.#loadFailed = true;
				log?.(`staged changes could not be loaded: ${messageOf(error)}`);
			},
		);
	}

	get onDidChangeDecorations(): vscode.Event<vscode.Uri[]> {
		return this.#decorationsChanged.event;
	}

	dispose(): void {
		for (const disposable of this.#disposables) disposable.dispose();
	}

	counts(): PendingCounts {
		const counts: PendingCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicts: this.#conflictByPath.size };
		for (const change of this.#pending.values()) counts[change.status] += 1;
		return counts;
	}

	/** Change paths staged for the next commit; empty means a commit takes every change. */
	stagedPaths(): string[] {
		return [...this.#stagedPaths];
	}

	/**
	 * Change paths for the next commit: the staged set, or undefined for every change. When the
	 * staged set failed to load, committing everything needs `confirmAll`; null means declined.
	 */
	async commitPaths(confirmAll: () => PromiseLike<boolean>): Promise<string[] | undefined | null> {
		await this.loaded;
		const staged = this.stagedPaths();
		if (staged.length > 0) return staged;
		if (this.#loadFailed && !(await confirmAll())) return null;
		return undefined;
	}

	/** Stages pending changes by change path; a rename is one entry and stays whole. */
	stage(paths: readonly string[]): Promise<void> {
		for (const path of paths) if (this.#pending.has(path)) this.#stagedPaths.add(path);
		this.refresh();
		return this.#saveStaged();
	}

	unstage(paths: readonly string[]): Promise<void> {
		for (const path of paths) this.#stagedPaths.delete(path);
		this.refresh();
		return this.#saveStaged();
	}

	stageAll(): Promise<void> {
		return this.stage([...this.#pending.keys()]);
	}

	unstageAll(): Promise<void> {
		return this.unstage([...this.#stagedPaths]);
	}

	pendingFor(path: string): PendingChange | undefined {
		return this.#pending.get(path);
	}

	conflictFor(path: string): Conflict | undefined {
		return this.#conflictByPath.get(path);
	}

	refresh(): void {
		const previous = this.#pending;
		const previousConflicts = this.#conflictByPath;
		const list = this.session.overlay.list();
		const conflicts = this.session.overlay.conflicts;
		this.#pending = new Map(list.map((change) => [change.path, change]));
		this.#conflictByPath = new Map(conflicts.map((conflict) => [conflict.path, conflict]));
		const pruned = [...this.#stagedPaths].filter((path) => !this.#pending.has(path));
		if (pruned.length > 0) {
			for (const path of pruned) this.#stagedPaths.delete(path);
			void this.#saveStaged();
		}
		this.#staged.resourceStates = list.filter((change) => this.#stagedPaths.has(change.path)).map((change) => this.#state(change));
		this.#changes.resourceStates = list.filter((change) => !this.#stagedPaths.has(change.path)).map((change) => this.#state(change));
		this.#conflicts.resourceStates = conflicts.map((conflict) => ({
			resourceUri: vfsUri(this.session, conflict.path),
			contextValue: 'conflict',
			decorations: { tooltip: conflict.message, iconPath: new vscode.ThemeIcon('warning') },
			command: { command: 'vscode.open', title: 'Open', arguments: [vfsUri(this.session, conflict.path)] },
		}));
		this.sourceControl.count = list.length + conflicts.length;
		this.#updateButton(this.#canCommit && list.length > 0);
		// Decorations show the status or conflict of a path; only paths where that changed need redrawing.
		const touched = new Set<string>();
		for (const path of new Set([...previous.keys(), ...this.#pending.keys()])) {
			if (previous.get(path)?.status !== this.#pending.get(path)?.status) touched.add(path);
		}
		for (const path of new Set([...previousConflicts.keys(), ...this.#conflictByPath.keys()])) {
			if (previousConflicts.get(path)?.message !== this.#conflictByPath.get(path)?.message) touched.add(path);
		}
		if (touched.size > 0) this.#decorationsChanged.fire([...touched].map((path) => vfsUri(this.session, path)));
	}

	#updateButton(enabled: boolean): void {
		if (enabled === this.#buttonEnabled) return;
		this.#buttonEnabled = enabled;
		const target = [this.sourceControl];
		this.sourceControl.actionButton = {
			command: { command: 'gitea.commit', title: 'Commit', arguments: target },
			secondaryCommands: [[{ command: 'gitea.commitToNewBranch', title: 'Commit to New Branch...', arguments: target }]],
			enabled,
		};
	}

	/** A note under the message box once there is text. */
	#validate(value: string, name: string): vscode.SourceControlInputBoxValidation | undefined {
		if (value.trim() === '') return undefined;
		if (!this.#canCommit) {
			return { message: `${name} is read-only here, so changes cannot be committed to it.`, type: vscode.SourceControlInputBoxValidationType.Information };
		}
		return { message: `The changes will be committed directly to ${name}.`, type: vscode.SourceControlInputBoxValidationType.Information };
	}

	async #saveStaged(): Promise<void> {
		await this.#store?.save(this.#identity, [...this.#stagedPaths]).catch(() => undefined);
	}

	#state(change: PendingChange): vscode.SourceControlResourceState {
		const uri = vfsUri(this.session, change.path);
		const base = (path: string) => vfsUri(this.session, path, BASE_SCHEME);
		const name = change.path.slice(change.path.lastIndexOf('/') + 1);
		let command: vscode.Command;
		if (change.status === 'deleted') {
			command = { command: 'vscode.open', title: 'Open Base', arguments: [base(change.path)] };
		} else if (change.status === 'added') {
			command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
		} else {
			command = {
				command: 'vscode.diff',
				title: 'Open Changes',
				arguments: [base(change.previousPath ?? change.path), uri, `${name} (Base) <-> (Working)`],
			};
		}
		return {
			resourceUri: uri,
			contextValue: change.status,
			command,
			decorations: {
				tooltip: change.previousPath ? `Renamed from ${change.previousPath}` : BADGES[change.status].label,
				strikeThrough: change.status === 'deleted',
			},
		};
	}

	#original(uri: vscode.Uri): vscode.Uri | undefined {
		const change = this.#pending.get(pathOf(uri));
		if (change?.status !== 'modified' && change?.status !== 'renamed') return undefined;
		return vfsUri(this.session, change.previousPath ?? change.path, BASE_SCHEME);
	}
}

/** Owns the SCM views and the explorer decorations for all sessions. */
export class ScmManager implements vscode.FileDecorationProvider, vscode.Disposable {
	readonly #views = new Map<string, SessionScm>();
	readonly #emitter = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.#emitter.event;

	attach(session: Session, store?: StagedStore, log?: (message: string) => void): SessionScm {
		const view = new SessionScm(session, store, log);
		view.onDidChangeDecorations((uris) => this.#emitter.fire(uris));
		this.#views.set(descriptorIdentity(session.descriptor), view);
		return view;
	}

	get views(): SessionScm[] {
		return [...this.#views.values()];
	}

	forSourceControl(control: vscode.SourceControl): SessionScm | undefined {
		return this.views.find((view) => view.sourceControl === control);
	}

	forUri(uri: vscode.Uri): SessionScm | undefined {
		try {
			return this.#views.get(identityForUri(uri));
		} catch {
			return undefined;
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const view = this.forUri(uri);
		if (!view) return undefined;
		const path = pathOf(uri);
		const conflict = view.conflictFor(path);
		if (conflict) {
			return new vscode.FileDecoration('!', conflict.message, new vscode.ThemeColor('list.errorForeground'));
		}
		const change = view.pendingFor(path);
		if (!change) return undefined;
		const { badge, color, label } = BADGES[change.status];
		const decoration = new vscode.FileDecoration(badge, label, new vscode.ThemeColor(color));
		decoration.propagate = true;
		return decoration;
	}

	dispose(): void {
		for (const view of this.#views.values()) view.dispose();
		this.#views.clear();
		this.#emitter.dispose();
	}
}
