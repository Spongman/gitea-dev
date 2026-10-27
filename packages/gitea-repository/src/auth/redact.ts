const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** Makes JSON, string and console output of a credential-holding object opaque. */
export abstract class Redacted {
	protected abstract readonly label: string;

	toJSON(): { type: string } {
		return { type: this.label };
	}

	toString(): string {
		return `[${this.label}]`;
	}

	[INSPECT](): string {
		return `[${this.label}]`;
	}
}

export function constantTimeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
