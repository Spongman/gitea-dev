/** Minimal terminal screen: enough of xterm (wrap with pending wrap, CR, LF, BS, CUU/CUD/CUF/CUB/CHA, ED, EL) to check redraws. */
export class Screen {
	readonly rows: string[][] = [[]];
	x = 0;
	y = 0;

	constructor(readonly columns: number) {}

	write(data: string): void {
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			if (ch === '\x1b' && data[i + 1] === '[') {
				const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(data.slice(i));
				if (!match) throw new Error(`bad escape at ${i}`);
				this.#csi(match[1], match[2]);
				i += match[0].length - 1;
			} else if (ch === '\r') {
				this.x = 0;
			} else if (ch === '\n') {
				this.#line(++this.y);
			} else if (ch === '\b') {
				this.x = Math.max(0, Math.min(this.x, this.columns - 1) - 1);
			} else {
				if (this.x >= this.columns) {
					this.x = 0;
					this.#line(++this.y);
				}
				this.#line(this.y)[this.x++] = ch;
			}
		}
	}

	#line(y: number): string[] {
		while (this.rows.length <= y) this.rows.push([]);
		return this.rows[y];
	}

	#csi(params: string, final: string): void {
		const n = Number(params.split(';')[0] || 1);
		this.x = Math.min(this.x, this.columns - 1);
		switch (final) {
			case 'A':
				this.y = Math.max(0, this.y - n);
				break;
			case 'B':
				this.#line((this.y += n));
				break;
			case 'C':
				this.x = Math.min(this.columns - 1, this.x + n);
				break;
			case 'D':
				this.x = Math.max(0, this.x - n);
				break;
			case 'G':
				this.x = Math.min(this.columns - 1, n - 1);
				break;
			case 'H':
				this.x = 0;
				this.y = 0;
				break;
			case 'J':
				if (params === '2') {
					this.rows.length = 1;
					this.rows[0] = [];
				} else {
					this.#line(this.y).length = this.x;
					this.rows.length = this.y + 1;
				}
				break;
			case 'K':
				this.#line(this.y).length = this.x;
				break;
			case 'm':
				break;
			default:
				throw new Error(`unsupported CSI ${final}`);
		}
	}

	/** Rows with trailing blanks trimmed and trailing empty rows dropped. */
	lines(): string[] {
		const out = this.rows.map((row) => Array.from({ length: row.length }, (_, i) => row[i] ?? ' ').join('').replace(/\s+$/, ''));
		while (out.length > 1 && out[out.length - 1] === '') out.pop();
		return out;
	}
}
