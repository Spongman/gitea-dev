import * as vscode from 'vscode';
import { AuthRegistry, FallbackSecrets, type OAuthConfiguration } from './auth.js';
import { createArchiveSupport } from './archive-ui.js';
import { BASE_SCHEME, SCHEME, descriptorIdentity, parseDescriptor, queryForUri, type Descriptor } from './descriptor.js';
import { SubmoduleDecorations } from './decorations.js';
import { GiteaBaseFileSystemProvider, GiteaFileSystemProvider, vfsUri } from './filesystem.js';
import { OverlayError, broadcastChannel, type ChangeOverlay, type Conflict } from './overlay.js';
import { refKindOf } from './branches.js';
import { registerRefUi } from './refs-ui.js';
import { ScmManager, type PendingCounts, type SessionScm } from './scm.js';
import type { Session } from './session.js';
import { GiteaSearchProvider } from './search.js';
import { SessionRegistry } from './sessions.js';
import { FileStagedStore } from './staged.js';
import { globalFiles } from './global-files.js';
import { registerSyncAuthentication, signInWithCommands } from './sync-auth.js';
import { AutoSettingsSync } from './sync-auto.js';
import { ThemeConfirmation } from './theme-confirm.js';
import { FileOverlayStorage } from './storage.js';
import { messageOf, pathOf, type CommandResult } from './util.js';

export interface GiteaExtensionApi {
	registry: SessionRegistry;
	/** Opens or reuses the session for a gitea-vfs URI. */
	resolveSession(uri: vscode.Uri): Promise<Session>;
	/** Merged view of the remote tree and local changes for a gitea-vfs URI. */
	resolveOverlay(uri: vscode.Uri): Promise<ChangeOverlay>;
}

export interface GiteaStatus {
	activated: true;
	ready: boolean;
	instance: string | null;
	owner: string | null;
	repository: string | null;
	ref: string | null;
	refKind: 'branch' | 'tag' | 'commit' | null;
	baseCommit: string | null;
	branch: string | null;
	canWrite: boolean;
	canBranch: boolean;
	/** Change paths staged for the next commit. */
	staged: string[];
	/** Set while the remote branch is ahead of the base. */
	remote: { head: string; incoming: number | null } | null;
	readonly: boolean;
	pending: number;
	counts: PendingCounts;
	conflicts: Conflict[];
	auth: 'pat' | 'oauth' | null;
	web: boolean;
	trusted: boolean;
	remoteName: string | null;
	terminals: number;
	failure: string | null;
	/** Archive prefetch state of the first session, for example 'ready'. */
	archive: string | null;
}

const EMPTY_COUNTS: PendingCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, conflicts: 0 };

function isUri(value: unknown): value is vscode.Uri {
	return value instanceof vscode.Uri;
}

export function activate(context: vscode.ExtensionContext): GiteaExtensionApi {
	const output = vscode.window.createOutputChannel('Gitea Web IDE');
	const log = (message: string) => output.appendLine(message);
	context.subscriptions.push(output);
	log('gitea-vscode-web activated');

	const secrets = new FallbackSecrets({
		get: (key) => Promise.resolve(context.secrets.get(key)),
		set: (key, value) => Promise.resolve(context.secrets.store(key, value)),
		delete: (key) => Promise.resolve(context.secrets.delete(key)),
	});
	const auth = new AuthRegistry(secrets, undefined, async (url) => {
		try {
			return await vscode.commands.executeCommand<string | undefined>('giteaHost.oauthAuthorizeSilent', url);
		} catch {
			return undefined;
		}
	});
	const credentialsChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(credentialsChanged);
	const oauthConfiguration = async (): Promise<OAuthConfiguration | undefined> => {
		try {
			return await vscode.commands.executeCommand<OAuthConfiguration | undefined>('giteaHost.authConfiguration');
		} catch {
			return undefined;
		}
	};
	const files = globalFiles(context.globalStorageUri);
	const archive = createArchiveSupport(log);
	context.subscriptions.push(archive);
	const registry = new SessionRegistry({
		storage: new FileOverlayStorage(files),
		auth,
		oauthConfiguration,
		log,
		createRepository: archive.createRepository,
		channel: broadcastChannel(),
	});
	const stagedStore = new FileStagedStore(files);
	const scm = new ScmManager();
	context.subscriptions.push(scm);

	// Register before any await so the workbench never sees an unknown scheme.
	const provider = new GiteaFileSystemProvider(registry);
	context.subscriptions.push(
		provider,
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
		vscode.workspace.registerFileSystemProvider(BASE_SCHEME, new GiteaBaseFileSystemProvider(registry), {
			isCaseSensitive: true,
			isReadonly: true,
		}),
		vscode.window.registerFileDecorationProvider(scm),
		vscode.window.registerFileDecorationProvider(new SubmoduleDecorations(registry)),
	);
	const search = new GiteaSearchProvider(
		async (uri) => (await registry.resolve(queryForUri(uri))).overlay,
		{},
		async (folder, kind, token) => archive.prepareSearch(await registry.resolve(queryForUri(folder)), kind, token),
	);
	context.subscriptions.push(
		vscode.workspace.registerFileSearchProvider(SCHEME, search),
		vscode.workspace.registerTextSearchProvider(SCHEME, search),
	);
	context.subscriptions.push({
		dispose: registry.onDidOpen((session) => {
			scm.attach(session, stagedStore, log);
			archive.attach(session);
			log(`ready: ${session.descriptor.owner}/${session.descriptor.repository}@${session.descriptor.ref} base=${session.baseCommit}`);
		}),
	});

	const folderDescriptors = (): { descriptor: Descriptor; uri: vscode.Uri }[] => {
		const found: { descriptor: Descriptor; uri: vscode.Uri }[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== SCHEME) continue;
			try {
				found.push({ descriptor: parseDescriptor(queryForUri(folder.uri)), uri: folder.uri });
			} catch (error) {
				log(`invalid launch descriptor: ${messageOf(error)}`);
			}
		}
		return found;
	};
	const openFolders = () => {
		for (const { uri } of folderDescriptors()) {
			registry.resolve(queryForUri(uri)).catch((error: unknown) => log(`open failed: ${messageOf(error)}`));
		}
	};
	openFolders();
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(openFolders));

	const pickView = async (arg?: unknown): Promise<SessionScm | undefined> => {
		if (arg && typeof arg === 'object') {
			if ('inputBox' in arg) {
				const view = scm.forSourceControl(arg as vscode.SourceControl);
				if (view) return view;
			}
			const uri = isUri(arg) ? arg : (arg as { resourceUri?: unknown }).resourceUri;
			if (isUri(uri)) {
				const view = scm.forUri(uri);
				if (view) return view;
			}
		}
		if (scm.views.length === 0) await registry.settled();
		const views = scm.views;
		if (views.length <= 1) return views[0];
		const picked = await vscode.window.showQuickPick(
			views.map((view) => ({
				label: `${view.session.descriptor.owner}/${view.session.descriptor.repository}`,
				description: view.session.descriptor.ref,
				view,
			})),
			{ placeHolder: 'Select a repository' },
		);
		return picked?.view;
	};

	const ui = registerRefUi(context, { scm, registry, pickView, log });

	const pickInstance = async (): Promise<{ instance: string } | undefined> => {
		const instances = [...new Set(folderDescriptors().map((f) => f.descriptor.instance))];
		for (const session of registry.sessions) {
			if (!instances.includes(session.descriptor.instance)) instances.push(session.descriptor.instance);
		}
		if (instances.length <= 1) return instances[0] === undefined ? undefined : { instance: instances[0] };
		const picked = await vscode.window.showQuickPick(instances, { placeHolder: 'Select a Gitea instance' });
		return picked === undefined ? undefined : { instance: picked };
	};

	/** Re-reads everything after credentials change. */
	const reloadAfterAuth = async (instance: string): Promise<void> => {
		for (const { descriptor, uri } of folderDescriptors()) {
			if (descriptor.instance !== instance) continue;
			try {
				const open = registry.sessions.find((s) => descriptorIdentity(s.descriptor) === descriptorIdentity(descriptor));
				if (open) await open.refresh();
				else await registry.resolve(queryForUri(uri));
				provider.refresh(uri);
			} catch (error) {
				log(`reload after sign-in failed: ${messageOf(error)}`);
			}
		}
	};

	const status = async (): Promise<GiteaStatus> => {
		await registry.settled();
		const view = scm.views[0];
		const session = view?.session;
		const failure = registry.lastFailure;
		const remote = session ? ui.remoteStatus(session) : undefined;
		return {
			activated: true,
			ready: session !== undefined,
			instance: session?.descriptor.instance ?? null,
			owner: session?.descriptor.owner ?? null,
			repository: session?.descriptor.repository ?? null,
			ref: session?.descriptor.ref ?? null,
			refKind: session ? refKindOf(session.descriptor) : null,
			baseCommit: session?.baseCommit ?? null,
			branch: session?.state.branch ?? null,
			canWrite: session?.state.canWrite ?? false,
			canBranch: session?.state.canBranch ?? false,
			staged: view?.stagedPaths() ?? [],
			remote: remote === undefined ? null : { head: remote.head, incoming: remote.incoming ?? null },
			readonly: session?.readonlyHint ?? false,
			pending: session?.overlay.size ?? 0,
			counts: view?.counts() ?? EMPTY_COUNTS,
			conflicts: [...(session?.overlay.conflicts ?? [])],
			auth: session ? (auth.kind(session.descriptor.instance) ?? null) : null,
			web: vscode.env.uiKind === vscode.UIKind.Web,
			trusted: vscode.workspace.isTrusted,
			remoteName: vscode.env.remoteName ?? null,
			terminals: vscode.window.terminals.length,
			failure: failure === undefined ? null : messageOf(failure),
			archive: session === undefined ? null : archive.stateOf(session),
		};
	};

	const commit = async (arg?: unknown): Promise<CommandResult> => {
		let message: string | undefined;
		let target: unknown = arg;
		let newBranch: string | undefined;
		if (typeof arg === 'string') {
			message = arg;
			target = undefined;
		} else if (arg && typeof arg === 'object' && typeof (arg as { message?: unknown }).message === 'string') {
			message = (arg as { message: string }).message;
		}
		if (arg && typeof arg === 'object' && typeof (arg as { newBranch?: unknown }).newBranch === 'string') {
			newBranch = (arg as { newBranch: string }).newBranch;
		}
		const view = await pickView(target);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const { session, sourceControl } = view;
		if (message === undefined || message.trim() === '') message = sourceControl.inputBox.value;
		if (message.trim() === '') {
			const entered = await vscode.window.showInputBox({
				prompt: `Commit message for ${session.descriptor.ref}`,
				ignoreFocusOut: true,
				validateInput: (value) => (value.trim() === '' ? 'A commit message is required.' : undefined),
			});
			if (entered === undefined) return { ok: false, cancelled: true };
			message = entered;
		}
		const text = message;
		const paths = await view.commitPaths(async () => {
			const detail = `The staged changes could not be loaded. Commit all ${session.overlay.size} pending change(s)?`;
			return (await vscode.window.showWarningMessage(detail, { modal: true }, 'Commit All')) === 'Commit All';
		});
		if (paths === null) return { ok: false, cancelled: true };
		try {
			let result: Awaited<ReturnType<Session['commit']>> | undefined;
			while (result === undefined) {
				try {
					const branch = newBranch;
					result = await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.SourceControl, title: 'Committing to Gitea' },
						() => session.commit(text, { paths, newBranch: branch }),
					);
				} catch (error) {
					if (!(error instanceof OverlayError && error.code === 'Protected' && newBranch === undefined)) throw error;
					newBranch = await ui.promptNewBranch(view);
					if (newBranch === undefined) return { ok: false, cancelled: true, code: error.code };
				}
			}
			sourceControl.inputBox.value = '';
			log(`committed ${result.sha} to ${result.branch} (${result.changes} change(s))`);
			if (newBranch === undefined) {
				void vscode.window.showInformationMessage(`Committed ${result.sha.slice(0, 8)} to ${session.descriptor.ref}.`);
			} else {
				ui.offerPullRequest(view, { branch: result.branch, sha: result.sha, message: text });
			}
			return { ok: true, sha: result.sha, changes: result.changes, baseCommit: session.baseCommit, branch: result.branch, newBranch: newBranch !== undefined };
		} catch (error) {
			const code = error instanceof OverlayError ? error.code : (error as { code?: unknown } | null)?.code;
			const conflicts = error instanceof OverlayError ? error.conflicts : [];
			const shown = conflicts.length > 0
				? `${conflicts.length} file(s) conflict with the remote branch; local changes were kept. Resolve them in Source Control.`
				: messageOf(error);
			log(`commit failed (${String(code)}): ${messageOf(error)}`);
			void vscode.window.showErrorMessage(`Commit failed: ${shown}`);
			return { ok: false, error: messageOf(error), code: code ?? null, conflicts };
		}
	};

	const refresh = async (arg?: unknown): Promise<CommandResult> => {
		const view = await pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		try {
			const result = await view.session.refresh();
			provider.refresh(vfsUri(view.session, ''));
			if (result.conflicts.length > 0) {
				void vscode.window.showWarningMessage(`${result.conflicts.length} change(s) conflict with the remote branch.`);
			}
			return { ok: true, ...result };
		} catch (error) {
			void vscode.window.showErrorMessage(`Refresh failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
	};

	const confirm = async (detail: string, confirmed: boolean): Promise<boolean> => {
		if (confirmed) return true;
		return (await vscode.window.showWarningMessage(detail, { modal: true }, 'Discard')) === 'Discard';
	};

	const discardChange = async (...args: unknown[]): Promise<CommandResult> => {
		const uris: vscode.Uri[] = [];
		let confirmed = false;
		for (const arg of args.flat()) {
			if (isUri(arg)) uris.push(arg);
			else if (arg && typeof arg === 'object') {
				const resource = (arg as { resourceUri?: unknown }).resourceUri;
				if (isUri(resource)) uris.push(resource);
				else if ((arg as { confirmed?: unknown }).confirmed === true) confirmed = true;
			}
		}
		const view = await pickView(uris[0]);
		if (!view || uris.length === 0) return { ok: false, error: 'No change selected.' };
		const paths = uris.map(pathOf);
		const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
		if (!(await confirm(`Discard local changes to ${label}? This cannot be undone.`, confirmed))) {
			return { ok: false, cancelled: true };
		}
		try {
			for (const path of paths) await view.session.overlay.discard(path);
			return { ok: true, discarded: paths };
		} catch (error) {
			void vscode.window.showErrorMessage(`Discard failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
	};

	const discardAll = async (...args: unknown[]): Promise<CommandResult> => {
		const confirmed = args.some((a) => a && typeof a === 'object' && (a as { confirmed?: unknown }).confirmed === true);
		const view = await pickView(args[0]);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const count = view.session.overlay.size;
		if (count === 0) return { ok: true, discarded: 0 };
		if (!(await confirm(`Discard all ${count} pending change(s)? This cannot be undone.`, confirmed))) {
			return { ok: false, cancelled: true };
		}
		try {
			await view.session.overlay.discardAll();
			return { ok: true, discarded: count };
		} catch (error) {
			void vscode.window.showErrorMessage(`Discard failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
	};

	const resourceUris = (args: unknown[]): vscode.Uri[] => {
		const uris: vscode.Uri[] = [];
		for (const arg of args.flat()) {
			if (isUri(arg)) uris.push(arg);
			else if (arg && typeof arg === 'object' && isUri((arg as { resourceUri?: unknown }).resourceUri)) {
				uris.push((arg as { resourceUri: vscode.Uri }).resourceUri);
			}
		}
		return uris;
	};

	const staging = (action: 'stage' | 'unstage' | 'stageAll' | 'unstageAll') => async (...args: unknown[]): Promise<CommandResult> => {
		const uris = resourceUris(args);
		const view = await pickView(uris[0] ?? args[0]);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const paths = uris.map(pathOf);
		await view.loaded;
		if (action === 'stage') await view.stage(paths);
		else if (action === 'unstage') await view.unstage(paths);
		else if (action === 'stageAll') await view.stageAll();
		else await view.unstageAll();
		return { ok: true, staged: view.stagedPaths() };
	};

	const openFile = async (...args: unknown[]): Promise<CommandResult> => {
		for (const uri of resourceUris(args)) await vscode.commands.executeCommand('vscode.open', uri);
		return { ok: true };
	};
	/** Runs the command a changed file's row runs on click: its diff, or the file for an added one. */
	const openChanges = async (...args: unknown[]): Promise<CommandResult> => {
		for (const arg of args.flat()) {
			const command = (arg as { command?: vscode.Command } | undefined)?.command;
			if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		}
		return { ok: true };
	};

	const signIn = async (): Promise<CommandResult> => {
		const target = await pickInstance();
		if (!target) return { ok: false, error: 'No Gitea instance is open.' };
		const token = await vscode.window.showInputBox({
			prompt: `Personal access token for ${target.instance}`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() === '' ? 'A token is required.' : undefined),
		});
		if (token === undefined) return { ok: false, cancelled: true };
		try {
			await auth.signInPat(target.instance, token);
		} catch (error) {
			void vscode.window.showErrorMessage(`Sign-in failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
		if (secrets.degraded) log('Secret storage is unavailable; the token is kept in memory only.');
		await reloadAfterAuth(target.instance);
		credentialsChanged.fire();
		return { ok: true, auth: 'pat', instance: target.instance };
	};

	const signInOAuth = async (): Promise<CommandResult> => {
		const target = await pickInstance();
		if (!target) return { ok: false, error: 'No Gitea instance is open.' };
		const config = await oauthConfiguration();
		if (!config) {
			void vscode.window.showErrorMessage('OAuth sign-in is not configured for this editor.');
			return { ok: false, error: 'OAuth is not configured.' };
		}
		try {
			await auth.signInOAuth(target.instance, config, async (url) => {
				const callback = await vscode.commands.executeCommand<string | undefined>('giteaHost.oauthAuthorize', url);
				if (!callback) throw new Error('Authorization was cancelled.');
				return callback;
			});
		} catch (error) {
			void vscode.window.showErrorMessage(`Sign-in failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
		await reloadAfterAuth(target.instance);
		credentialsChanged.fire();
		return { ok: true, auth: 'oauth', instance: target.instance };
	};

	const signOut = async (): Promise<CommandResult> => {
		const target = await pickInstance();
		if (!target) return { ok: false, error: 'No Gitea instance is open.' };
		await auth.signOut(target.instance);
		await reloadAfterAuth(target.instance);
		credentialsChanged.fire();
		return { ok: true, instance: target.instance };
	};

	/** The shell code loads on first use. */
	const openShell = async (arg?: unknown): Promise<CommandResult> => {
		const view = await pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const shell = await import('./shell/index.js');
		context.subscriptions.push(shell.openShell(view.session));
		return { ok: true };
	};
	const syncInstance = folderDescriptors()[0]?.descriptor.instance;
	if (syncInstance !== undefined) {
		const autoSync = new AutoSettingsSync({ instance: syncInstance, state: context.globalState, commands: vscode.commands, window: vscode.window, log });
		const themeConfirmation = new ThemeConfirmation({ instance: syncInstance, commands: vscode.commands, window: vscode.window, log });
		const syncAuth = registerSyncAuthentication(vscode, {
			instance: syncInstance,
			onSession: (session, authorization) => { void autoSync.onSession(session, authorization); void themeConfirmation.onSession(authorization); },
			headers: async () => {
				await auth.restore(syncInstance, await oauthConfiguration());
				return auth.forInstance(syncInstance).headers();
			},
			signIn: signInWithCommands(vscode.commands),
			signOut: async () => {
				await auth.signOut(syncInstance);
				await reloadAfterAuth(syncInstance);
				credentialsChanged.fire();
			},
			onDidChangeCredentials: credentialsChanged.event,
			log,
		});
		context.subscriptions.push(syncAuth);
		// Credentials restored from secret storage count as a sign-in for automatic sync.
		void syncAuth.provider.refresh();
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('gitea.status', status),
		vscode.commands.registerCommand('gitea.commit', commit),
		vscode.commands.registerCommand('gitea.refresh', refresh),
		vscode.commands.registerCommand('gitea.openFile', openFile),
		vscode.commands.registerCommand('gitea.openChanges', openChanges),
		vscode.commands.registerCommand('gitea.showOutput', () => output.show(true)),
		vscode.commands.registerCommand('gitea.discardChange', discardChange),
		vscode.commands.registerCommand('gitea.discardAll', discardAll),
		vscode.commands.registerCommand('gitea.stage', staging('stage')),
		vscode.commands.registerCommand('gitea.unstage', staging('unstage')),
		vscode.commands.registerCommand('gitea.stageAll', staging('stageAll')),
		vscode.commands.registerCommand('gitea.unstageAll', staging('unstageAll')),
		vscode.commands.registerCommand('gitea.signIn', signIn),
		vscode.commands.registerCommand('gitea.signInOAuth', signInOAuth),
		vscode.commands.registerCommand('gitea.signOut', signOut),
		vscode.commands.registerCommand('gitea.openShell', openShell),
		// The terminal panel's New Terminal starts the same shell.
		vscode.window.registerTerminalProfileProvider('gitea.shell', {
			provideTerminalProfile: async () => {
				const view = await pickView();
				if (!view) return undefined;
				const shell = await import('./shell/index.js');
				return new vscode.TerminalProfile({ ...shell.shellTerminal(view.session), isTransient: true });
			},
		}),
	);

	// Shows the terminal panel's New Terminal button before a terminal exists; the host maps New Terminal to the shell.

	return {
		registry,
		resolveSession: (uri) => registry.resolve(queryForUri(uri)),
		resolveOverlay: async (uri) => (await registry.resolve(queryForUri(uri))).overlay,
	};
}

export function deactivate(): void {}
