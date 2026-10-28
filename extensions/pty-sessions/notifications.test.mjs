import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProcessNotifications } from './notifications.ts';
import { ProcessChannel } from './ipc.ts';

function setup() {
    const events = new Map(), sent = [], errors = [];
    let idle = true;
    const channel = new ProcessChannel();
    // No server/timers needed: invoke a batch as the backend would.
    channel.scheduleFlush = () => {};
    const ctx = { isIdle: () => idle, sessionManager: { getBranch: () => [] } };
    const pi = { on(name, handler) { events.set(name, handler); }, sendMessage(message, options) { sent.push({ message, options }); } };
    const delivery = new ProcessNotifications(pi, channel, () => ctx, () => errors.push('send failed'));
    const enqueue = text => { const entry = { id: 'pty-1', text, timestamp: new Date().toISOString() }; channel.queue.push(entry); return entry; };
    const confirm = message => events.get('message_end')({ message: { role: 'custom', ...message } });
    return { events, channel, ctx, pi, delivery, sent, errors, enqueue, confirm, setIdle(value) { idle = value; } };
}

test('busy parent reports remain local; transcript ACK removes only the actual delivered prefix, not newer arrivals', () => {
    const s = setup(), first = s.enqueue('First');
    s.setIdle(false);
    assert.equal(s.delivery.dispatch([first]), false); assert.equal(s.sent.length, 0); assert.equal(s.channel.queue.length, 1);
    s.setIdle(true); s.delivery.dispatch([first]);
    assert.equal(s.sent.length, 1); assert.equal(s.channel.queue.length, 1, 'send is not an acknowledgement');
    const second = s.enqueue('Second');
    assert.match(s.sent[0].message.content, /Untrusted managed-process/);
    assert.deepEqual(s.sent[0].options, { triggerTurn: true, deliverAs: 'followUp' });
    s.confirm(s.sent[0].message);
    assert.deepEqual(s.channel.queue, [second]);
    s.delivery.dispatch([second]); assert.equal(s.sent.length, 1, 'at most one batch per run');
    s.events.get('agent_settled')({}, s.ctx);
    s.delivery.dispatch([second]); assert.equal(s.sent.length, 2);
    s.confirm(s.sent[1].message); assert.equal(s.channel.queue.length, 0);
});

test('an unconfirmed send survives abort, retries with a new delivery ID and ignores obsolete acknowledgements', () => {
    const s = setup(), entry = s.enqueue('Do not lose this');
    s.delivery.dispatch([entry]); const original = s.sent[0].message;
    s.events.get('agent_settled')({ aborted: true }, s.ctx);
    assert.equal(s.channel.queue.length, 1);
    s.delivery.dispatch([entry]); const retry = s.sent[1].message;
    assert.notEqual(original.details.processReportId, retry.details.processReportId);
    s.confirm(original); assert.equal(s.channel.queue.length, 1);
    s.confirm(retry); assert.equal(s.channel.queue.length, 0);
});

test('a failed asynchronous handoff can piggyback on the next normal run without another send/model request', () => {
    const s = setup(), entry = s.enqueue('Recovered');
    s.delivery.dispatch([entry]);
    assert.equal(s.events.get('before_agent_start')({ messageType: 'custom', message: { role: 'custom', ...s.sent[0].message } }), undefined);
    const draft = s.events.get('before_agent_start')({ messageType: 'user', prompt: 'Next user request' });
    assert.equal(draft.message, s.sent[0].message); assert.equal(s.sent.length, 1);
    s.confirm(draft.message); assert.equal(s.channel.queue.length, 0);
});

test('settlement checks persisted custom entries defensively to avoid replaying an already delivered report', () => {
    const s = setup(), entry = s.enqueue('Already delivered');
    s.delivery.dispatch([entry]);
    s.ctx.sessionManager.getBranch = () => [{ type: 'custom_message', customType: 'process-message', details: s.sent[0].message.details }];
    s.events.get('agent_settled')({}, s.ctx);
    assert.equal(s.channel.queue.length, 0);
});

test('a manual busy-to-idle transition without an agent boundary still delivers through a lazy local readiness check', async t => {
    let idle = false, resolveSent;
    const sent = new Promise(resolve => { resolveSent = resolve; });
    const events = new Map();
    const channel = new ProcessChannel({ onNotify: messages => delivery.dispatch(messages) });
    const delivery = new ProcessNotifications({ on(name, handler) { events.set(name, handler); }, sendMessage(message) { resolveSent(message); } },
        channel, () => ({ isIdle: () => idle }));
    const timer = setTimeout(() => resolveSent(null), 1500);
    t.after(() => { clearTimeout(timer); delivery.close(); channel.close(); });
    channel.queue.push({ id: 'pty-1', text: 'Finished during manual compaction', timestamp: new Date().toISOString() });
    channel.scheduleFlush();
    await new Promise(resolve => setTimeout(resolve, 150));
    idle = true; // No agent_end / agent_settled event accompanies this transition.
    const message = await sent;
    assert.ok(message, 'idle readiness check should dispatch the report');
    events.get('message_end')({ message: { role: 'custom', ...message } });
    assert.equal(channel.queue.length, 0);
});

test('synchronous failure retains reports; shutdown disables dispatch and retained lifecycle handlers', () => {
    const s = setup(), entry = s.enqueue('Still queued');
    s.pi.sendMessage = () => { throw new Error('Unavailable'); };
    s.delivery.dispatch([entry]); assert.equal(s.channel.queue.length, 1); assert.deepEqual(s.errors, ['send failed']);
    s.delivery.close();
    s.delivery.dispatch([entry]);
    s.events.get('agent_end')(); s.events.get('agent_settled')({}, s.ctx);
    assert.equal(s.events.get('before_agent_start')({ messageType: 'user' }), undefined);
    assert.equal(s.channel.queue.length, 1); assert.equal(s.errors.length, 1);
});
