import { EMPLOYEES, AppError, requireRole, normalizeSale, normalizeExpense, parseSplit, reference, ALLOCATIONS, employee, calculateDashboard, calculateCommission, splitChanged } from './domain.mjs';
import { integrationConfig } from './integrations.mjs';
function delivery(record, jobs, channel) {
  const candidates = jobs.filter(j => j.reference === record.reference && j.channel === channel).map(j => j.status === 'processing' && j.lease_until && new Date(j.lease_until).getTime() <= Date.now() ? { ...j, status: 'failed', last_error: 'Delivery interrupted. Retry this reference.' } : j).sort((a, b) => b.version - a.version || b.id - a.id);
  // A later successful decision must not hide an earlier failed notification.
  // Sheets jobs are fulfilled together when the latest row is synchronized.
  const job = candidates.find(j => j.status === 'failed') || candidates.find(j => ['pending', 'processing'].includes(j.status)) || candidates[0];
  return job ? { status: job.status, error: job.last_error, event: job.event, attempts: job.attempts, completedAt: job.completed_at } : { status: channel === 'telegram' ? 'no_recipient' : 'pending', error: null, event: 'submission', attempts: 0 };
}
export function publicTransaction(record, jobs = []) {
  return {
    reference: record.reference, kind: record.kind, submittedAt: record.submitted_at, submittedBy: employee(record.submitted_by), source: record.source,
    customer: record.customer, project: record.project, description: record.description, amountCents: Number(record.amount_cents),
    proposedSplit: record.proposed_split_bp?.map(n => n / 100) || null, finalSplit: record.final_split_bp?.map(n => n / 100) || null,
    commissionPoolCents: Number(record.commission_pool_cents), proposedCommissionPoolCents: record.kind === 'sale' ? calculateCommission(Number(record.amount_cents), record.proposed_split_bp).pool : null, commissionsCents: record.commission_cents.map(Number), category: record.category,
    proposedAllocation: record.proposed_allocation, finalAllocation: record.final_allocation, status: record.status, decisionAt: record.decision_at,
    changed: record.kind === 'sale' ? splitChanged(record) : record.final_allocation !== null && record.final_allocation !== record.proposed_allocation,
    sync: delivery(record, jobs, 'sheets'), notification: delivery(record, jobs, 'telegram'),
  };
}
export async function readState(store, role, env = process.env) {
  const integrations = integrationConfig(env);
  const state = { role, employees: EMPLOYEES, configured: integrations.supabase && integrations.session,
    integrations,
    links: { telegram: env.TELEGRAM_BOT_USERNAME ? `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')}` : null, sheets: env.GOOGLE_SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.GOOGLE_SHEET_ID}/edit` : null, github: env.GITHUB_REPOSITORY_URL || 'https://github.com/sienasiena2005-dev/ea25077-friends-included' },
    transactions: [], dashboard: null, setup: null };
  if (!state.configured) {
    state.error = !integrations.supabase ? 'Supabase is not connected. This page cannot record transactions or display completed test results until the server connection is configured.' : 'The role-session signing secret is missing or too short. Configure SESSION_SECRET on the server.';
    return state;
  }
  if (!employee(role)) return state;
  const records = await store.listTransactions(role);
  const jobs = await store.listJobs(records.map(r => r.reference));
  state.transactions = records.map(r => publicTransaction(r, jobs));
  if (role === 'svetlana') {
    state.dashboard = calculateDashboard(records);
    const [accounts, faults] = await Promise.all([store.listAccounts(), store.getSettings()]);
    state.setup = { telegramAccounts: accounts.map(a => ({ telegramUserId: a.telegram_user_id, chatId: a.chat_id, firstName: a.first_name, employeeId: a.employee_id, startedAt: a.started_at })), faults: { sheets: faults.fail_sheets, telegram: faults.fail_telegram } };
  }
  return state;
}
export async function processAction(store, role, input, origin = { source: 'website', chatId: null, updateId: null }) {
  if (!employee(role)) throw new AppError('Choose a demonstration role first.', 'unauthorized', 401);
  if (input.action === 'sale' || input.action === 'expense') {
    const record = input.action === 'sale' ? normalizeSale(input, role) : normalizeExpense(input, role);
    return store.rpc('fi_submit', { p_role: role, p_record: record, p_source: origin.source, p_chat_id: origin.chatId, p_update_id: origin.updateId });
  }
  if (input.action === 'approveSale' || input.action === 'allocateExpense') {
    requireRole(role, 'manager');
    const ref = reference(input.reference);
    if (input.action === 'approveSale') return store.rpc('fi_decide', { p_role: role, p_reference: ref, p_split: parseSplit(input.split), p_allocation: null });
    if (!ALLOCATIONS.includes(input.allocation)) throw new AppError('Select A, B or Company overhead.');
    return store.rpc('fi_decide', { p_role: role, p_reference: ref, p_split: null, p_allocation: input.allocation });
  }
  if (input.action === 'linkTelegram') {
    requireRole(role, 'manager');
    if (!/^\d{1,20}$/.test(String(input.telegramUserId || ''))) throw new AppError('Enter the numeric Telegram user ID shown by /whoami.');
    if (input.employeeId !== null && !employee(input.employeeId)) throw new AppError('Choose a fictional employee or unlink the account.');
    await store.rpc('fi_link_telegram', { p_role: role, p_user_id: String(input.telegramUserId), p_employee: input.employeeId });
    return { linked: true };
  }
  if (input.action === 'retry') {
    requireRole(role, 'manager');
    if (!['sheets', 'telegram'].includes(input.channel)) throw new AppError('Choose Sheets or Telegram delivery.');
    const count = await store.rpc('fi_retry', { p_role: role, p_reference: reference(input.reference), p_channel: input.channel });
    return { retryCount: count };
  }
  if (input.action === 'setFailure') {
    requireRole(role, 'manager');
    if (!['sheets', 'telegram'].includes(input.channel) || typeof input.enabled !== 'boolean') throw new AppError('Choose a channel and a true or false interruption setting.');
    await store.setFailure(input.channel, input.enabled);
    return { channel: input.channel, enabled: input.enabled };
  }
  throw new AppError('Unknown action.');
}
