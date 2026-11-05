import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramControl } from '../worker/telegram.mjs';

test('Telegram button choice returns the selected value from an update', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  control.ask = async (_prompt, rows) => {
    assert.equal(rows.length, 1);
    return { type: 'callback', text: 'file:0' };
  };
  assert.equal(await control.choose('Choose a file', [{ label: 'Resume', value: 'file:0' }]), 'file:0');
});

test('Telegram choice safely rejects an update without a selection value', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  control.ask = async () => undefined;
  assert.equal(await control.choose('Choose a file', [{ label: 'Resume', value: 'file:0' }]), '');
});

test('Telegram choice normalizes a typed button label to its action value', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  control.ask = async () => ({ type: 'text', text: 'End' });
  assert.equal(await control.choose('Choose what to do', [{ label: 'End', value: 'end' }]), 'end');
});

test('Telegram callback maps the button to its value, confirms it, and ignores repeats', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  const sent = [];
  control.api = async (method, body) => { sent.push({ method, body }); return {}; };
  control.callbackMap.set('button-id', { value: 'continue', label: 'Continue (skip sync)' });
  const callback = { id: 'callback-1', data: 'button-id', from: { id: 1 }, message: { chat: { id: 1 } } };

  assert.equal(await control.handleCallback(callback, 5), true);
  assert.equal(control.take().text, 'continue');
  assert.equal(sent.some(({ method, body }) => method === 'sendMessage' && body.text === '<b>[WORKER]</b>\nSelected: Continue (skip sync)'), true);
  assert.equal(await control.handleCallback(callback, 5), false);
  assert.equal(control.take(), undefined);
});

test('Telegram formats bracketed titles in bold and escapes message text', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  let sent;
  control.api = async (_method, body) => { sent = body; return {}; };
  await control.send('[REVIEW] Review reached. <Do not submit>');
  assert.equal(sent.parse_mode, 'HTML');
  assert.equal(sent.text, '<b>[REVIEW]</b>\nReview reached. &lt;Do not submit&gt;');
});

test('Telegram sends progress messages in the order received', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  const sent = [];
  control.api = async (_method, body) => {
    await new Promise((resolve) => setTimeout(resolve, body.text.includes('FIRST') ? 10 : 0));
    sent.push(body.text);
  };
  await Promise.all([control.send('[SYNCING] FIRST'), control.send('[SYNCED] SECOND')]);
  assert.deepEqual(sent.map((text) => text.split('\n')[1]), ['FIRST', 'SECOND']);
});
