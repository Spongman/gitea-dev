import type { EntryType } from '../../gitea-repository/src/index.js';
import type { LinkTarget } from './overlay.js';

// vscode.FileType values (vscode.d.ts: Unknown 0, File 1, Directory 2, SymbolicLink 64). Kept
// numeric so the mapping runs without the vscode module.
const UNKNOWN = 0;
const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;

/**
 * vscode.FileType bits of an entry. A symlink is its target's type combined with SymbolicLink;
 * a link whose target is unknown (dangling, outside the repository) is Unknown | SymbolicLink.
 * A submodule is Unknown: it is neither a file nor a directory that can be opened.
 */
export function fileTypeBits(type: EntryType, target?: LinkTarget): number {
	switch (type) {
		case 'directory':
			return DIRECTORY;
		case 'file':
			return FILE;
		case 'symlink':
			return (target === 'directory' ? DIRECTORY : target === 'file' ? FILE : UNKNOWN) | SYMBOLIC_LINK;
		default:
			return UNKNOWN;
	}
}
