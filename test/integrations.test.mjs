import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { serviceAccountAssertion, syncSheetRecord, telegramSend, sheetValues } from '../lib/integrations.mjs';
import { drainOutbox } from '../lib/outbox.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test-only@example.iam.gserviceaccount.com', GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), GOOGLE_SHEET_ID: 'test-only', TELEGRAM_BOT_TOKEN: 'test-only' };
const pending = { reference: 'CHECK', kind: 'sale', submitted_at: '2026-10-11T00:00:00Z', submitted_by: 'richard', source: 'website', customer: 'Fictional customer', project: 'A', description: 'Integration adapter unit test', amount_cents: 100000, proposed_split_bp: [5000,3000,2000], final_split_bp: null, commission_pool_cents: 0, commission_cents: [0,0,0], status: 'pending' };
const ok = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
test('Google service-account JWT is RS256 signed with correct scope and bounded lifetime', () => {
  const token = serviceAccountAssertion(env, 1000000000000);
  const [head, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(head, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, env.GOOGLE_SERVICE_ACCOUNT_EMAIL); assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets'); assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(keys.publicKey, Buffer.from(signature, 'base64url')), true);
});
test('Pending sale Sheets columns have blank approved shares and zero earned amounts', () => {
  const row = sheetValues(pending, 'Richard');
  assert.deepEqual(row.slice(7, 10), [50,30,20]); assert.deepEqual(row.slice(10, 13), ['', '', '']);
  assert.deepEqual(row.slice(13, 17), [0,0,0,0]); assert.equal(row[17], 'Pending approval');
});
test('Google Sheets adapter updates the existing reference on approval and retry', async () => {
  // Deliberate HTTP mock: validates requests/row idempotence, never claims a
  // real service-account token or external spreadsheet write.
  const rows = [], formats = [];
  const fetcher = async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'mock-access-token', expires_in: 3600 });
    if (url.includes('?fields=sheets.properties')) return ok({ sheets: [{ properties: { title: 'Sales', sheetId: 10 } }, { properties: { title: 'Expenses', sheetId: 20 } }] });
    if (url.endsWith(':batchUpdate')) { formats.push(...JSON.parse(options.body).requests); return ok({ replies: [] }); }
    const decoded = decodeURIComponent(url);
    if (options.method === 'PUT' && decoded.includes('Sales!A1:T1')) return ok({ updatedRows: 1 });
    if (decoded.includes('Sales!A2:A') && !options.method) return ok({ values: rows.map(row => [row[0]]) });
    if (options.method === 'PUT') {
      const match = /Sales!A(\d+):T\d+/.exec(decoded); assert(match);
      rows[Number(match[1]) - 2] = JSON.parse(options.body).values[0]; return ok({ updatedRows: 1 });
    }
    throw new Error(`Unexpected mock adapter request: ${decoded}`);
  };
  await syncSheetRecord(pending, 'Richard', env, fetcher);
  const approved = { ...pending, final_split_bp: [2000,4000,4000], commission_pool_cents: 10000, commission_cents: [2000,4000,4000], status: 'approved', decision_at: '2026-10-11T01:00:00Z' };
  await syncSheetRecord(approved, 'Richard', env, fetcher);
  await syncSheetRecord(approved, 'Richard', env, fetcher);
  assert.equal(rows.length, 1); assert.equal(rows[0][0], 'CHECK');
  assert.deepEqual(rows[0].slice(7, 10), [50,30,20]); assert.deepEqual(rows[0].slice(10, 13), [20,40,40]);
  assert.deepEqual(rows[0].slice(13, 17), [100,20,40,40]);
  assert(formats.some(r => r.repeatCell?.cell?.userEnteredFormat?.numberFormat?.pattern === '€#,##0.00'));
  assert(formats.some(r => r.repeatCell?.cell?.userEnteredFormat?.verticalAlignment === 'TOP'));
  assert(formats.some(r => r.autoResizeDimensions?.dimensions?.dimension === 'ROWS'));
});
test('Failed Google request is rejected without claiming synchronization success', async () => {
  const fetcher = async url => url === 'https://oauth2.googleapis.com/token' ? ok({ access_token: 'mock', expires_in: 3600 }) : new Response('{}', { status: 403 });
  await assert.rejects(syncSheetRecord(pending, 'Richard', env, fetcher), /Google Sheets update failed/);
});
test('Telegram HTTP200 with ok:false is a failure, not a sent notification', async () => {
  await assert.rejects(telegramSend('123', 'Test', env, async () => ok({ ok: false, error_code: 403, description: 'Bot was blocked' })), /delivery failed/);
});
test('Outbox uses latest financial record for Sheets, frozen event destination for Telegram', async () => {
  const claimed = { sheets: false, telegram: false }, finished = [], seenChats = [];
  const current = { ...pending, status: 'approved', final_split_bp: [2000,4000,4000], commission_pool_cents: 10000, commission_cents: [2000,4000,4000] };
  const store = {
    async getSettings() { return { fail_sheets: true, fail_telegram: false }; },
    async getTransaction() { throw new Error('Failure mode must interrupt before reading or writing external data'); },
    async rpc(name, args) {
      if (name === 'fi_claim_outbox') { const channel = args.p_channel; if (claimed[channel]) return null; claimed[channel] = true; return { id: channel === 'sheets' ? 1 : 2, reference: 'CHECK', version: 1, channel, event: 'submission', payload: pending, destination: 'original-chat-123', lease_token: 'lease' }; }
      if (name === 'fi_finish_outbox') { finished.push(args); return null; }
      throw new Error('Unexpected RPC');
    },
  };
  const fetcher = async (url, options) => { seenChats.push(JSON.parse(options.body).chat_id); return ok({ ok: true, result: { message_id: 1 } }); };
  const result = await drainOutbox(store, { env, fetcher, limit: 1 });
  assert.equal(result[0].status, 'failed'); assert.match(result[0].error, /Intentional/);
  assert.equal(finished[0].p_success, false); assert.deepEqual(seenChats, ['original-chat-123']);
  assert.equal(result[1].status, 'sent');
  assert.equal(current.status, 'approved'); // Delivery failures never undo the saved decision.
});
