/** LRU cache bounded by entry count and total byte cost. */
export class BoundedCache<V> {
	readonly #items = new Map<string, { value: V; cost: number }>();
	#bytes = 0;

	constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number,
	) {}

	get(key: string): V | undefined {
		const item = this.#items.get(key);
		if (item === undefined) {
			return undefined;
		}
		this.#items.delete(key);
		this.#items.set(key, item);
		return item.value;
	}

	set(key: string, value: V, cost: number): void {
		this.delete(key);
		if (cost > this.maxBytes || this.maxEntries <= 0) {
			return;
		}
		this.#items.set(key, { value, cost });
		this.#bytes += cost;
		for (const [oldest, item] of this.#items) {
			if (this.#items.size <= this.maxEntries && this.#bytes <= this.maxBytes) {
				break;
			}
			this.#items.delete(oldest);
			this.#bytes -= item.cost;
		}
	}

	delete(key: string): void {
		const item = this.#items.get(key);
		if (item !== undefined) {
			this.#items.delete(key);
			this.#bytes -= item.cost;
		}
	}

	clear(): void {
		this.#items.clear();
		this.#bytes = 0;
	}
}
