const { runMaintenance, isBusy } = require('./queue');
const { startCodexLogin } = require('./codex');
const { startClaudeLogin } = require('./claude');
const { KILL_GRACE_MS } = require('./config');
const log = require('./logger');

/**
 * /login flow state machine. The agent adapters (claude.js / codex.js) spawn
 * the login child and describe the flow (URL extraction, messages, timeouts);
 * this module owns the single pending login: URL relay, Discord code input,
 * timeouts and the maintenance hold.
 */

let pendingLogin = null;

function killLogin(login) {
	if (!login || login.closed) return;
	login.killed = true;
	try { login.child.kill('SIGTERM'); } catch (_) {}
	try {
		if (login.flow.cleanup) login.flow.cleanup();
	} catch (err) {
		log.warn(`${login.flow.label} login cleanup failed: ${err.message}`);
	}
	setTimeout(() => {
		if (!login.closed) {
			try { login.child.kill('SIGKILL'); } catch (_) {}
			try {
				if (login.flow.cleanup) login.flow.cleanup();
			} catch (err) {
				log.warn(`${login.flow.label} login cleanup failed: ${err.message}`);
			}
		}
	}, KILL_GRACE_MS);
}

function clearLogin(login) {
	if (!login || pendingLogin !== login) return;
	clearTimeout(login.timeout);
	clearTimeout(login.urlTimeout);
	if (login.releaseMaintenance) {
		login.releaseMaintenance();
		login.releaseMaintenance = null;
	}
	pendingLogin = null;
}

function resolveLoginStart(login) {
	if (!login || login.startResolved) return;
	login.startResolved = true;
	if (login.resolveStart) login.resolveStart();
}

function loginOutput(login) {
	return `${login.stdout}\n${login.stderr}`;
}

function maybeSendLoginUrl(login, channel) {
	if (login.urlSent) return;
	const output = loginOutput(login);
	const url = login.flow.extractUrl(output);
	if (!url) return;
	login.urlSent = true;
	clearTimeout(login.urlTimeout);
	channel.send(login.flow.formatUrlMessage(url, output))
		.catch(err => log.error(`${login.flow.label} login URL send error:`, err.message))
		.finally(() => resolveLoginStart(login));
}

async function finishPendingLogin(channel, content) {
	const login = pendingLogin;
	if (!login || login.channelId !== channel.id) return false;

	const trimmed = content.trim();
	if (trimmed === '/login') {
		await channel.send(`${login.flow.label} login is already pending here. ${login.flow.pendingHint}`);
		return true;
	}
	if (trimmed === '/login cancel' || trimmed === '/cancel') {
		killLogin(login);
		clearLogin(login);
		await channel.send(login.flow.cancelMessage);
		resolveLoginStart(login);
		return true;
	}
	if (!login.flow.awaitsDiscordInput) {
		await channel.send(`${login.flow.label} login is pending. ${login.flow.pendingHint}`);
		return true;
	}
	if (trimmed.startsWith('/')) {
		await channel.send(`${login.flow.label} login is pending. ${login.flow.inputHint}`);
		return true;
	}

	login.inputSubmitted = true;
	try {
		login.child.stdin.write(`${trimmed}\n`);
		if (login.flow.inputReceivedMessage) {
			await channel.send(login.flow.inputReceivedMessage);
		}
	} catch (err) {
		clearLogin(login);
		await channel.send(`${login.flow.label} login failed before the input could be sent: ${err.message}`);
		resolveLoginStart(login);
	}
	return true;
}

/**
 * /login — start the selected agent's browser login flow in the selected
 * environment. Only one login can be pending because it holds maintenance.
 */
async function handleLogin({ channel, channelId, mode, agent }) {
	if (pendingLogin) {
		const sameChannel = pendingLogin.channelId === channelId;
		await channel.send(sameChannel
			? `${pendingLogin.flow.label} login is already pending here. ${pendingLogin.flow.pendingHint}`
			: `${pendingLogin.flow.label} login is already pending in another channel. Finish or let it expire before starting a new one.`);
		return true;
	}
	if (isBusy()) {
		await channel.send('⏳ A prompt is currently running. Retry `/login` when the queue is idle.');
		return true;
	}

	let flow;
	try {
		flow = agent === 'codex' ? startCodexLogin(mode) : startClaudeLogin(mode);
	} catch (err) {
		if (err.code === 'CODEX_NOT_AVAILABLE') {
			await channel.send(`Codex is not installed or not available in **${mode}** mode.`);
			return true;
		}
		const label = agent === 'codex' ? 'Codex' : 'Claude';
		await channel.send(`${label} login failed to start: ${err.message}`);
		return true;
	}

	const login = {
		flow,
		child: flow.child,
		channelId,
		stdout: '',
		stderr: '',
		urlSent: false,
		inputSubmitted: false,
		killed: false,
		closed: false,
		timeout: null,
		urlTimeout: null,
		releaseMaintenance: null,
		startResolved: false,
		resolveStart: null,
	};
	const maintenanceHold = new Promise((resolve) => { login.releaseMaintenance = resolve; });
	const startPromise = new Promise((resolve) => { login.resolveStart = resolve; });
	pendingLogin = login;
	runMaintenance(() => maintenanceHold)
		.catch(err => log.warn(`${flow.label} login maintenance failed: ${err.message}`));

	login.child.stdin.on('error', () => {});
	login.child.stdout.on('data', (chunk) => {
		login.stdout += chunk;
		maybeSendLoginUrl(login, channel);
	});
	login.child.stderr.on('data', (chunk) => {
		login.stderr += chunk;
		maybeSendLoginUrl(login, channel);
	});
	login.child.on('error', (err) => {
		clearLogin(login);
		channel.send(`${flow.label} login failed to start: ${err.message}`)
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	});
	login.child.on('close', (code) => {
		login.closed = true;
		if (pendingLogin !== login) return;
		clearLogin(login);
		if (code === 0) {
			channel.send(flow.successMessage).catch(() => {})
				.finally(() => resolveLoginStart(login));
			return;
		}
		channel.send(flow.formatFailureMessage({
			killed: login.killed,
			urlSent: login.urlSent,
			inputSubmitted: login.inputSubmitted,
			code,
			output: loginOutput(login),
		}))
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	});

	login.urlTimeout = setTimeout(() => {
		if (login.urlSent || pendingLogin !== login) return;
		killLogin(login);
		clearLogin(login);
		channel.send(flow.noUrlMessage)
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	}, flow.urlTimeoutMs);
	login.timeout = setTimeout(() => {
		if (pendingLogin !== login) return;
		killLogin(login);
		clearLogin(login);
		channel.send(flow.formatFailureMessage({
			killed: true,
			urlSent: login.urlSent,
			inputSubmitted: login.inputSubmitted,
			output: loginOutput(login),
		})).catch(() => {});
	}, flow.timeoutMs);

	await startPromise;
	return true;
}

module.exports = { handleLogin, finishPendingLogin };
