import * as vscode from 'vscode';
import { SCHEME } from './descriptor.js';
import type { SessionRegistry } from './sessions.js';

/** Marks submodule entries in the Explorer, with the commit they point at in the tooltip. */
export class SubmoduleDecorations implements vscode.FileDecorationProvider {
	readonly #registry: SessionRegistry;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
	}

	async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
		if (uri.scheme !== SCHEME) return undefined;
		try {
			const session = await this.#registry.resolveUri(uri);
			const commit = await session.overlay.submoduleCommit(uri.path);
			if (commit === undefined) return undefined;
			return new vscode.FileDecoration('S', `Submodule at commit ${commit}`, new vscode.ThemeColor('gitDecoration.submoduleResourceForeground'));
		} catch {
			return undefined;
		}
	}
}
