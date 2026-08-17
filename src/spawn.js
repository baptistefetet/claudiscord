const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const log = require('./logger');

const VERSION_TIMEOUT_MS = 10_000;

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

/**
 * Version number printed by an agent CLI, null when the probe fails. Keeps the
 * number only: `claude --version` prints "2.1.195 (Claude Code)", `codex
 * --version` prints "codex-cli 0.5.0". Backs getClaudeVersion/getCodexVersion.
 */
async function probeVersion(cmd, args, options = {}) {
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			encoding: 'utf8',
			timeout: VERSION_TIMEOUT_MS,
			...options,
		});
		return (stdout.match(/\d+(?:\.\d+)+/) || [])[0] || null;
	} catch {
		return null;
	}
}

module.exports = { spawnCollect, probeVersion };
