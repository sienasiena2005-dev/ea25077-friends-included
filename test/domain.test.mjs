import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeSale, normalizeExpense, parseMoney, parseSplit, calculateCommission, calculateDashboard, parseTelegram, notificationText } from '../lib/domain.mjs';
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
function saleRecord(input, approved = false) {
  const record = { ...normalizeSale(input, input.employee), submitted_by: input.employee, status: approved ? 'approved' : 'pending', final_split_bp: approved ? parseSplit(input.finalSplit) : null };
  return record;
}
function expenseRecord(input, decided = false) {
  const record = { ...normalizeExpense(input, 'kevin'), submitted_by: 'kevin', status: 'awaiting_allocation', final_allocation: null };
  if (input.allocation === 'Company overhead' || decided && input.finalAllocation) { record.status = 'allocated'; record.final_allocation = input.finalAllocation; }
  return record;
}
test('Test1 before decisions: paid expenses count once, pending sales earn nothing', () => {
  const records = [...fixture.sales.slice(0, 2).map(s => saleRecord(s)), ...fixture.expenses.slice(0, 3).map(e => expenseRecord(e))];
  const d = calculateDashboard(records);
  assert.equal(d.company.incomeCents, 0); assert.equal(d.company.commissionCents, 0); assert.equal(d.company.resultCents, -30000);
  assert.equal(d.projects.A.resultCents, 0); assert.equal(d.projects.B.resultCents, 0);
  assert.equal(d.company.awaitingCents, 20000); assert.equal(d.company.overheadCents, 10000);
});
test('Test1 approved results use corrected proposal and expense allocation', () => {
  const records = [...fixture.sales.slice(0, 2).map(s => saleRecord(s, true)), ...fixture.expenses.slice(0, 3).map(e => expenseRecord(e, true))];
  const d = calculateDashboard(records);
  assert.equal(d.projects.A.resultCents, 70000); assert.equal(d.projects.B.resultCents, 180000); assert.equal(d.company.resultCents, 240000);
  assert.deepEqual(d.earnedCommission, { richard: 9000, anastasia: 11000, jean_claude: 10000 });
});
test('Cumulative Test2 leaves S05 and E07 pending with reconciliation', () => {
  const records = [...fixture.sales.map(s => saleRecord(s, !!s.finalSplit)), ...fixture.expenses.map(e => expenseRecord(e, !!e.finalAllocation))];
  const d = calculateDashboard(records);
  assert.deepEqual(d.projects.A, { incomeCents: 250000, commissionCents: 25000, expensesCents: 20000, resultCents: 205000 });
  assert.deepEqual(d.projects.B, { incomeCents: 280000, commissionCents: 28000, expensesCents: 34000, resultCents: 218000 });
  assert.deepEqual(d.company, { incomeCents: 530000, commissionCents: 53000, expensesCents: 84000, overheadCents: 16000, awaitingCents: 14000, resultCents: 393000 });
  assert.equal(d.reconciliationCents, 393000); assert.equal(d.pendingSalesCents, 60000);
  assert.deepEqual(d.earnedCommission, { richard: 14000, anastasia: 17500, jean_claude: 21500 });
  // An additional legitimate amount changes the result; supplied answers are not a reset target.
  const extra = saleRecord({ reference: 'NEW', employee: 'richard', amount: '123.45', project: 'A', customer: 'New fictional customer', description: 'New service', split: [100,0,0], finalSplit: [100,0,0] }, true);
  assert.equal(calculateDashboard([...records, extra]).company.resultCents, 393000 + 12345 - 1235);
});
for (const item of fixture.rounding_cases) test(`Cent rounding: ${item.label}`, () => {
  const actual = calculateCommission(item.sale_cents, parseSplit(item.shares));
  assert.equal(actual.pool, item.pool_cents); assert.deepEqual(actual.amounts, Object.values(item.earned_cents));
  assert.equal(actual.amounts.reduce((a, b) => a + b, 0), actual.pool);
});
for (const invalid of [null, undefined, '', '0', 0, '-1', '1.234', 'NaN', '1e2']) test(`Reject invalid amount ${String(invalid)}`, () => assert.throws(() => parseMoney(invalid)));
test('Missing customer/reference/project/description is rejected', () => {
  for (const key of ['reference', 'customer', 'description', 'project']) { const input = { ...fixture.sales[0], [key]: '' }; assert.throws(() => normalizeSale(input, 'richard')); }
});
test('Split 60/30/20 is rejected before any persistence', () => assert.throws(() => parseSplit([60, 30, 20])));
test('Salesperson cannot submit expenses; Kevin cannot submit sales', () => {
  assert.throws(() => normalizeExpense(fixture.expenses[0], 'richard'));
  assert.throws(() => normalizeSale(fixture.sales[0], 'kevin'));
});
test('Telegram slash formats and website use identical normalization', () => {
  const s = fixture.sales[0], e = fixture.expenses[0];
  assert.deepEqual(normalizeSale(parseTelegram(`/sale ${s.reference} | ${s.customer} | ${s.project} | ${s.description} | ${s.amount} | ${s.split.join(' | ')}`), 'richard'), normalizeSale(s, 'richard'));
  assert.deepEqual(normalizeExpense(parseTelegram(`/expense@MyBot ${e.reference} | ${e.description} | ${e.amount} | ${e.category} | ${e.allocation}`), 'kevin'), normalizeExpense(e, 'kevin'));
});
test('Decision notification states corrected split and allocation accurately', () => {
  const s = saleRecord(fixture.sales[2], true);
  assert.match(notificationText(s, 'decision'), /split changed/); assert.match(notificationText(s, 'decision'), /total commission €150\.00/);
  assert.match(notificationText(s, 'decision'), /Richard: 40% → 20% \(€30\.00\)/);
  const e = expenseRecord(fixture.expenses[4], true);
  assert.match(notificationText(e, 'decision'), /allocation changed/); assert.match(notificationText(e, 'decision'), /Proposed: A\. Approved: B/);
});
