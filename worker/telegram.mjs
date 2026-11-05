import crypto from 'node:crypto';

const API = 'https://api.telegram.org/bot';

function telegramHtml(text) {
  const raw = String(text).slice(0, 3900);
  const existing = raw.match(/^\[([A-Za-z][A-Za-z0-9 _-]{0,30})\]\s*/);
  const body = existing ? raw.slice(existing[0].length) : raw;
  const lower = body.toLowerCase();
  const title = existing?.[1]
    || (lower.includes('review') ? 'REVIEW'
      : lower.includes('cover letter') || lower.includes('question') || lower.includes('choose') ? 'QUESTION'
        : lower.includes('duplicate') || lower.includes('sheet') ? 'SHEET'
          : lower.includes('captcha') || lower.includes('browser takeover') || lower.includes('paused') || lower.includes('resume') ? 'BROWSER'
            : lower.includes('status') || /\b(applying|waiting_input|waiting_browser|synced|syncing)\b/.test(lower) ? 'STATUS'
              : 'WORKER');
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<b>[${escape(title)}]</b>\n${escape(body)}`;
}

export class TelegramControl {
  constructor(token, binding, { offset = 0, onOffset = () => {} } = {}) {
    this.token = token;
    this.binding = binding;
    this.offset = offset;
    this.onOffset = onOffset;
    this.queue = [];
    this.waiter = null;
    this.polling = false;
    this.callbackMap = new Map();
    this.seenCallbacks = new Set();
    this.sendQueue = Promise.resolve();
  }

  async api(method, body = {}, { signal } = {}) {
    const response = await fetch(`${API}${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed (${data.error_code || response.status}).`);
    return data.result;
  }

  async start() {
    this.polling = true;
    this.pollPromise = this.poll();
  }

  async stop() {
    this.polling = false;
    this.pollAbort?.abort();
    await this.pollPromise?.catch(() => {});
  }

  async send(text, replyMarkup) {
    const request = this.sendQueue.then(() => this.api('sendMessage', { chat_id: this.binding.chatId, text: telegramHtml(text), parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }));
    this.sendQueue = request.catch(() => {});
    return request;
  }

  async ask(prompt, buttons) {
    await this.send(prompt, buttons ? { inline_keyboard: buttons } : undefined);
    return this.next();
  }

  async next() {
    if (this.queue.length) return this.queue.shift();
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  receive(value) {
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(value); }
    else this.queue.push(value);
  }

  take() { return this.queue.shift(); }
  putBack(value) { if (value !== undefined) this.queue.unshift(value); }

  async poll() {
    while (this.polling) {
      try {
        this.pollAbort = new AbortController();
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { signal: this.pollAbort.signal });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.onOffset(this.offset);
          const message = update.message;
          if (message && String(message.from?.id) === String(this.binding.userId) && String(message.chat?.id) === String(this.binding.chatId) && message.chat?.type === 'private') {
            this.receive({ type: 'text', text: message.text || '', updateId: update.update_id });
          }
          const callback = update.callback_query;
          if (callback) {
            await this.handleCallback(callback, update.update_id);
          }
        }
      } catch (error) {
        if (this.polling) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  async handleCallback(callback, updateId) {
    const choice = this.callbackMap.get(callback.data);
    const valid = String(callback.from?.id) === String(this.binding.userId)
      && String(callback.message?.chat?.id) === String(this.binding.chatId)
      && this.binding.chatId === this.binding.userId;
    if (valid && choice && !this.seenCallbacks.has(callback.id)) {
      this.seenCallbacks.add(callback.id);
      this.callbackMap.delete(callback.data);
      this.receive({ type: 'callback', text: choice.value, updateId, callbackId: callback.id });
      await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: `Selected: ${choice.label}` }).catch(() => {});
      await this.send(`Selected: ${choice.label}`).catch(() => {});
      return true;
    }
    await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: 'This choice is no longer available.' }).catch(() => {});
    return false;
  }

  async choose(prompt, choices) {
    this.callbackMap.clear();
    const rows = choices.map(({ label, value, key }) => {
      const id = crypto.randomBytes(8).toString('hex');
      this.callbackMap.set(id, { value, label });
      return [{ text: label.slice(0, 60), callback_data: id }];
    });
    process.stdout.write(`${prompt}\n`);
    const response = await this.ask(prompt, rows);
    const raw = typeof response === 'string' ? response
      : typeof response?.text === 'string' ? response.text
        : typeof response?.value === 'string' ? response.value : '';
    const normalized = raw.trim().toLowerCase();
    const matchingChoice = choices.find((choice) => choice.value.toLowerCase() === normalized || choice.label.trim().toLowerCase() === normalized);
    return matchingChoice?.value ?? raw;
  }
}
