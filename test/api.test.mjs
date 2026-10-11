import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHandler } from '../api/app.js';
import { createTelegramHandler } from '../api/telegram.js';
import { signRole, verifyRole } from '../lib/session.mjs';
import { publicTransaction, readState } from '../lib/service.mjs';
const env = { SESSION_SECRET: 'test-session-secret-with-more-than-thirty-two-characters', SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'local-test-only', TELEGRAM_WEBHOOK_SECRET: 'local-webhook-test' };
const transaction = { reference: 'EXTRA', kind: 'sale', submitted_at: '2026-10-11T00:00:00Z', submitted_by: 'richard', source: 'website', customer: 'Fictional customer', project: 'A', description: 'Delivered service', amount_cents: 10000, proposed_split_bp: [5000,3000,2000], final_split_bp: null, commission_pool_cents: 0, commission_cents: [0,0,0], category: null, proposed_allocation: null, final_allocation: null, status: 'pending', version: 1, decision_at: null };
function request(handler, body, role, method = 'POST', headers = {}) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text), headers: this.headers }); } };
    const req = { method, body, headers: { host: 'localhost:8787', ...(role ? { cookie: `friends_role=${signRole(role, env.SESSION_SECRET)}` } : {}), ...headers } };
    handler(req, res);
  });
}
function stubStore() {
  const calls = [];
  return { calls, configured: true, async rpc(name, args) { calls.push({ name, args }); return { transaction, unchanged: false }; }, async listJobs() { return []; }, async listTransactions(role) { calls.push({ role }); return role === 'richard' || role === 'svetlana' ? [transaction] : []; }, async listAccounts() { return []; }, async getSettings() { return { fail_sheets: false, fail_telegram: false }; }, async setFailure() { calls.push({ failure: true }); } };
}
test('Role cookie resists signature tampering and expires', () => {
  const token = signRole('richard', env.SESSION_SECRET, 0);
  assert.equal(verifyRole(token, env.SESSION_SECRET, 1000), 'richard');
  assert.equal(verifyRole(`${token.slice(0, -2)}AA`, env.SESSION_SECRET, 1000), null);
  assert.equal(verifyRole(token, env.SESSION_SECRET, 50000000), null);
});
test('Forged body role cannot promote Richard to manager', async () => {
  const store = stubStore(), handler = createAppHandler({ env, store, drain: async () => [] });
  const result = await request(handler, { action: 'approveSale', role: 'svetlana', reference: 'EXTRA', split: [50,30,20] }, 'richard');
  assert.equal(result.status, 403); assert.equal(store.calls.length, 0);
});
test('Kevin cannot submit sale and missing/invalid amount cannot reach DB', async () => {
  const store = stubStore(), handler = createAppHandler({ env, store, drain: async () => [] });
  const input = { action: 'sale', reference: 'EXTRA', customer: 'Customer', project: 'A', description: 'Service', amount: '100', split: [50,30,20] };
  assert.equal((await request(handler, input, 'kevin')).status, 403);
  assert.equal((await request(handler, { ...input, amount: '0' }, 'richard')).status, 400);
  assert.equal((await request(handler, { ...input, split: [60,30,20] }, 'richard')).status, 400);
  assert.equal(store.calls.length, 0);
});
test('Unselected role and cross-origin actions are denied', async () => {
  const store = stubStore(), handler = createAppHandler({ env, store, drain: async () => [] });
  assert.equal((await request(handler, { action: 'approveSale' }, null)).status, 401);
  assert.equal((await request(handler, { action: 'role', role: 'svetlana' }, null, 'POST', { origin: 'https://unrelated.example' })).status, 403);
  assert.equal(store.calls.length, 0);
});
test('Selected role supplies submitter, ignores forged source and chat', async () => {
  const store = stubStore(), handler = createAppHandler({ env, store, drain: async () => [] });
  const result = await request(handler, { action: 'sale', role: 'anastasia', source: 'telegram', chatId: 'spoof', reference: 'EXTRA', customer: 'Customer', project: 'A', description: 'Service', amount: '100', split: [50,30,20] }, 'richard');
  assert.equal(result.status, 200); assert.equal(store.calls[0].args.p_role, 'richard'); assert.equal(store.calls[0].args.p_source, 'website'); assert.equal(store.calls[0].args.p_chat_id, null);
});
test('Employees receive own records without dashboard or manager account mapping', async () => {
  const store = stubStore();
  const state = await readState(store, 'richard', env);
  assert.equal(store.calls[0].role, 'richard'); assert.equal(state.transactions.length, 1); assert.equal(state.dashboard, null); assert.equal(state.setup, null);
});
test('Missing real integrations do not fabricate financial records or totals', async () => {
  const state = await readState(stubStore(), 'svetlana', { SESSION_SECRET: env.SESSION_SECRET });
  assert.equal(state.configured, false); assert.deepEqual(state.transactions, []); assert.equal(state.dashboard, null); assert.match(state.error, /not connected/);
});
test('Expired delivery lease is visible as failed and retryable', () => {
  const record = publicTransaction(transaction, [{ id: 1, reference: 'EXTRA', version: 1, channel: 'sheets', event: 'submission', status: 'processing', lease_until: '2000-01-01T00:00:00Z' }]);
  assert.equal(record.sync.status, 'failed'); assert.match(record.sync.error, /interrupted/);
});
test('A successful decision cannot hide an earlier failed Telegram confirmation', () => {
  const record = publicTransaction({ ...transaction, version: 2 }, [{ id: 1, reference: 'EXTRA', version: 1, channel: 'telegram', event: 'submission', status: 'failed', last_error: 'Initial confirmation failed' }, { id: 2, reference: 'EXTRA', version: 2, channel: 'telegram', event: 'decision', status: 'sent' }]);
  assert.equal(record.notification.status, 'failed'); assert.equal(record.notification.event, 'submission');
});
test('Manager mapping, retry and fault controls deny staff at the processing layer', async () => {
  for (const body of [{ action: 'linkTelegram', telegramUserId: '123', employeeId: 'richard' }, { action: 'retry', reference: 'EXTRA', channel: 'sheets' }, { action: 'setFailure', channel: 'telegram', enabled: true }]) {
    const store = stubStore(), result = await request(createAppHandler({ env, store, drain: async () => [] }), body, 'kevin');
    assert.equal(result.status, 403); assert.equal(store.calls.length, 0);
  }
});
test('Telegram webhook denies forged secret and accepts saved replay without current-role mutation', async () => {
  let submissions = 0;
  const store = { async getByTelegramUpdate() { return transaction; }, async registerTelegram() { submissions++; } };
  const handler = createTelegramHandler({ env, store, drain: async () => [], send: async () => {} });
  const update = { update_id: 100, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/sale EXTRA | Customer | A | Service | 100 | 50 | 30 | 20' } };
  assert.equal((await request(handler, update, null)).status, 403);
  const valid = await request(handler, update, null, 'POST', { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET });
  assert.equal(valid.body.duplicate, true); assert.equal(submissions, 0);
});
