import { Bash, defineCommand, getCommandNames, InMemoryFs, MountableFs, type IFileSystem } from 'just-bash/browser';
import type { PendingChange } from '../overlay.js';

const WORKSPACE = '/workspace';

interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface ShellOptions {
	/** Mounted at /workspace, which is the home and starting directory. */
	fs: IFileSystem;
	/** Shown in the prompt, e.g. `owner/repo@main`. */
	label: string;
	/** Pending overlay changes, for the `status` builtin. */
	pending: () => PendingChange[];
}

const STATUS_LETTER: Record<PendingChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

export function formatStatus(changes: readonly PendingChange[]): string {
	if (changes.length === 0) return 'No pending changes.\n';
	const rows = changes.map((change) => `${STATUS_LETTER[change.status]}  ${change.previousPath === undefined ? '' : `${change.previousPath} -> `}${change.path}`);
	return `${rows.join('\n')}\n${changes.length} pending change(s); commit them from Source Control.\n`;
}

function helpText(): string {
	return `Gitea shell: a virtual bash (just-bash) over this repository. It starts no process and uses no network.
${WORKSPACE} (~) is the repository; changes land in the local overlay and are shown in Source Control. Nothing is committed from here.

  status    list pending changes: A added, M modified, D deleted, R renamed (paths relative to the repository root)
  help      show this text; "help NAME" describes a bash builtin

Commands: ${getCommandNames().join(' ')}
Not available: curl, python, node, git. Links, chmod and touch on existing files are refused by the overlay.
The working directory and variables persist between lines; functions and multi-line input do not.
Ctrl+C interrupts a command, Ctrl+D on an empty line (or "exit") closes the shell.
`;
}

const exitRequest = /^\s*exit(\s+-?\d+)?\s*$/;
const helpRequest = /^\s*help\s*$/;
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One bash instance whose working directory and variables survive from line to line. */
export class GiteaShell {
	readonly #bash: Bash;
	readonly #label: string;
	#env: Record<string, string> = { HOME: WORKSPACE };
	#cwd = WORKSPACE;
	#running = false;

	constructor(options: ShellOptions) {
		this.#label = options.label;
		const base = new InMemoryFs();
		base.mkdirSync('/tmp', { recursive: true });
		const fs = new MountableFs({ base, mounts: [{ mountPoint: WORKSPACE, filesystem: options.fs }] });
		const status = defineCommand('status', async () => ({ stdout: formatStatus(options.pending()), stderr: '', exitCode: 0 }));
		// just-bash reports every chmod failure as a missing file, so say the real reason.
		const chmod = defineCommand('chmod', async () => ({ stdout: '', stderr: 'chmod: file modes are not supported (the repository overlay does not track them)\n', exitCode: 1 }));
		// just-bash's touch sets the time even on a file it just created, which the overlay refuses.
		const touch = defineCommand('touch', async (args, ctx) => {
			const operands = args.filter((arg) => arg !== '-c' && arg !== '--no-create');
			if (operands.some((arg) => arg.startsWith('-') && arg !== '--')) {
				return { stdout: '', stderr: 'touch: only -c is supported (the repository overlay does not track times)\n', exitCode: 1 };
			}
			let stderr = '';
			for (const operand of operands.filter((arg) => arg !== '--')) {
				const path = ctx.fs.resolvePath(ctx.cwd, operand);
				try {
					if (!(await ctx.fs.exists(path))) {
						if (!args.includes('-c') && !args.includes('--no-create')) await ctx.fs.writeFile(path, '');
					} else {
						const now = new Date();
						await ctx.fs.utimes(path, now, now);
					}
				} catch (error) {
					stderr += `touch: cannot touch '${operand}': ${error instanceof Error ? error.message : String(error)}\n`;
				}
			}
			return { stdout: '', stderr, exitCode: stderr === '' ? 0 : 1 };
		});
		// No network, python or javascript options; defenseInDepth is inert in the browser build and off elsewhere.
		this.#bash = new Bash({ fs, cwd: WORKSPACE, env: this.#env, customCommands: [status, chmod, touch], defenseInDepth: false });
	}

	get cwd(): string {
		return this.#cwd;
	}

	/** `owner/repo@ref:~/dir$ `; ~ stands for /workspace. */
	prompt(): string {
		const shown = this.#cwd === WORKSPACE || this.#cwd.startsWith(`${WORKSPACE}/`) ? `~${this.#cwd.slice(WORKSPACE.length)}` : this.#cwd;
		return `${this.#label}:${shown}$ `;
	}

	/** True when the line asks to close the shell. */
	static isExit(line: string): boolean {
		return exitRequest.test(line);
	}

	async run(line: string, signal?: AbortSignal): Promise<ShellResult> {
		if (helpRequest.test(line)) return { stdout: helpText(), stderr: '', exitCode: 0 };
		// An interrupted command may still be running; a second one would race it for the working directory and variables.
		if (this.#running) return { stdout: '', stderr: 'bash: the interrupted command is still stopping; try again in a moment\n', exitCode: 1 };
		this.#running = true;
		try {
			const result = await this.#bash.exec(line, { cwd: this.#cwd, env: this.#env, signal });
			// The prompt of an interrupted command was already given back, so its late result must not change the state.
			if (!signal?.aborted) {
				const env: Record<string, string> = {};
				for (const [name, value] of Object.entries(result.env ?? {})) if (variableName.test(name)) env[name] = value;
				this.#env = env;
				this.#cwd = env.PWD?.startsWith('/') ? env.PWD : this.#cwd;
			}
			return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { stdout: '', stderr: `bash: ${message}\n`, exitCode: signal?.aborted ? 130 : 1 };
		} finally {
			this.#running = false;
		}
	}
}
