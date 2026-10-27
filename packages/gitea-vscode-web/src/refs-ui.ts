import * as vscode from 'vscode';
import { validateBranchName } from '../../gitea-repository/src/index.js';
import { compareUrl, pullRequestFailure, pullRequestText, refKindOf, refLabel, shortRef, suggestBranchName } from './branches.js';
import type { RefKind } from './descriptor.js';
import { RemoteWatcher, clampInterval, type RemoteStatus } from './remote.js';
import type { ScmManager, SessionScm } from './scm.js';
import type { Session } from './session.js';
import type { SessionRegistry } from './sessions.js';
import { messageOf, type CommandResult } from './util.js';

interface RefUiHost {
	scm: ScmManager;
	registry: SessionRegistry;
	pickView(arg?: unknown): Promise<SessionScm | undefined>;
	log(message: string): void;
}

interface RefUi {
	/** Asks for a branch name after a protected branch refused a commit; undefined when cancelled. */
	promptNewBranch(view: SessionScm): Promise<string | undefined>;
	/** Offers a pull request (and the switch) after a commit to a new branch; does not wait for the answer. */
	offerPullRequest(view: SessionScm, commit: { branch: string; sha: string; message: string }): void;
	remoteStatus(session: Session): RemoteStatus | undefined;
}

interface RefArgs {
	ref?: string;
	refKind?: RefKind;
	confirmed?: boolean;
	name?: string;
	head?: string;
	base?: string;
	title?: string;
	body?: string;
	message?: string;
}

const KINDS = new Set<string>(['branch', 'tag', 'commit']);

function argsOf(arg: unknown): RefArgs {
	return arg !== null && typeof arg === 'object' && !('inputBox' in arg) ? (arg as RefArgs) : {};
}

function branchNameError(name: string): string | undefined {
	try {
		validateBranchName(name);
		return undefined;
	} catch {
		return 'Not a valid branch name.';
	}
}

/** The pull request page; a URL the server returned is used only when it is on the instance. */
function pullRequestPage(session: Session, created: { number: number; url: string }): string {
	const { instance, owner, repository } = session.descriptor;
	try {
		if (new URL(created.url).origin === new URL(instance).origin) return created.url;
	} catch {
		// Not a URL; use the page on the instance.
	}
	return `${instance}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${created.number}`;
}

interface RefPick extends vscode.QuickPickItem {
	action?: 'create';
	ref?: { name: string; kind: RefKind };
}

export function registerRefUi(context: vscode.ExtensionContext, host: RefUiHost): RefUi {
	const { scm, registry, log } = host;
	const item = vscode.window.createStatusBarItem('gitea.ref', vscode.StatusBarAlignment.Left, 100);
	item.name = 'Gitea Ref';
	item.command = 'gitea.switchRef';
	context.subscriptions.push(item);
	const watchers = new Map<Session, RemoteWatcher>();
	const prompted = new Map<Session, string>();

	const config = () => vscode.workspace.getConfiguration('giteaWebIde');
	const primary = (): Session | undefined => scm.views[0]?.session;

	const renderStatusBar = (): void => {
		const session = primary();
		if (!session) {
			item.hide();
			return;
		}
		const remote = watchers.get(session)?.status;
		const { owner, repository } = session.descriptor;
		const behind = remote === undefined ? '' : ` $(arrow-down)${remote.incoming ?? ''}`;
		item.text = `${refLabel(session.descriptor)}${behind}`;
		item.tooltip = remote === undefined
			? `${owner}/${repository} at ${shortRef(session.descriptor)}. Click to switch branch or tag.`
			: `${owner}/${repository}: the remote branch has ${remote.incoming === undefined ? 'new' : remote.incoming} new commit(s). Click to switch branch or tag.`;
		item.show();
	};

	const viewOf = (session: Session) => scm.views.find((view) => view.session === session);

	const promptUpdate = async (session: Session, status: RemoteStatus): Promise<void> => {
		const branch = session.state.branch ?? shortRef(session.descriptor);
		const count = status.incoming === undefined ? 'New commits' : `${status.incoming} new commit(s)`;
		const choice = await vscode.window.showInformationMessage(`${count} on ${branch}. Update?`, 'Update');
		const view = viewOf(session);
		if (choice === 'Update' && view) await vscode.commands.executeCommand('gitea.refresh', view.sourceControl);
	};

	const watch = (session: Session): void => {
		if (watchers.has(session)) return;
		const watcher = new RemoteWatcher({
			session,
			enabled: () => config().get<boolean>('autoFetch.enabled', true),
			intervalSeconds: () => clampInterval(config().get<number>('autoFetch.interval')),
			isFocused: () => vscode.window.state.focused,
			log,
			onChange: (status) => {
				renderStatusBar();
				if (status === undefined || prompted.get(session) === status.head) return;
				prompted.set(session, status.head);
				void promptUpdate(session, status);
			},
		});
		watchers.set(session, watcher);
		watcher.start();
		context.subscriptions.push(
			{ dispose: () => watcher.stop() },
			{ dispose: session.overlay.onDidChange((event) => {
				if (event.reason === 'rebase' || event.reason === 'commit' || event.reason === 'reload') watcher.baseMoved();
			}) },
		);
	};

	context.subscriptions.push(
		{ dispose: registry.onDidOpen((session) => {
			watch(session);
			renderStatusBar();
		}) },
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) for (const watcher of watchers.values()) watcher.focusGained();
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('giteaWebIde.autoFetch')) for (const watcher of watchers.values()) watcher.restart();
		}),
	);
	for (const session of registry.sessions) watch(session);
	renderStatusBar();

	const openRef = async (name: string, kind: RefKind): Promise<CommandResult> => {
		try {
			await vscode.commands.executeCommand('giteaHost.openRef', { ref: name, refKind: kind });
			return { ok: true, ref: name, refKind: kind };
		} catch (error) {
			void vscode.window.showErrorMessage(`Cannot open ${name}: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
	};

	const listRefs = async (session: Session): Promise<{ branches: string[]; tags: string[]; truncated: boolean }> => {
		const [branches, tags] = await Promise.all([session.refs.listBranches(), session.refs.listTagRefs()]);
		return {
			branches: branches.branches.map((ref) => ref.name),
			tags: tags.branches.map((ref) => ref.name),
			truncated: branches.truncated || tags.truncated,
		};
	};

	const pickRef = async (session: Session): Promise<RefPick | undefined> => {
		const current = session.descriptor;
		const picks = vscode.window.createQuickPick<RefPick>();
		picks.placeholder = 'Select a branch or tag to open, or create a branch';
		picks.busy = true;
		picks.items = [{ label: '$(add) Create new branch...', action: 'create' }];
		const done = new Promise<RefPick | undefined>((resolve) => {
			picks.onDidAccept(() => resolve(picks.selectedItems[0]));
			picks.onDidHide(() => resolve(undefined));
		});
		picks.show();
		try {
			const { branches, tags } = await listRefs(session);
			const here = shortRef(current);
			const rows = (names: string[], kind: RefKind): RefPick[] =>
				names.map((name) => ({
					label: `${kind === 'tag' ? '$(tag)' : '$(git-branch)'} ${name}`,
					description: name === here && refKindOf(current) === kind ? 'current' : undefined,
					ref: { name, kind },
				}));
			picks.items = [
				{ label: '$(add) Create new branch...', action: 'create' },
				{ label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
				...rows(branches, 'branch'),
				{ label: 'Tags', kind: vscode.QuickPickItemKind.Separator },
				...rows(tags, 'tag'),
			];
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not list branches and tags: ${messageOf(error)}`);
			picks.hide();
		} finally {
			picks.busy = false;
		}
		const picked = await done;
		picks.dispose();
		return picked;
	};

	const createBranch = async (arg?: unknown): Promise<CommandResult> => {
		const view = await host.pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const { session } = view;
		let name = argsOf(arg).name;
		if (name === undefined) {
			name = await vscode.window.showInputBox({
				prompt: `New branch from ${shortRef(session.descriptor)}; pending changes move to it`,
				ignoreFocusOut: true,
				validateInput: (value) => branchNameError(value),
			});
			if (name === undefined) return { ok: false, cancelled: true };
		}
		try {
			// Pending changes move to the new branch only once it opens; otherwise they move back.
			const created = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Creating branch ${name}` },
				() => session.createBranch(name as string, async (branch) => {
					log(`created branch ${branch.name} at ${branch.commit}`);
					try {
						await vscode.commands.executeCommand('giteaHost.openRef', { ref: branch.name, refKind: 'branch' });
					} catch (error) {
						throw new Error(`branch ${branch.name} was created but cannot be opened: ${messageOf(error)}`);
					}
				}),
			);
			return { ok: true, ref: created.name, refKind: 'branch', name: created.name, commit: created.commit };
		} catch (error) {
			const code = (error as { code?: unknown } | null)?.code;
			void vscode.window.showErrorMessage(`Create branch failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error), code: code ?? null };
		}
	};

	const switchRef = async (arg?: unknown): Promise<CommandResult> => {
		const view = await host.pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const { session } = view;
		const args = argsOf(arg);
		let target: { name: string; kind: RefKind } | undefined;
		if (typeof args.ref === 'string' && args.refKind !== undefined && KINDS.has(args.refKind)) {
			target = { name: args.ref, kind: args.refKind };
		} else {
			const picked = await pickRef(session);
			if (!picked) return { ok: false, cancelled: true };
			if (picked.action === 'create') return createBranch(arg);
			target = picked.ref && { name: picked.ref.name, kind: picked.ref.kind };
		}
		if (!target) return { ok: false, cancelled: true };
		const pending = session.overlay.size;
		if (pending > 0 && args.confirmed !== true) {
			const choice = await vscode.window.showWarningMessage(
				`${pending} pending change(s) stay on ${shortRef(session.descriptor)} and are not carried to ${target.name}.`,
				{ modal: true },
				'Switch',
			);
			if (choice !== 'Switch') return { ok: false, cancelled: true };
		}
		return openRef(target.name, target.kind);
	};

	const createPullRequest = async (arg?: unknown): Promise<CommandResult> => {
		const view = await host.pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const { session } = view;
		const args = argsOf(arg);
		const head = args.head ?? session.state.branch;
		if (head === null || head === undefined) return { ok: false, error: 'Open a branch to create a pull request.' };
		try {
			const base = args.base ?? (await session.refs.defaultBranch());
			if (base === head) {
				void vscode.window.showErrorMessage(`${head} is the base branch; switch to the branch with your changes first.`);
				return { ok: false, error: 'Head and base are the same branch.' };
			}
			let title = args.title;
			if (title === undefined) {
				title = await vscode.window.showInputBox({ prompt: `Pull request title (${head} into ${base})`, value: head, ignoreFocusOut: true });
				if (title === undefined) return { ok: false, cancelled: true };
			}
			const text = title;
			const instance = session.descriptor.instance;
			const { owner, repository } = session.descriptor;
			try {
				const created = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Creating pull request' },
					() => session.refs.createPullRequest({ head, base, title: text, body: args.body }),
				);
				log(`created pull request #${created.number} ${head} -> ${base}`);
				const buttons = head === session.state.branch ? ['Open Pull Request'] : ['Open Pull Request', 'Switch to Branch'];
				void vscode.window.showInformationMessage(`Created pull request #${created.number}.`, ...buttons).then((choice) => {
					if (choice === 'Open Pull Request') void vscode.env.openExternal(vscode.Uri.parse(pullRequestPage(session, created)));
					else if (choice === 'Switch to Branch') void openRef(head, 'branch');
				});
				return { ok: true, number: created.number, url: created.url, head, base };
			} catch (error) {
				const link = compareUrl(instance, owner, repository, base, head);
				const status = (error as { status?: unknown } | null)?.status ?? null;
				log(`create pull request failed (${String(status)}): ${messageOf(error)}`);
				void vscode.window.showWarningMessage(pullRequestFailure(error), 'Open Compare Page').then((choice) => {
					if (choice === 'Open Compare Page') void vscode.env.openExternal(vscode.Uri.parse(link));
				});
				return { ok: false, error: messageOf(error), status, compareUrl: link };
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Create pull request failed: ${messageOf(error)}`);
			return { ok: false, error: messageOf(error) };
		}
	};

	const checkRemote = async (arg?: unknown): Promise<CommandResult> => {
		const view = await host.pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const watcher = watchers.get(view.session);
		if (!watcher) return { ok: false, error: 'No remote check is running for this repository.' };
		try {
			const status = await watcher.check();
			return { ok: true, behind: status !== undefined, head: status?.head ?? null, incoming: status?.incoming ?? null };
		} catch (error) {
			return { ok: false, error: messageOf(error) };
		}
	};

	const commitToNewBranch = async (arg?: unknown): Promise<CommandResult> => {
		const view = await host.pickView(arg);
		if (!view) return { ok: false, error: 'No Gitea repository is open.' };
		const args = argsOf(arg);
		const name = args.name ?? (await promptName(view, 'Commit to a new branch'));
		if (name === undefined) return { ok: false, cancelled: true };
		return vscode.commands.executeCommand<CommandResult>('gitea.commit', { message: args.message, newBranch: name });
	};

	const promptName = async (view: SessionScm, title: string): Promise<string | undefined> => {
		const { session } = view;
		let taken = new Set<string>();
		try {
			taken = new Set((await listRefs(session)).branches);
		} catch {
			// The suggestion is only a convenience.
		}
		const branch = session.state.branch ?? shortRef(session.descriptor);
		return vscode.window.showInputBox({
			title,
			prompt: 'Name of the new branch',
			value: suggestBranchName(branch, taken),
			ignoreFocusOut: true,
			validateInput: (value) => branchNameError(value) ?? (taken.has(value) ? 'A branch with that name exists.' : undefined),
		});
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('gitea.switchRef', switchRef),
		vscode.commands.registerCommand('gitea.createBranch', createBranch),
		vscode.commands.registerCommand('gitea.commitToNewBranch', commitToNewBranch),
		vscode.commands.registerCommand('gitea.createPullRequest', createPullRequest),
		vscode.commands.registerCommand('gitea.checkRemote', checkRemote),
	);

	return {
		promptNewBranch: (view) => promptName(view, `${view.session.state.branch ?? 'This branch'} does not accept direct commits`),
		offerPullRequest: (view, commit) => {
			const { session } = view;
			const base = session.state.branch;
			const short = commit.sha.slice(0, 8);
			void vscode.window
				.showInformationMessage(`Committed ${short} to new branch ${commit.branch}.`, 'Create Pull Request', 'Switch to Branch')
				.then((choice) => {
					if (choice === 'Switch to Branch') void openRef(commit.branch, 'branch');
					else if (choice === 'Create Pull Request' && base !== null) {
						void createPullRequest({ head: commit.branch, base, ...pullRequestText(commit.message) });
					}
				});
		},
		remoteStatus: (session) => watchers.get(session)?.status,
	};
}
