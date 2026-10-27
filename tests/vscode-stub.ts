// Minimal stand-in for the 'vscode' module, for unit tests of extension code. Tests drive it through `testing`.

type Listener<T> = (value: T) => unknown;

export const testing = {
	commands: new Map<string, (...args: unknown[]) => unknown>(),
	/** Overrides for executeCommand, e.g. host commands; may throw. */
	hostCommands: new Map<string, (...args: unknown[]) => unknown>(),
	opened: [] as string[],
	messages: [] as Array<{ level: 'info' | 'warning' | 'error'; text: string; items: unknown[] }>,
	/** Answer for the next message box, by level; undefined dismisses it. */
	answers: {} as Partial<Record<'info' | 'warning' | 'error', string>>,
	inputs: [] as Array<string | undefined>,
	reset(): void {
		this.commands.clear();
		this.hostCommands.clear();
		this.opened.length = 0;
		this.messages.length = 0;
		this.answers = {};
		this.inputs.length = 0;
	},
};

export class Disposable {
	readonly #fn: () => void;
	constructor(fn: () => void) {
		this.#fn = fn;
	}
	dispose(): void {
		this.#fn();
	}
}

export class EventEmitter<T> {
	readonly #listeners = new Set<Listener<T>>();
	readonly event = (listener: Listener<T>) => {
		this.#listeners.add(listener);
		return new Disposable(() => this.#listeners.delete(listener));
	};
	fire(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}
	dispose(): void {
		this.#listeners.clear();
	}
}

export class Uri {
	constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query: string) {}
	static from(parts: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
		return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '');
	}
	static parse(text: string): Uri {
		const url = new URL(text);
		return new Uri(url.protocol.slice(0, -1), url.host, url.pathname, url.search.slice(1));
	}
	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
	}
}

export class ThemeIcon {
	constructor(readonly id: string) {}
}

export class ThemeColor {
	constructor(readonly id: string) {}
}

export class FileDecoration {
	propagate?: boolean;
	constructor(readonly badge?: string, readonly tooltip?: string, readonly color?: ThemeColor) {}
}

export class FileSystemError extends Error {
	static FileNotFound = (x?: unknown) => new FileSystemError(String(x));
	static FileExists = (x?: unknown) => new FileSystemError(String(x));
	static FileIsADirectory = (x?: unknown) => new FileSystemError(String(x));
	static FileNotADirectory = (x?: unknown) => new FileSystemError(String(x));
	static NoPermissions = (x?: unknown) => new FileSystemError(String(x));
	static Unavailable = (x?: unknown) => new FileSystemError(String(x));
}

export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum FilePermission { Readonly = 1 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum SourceControlInputBoxValidationType { Error = 0, Warning = 1, Information = 2 }

const disposable = () => new Disposable(() => undefined);

function group(id: string, label: string) {
	return { id, label, resourceStates: [] as unknown[], hideWhenEmpty: false, dispose: () => undefined };
}

export const scm = {
	createSourceControl(id: string, label: string, rootUri?: Uri) {
		return {
			id,
			label,
			rootUri,
			inputBox: { value: '', placeholder: '' },
			count: 0,
			acceptInputCommand: undefined as unknown,
			actionButton: undefined as unknown,
			quickDiffProvider: undefined as unknown,
			createResourceGroup: group,
			dispose: () => undefined,
		};
	},
};

function message(level: 'info' | 'warning' | 'error') {
	return async (text: string, ...items: unknown[]) => {
		testing.messages.push({ level, text, items });
		return testing.answers[level];
	};
}

export const window = {
	state: { focused: false },
	createStatusBarItem: () => ({ text: '', tooltip: '', name: '', command: '', show: () => undefined, hide: () => undefined, dispose: () => undefined }),
	showInformationMessage: message('info'),
	showWarningMessage: message('warning'),
	showErrorMessage: message('error'),
	showInputBox: async () => testing.inputs.shift(),
	showQuickPick: async () => undefined,
	withProgress: async <T>(_options: unknown, task: () => Promise<T>) => task(),
	onDidChangeWindowState: disposable,
	createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
};

export const commands = {
	registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
		testing.commands.set(id, handler);
		return new Disposable(() => testing.commands.delete(id));
	},
	async executeCommand(id: string, ...args: unknown[]) {
		const handler = testing.hostCommands.get(id) ?? testing.commands.get(id);
		if (!handler) throw new Error(`command '${id}' not found`);
		return handler(...args);
	},
};

export const workspace = {
	getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback }),
	onDidChangeConfiguration: disposable,
};

export const env = {
	async openExternal(uri: Uri) {
		testing.opened.push(uri.toString());
		return true;
	},
};
