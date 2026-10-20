'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, ClaudeAPIError, describeError } = require('../../chrome/content/zotero/xpcom/styleAI/claudeClient.js');

function ok(text, extra = {}) {
	return {
		status: 200,
		text: JSON.stringify(Object.assign({
			content: [{ type: 'text', text }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 5 },
			model: 'claude-sonnet-5-5'
		}, extra))
	};
}

function fake(responses) {
	let calls = [];
	let request = async (url, options) => {
		calls.push({ url, options });
		let next = responses.shift();
		if (next instanceof Error) throw next;
		return next;
	};
	return { request, calls };
}

const noSleep = () => { let waits = []; let f = async ms => { waits.push(ms); }; f.waits = waits; return f; };

test('sends the documented request and returns the text', async () => {
	let { request, calls } = fake([ok('Hello')]);
	let client = createClient({ apiKey: 'sk-test', request, sleep: noSleep() });
	let reply = await client.send({ system: 'Be brief', messages: [{ role: 'user', content: 'Hi' }] });
	assert.equal(reply.text, 'Hello');
	assert.equal(reply.stopReason, 'end_turn');
	assert.deepEqual(reply.usage, { input_tokens: 10, output_tokens: 5 });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
	assert.equal(calls[0].options.method, 'POST');
	assert.equal(calls[0].options.headers['x-api-key'], 'sk-test');
	assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
	let body = JSON.parse(calls[0].options.body);
	assert.equal(body.model, 'claude-sonnet-5-5');
	assert.equal(body.system, 'Be brief');
	assert.ok(body.max_tokens > 0);
	assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
});

test('joins several text blocks and ignores other blocks', async () => {
	let { request } = fake([{ status: 200, text: JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }] }) }]);
	let reply = await createClient({ apiKey: 'k', request }).send({ messages: [] });
	assert.equal(reply.text, 'ab');
});

test('uses the model and token limit it is given', async () => {
	let { request, calls } = fake([ok('x')]);
	let client = createClient({ apiKey: 'k', request, model: 'claude-opus-5-5', maxTokens: 123 });
	await client.send({ messages: [] });
	let body = JSON.parse(calls[0].options.body);
	assert.equal(body.model, 'claude-opus-5-5');
	assert.equal(body.max_tokens, 123);
	assert.equal('system' in body, false);
});

test('refuses to start without a key or a request function', () => {
	assert.throws(() => createClient({ request: async () => {} }), e => e.kind === 'auth');
	assert.throws(() => createClient({ apiKey: 'k' }), /request function/);
});

for (let [status, kind] of [[401, 'auth'], [403, 'auth'], [413, 'too-large'], [400, 'invalid'], [404, 'invalid']]) {
	test(`HTTP ${status} is "${kind}" and not retried`, async () => {
		let { request, calls } = fake([{ status, text: JSON.stringify({ error: { message: 'Because.' } }) }]);
		let sleep = noSleep();
		await assert.rejects(
			createClient({ apiKey: 'k', request, sleep }).send({ messages: [] }),
			e => e instanceof ClaudeAPIError && e.kind === kind && e.status === status && e.message === 'Because.'
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(sleep.waits, []);
	});
}

test('429 and 529 are retried with a longer wait each time, then succeed', async () => {
	let { request, calls } = fake([{ status: 429, text: '{}' }, { status: 529, text: '{}' }, ok('done')]);
	let sleep = noSleep();
	let reply = await createClient({ apiKey: 'k', request, sleep }).send({ messages: [] });
	assert.equal(reply.text, 'done');
	assert.equal(calls.length, 3);
	assert.deepEqual(sleep.waits, [2000, 6000]);
});

test('gives up after the retries and reports the last error', async () => {
	let { request, calls } = fake([{ status: 500, text: 'oops' }, { status: 500, text: 'oops' }, { status: 503, text: 'oops' }]);
	await assert.rejects(
		createClient({ apiKey: 'k', request, sleep: noSleep() }).send({ messages: [] }),
		e => e.kind === 'overloaded' && e.status === 503 && /HTTP 503/.test(e.message)
	);
	assert.equal(calls.length, 3);
});

test('retries can be turned off', async () => {
	let { request, calls } = fake([{ status: 429, text: '{}' }]);
	await assert.rejects(createClient({ apiKey: 'k', request, retries: 0 }).send({ messages: [] }), e => e.kind === 'rate-limit');
	assert.equal(calls.length, 1);
});

test('a request that gets no response is a network error and is not retried', async () => {
	let { request, calls } = fake([new Error('offline')]);
	await assert.rejects(
		createClient({ apiKey: 'k', request, sleep: noSleep() }).send({ messages: [] }),
		e => e.kind === 'network' && /offline/.test(e.message)
	);
	assert.equal(calls.length, 1);
});

test('replies that are not what the API sends are "bad-reply"', async () => {
	for (let text of ['not json', '{}', JSON.stringify({ content: 'x' })]) {
		let { request } = fake([{ status: 200, text }]);
		await assert.rejects(createClient({ apiKey: 'k', request }).send({ messages: [] }), e => e.kind === 'bad-reply', text);
	}
});

test('the API key never appears in an error message', async () => {
	let { request } = fake([{ status: 401, text: '{"error":{"message":"invalid x-api-key"}}' }]);
	await assert.rejects(createClient({ apiKey: 'sk-secret-123', request }).send({ messages: [] }), e => !e.message.includes('sk-secret-123'));
});

test('describeError gives something to act on for each kind', () => {
	for (let kind of ['auth', 'rate-limit', 'overloaded', 'too-large']) {
		assert.ok(describeError(new ClaudeAPIError(kind, 'raw')).length > 20, kind);
		assert.notEqual(describeError(new ClaudeAPIError(kind, 'raw')), 'raw');
	}
	assert.equal(describeError(new ClaudeAPIError('invalid', 'Bad field')), 'Bad field');
	assert.equal(describeError(new Error('plain')), 'plain');
});
