const { spawn } = require('child_process');
const { PROMPT_TIMEOUT_MS } = require('./config');
const log = require('./logger');

/**
 * Spawn a command with timeout, stdout/stderr collection, and SIGTERM→SIGKILL.
 * Returns { stdout, stderr, code }. Waits for the process to exit naturally —
 * if the child launches a background task (e.g. forced by the harness when a
 * `sleep` is too long), we wait for it to complete rather than killing early.
 * The trade-off is that truly interactive commands (`gws auth login`, ssh to
 * an unknown host, `apt install` without `-y`) will hang until PROMPT_TIMEOUT_MS.
 *
 * Agent-agnostic: used by the Claude, Codex and container executors alike.
 */
function spawnWithTimeout(cmd, args, options = {}) {
	const {
		timeoutMs = PROMPT_TIMEOUT_MS,
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

		let killed = false;
		let killTimer = null;
		const timer = setTimeout(() => {
			killed = true;
			log.warn(`${label} timeout after ${timeoutMs}ms, sending SIGTERM`);
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				try { child.kill('SIGKILL'); } catch (_) {}
			}, 5000);
		}, timeoutMs);

		child.on('close', (code) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (killed) {
				reject(Object.assign(new Error('timeout'), { code: 124, stdout, stderr }));
				return;
			}
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			err.stdout = stdout;
			err.stderr = stderr;
			reject(err);
		});
	});
}

module.exports = { spawnWithTimeout };
