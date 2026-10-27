import { isRepositoryError } from '../../gitea-repository/src/index.js';
import type { Descriptor, RefKind } from './descriptor.js';

const HEX_ID = /^[0-9a-f]{7,64}$/i;

export function refKindOf(descriptor: Descriptor): RefKind {
	if (descriptor.refKind !== undefined) return descriptor.refKind;
	if (descriptor.ref.startsWith('refs/tags/')) return 'tag';
	if (descriptor.ref.startsWith('refs/heads/')) return 'branch';
	return HEX_ID.test(descriptor.ref) ? 'commit' : 'branch';
}

export function shortRef(descriptor: Descriptor): string {
	return descriptor.ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Status bar text for the opened ref. */
export function refLabel(descriptor: Descriptor): string {
	const kind = refKindOf(descriptor);
	const name = shortRef(descriptor);
	if (kind === 'tag') return `$(tag) ${name}`;
	if (kind === 'commit') return `$(git-commit) ${name.slice(0, 8)}`;
	return `$(git-branch) ${name}`;
}

/** Suggested name for a branch that receives a commit the current branch refuses. */
export function suggestBranchName(current: string, taken: ReadonlySet<string> = new Set()): string {
	const base = `${current.replace(/^refs\/heads\//, '').replace(/[^\w./-]+/g, '-')}-patch`;
	for (let n = 1; ; n++) {
		if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}
}

/** First line is the title; the rest is the body. */
export function pullRequestText(message: string): { title: string; body: string } {
	const trimmed = message.trim();
	const newline = trimmed.indexOf('\n');
	if (newline < 0) return { title: trimmed, body: '' };
	return { title: trimmed.slice(0, newline).trim(), body: trimmed.slice(newline + 1).trim() };
}

function encodeRef(name: string): string {
	return name.split('/').map(encodeURIComponent).join('/');
}

/** Web page that opens Gitea's own create-pull-request form. */
export function compareUrl(instance: string, owner: string, repository: string, base: string, head: string): string {
	return `${instance}/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeRef(base)}...${encodeRef(head)}?expand=1`;
}

/** User-facing reason for a failed create-pull-request call; every failure can fall back to the compare page. */
export function pullRequestFailure(error: unknown): string {
	if (isRepositoryError(error)) {
		if (error.status === 409) return 'A pull request for these branches is already open.';
		if (error.status === 422) return 'There is nothing to propose: the branches are the same or have no differences.';
		if (error.status === 403 || error.status === 404) return 'Pull requests are not available to you in this repository.';
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}
