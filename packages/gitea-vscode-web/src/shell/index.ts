import * as vscode from 'vscode';
import { vfsUri } from '../filesystem.js';
import type { Session } from '../session.js';
import { VfsFileSystem } from './fs.js';
import { indexPaths } from './path-index.js';
import { GiteaShell } from './shell.js';
import { ShellTerminal } from './terminal.js';

/** A terminal name and pseudoterminal running the virtual shell on the session's repository overlay. */
export function shellTerminal(session: Session): { name: string; pty: vscode.Pseudoterminal } {
	const { owner, repository, ref } = session.descriptor;
	const fs = new VfsFileSystem(vscode.workspace.fs, (path) => vfsUri(session, path));
	const stopIndexing = indexPaths(session, fs);
	const written = new vscode.EventEmitter<string>();
	const closed = new vscode.EventEmitter<number>();
	const shell = new GiteaShell({ fs, label: `${owner}/${repository}@${ref}`, pending: () => session.overlay.list() });
	const terminal = new ShellTerminal(shell, { write: (data) => written.fire(data), close: (code) => closed.fire(code) });
	const pty: vscode.Pseudoterminal = {
		onDidWrite: written.event,
		onDidClose: closed.event,
		open: (dimensions) => terminal.open(dimensions?.columns),
		close: () => {
			terminal.dispose();
			stopIndexing();
			written.dispose();
			closed.dispose();
		},
		handleInput: (data) => terminal.handleInput(data),
		setDimensions: (dimensions) => terminal.setDimensions(dimensions.columns),
	};
	return { name: `Gitea: ${owner}/${repository}`, pty };
}

/** Opens a terminal running the virtual shell. */
export function openShell(session: Session): vscode.Terminal {
	const { name, pty } = shellTerminal(session);
	const created = vscode.window.createTerminal({ name, pty, isTransient: true });
	created.show();
	return created;
}
