/** What commands return, for callers that run them programmatically. */
export type CommandResult = Record<string, unknown> & { ok: boolean };

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Repository path of a workspace URI. */
export function pathOf(uri: { path: string }): string {
	return uri.path.replace(/^\/+/, '');
}

export function parentOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index < 0 ? '' : path.slice(0, index);
}
