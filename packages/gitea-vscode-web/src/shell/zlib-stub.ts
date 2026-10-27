// Stands in for node:zlib in the browser build of just-bash, which imports it for gzip, gunzip
// and zcat. Those commands fail with this message; nothing else uses zlib.
const unavailable = (): never => {
	throw new Error('gzip is not available in the browser shell');
};

export const gzipSync = unavailable;
export const gunzipSync = unavailable;
export const constants = {};
