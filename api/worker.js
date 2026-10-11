import { SupabaseStore } from '../lib/store.mjs';
import { drainOutbox } from '../lib/outbox.mjs';
import { AppError } from '../lib/domain.mjs';
import { sendJson, sendError } from '../lib/http.mjs';
export default async function handler(req, res) {
  try {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new AppError('Worker authentication required.', 'forbidden', 403);
    const store = new SupabaseStore();
    return sendJson(res, 200, { ok: true, outcomes: await drainOutbox(store, { limit: 3 }) });
  } catch (e) { return sendError(res, e); }
}
