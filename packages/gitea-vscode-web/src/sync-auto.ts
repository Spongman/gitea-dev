import type * as vscode from 'vscode';
import { giteaRequest } from './sync-auth.js';

/** Host command (packages/editor-host/src/bootstrap.ts) that runs the native turn-on with default answers. */
export const TURN_ON_COMMAND = 'giteaHost.syncTurnOn';
const PROBE_NAME = 'WEBIDE_SYNC_PROBE';
/** A Gitea found to lack the variables API is probed again after this long, so an upgrade is noticed. */
const UNSUPPORTED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export type Probe = 'ok' | 'unsupported' | 'scope' | 'unauthorized' | 'unavailable';

/** Whether the token can write user Actions variables, the store of Settings Sync. Removes its probe variable; a failed removal is retried once and logged. */
export async function probeVariables(instance: string, authorization: string, fetcher?: typeof fetch, log?: (message: string) => void): Promise<Probe> {
	const call = async (method: string, body?: string): Promise<{ status: number; text: string }> => {
		const res = await giteaRequest(instance, `/user/actions/variables/${PROBE_NAME}`, authorization, { method, body, fetcher });
		return { status: res.status, text: await res.text().catch(() => '') };
	};
	const remove = async (): Promise<boolean> => {
		const removed = await call('DELETE').then((res) => (res.status >= 200 && res.status < 300) || res.status === 404, () => false);
		return removed || (await call('DELETE').then((res) => (res.status >= 200 && res.status < 300) || res.status === 404, () => false));
	};
	try {
		const created = await call('POST', JSON.stringify({ value: '1' }));
		if (created.status === 401) { return 'unauthorized'; }
		if (created.status === 403) { return 'scope'; }
		if (created.status === 404 || created.status === 405) { return 'unsupported'; }
		if (created.status === 409 || (created.status >= 200 && created.status < 300)) {
			if (!(await remove())) log?.(`Settings Sync probe variable ${PROBE_NAME} could not be removed; remove it in the Gitea user settings.`);
			return 'ok';
		}
		return 'unavailable';
	} catch {
		return 'unavailable';
	}
}

interface AutoSyncDeps {
	instance: string;
	/** The extension's globalState; remembers that the automatic turn-on already ran for an account. */
	state: Pick<vscode.Memento, 'get' | 'update'>;
	commands: Pick<typeof vscode.commands, 'executeCommand'>;
	window: Pick<typeof vscode.window, 'showWarningMessage'>;
	fetch?: typeof fetch;
	log?: (message: string) => void;
	/** Lets the workbench finish starting before the native action runs. */
	delayMs?: number;
	now?: () => number;
}

/**
 * Turns native Settings Sync on once per Gitea account and browser profile after sign-in.
 * Afterwards the native stored flag decides, so turning sync off stays off.
 */
export class AutoSettingsSync {
	#running = false;
	#warned = false;

	constructor(private readonly deps: AutoSyncDeps) {}

	#key(session: vscode.AuthenticationSession): string {
		return `gitea.settingsSync.auto:${this.deps.instance}:${session.account.id}`;
	}

	#warn(message: string): void {
		if (this.#warned) { return; }
		this.#warned = true;
		void this.deps.window.showWarningMessage(message);
	}

	/** Whether the remembered outcome for the account still stands; an 'unsupported' finding expires. */
	#settled(key: string): boolean {
		const value = this.deps.state.get(key);
		if (value === undefined) { return false; }
		const found = /^unsupported:(\d+)$/.exec(String(value));
		return found === null ? value !== 'unsupported' : (this.deps.now ?? Date.now)() - Number(found[1]) < UNSUPPORTED_RETRY_MS;
	}

	/** `authorization` is the credential's own header value, as given to the sync auth provider's onSession. */
	async onSession(session: vscode.AuthenticationSession, authorization: string): Promise<void> {
		const key = this.#key(session);
		if (this.#running || this.#settled(key)) { return; }
		this.#running = true;
		try {
			await new Promise((resolve) => setTimeout(resolve, this.deps.delayMs ?? 1500));
			switch (await probeVariables(this.deps.instance, authorization, this.deps.fetch, this.deps.log)) {
				case 'unsupported':
					await this.deps.state.update(key, `unsupported:${(this.deps.now ?? Date.now)()}`);
					this.#warn('Settings Sync is unavailable: this Gitea has no user Actions variables API (Gitea 1.24 or later is required).');
					return;
				case 'scope':
					this.#warn('Settings Sync was not turned on: the Gitea token needs the read:user and write:user scopes.');
					return;
				case 'ok':
					break;
				default:
					this.deps.log?.('Settings Sync was not turned on: the Gitea token was not accepted or Gitea was unreachable.');
					return;
			}
			// Recorded first: a failed attempt must not repeat on every load; the native action stays available.
			await this.deps.state.update(key, 'turned-on');
			try {
				await this.deps.commands.executeCommand(TURN_ON_COMMAND);
			} catch (error) {
				await this.deps.state.update(key, undefined);
				this.deps.log?.(`Settings Sync automatic turn-on failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.#running = false;
		}
	}
}
