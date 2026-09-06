const { spawn, execFileSync } = require('child_process');
const {
	SHELL_TIMEOUT_MS,
	KILL_GRACE_MS,
	DISCORD_MAX_MSG_LENGTH,
	CONTAINER_NAME,
	ADMIN_USER_HOME,
} = require('./config');
const { ensureContainer, DOCKER_AVAILABLE } = require('./container');
const { runMaintenance, isBusy } = require('./queue');
const log = require('./logger');

// Worst case: "```\n" (4) + output + "\n... (truncated)\n```" (21) = 25 overhead
const SHELL_MAX_OUTPUT = DISCORD_MAX_MSG_LENGTH - 25;

/**
 * Execute a shell command and return output for Discord. spawn, not exec: a
 * blocked event loop would kill the Discord WebSocket heartbeat. SIGTERM→SIGKILL
 * with process group kill (host) or container cleanup (sandbox).
 */
function executeShell(command, { inContainer } = {}) {
	return new Promise((resolve) => {
		const spawnArgs = inContainer
			? { cmd: 'docker', args: ['exec', CONTAINER_NAME, 'bash', '-c', command], opts: { stdio: ['pipe', 'pipe', 'pipe'] } }
			: { cmd: 'bash', args: ['-c', command], opts: { cwd: ADMIN_USER_HOME, stdio: ['pipe', 'pipe', 'pipe'], detached: true } };

		const child = spawn(spawnArgs.cmd, spawnArgs.args, spawnArgs.opts);
		child.stdin.end();

		let stdout = '';
		let stderr = '';
		let killed = false;

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		const timer = setTimeout(() => {
			killed = true;
			log.warn(`Shell timeout after ${SHELL_TIMEOUT_MS / 1000}s, sending SIGTERM`);
			if (inContainer) {
				child.kill('SIGTERM');
			} else {
				try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
			}
			setTimeout(() => {
				if (inContainer) {
					try { child.kill('SIGKILL'); } catch (_) {}
					try {
						execFileSync('docker', ['exec', CONTAINER_NAME, 'pkill', '-9', '-f', command.slice(0, 80)], { timeout: 5000 });
					} catch (_) {}
				} else {
					try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
				}
			}, KILL_GRACE_MS);
		}, SHELL_TIMEOUT_MS);

		child.on('close', (code) => {
			clearTimeout(timer);
			if (killed) {
				resolve(`(timeout after ${SHELL_TIMEOUT_MS / 1000}s)`);
				return;
			}
			const output = (stdout + stderr).trim();
			if (code === 0) {
				resolve(output || '(no output)');
			} else {
				resolve(output || `(exit code ${code})`);
			}
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			resolve(`(error: ${err.message})`);
		});
	});
}

/**
 * `!<command>` — run a shell command and post its output to the channel.
 * Host shell in admin mode, container shell in sandbox mode. Runs as global
 * maintenance: refused while any execution is pending.
 */
async function handleShell(channel, mode, command) {
	if (mode === 'sandbox' && !DOCKER_AVAILABLE) {
		await channel.send('Sandbox is not available — shell requires either admin mode or a working sandbox.');
		return true;
	}
	if (isBusy()) {
		await channel.send('⏳ An execution or maintenance operation is running. Retry the shell command when the bot is idle.');
		return true;
	}
	let output = await runMaintenance(async () => {
		if (mode === 'sandbox') {
			ensureContainer();
			return executeShell(command, { inContainer: true });
		}
		return executeShell(command);
	});

	let truncated = false;
	if (output.length > SHELL_MAX_OUTPUT) {
		output = output.slice(0, SHELL_MAX_OUTPUT);
		truncated = true;
	}

	const response = '```\n' + output + (truncated ? '\n... (truncated)' : '') + '\n```';
	try {
		await channel.send(response);
	} catch (err) {
		log.error('Shell send error:', err.message);
		await channel.send('Output too large or failed to send.').catch(() => {});
	}
	return true;
}

module.exports = { handleShell };
