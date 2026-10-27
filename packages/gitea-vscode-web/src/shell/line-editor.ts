interface LineEditorHost {
	/** Output with CRLF line ends, ready for the terminal. */
	write(data: string): void;
	/** Prompt text; may contain SGR color codes. */
	prompt(): string;
	/** A finished line; the editor stays busy until `ready()`. */
	onLine(line: string): void;
	/** Ctrl+C while a command runs. */
	onInterrupt(): void;
	/** Ctrl+D on an empty line. */
	onEof(): void;
}

const ESC = '\x1b';
const MAX_HISTORY = 500;
/** An escape sequence that has not continued after this long was a lone Esc key press. */
const ESCAPE_FLUSH_MS = 50;
const SGR = /\x1b\[[0-9;]*m/g;

/** Single-line editor for a pseudoterminal: history, cursor keys, kill keys, wrapped lines. */
export class LineEditor {
	readonly #host: LineEditorHost;
	readonly #history: string[] = [];
	#line: string[] = [];
	#cursor = 0;
	#columns = 80;
	#row = 0;
	#browsing = -1;
	#draft = '';
	#busy = true;
	#escape = '';
	#escapeTimer: ReturnType<typeof setTimeout> | undefined;
	#queued = '';
	#skipLineFeed = false;
	#promptText = '';

	constructor(host: LineEditorHost) {
		this.#host = host;
	}

	get history(): readonly string[] {
		return this.#history;
	}

	setColumns(columns: number): void {
		if (columns > 0) this.#columns = columns;
	}

	/** Shows a fresh prompt and accepts input; typed-ahead input is replayed. */
	ready(): void {
		this.#busy = false;
		this.#line = [];
		this.#cursor = 0;
		this.#row = 0;
		this.#browsing = -1;
		this.#promptText = this.#host.prompt();
		this.#host.write(this.#promptText);
		const queued = this.#queued;
		this.#queued = '';
		if (queued !== '') this.feed(queued);
	}

	feed(data: string): void {
		if (this.#busy) {
			// While a command runs only Ctrl+C acts; the rest waits for the next prompt.
			for (const ch of data) {
				if (ch === '\x03') this.#host.onInterrupt();
				else this.#queued += ch;
			}
			return;
		}
		clearTimeout(this.#escapeTimer);
		for (const ch of data) {
			if (this.#busy) {
				this.#queued += ch;
				continue;
			}
			this.#accept(ch);
		}
		if (this.#escape !== '') this.#escapeTimer = setTimeout(() => (this.#escape = ''), ESCAPE_FLUSH_MS);
	}

	#accept(ch: string): void {
		if (this.#escape !== '') {
			this.#escape += ch;
			this.#escapeSequence();
			return;
		}
		if (ch !== '\n') this.#skipLineFeed = false;
		const code = ch.codePointAt(0)!;
		switch (ch) {
			case ESC:
				this.#escape = ESC;
				return;
			case '\r':
				this.#skipLineFeed = true;
				this.#submit();
				return;
			case '\n':
				if (this.#skipLineFeed) this.#skipLineFeed = false;
				else this.#submit();
				return;
			case '\x7f':
			case '\b':
				if (this.#cursor > 0) this.#edit(() => this.#line.splice(--this.#cursor, 1));
				return;
			case '\x03':
				this.#moveToEnd();
				this.#host.write('^C\r\n');
				this.ready();
				return;
			case '\x04':
				if (this.#line.length === 0) this.#host.onEof();
				else if (this.#cursor < this.#line.length) this.#edit(() => this.#line.splice(this.#cursor, 1));
				return;
			case '\x01':
				this.#move(0);
				return;
			case '\x05':
				this.#move(this.#line.length);
				return;
			case '\x02':
				this.#move(this.#cursor - 1);
				return;
			case '\x06':
				this.#move(this.#cursor + 1);
				return;
			case '\x0b':
				this.#edit(() => this.#line.splice(this.#cursor));
				return;
			case '\x15':
				this.#edit(() => {
					this.#line.splice(0, this.#cursor);
					this.#cursor = 0;
				});
				return;
			case '\x17':
				this.#edit(() => {
					let start = this.#cursor;
					while (start > 0 && this.#line[start - 1] === ' ') start--;
					while (start > 0 && this.#line[start - 1] !== ' ') start--;
					this.#line.splice(start, this.#cursor - start);
					this.#cursor = start;
				});
				return;
			case '\x0c':
				this.#host.write('\x1b[2J\x1b[H');
				this.#row = 0;
				this.#redraw();
				return;
			case '\x10':
				this.#recall(1);
				return;
			case '\x0e':
				this.#recall(-1);
				return;
			default:
				if (code >= 0x20) this.#insert(ch);
		}
	}

	#escapeSequence(): void {
		const seq = this.#escape;
		if (seq.length === 2) {
			// ESC [ and ESC O start a sequence; ESC ESC restarts it; anything else is Alt+key, which is ignored.
			if (seq[1] === ESC) this.#escape = ESC;
			else if (seq[1] !== '[' && seq[1] !== 'O') this.#escape = '';
			return;
		}
		const last = seq[seq.length - 1];
		if (seq[1] === 'O' || (last >= '@' && last <= '~')) {
			this.#escape = '';
			const params = seq.slice(2, -1);
			switch (seq[1] === 'O' ? `O${last}` : `${params}${last}`) {
				case 'A':
				case 'OA':
					this.#recall(1);
					break;
				case 'B':
				case 'OB':
					this.#recall(-1);
					break;
				case 'C':
				case 'OC':
					this.#move(this.#cursor + 1);
					break;
				case 'D':
				case 'OD':
					this.#move(this.#cursor - 1);
					break;
				case 'H':
				case 'OH':
				case '1~':
				case '7~':
					this.#move(0);
					break;
				case 'F':
				case 'OF':
				case '4~':
				case '8~':
					this.#move(this.#line.length);
					break;
				case '3~':
					if (this.#cursor < this.#line.length) this.#edit(() => this.#line.splice(this.#cursor, 1));
					break;
			}
		}
	}

	#submit(): void {
		this.#moveToEnd();
		this.#host.write('\r\n');
		const text = this.#line.join('');
		this.#busy = true;
		if (text.trim() !== '' && this.#history[this.#history.length - 1] !== text) {
			this.#history.push(text);
			if (this.#history.length > MAX_HISTORY) this.#history.shift();
		}
		this.#host.onLine(text);
	}

	#insert(ch: string): void {
		const atEnd = this.#cursor === this.#line.length;
		this.#line.splice(this.#cursor++, 0, ch);
		this.#browsing = -1;
		if (atEnd && (this.#width() + this.#cursor) % this.#columns !== 0) {
			this.#host.write(ch);
			this.#row = Math.floor((this.#width() + this.#cursor) / this.#columns);
		} else {
			this.#redraw();
		}
	}

	#edit(change: () => void): void {
		change();
		this.#browsing = -1;
		this.#redraw();
	}

	#move(to: number): void {
		const target = Math.max(0, Math.min(this.#line.length, to));
		if (target === this.#cursor) return;
		this.#cursor = target;
		this.#redraw();
	}

	#moveToEnd(): void {
		this.#move(this.#line.length);
	}

	/** Up (+1) goes to older history, down (-1) to newer; the unfinished line is kept as a draft. */
	#recall(direction: 1 | -1): void {
		if (direction === 1) {
			const older = this.#browsing === -1 ? this.#history.length - 1 : this.#browsing - 1;
			if (older < 0) return;
			if (this.#browsing === -1) this.#draft = this.#line.join('');
			this.#browsing = older;
		} else {
			if (this.#browsing === -1) return;
			this.#browsing = this.#browsing + 1 >= this.#history.length ? -1 : this.#browsing + 1;
		}
		this.#line = [...(this.#browsing === -1 ? this.#draft : this.#history[this.#browsing])];
		this.#cursor = this.#line.length;
		this.#redraw();
	}

	#width(): number {
		return this.#promptText.replace(SGR, '').length;
	}

	/** Rewrites the prompt and line from the row where the cursor was, then places the cursor. */
	#redraw(): void {
		const columns = this.#columns;
		const width = this.#width();
		const total = width + this.#line.length;
		let out = `${this.#row > 0 ? `${ESC}[${this.#row}A` : ''}\r${ESC}[J${this.#promptText}${this.#line.join('')}`;
		// A line that ends exactly at the right edge leaves the cursor in a pending wrap; settle it.
		if (total % columns === 0) out += ' \r';
		const endRow = Math.floor(total / columns);
		const row = Math.floor((width + this.#cursor) / columns);
		const column = (width + this.#cursor) % columns;
		if (endRow > row) out += `${ESC}[${endRow - row}A`;
		out += `${ESC}[${column + 1}G`;
		this.#row = row;
		this.#host.write(out);
	}
}
