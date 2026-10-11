import { SupabaseStore } from '../lib/store.mjs';
import { AppError } from '../lib/domain.mjs';
import { roleFromRequest, setRoleCookie, assertSameOrigin } from '../lib/session.mjs';
import { readState, processAction, publicTransaction } from '../lib/service.mjs';
import { drainOutbox } from '../lib/outbox.mjs';
import { readJson, sendJson, sendError } from '../lib/http.mjs';
export function createAppHandler(options = {}) {
  const env = options.env || process.env;
  const store = options.store || new SupabaseStore(env, options.fetcher || fetch);
  const drain = options.drain || (() => drainOutbox(store, { env, fetcher: options.fetcher || fetch, limit: 2 }));
  return async function handler(req, res) {
    try {
      if (req.method === 'GET') {
        const role = roleFromRequest(req, env);
        if (role && store.configured && typeof store.hasPendingJobs === 'function' && await store.hasPendingJobs()) {
          // Periodic website refresh also delivers healthy queued work. No
          // financial records change, and failed deliveries require explicit retry.
          try { await drain(); } catch { /* The durable status remains visible. */ }
        }
        return sendJson(res, 200, await readState(store, role, env));
      }
      if (req.method !== 'POST') throw new AppError('Use GET to view records or POST to process actions.', 'method', 405);
      assertSameOrigin(req);
      const input = await readJson(req);
      if (input.action === 'role') { setRoleCookie(res, req, input.role, env); return sendJson(res, 200, { ok: true, role: input.role }); }
      const role = roleFromRequest(req, env);
      // Never accept an employee/role/source supplied with a financial action.
      const result = await processAction(store, role, input);
      let deliveryWarning = null;
      try { await drain(); } catch { deliveryWarning = 'The financial action is saved. Delivery processing did not finish; check synchronization and notification status and retry.'; }
      const transaction = result?.transaction ? publicTransaction(result.transaction, await store.listJobs([result.transaction.reference])) : null;
      return sendJson(res, 200, { ok: true, ...result, transaction, deliveryWarning });
    } catch (error) { return sendError(res, error); }
  };
}
export default createAppHandler();
