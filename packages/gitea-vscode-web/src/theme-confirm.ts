import type * as vscode from 'vscode';
import { colorSchemeOf, type ColorScheme } from '../../editor-host/src/theme.js';
import { giteaRequest } from './sync-auth.js';

/** Host commands (packages/editor-host/src/bootstrap.ts). */
export const COLOR_SCHEME_COMMAND = 'giteaHost.colorScheme';
export const CONFIRM_COLOR_SCHEME_COMMAND = 'giteaHost.confirmColorScheme';

type Confirmation = 'match' | 'updated' | 'unknown';

/** The user's Gitea theme setting (`GET /api/v1/user/settings`), or undefined when it cannot be read. */
export async function userTheme(instance: string, authorization: string, fetcher?: typeof fetch): Promise<string | undefined> {
	try {
		const res = await giteaRequest(instance, '/user/settings', authorization, { fetcher });
		if (!res.ok) { return undefined; }
		const body = (await res.json()) as { theme?: unknown };
		return typeof body.theme === 'string' ? body.theme : undefined;
	} catch {
		return undefined;
	}
}

interface ThemeConfirmDeps {
	instance: string;
	commands: Pick<typeof vscode.commands, 'executeCommand'>;
	window: Pick<typeof vscode.window, 'showInformationMessage'>;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
}

/**
 * After sign-in, checks the scheme the editor started with against the user's Gitea theme setting.
 * On a mismatch the host remembers the setting for later loads and the user may reload now; the
 * theme is never written to settings.json, so Settings Sync does not carry it.
 */
export class ThemeConfirmation {
	#done = false;

	constructor(private readonly deps: ThemeConfirmDeps) {}

	/** `authorization` is the credential's own header value, as given to the sync auth provider's onSession. */
	async onSession(authorization: string): Promise<Confirmation> {
		if (this.#done) { return 'match'; }
		this.#done = true;
		const theme = await userTheme(this.deps.instance, authorization, this.deps.fetcher);
		if (theme === undefined) { this.#done = false; return 'unknown'; }
		const wanted = colorSchemeOf(theme);
		const current = await this.deps.commands.executeCommand<ColorScheme | undefined>(COLOR_SCHEME_COMMAND).then(undefined, () => undefined);
		if (current === undefined || current === wanted) { return 'match'; }
		await this.deps.commands.executeCommand(CONFIRM_COLOR_SCHEME_COMMAND, wanted);
		this.deps.log?.(`Gitea theme ${theme} is ${wanted}; the editor started ${current}.`);
		const label = wanted === 'auto' ? 'set to follow the system' : wanted;
		void this.deps.window.showInformationMessage(`Your Gitea theme is ${label}. Reload the editor to match it?`, 'Reload').then((choice) => {
			if (choice === 'Reload') { void this.deps.commands.executeCommand('workbench.action.reloadWindow'); }
		});
		return 'updated';
	}
}
