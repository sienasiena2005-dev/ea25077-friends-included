import { timingSafeEqual } from 'node:crypto';
import { SupabaseStore } from '../lib/store.mjs';
import { AppError, parseTelegram, employee } from '../lib/domain.mjs';
import { processAction } from '../lib/service.mjs';
import { telegramSend } from '../lib/integrations.mjs';
import { drainOutbox } from '../lib/outbox.mjs';
import { readJson, sendJson, sendError } from '../lib/http.mjs';
const HELP = `Friends Included finance bot\n\nStart here: /whoami shows the user ID Svetlana must link in the website manager setup. An unlinked account cannot submit transactions.\n\nSalespeople:\n/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000.00 | 50 | 30 | 20\n\nKevin:\n/expense E01 | Rented suit and fake pearl necklace for the relatives | 120.00 | Materials | A\n\nUse a new unique reference for each entry. Sale splits are Richard / Anastasia / Jean-Claude and must total 100%. No VAT. Amounts must be positive. Decisions are made by Svetlana on the website.`;
export function createTelegramHandler(options = {}) {
  const env = options.env || process.env;
  const fetcher = options.fetcher || fetch;
  const store = options.store || new SupabaseStore(env, fetcher);
  const send = options.send || ((chat, message) => telegramSend(chat, message, env, fetcher));
  const drain = options.drain || (() => drainOutbox(store, { env, fetcher, limit: 2 }));
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') throw new AppError('Telegram webhook accepts POST only.', 'method', 405);
      const supplied = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      const expected = env.TELEGRAM_WEBHOOK_SECRET || '';
      const suppliedBuffer = Buffer.from(supplied), expectedBuffer = Buffer.from(expected);
      if (!expected || suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) throw new AppError('Webhook authentication failed.', 'forbidden', 403);
      const update = await readJson(req);
      const message = update.message;
      if (!message?.from?.id || !message.chat?.id || typeof message.text !== 'string') return sendJson(res, 200, { ok: true, ignored: true });
      if (message.chat.type !== 'private') { await send(message.chat.id, 'Please start this bot in a private chat. Financial entries are accepted in private chats only.'); return sendJson(res, 200, { ok: true }); }
      if (!Number.isSafeInteger(update.update_id)) throw new AppError('Telegram update ID is required.');
      // A webhook can be retried after the user has been linked to a different
      // employee. Recognize the saved update before applying the current role.
      if (typeof store.getByTelegramUpdate === 'function' && await store.getByTelegramUpdate(update.update_id)) {
        try { await drain(); } catch { /* Existing saved work stays durable. */ }
        return sendJson(res, 200, { ok: true, duplicate: true });
      }
      await store.registerTelegram(message.from.id, message.chat.id, message.from.first_name);
      const text = message.text.trim();
      const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
      if (['/start', '/help', '/whoami'].includes(command)) {
        const account = await store.getAccount(String(message.from.id));
        await send(message.chat.id, `${command === '/help' ? HELP : `Telegram user ID: ${message.from.id}\nPrivate chat ID: ${message.chat.id}\nLinked employee: ${employee(account?.employee_id)?.name || 'Not linked'}.\nAsk Svetlana to link your ID in the website manager setup. You cannot assign your own role through this bot.\nUse /help for transaction commands.`}`);
        return sendJson(res, 200, { ok: true });
      }
      const account = await store.getAccount(String(message.from.id));
      if (!account?.employee_id) { await send(message.chat.id, `Your Telegram user ID ${message.from.id} is not linked to a fictional employee. Svetlana must link it on the website before you can submit transactions.`); return sendJson(res, 200, { ok: true, denied: true }); }
      try {
        const input = parseTelegram(text);
        await processAction(store, account.employee_id, input, { source: 'telegram', chatId: String(message.chat.id), updateId: update.update_id });
      } catch (error) {
        if (error instanceof AppError && error.status < 500) { await send(message.chat.id, `Not saved: ${error.message}`); return sendJson(res, 200, { ok: true, rejected: true }); }
        throw error;
      }
      // Confirmations are sent only from the durable post-save outbox.
      try { await drain(); } catch { /* Saved jobs remain pending and visible. */ }
      return sendJson(res, 200, { ok: true });
    } catch (error) { return sendError(res, error); }
  };
}
export default createTelegramHandler();
