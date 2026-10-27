import * as vscode from 'vscode';

import type { ChangeOverlay } from './overlay.js';
import {
	InvalidQueryError,
	searchFiles,
	searchText,
	type EngineRange,
	type SearchLimits,
	type WalkSummary,
} from './search-engine.js';

type SearchOverlay = Pick<ChangeOverlay, 'readDirectory' | 'readFile' | 'stat'>;

/** Runs before a scan (for example to prefetch trees or the archive); returns warnings to show with text results. */
type SearchPrepare = (folder: vscode.Uri, kind: 'file' | 'text', token: vscode.CancellationToken) => Promise<string[]>;

const WARNING: vscode.TextSearchCompleteMessageType = 2;

function rootOf(folder: vscode.Uri): string {
	return folder.path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function childUri(folder: vscode.Uri, relative: string): vscode.Uri {
	return folder.with({ path: `${folder.path.replace(/\/+$/, '')}/${relative}` });
}

function toRange(range: EngineRange): vscode.Range {
	return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** Why a file listing is incomplete; undefined when it is complete. */
function fileSearchNotice(summary: WalkSummary): string | undefined {
	const notes: string[] = [];
	if (summary.filesTruncated) notes.push(`Quick Open lists only the first ${summary.files} files.`);
	if (summary.unlistable > 0) notes.push(`${summary.unlistable} folder(s) could not be listed.`);
	return notes.length === 0 ? undefined : notes.join(' ');
}

/**
 * Quick Open and Search view backend over the change overlay. Scans in the worker; there is
 * no server code search. Ignore files and symlink following are not supported: symlinks and
 * submodules are skipped, and Git LFS files are listed but their content is not searched.
 */
export class GiteaSearchProvider implements vscode.FileSearchProvider, vscode.TextSearchProvider {
	readonly #resolveOverlay: (uri: vscode.Uri) => Promise<SearchOverlay>;
	readonly #limits: Partial<SearchLimits>;

	readonly #prepare: SearchPrepare | undefined;

	constructor(resolveOverlay: (uri: vscode.Uri) => Promise<SearchOverlay>, limits: Partial<SearchLimits> = {}, prepare?: SearchPrepare) {
		this.#resolveOverlay = resolveOverlay;
		this.#limits = limits;
		this.#prepare = prepare;
	}

	/** Best effort: a failed preparation only costs speed. */
	async #prepared(folder: vscode.Uri, kind: 'file' | 'text', token: vscode.CancellationToken): Promise<string[]> {
		try {
			return (await this.#prepare?.(folder, kind, token)) ?? [];
		} catch {
			return [];
		}
	}

	async provideFileSearchResults(
		query: vscode.FileSearchQuery,
		options: vscode.FileSearchOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.Uri[]> {
		const overlay = await this.#resolveOverlay(options.folder);
		await this.#prepared(options.folder, 'file', token);
		const { paths, summary } = await searchFiles(overlay, {
			pattern: query.pattern,
			root: rootOf(options.folder),
			includes: options.includes,
			excludes: options.excludes,
			maxResults: options.maxResults,
			limits: this.#limits,
			isCancelled: () => token.isCancellationRequested,
		});
		if (token.isCancellationRequested) return [];
		const notice = fileSearchNotice(summary);
		// Quick Open shows no provider messages, so use the status bar.
		if (notice !== undefined) vscode.window.setStatusBarMessage(notice, 10_000);
		return paths.map((path) => childUri(options.folder, path));
	}

	async provideTextSearchResults(
		query: vscode.TextSearchQuery,
		options: vscode.TextSearchOptions,
		progress: vscode.Progress<vscode.TextSearchResult>,
		token: vscode.CancellationToken,
	): Promise<vscode.TextSearchComplete> {
		const overlay = await this.#resolveOverlay(options.folder);
		const messages: vscode.TextSearchCompleteMessage[] = [];
		for (const text of await this.#prepared(options.folder, 'text', token)) messages.push({ text, type: WARNING });
		let summary;
		try {
			summary = await searchText(overlay, {
				query,
				root: rootOf(options.folder),
				includes: options.includes,
				excludes: options.excludes,
				maxResults: options.maxResults,
				maxFileSize: options.maxFileSize,
				previewOptions: options.previewOptions,
				encoding: options.encoding,
				beforeContext: options.beforeContext,
				afterContext: options.afterContext,
				limits: this.#limits,
				isCancelled: () => token.isCancellationRequested,
				onResult: (result) => {
					const uri = childUri(options.folder, result.path);
					if (result.kind === 'context') {
						progress.report({ uri, text: result.text, lineNumber: result.lineNumber });
					} else {
						progress.report({
							uri,
							ranges: result.ranges.map(toRange),
							preview: { text: result.preview.text, matches: result.preview.matches.map(toRange) },
						});
					}
				},
			});
		} catch (error) {
			if (!(error instanceof InvalidQueryError)) throw error;
			return { message: { text: error.message, type: WARNING } };
		}
		for (const text of summary.warnings) messages.push({ text, type: WARNING });
		const complete: vscode.TextSearchComplete = { limitHit: summary.limitHit };
		if (messages.length > 0) complete.message = messages;
		return complete;
	}
}
