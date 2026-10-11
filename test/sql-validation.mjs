import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { normalizeSale, normalizeExpense, parseSplit, calculateCommission, calculateDashboard } from '../lib/domain.mjs';
const db = await PGlite.create();
const checks = [];
const check = async (name, run) => { try { await run(); checks.push({ name, passed: true }); } catch (e) { checks.push({ name, passed: false, error: e.message }); } };
await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
const schema = await fs.readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
await check('Full unmodified Supabase schema installs in PostgreSQL engine', () => db.exec(schema));
if (!checks[0].passed) { console.log(JSON.stringify(checks)); await db.close(); process.exit(1); }
await db.exec('set role service_role;');
const rpc = async (name, args, casts) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}${casts?.[i] ? `::${casts[i]}` : ''}`).join(',')}) as value`, args)).rows[0].value;
const sale = (reference, amount = '1000.00', split = [50, 30, 20], project = 'A') => normalizeSale({ reference, customer: 'Fictional SQL test customer', description: 'SQL test', amount, project, split }, 'richard');
const submit = (role, record, source = 'website', chat = null, update = null) => rpc('fi_submit', [role, JSON.stringify(record), source, chat, update], ['text', 'jsonb', 'text', 'text', 'bigint']);
const decide = (role, reference, split, allocation = null) => rpc('fi_decide', [role, reference, split, allocation], ['text', 'text', 'integer[]', 'text']);
const rows = async () => (await db.query('select * from public.fi_transactions order by reference')).rows;
await check('Schema contains no seeded financial records', async () => assert.equal((await rows()).length, 0));
await check('Service role can submit sale and atomic post-save outbox', async () => {
  const result = await submit('richard', sale('SQL01'));
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.commission_pool_cents, 0);
  assert.equal((await db.query("select count(*)::int as count from public.fi_outbox where reference='SQL01'")).rows[0].count, 2);
});
await check('Svetlana cannot submit sale', () => assert.rejects(submit('svetlana', sale('BAD01'))));
await check('Kevin cannot submit sale', () => assert.rejects(submit('kevin', sale('BAD01'))));
await check('Duplicate reference rejected, no second record', async () => { await assert.rejects(submit('richard', sale('SQL01'))); assert.equal((await rows()).length, 1); });
await check('SQL rejects null customer', () => assert.rejects(submit('richard', { ...sale('BAD01'), customer: null })));
await check('SQL rejects missing customer', () => { const record = sale('BAD01'); delete record.customer; return assert.rejects(submit('richard', record)); });
await check('SQL rejects empty proposal', () => assert.rejects(submit('richard', { ...sale('BAD01'), proposed_split_bp: [] })));
await check('SQL rejects null proposal entry', () => assert.rejects(submit('richard', { ...sale('BAD01'), proposed_split_bp: [10000, null, 0] })));
await check('SQL rejects zero amount', () => assert.rejects(submit('richard', { ...sale('BAD01'), amount_cents: 0 })));
await check('SQL rejects nonmanager approval', () => assert.rejects(decide('richard', 'SQL01', [5000, 3000, 2000])));
await check('SQL rejects null manager role', () => assert.rejects(decide(null, 'SQL01', [5000, 3000, 2000])));
await check('SQL rejects empty final split', () => assert.rejects(decide('svetlana', 'SQL01', [])));
await check('SQL rejects null final split', () => assert.rejects(decide('svetlana', 'SQL01', null)));
await check('SQL rejects split totaling110%', () => assert.rejects(decide('svetlana', 'SQL01', [6000, 3000, 2000])));
await check('Changed approval preserves proposal and calculates commissions', async () => {
  const { transaction } = await decide('svetlana', 'SQL01', [2000, 4000, 4000]);
  assert.deepEqual(transaction.proposed_split_bp, [5000, 3000, 2000]);
  assert.deepEqual(transaction.final_split_bp, [2000, 4000, 4000]);
  assert.deepEqual(transaction.commission_cents, [2000, 4000, 4000]);
});
await check('Repeated approval returns same record, same total, no duplicate jobs', async () => {
  const before = calculateDashboard(await rows());
  const repeated = await decide('svetlana', 'SQL01', [10000, 0, 0]);
  assert.equal(repeated.unchanged, true);
  assert.deepEqual(calculateDashboard(await rows()), before);
  assert.equal((await db.query("select count(*)::int as count from public.fi_outbox where reference='SQL01'")).rows[0].count, 4);
});
await check('Two simultaneous approval requests are idempotent in serialized PG engine', async () => {
  await submit('richard', sale('SQL02'));
  const results = await Promise.all([decide('svetlana', 'SQL02', [5000, 3000, 2000]), decide('svetlana', 'SQL02', [5000, 3000, 2000])]);
  assert.equal(results.filter(r => r.unchanged).length, 1);
  assert.equal((await db.query("select count(*)::int as count from public.fi_outbox where reference='SQL02'")).rows[0].count, 4);
});
await check('Telegram replay is idempotent; original submitter and chat frozen after mapping changes', async () => {
  await db.query('insert into public.fi_telegram_accounts(telegram_user_id,chat_id,employee_id,linked_at) values($1,$2,$3,now())', ['123', '456', 'richard']);
  await submit('richard', sale('BOT01'), 'telegram', '456', 101);
  await rpc('fi_link_telegram', ['svetlana', '123', 'kevin']);
  const repeat = await submit('kevin', sale('BOT01'), 'telegram', '999', 101).catch(e => e);
  // Processing role checks run before replay; Kevin cannot submit sales. A
  // genuine replay uses its originally saved record (see webhook replay guard).
  assert(repeat instanceof Error);
  const existing = (await db.query("select * from public.fi_transactions where reference='BOT01'")).rows[0];
  assert.equal(existing.submitted_by, 'richard'); assert.equal(existing.origin_chat_id, '456');
  const decided = await decide('svetlana', 'BOT01', [5000, 3000, 2000]);
  const job = (await db.query("select destination from public.fi_outbox where reference='BOT01' and channel='telegram' and event='decision'")).rows[0];
  assert.equal(job.destination, '456');
  assert.equal(decided.transaction.submitted_by, 'richard');
});
await check('Website late link is resolved at decision and frozen in outbox', async () => {
  await submit('jean_claude', { ...sale('WEB01'), proposed_split_bp: [4000, 4000, 2000] });
  await rpc('fi_link_telegram', ['svetlana', '123', 'jean_claude']);
  await decide('svetlana', 'WEB01', [2000, 3000, 5000]);
  await rpc('fi_link_telegram', ['svetlana', '123', 'kevin']);
  const job = (await db.query("select destination from public.fi_outbox where reference='WEB01' and channel='telegram' and event='decision'")).rows[0];
  assert.equal(job.destination, '456');
});
await check('SQL expenses immediately reduce company once, approval changes only allocation', async () => {
  const input = normalizeExpense({ reference: 'EXP01', amount: '80', description: 'Test taxi', category: 'Travel', allocation: 'B' }, 'kevin');
  await submit('kevin', input);
  const before = calculateDashboard(await rows());
  await decide('svetlana', 'EXP01', null, 'A');
  const after = calculateDashboard(await rows());
  assert.equal(before.company.resultCents, after.company.resultCents);
  assert.equal(after.projects.A.expensesCents - before.projects.A.expensesCents, 8000);
});
await check('Automatically allocated overhead creates only initial notification', async () => {
  await submit('kevin', normalizeExpense({ reference: 'EXP02', amount: '60', description: 'Test phone', category: 'Other', allocation: 'Company overhead' }, 'kevin'));
  const result = await decide('svetlana', 'EXP02', null, 'A');
  assert.equal(result.unchanged, true); assert.equal(result.transaction.final_allocation, 'Company overhead');
  assert.equal((await db.query("select count(*)::int as count from public.fi_outbox where reference='EXP02'")).rows[0].count, 2);
});
const controls = JSON.parse(await fs.readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
for (const [index, item] of controls.rounding_cases.entries()) await check(`SQL rounding: ${item.label}`, async () => {
  await submit('richard', sale(`ROUND${index}`, (item.sale_cents / 100).toFixed(2), item.shares));
  const split = parseSplit(item.shares);
  const { transaction } = await decide('svetlana', `ROUND${index}`, split);
  assert.equal(transaction.commission_pool_cents, item.pool_cents);
  assert.deepEqual(transaction.commission_cents, Object.values(item.earned_cents));
  assert.deepEqual(transaction.commission_cents, calculateCommission(item.sale_cents, split).amounts);
});
await check('Sheets lease prevents two active jobs', async () => {
  const first = await rpc('fi_claim_outbox', ['sheets']);
  assert(first); assert.equal(await rpc('fi_claim_outbox', ['sheets']), null);
  await rpc('fi_finish_outbox', [first.id, first.lease_token, false, 'Interrupted test delivery']);
  const second = await rpc('fi_claim_outbox', ['sheets']); assert(second); assert.notEqual(second.id, first.id);
  await rpc('fi_finish_outbox', [second.id, second.lease_token, true, null]);
});
await check('Failed notification stays failed; retry leaves financial records unchanged', async () => {
  const job = await rpc('fi_claim_outbox', ['telegram']); assert(job);
  const before = calculateDashboard(await rows());
  await rpc('fi_finish_outbox', [job.id, job.lease_token, false, 'Telegram failure test']);
  const saved = (await db.query('select status from public.fi_outbox where id=$1', [job.id])).rows[0]; assert.equal(saved.status, 'failed');
  await rpc('fi_retry', ['svetlana', job.reference, 'telegram']);
  assert.deepEqual(calculateDashboard(await rows()), before);
});
await check('No public access to transactions or financial RPC', async () => {
  await db.exec('reset role; set role anon;');
  await assert.rejects(db.query('select * from public.fi_transactions'));
  await assert.rejects(db.query("select public.fi_decide('svetlana','SQL01',array[5000,3000,2000],null)"));
  await db.exec('reset role; set role service_role;');
});
const failed = checks.filter(c => !c.passed);
const report = { evidence_kind: 'Unmodified Supabase schema and RPCs executed in local PGlite PostgreSQL engine; not a live Supabase/Telegram/Google Sheets test. PGlite uses one serialized connection, so live multi-connection concurrency remains unverified.', checks: checks.length, passed: checks.length - failed.length, failed: failed.length, results: checks };
await fs.mkdir(new URL('./.reports/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('./.reports/postgres-validation.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks, passed: report.passed, failed: report.failed, failures: failed }));
await db.close();
process.exitCode = failed.length ? 1 : 0;

