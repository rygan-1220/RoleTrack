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

test('Telegram callback maps the button to its value, confirms it, and ignores repeats', async () => {
  const control = new TelegramControl('token', { userId: '1', chatId: '1' });
  const sent = [];
  control.api = async (method, body) => { sent.push({ method, body }); return {}; };
  control.callbackMap.set('button-id', { value: 'continue', label: 'Continue (skip sync)' });
  const callback = { id: 'callback-1', data: 'button-id', from: { id: 1 }, message: { chat: { id: 1 } } };

  assert.equal(await control.handleCallback(callback, 5), true);
  assert.equal(control.take().text, 'continue');
  assert.equal(sent.some(({ method, body }) => method === 'sendMessage' && body.text === 'Selected: Continue (skip sync)'), true);
  assert.equal(await control.handleCallback(callback, 5), false);
  assert.equal(control.take(), undefined);
});
