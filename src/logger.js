const TAG = '[claudiscord]';

function timestamp() {
	return new Date().toISOString();
}

function info(...args) {
	console.log(timestamp(), TAG, ...args);
}

function warn(...args) {
	console.warn(timestamp(), TAG, 'WARN', ...args);
}

function error(...args) {
	console.error(timestamp(), TAG, 'ERROR', ...args);
}

module.exports = { info, warn, error };
