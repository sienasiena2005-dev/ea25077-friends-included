export const EMPLOYEES = Object.freeze([
  { id: 'richard', name: 'Richard “Call Me Dick” Darling', kind: 'sales' },
  { id: 'anastasia', name: 'Anastasia Ferrari', kind: 'sales' },
  { id: 'jean_claude', name: 'Jean-Claude Bērziņš', kind: 'sales' },
  { id: 'kevin', name: 'Kevin von Whatever', kind: 'expense' },
  { id: 'svetlana', name: 'Svetlana de Monte Carlo', kind: 'manager' },
]);
export const SALESPEOPLE = ['richard', 'anastasia', 'jean_claude'];
export const ALLOCATIONS = ['A', 'B', 'Company overhead'];
export class AppError extends Error {
  constructor(message, code = 'validation', status = 400) { super(message); this.code = code; this.status = status; }
}
export function employee(id) { return EMPLOYEES.find(e => e.id === id); }
export function requireRole(role, kind) {
  if (!employee(role) || employee(role).kind !== kind) throw new AppError(`This action requires the ${kind === 'manager' ? 'Svetlana manager' : kind === 'sales' ? 'salesperson' : 'Kevin expense reporter'} role.`, 'forbidden', 403);
}
export function requiredText(value, name, max = 600) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(`${name} is required.`);
  if (value.trim().length > max) throw new AppError(`${name} must be at most ${max} characters.`);
  return value.trim();
}
export function reference(value) {
  const ref = requiredText(value, 'Reference', 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(ref)) throw new AppError('Reference may contain letters, numbers, hyphens and underscores only.');
  return ref;
}
export function parseMoney(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new AppError('Amount must be a positive euro amount with at most two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 10000000000) throw new AppError('Amount must be greater than zero and no more than €100,000,000.00.');
  return cents;
}
export function parseSplit(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new AppError('Enter percentages for Richard, Anastasia and Jean-Claude.');
  const bp = value.map((item, index) => {
    const text = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new AppError(`${employee(SALESPEOPLE[index]).name}: enter a percentage from 0 to 100 with at most two decimal places.`);
    const [whole, fraction = ''] = text.split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (amount < 0 || amount > 10000) throw new AppError('Each commission share must be between 0% and 100%.');
    return amount;
  });
  if (bp.reduce((a, b) => a + b, 0) !== 10000) throw new AppError('Commission shares must total exactly 100%.');
  return bp;
}
export function calculateCommission(amountCents, basisPoints) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError('Invalid sale amount.');
  if (!Array.isArray(basisPoints) || basisPoints.length !== 3 || basisPoints.some(n => !Number.isInteger(n) || n < 0 || n > 10000) || basisPoints.reduce((a, b) => a + b, 0) !== 10000) throw new AppError('Invalid commission split.');
  const pool = Math.floor((amountCents + 5) / 10);
  const amounts = basisPoints.map(bp => Math.floor((pool * bp + 5000) / 10000));
  const difference = pool - amounts.reduce((a, b) => a + b, 0);
  const largest = basisPoints.indexOf(Math.max(...basisPoints));
  amounts[largest] += difference;
  return { pool, amounts };
}
export function normalizeSale(input, role) {
  requireRole(role, 'sales');
  if (!['A', 'B'].includes(input.project)) throw new AppError('Select project A or B.');
  return { reference: reference(input.reference), kind: 'sale', customer: requiredText(input.customer, 'Customer', 150), description: requiredText(input.description, 'Description'), project: input.project, amount_cents: parseMoney(input.amount), proposed_split_bp: parseSplit(input.split) };
}
export function normalizeExpense(input, role) {
  requireRole(role, 'expense');
  if (!['Materials', 'Travel', 'Other'].includes(input.category)) throw new AppError('Select Materials, Travel or Other.');
  if (!ALLOCATIONS.includes(input.allocation)) throw new AppError('Select A, B or Company overhead.');
  return { reference: reference(input.reference), kind: 'expense', description: requiredText(input.description, 'Description'), category: input.category, amount_cents: parseMoney(input.amount), proposed_allocation: input.allocation };
}
export function calculateDashboard(records) {
  const blankProject = () => ({ incomeCents: 0, commissionCents: 0, expensesCents: 0, resultCents: 0 });
  const projects = { A: blankProject(), B: blankProject() };
  const company = { incomeCents: 0, commissionCents: 0, expensesCents: 0, overheadCents: 0, awaitingCents: 0, resultCents: 0 };
  const earnedCommission = { richard: 0, anastasia: 0, jean_claude: 0 };
  let pendingSalesCents = 0, pendingSalesCount = 0, awaitingExpenseCount = 0;
  for (const r of records) {
    if (r.kind === 'sale') {
      if (r.status !== 'approved') { pendingSalesCents += r.amount_cents; pendingSalesCount++; continue; }
      const { pool, amounts } = calculateCommission(r.amount_cents, r.final_split_bp);
      projects[r.project].incomeCents += r.amount_cents;
      projects[r.project].commissionCents += pool;
      company.incomeCents += r.amount_cents; company.commissionCents += pool;
      SALESPEOPLE.forEach((id, i) => earnedCommission[id] += amounts[i]);
    } else {
      company.expensesCents += r.amount_cents;
      if (r.status === 'awaiting_allocation') { company.awaitingCents += r.amount_cents; awaitingExpenseCount++; }
      else if (r.final_allocation === 'Company overhead') company.overheadCents += r.amount_cents;
      else projects[r.final_allocation].expensesCents += r.amount_cents;
    }
  }
  for (const p of Object.values(projects)) p.resultCents = p.incomeCents - p.commissionCents - p.expensesCents;
  company.resultCents = company.incomeCents - company.commissionCents - company.expensesCents;
  return { projects, company, earnedCommission, pendingSalesCents, pendingSalesCount, awaitingExpenseCount, reconciliationCents: projects.A.resultCents + projects.B.resultCents - company.overheadCents - company.awaitingCents };
}
export function euro(cents) { return `€${(cents / 100).toFixed(2)}`; }
export function splitChanged(record) { return record.final_split_bp?.some((bp, i) => bp !== record.proposed_split_bp[i]) ?? false; }
export function notificationText(record, event) {
  if (event === 'submission') {
    const location = record.kind === 'sale' ? `Project ${record.project}` : `Proposed allocation: ${record.proposed_allocation}`;
    const status = record.status === 'approved' ? 'Approved' : record.status === 'pending' ? 'Pending approval' : record.status === 'allocated' ? 'Automatically allocated to Company overhead' : 'Awaiting allocation';
    return `${record.kind === 'sale' ? 'Sale' : 'Expense'} ${record.reference} saved. ${euro(record.amount_cents)}; ${location}. ${status}.`;
  }
  if (record.kind === 'sale') {
    const { pool, amounts } = calculateCommission(record.amount_cents, record.final_split_bp);
    return `Sale ${record.reference} approved — commission split ${splitChanged(record) ? 'changed' : 'unchanged'}. Sale ${euro(record.amount_cents)}; total commission ${euro(pool)}.\n${['Richard', 'Anastasia', 'Jean-Claude'].map((name, i) => `${name}: ${record.proposed_split_bp[i] / 100}% → ${record.final_split_bp[i] / 100}% (${euro(amounts[i])}).`).join('\n')}`;
  }
  const changed = record.proposed_allocation !== record.final_allocation;
  return `Expense ${record.reference} — allocation ${changed ? 'changed' : 'confirmed'}. ${euro(record.amount_cents)}: ${record.description}\nProposed: ${record.proposed_allocation}. Approved: ${record.final_allocation}.`;
}
export function parseTelegram(text) {
  const match = /^\s*(\/\w+)(?:@\w+)?(?:\s+|\s*\|\s*)(.*)$/s.exec(text);
  if (!match) throw new AppError('Use /help to see the transaction commands.');
  const command = match[1].toLowerCase();
  const pieces = match[2].split('|').map(s => s.trim());
  if (command === '/sale') {
    if (pieces.length !== 8) throw new AppError('Use /sale reference | customer | A or B | description | amount | Richard % | Anastasia % | Jean-Claude %');
    return { action: 'sale', reference: pieces[0], customer: pieces[1], project: pieces[2], description: pieces[3], amount: pieces[4], split: pieces.slice(5) };
  }
  if (command === '/expense') {
    if (pieces.length !== 5) throw new AppError('Use /expense reference | description | amount | Materials, Travel or Other | A, B or Company overhead');
    return { action: 'expense', reference: pieces[0], description: pieces[1], amount: pieces[2], category: pieces[3], allocation: pieces[4] };
  }
  throw new AppError('Use /help to see the sale and expense commands. Roles are linked by Svetlana on the website; they cannot be selected through the bot.');
}
