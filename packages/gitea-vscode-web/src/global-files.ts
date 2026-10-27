import * as vscode from 'vscode';
import type { StorageFiles } from './storage.js';

function isNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/**
 * StorageFiles under `root`, normally the extension's globalStorageUri. An empty file counts as
 * missing: VS Code's IndexedDB file system lists files only as of the tab's first access, and
 * refuses to delete one it does not list, so a delete first overwrites the file with nothing.
 */
export function globalFiles(root: vscode.Uri, fs: vscode.FileSystem = vscode.workspace.fs): StorageFiles {
	const uri = (path: string) => vscode.Uri.joinPath(root, path);
	return {
		async read(path) {
			try {
				const bytes = await fs.readFile(uri(path));
				return bytes.byteLength === 0 ? undefined : bytes;
			} catch (error) {
				if (isNotFound(error)) return undefined;
				throw error;
			}
		},
		async write(path, data) {
			await fs.writeFile(uri(path), data);
		},
		async delete(path) {
			await fs.writeFile(uri(path), new Uint8Array(0));
			try {
				await fs.delete(uri(path));
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
		async list(directory) {
			try {
				return (await fs.readDirectory(uri(directory)))
					.filter(([, type]) => type === vscode.FileType.File)
					.map(([name]) => name);
			} catch (error) {
				if (isNotFound(error)) return [];
				throw error;
			}
		},
	};
}
