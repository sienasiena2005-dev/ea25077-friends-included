import { employee } from './domain.mjs';
import { syncSheetRecord, telegramSend, jobNotification } from './integrations.mjs';
export async function drainOutbox(store, options = {}) {
  const { env = process.env, fetcher = fetch, limit = 4, budgetMs = 25000 } = options;
  const deadline = Date.now() + budgetMs;
  const deadlineSignal = AbortSignal.timeout(budgetMs);
  const boundedFetch = (url, request = {}) => fetcher(url, { ...request, signal: request.signal ? AbortSignal.any([deadlineSignal, request.signal]) : deadlineSignal });
  const outcomes = [];
  const settings = await store.getSettings(deadlineSignal);
  for (const channel of ['sheets', 'telegram']) {
    for (let i = 0; i < limit; i++) {
      if (Date.now() + 1000 >= deadline) break;
      const job = await store.rpc('fi_claim_outbox', { p_channel: channel }, deadlineSignal);
      if (!job) break;
      let success = false, error = null;
      try {
        if (settings[channel === 'sheets' ? 'fail_sheets' : 'fail_telegram']) throw new Error(`Intentional ${channel === 'sheets' ? 'Sheets synchronization' : 'Telegram delivery'} interruption is enabled in manager setup. Disable it and retry.`);
        if (channel === 'sheets') {
          const current = await store.getTransaction(job.reference, deadlineSignal);
          if (!current) throw new Error('The saved transaction could not be read.');
          await syncSheetRecord(current, employee(current.submitted_by).name, env, boundedFetch);
        } else {
          await telegramSend(job.destination, jobNotification(job), env, boundedFetch);
        }
        success = true;
      } catch (e) { error = deadlineSignal.aborted ? 'Delivery timed out. The financial record is saved; retry delivery.' : e.message || 'Delivery did not complete.'; }
      await store.rpc('fi_finish_outbox', { p_id: job.id, p_token: job.lease_token, p_success: success, p_error: error });
      outcomes.push({ id: job.id, reference: job.reference, channel, status: success ? 'sent' : 'failed', error });
    }
  }
  return outcomes;
}
