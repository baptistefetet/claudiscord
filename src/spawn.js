const { spawn } = require('child_process');
const log = require('./logger');

/**
 * Spawn a command with stdout/stderr collection, resolving on exit.
 * Returns { stdout, stderr, code }.
 *
 * Deliberately unbounded: only the operator knows how long a given prompt should
 * take, so a stuck agent holds its channel queue until they intervene rather
 * than being killed mid-operation. Interactive commands (`apt install` without
 * `-y`, ssh to an unknown host) therefore hang until the operator kills them.
 *
 * Agent-agnostic: used by the Claude, Codex and container executors alike.
 */
function spawnCollect(cmd, args, options = {}) {
	const {
		cwd,
		env,
		label = 'process',
		input = null,
	} = options;

	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		child.stdin.on('error', () => {});
		child.stdin.end(input === null ? undefined : input);

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		child.on('close', (code) => {
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			err.stdout = stdout;
			err.stderr = stderr;
			reject(err);
		});
	});
}

module.exports = { spawnCollect };
