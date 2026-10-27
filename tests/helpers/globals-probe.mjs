// Child process for tests/shell-globals.test.ts: which globals does just-bash change, and when?
// Usage: node globals-probe.mjs <browser|node> <default|off>
// Prints JSON { import, construct, during, after } = names of globals whose value changed since the previous stage.
const [entry, defense] = process.argv.slice(2);

const intrinsics = () => ({
	'Function.prototype.constructor': Object.getOwnPropertyDescriptor(Function.prototype, 'constructor'),
	'Object.prototype.constructor': Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'),
	'Promise.prototype.then': Object.getOwnPropertyDescriptor(Promise.prototype, 'then'),
	'Error.prepareStackTrace': Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'),
	'Proxy.revocable': Object.getOwnPropertyDescriptor(Proxy, 'revocable'),
});

function snapshot() {
	const out = new Map();
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		const d = Object.getOwnPropertyDescriptor(globalThis, name);
		out.set(`globalThis.${name}`, d.get ?? d.value);
		if (d.get) out.set(`globalThis.${name}#set`, d.set);
	}
	for (const [name, d] of Object.entries(intrinsics())) {
		out.set(name, d === undefined ? undefined : (d.get ?? d.value));
		if (d?.get) out.set(`${name}#set`, d.set);
	}
	return out;
}

function changed(before, after) {
	const names = new Set([...before.keys(), ...after.keys()]);
	return [...names].filter((name) => !Object.is(before.get(name), after.get(name))).sort();
}

let stage = snapshot();
const diff = () => {
	const next = snapshot();
	const result = changed(stage, next);
	stage = next;
	return result;
};

const report = {};
const module = await import(entry === 'browser' ? 'just-bash/browser' : 'just-bash');
const { Bash, defineCommand } = module;
report.import = diff();

let midExec = [];
const probe = defineCommand('probe', async () => {
	midExec = changed(stage, snapshot());
	return { stdout: '', stderr: '', exitCode: 0 };
});
const options = { customCommands: [probe], files: { '/a.txt': 'x\n' } };
if (defense === 'off') options.defenseInDepth = false;
const bash = new Bash(options);
report.construct = diff();
await bash.exec('cat /a.txt | grep x; probe; echo done');
report.during = midExec;
report.after = diff();
await bash.exec('probe');
report.second = diff();
console.log(JSON.stringify(report));
