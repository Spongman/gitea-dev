import { LineEditor } from './line-editor.js';
import { GiteaShell } from './shell.js';

interface TerminalSink {
	write(data: string): void;
	close(exitCode: number): void;
}

/** After an interrupt, how long to wait for the command to stop before giving the prompt back. */
const STOP_WAIT_MS = 1000;

const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

/** Connects terminal input and output to one shell: line editing, running lines, Ctrl+C. */
export class ShellTerminal {
	readonly #shell: GiteaShell;
	readonly #sink: TerminalSink;
	readonly #editor: LineEditor;
	#abort: AbortController | undefined;
	#stop: (() => void) | undefined;
	#closed = false;

	constructor(shell: GiteaShell, sink: TerminalSink) {
		this.#shell = shell;
		this.#sink = sink;
		this.#editor = new LineEditor({
			write: (data) => this.#sink.write(data),
			prompt: () => `\x1b[1;32m${this.#shell.prompt()}\x1b[0m`,
			onLine: (line) => void this.#run(line),
			onInterrupt: () => {
				this.#sink.write('^C\r\n');
				this.#stop?.();
			},
			onEof: () => this.#exit(0),
		});
	}

	open(columns?: number): void {
		if (columns !== undefined) this.#editor.setColumns(columns);
		this.#sink.write('Gitea shell over the repository overlay. Type "help". Changes stay local until committed.\r\n');
		this.#editor.ready();
	}

	setDimensions(columns: number): void {
		this.#editor.setColumns(columns);
	}

	handleInput(data: string): void {
		if (!this.#closed) this.#editor.feed(data);
	}

	/** Stops a running command and ignores any further input or output. */
	dispose(): void {
		this.#closed = true;
		this.#abort?.abort();
	}

	#exit(code: number): void {
		if (this.#closed) return;
		this.dispose();
		this.#sink.close(code);
	}

	async #run(line: string): Promise<void> {
		if (GiteaShell.isExit(line)) {
			this.#exit(Number(line.trim().split(/\s+/)[1] ?? 0) & 0xff);
			return;
		}
		if (line.trim() !== '') {
			const abort = new AbortController();
			this.#abort = abort;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const stopped = new Promise<undefined>((resolve) => {
				this.#stop = () => {
					abort.abort();
					timer = setTimeout(() => resolve(undefined), STOP_WAIT_MS);
				};
			});
			const result = await Promise.race([this.#shell.run(line, abort.signal), stopped]);
			clearTimeout(timer);
			this.#stop = undefined;
			this.#abort = undefined;
			if (this.#closed) return;
			if (result !== undefined) this.#print(result.stdout, result.stderr);
		}
		this.#editor.ready();
	}

	#print(stdout: string, stderr: string): void {
		const text = crlf(stdout + stderr);
		this.#sink.write(text === '' || text.endsWith('\n') ? text : `${text}\r\n`);
	}
}
