const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildCodexArgs,
	parseCodexOutput,
	isCodexAuthError,
} = require('../src/codex');

test('buildCodexArgs forces xhigh reasoning for new and resumed sessions', () => {
	for (const sessionId of [null, 'thread-123']) {
		const args = buildCodexArgs({
			sessionId,
			systemPrompt: 'System instructions',
		});
		const effortIndex = args.indexOf('model_reasoning_effort="xhigh"');

		assert.notEqual(effortIndex, -1);
		assert.equal(args[effortIndex - 1], '-c');
		assert.equal(args.at(-1), '-');
	}
});

test('parseCodexOutput returns the thread and last completed agent message', () => {
	const stdout = [
		'not json',
		JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
		JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last' } }),
	].join('\n');

	assert.deepEqual(parseCodexOutput(stdout), {
		sessionId: 'thread-123',
		result: 'last',
	});
});

test('isCodexAuthError recognizes login failures without matching normal output', () => {
	assert.equal(isCodexAuthError('', 'Not logged in. Please run codex login.'), true);
	assert.equal(isCodexAuthError('The task discusses authentication.', ''), false);
});
