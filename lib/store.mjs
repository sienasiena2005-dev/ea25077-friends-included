import { AppError } from './domain.mjs';
export class SupabaseStore {
  constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  get configured() { return !!this.env.SUPABASE_URL && !!this.env.SUPABASE_SERVICE_ROLE_KEY; }
  async request(path, options = {}) {
    if (!this.configured) throw new AppError('Supabase connection is not configured. No transactions have been saved.', 'configuration', 503);
    const url = `${this.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
    const response = await this.fetcher(url, {
      ...options,
      headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...options.headers },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    const body = await response.text();
    let data; try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (!response.ok) {
      const pgCode = data?.code;
      if (pgCode === '23505') throw new AppError('This reference already exists. Use a unique reference.', 'duplicate', 409);
      if (pgCode === '42501') throw new AppError(data?.message || 'This role is not allowed to perform the action.', 'forbidden', 403);
      if (pgCode === 'P0001' || pgCode === '23514' || pgCode === '23502' || pgCode === '22P02') throw new AppError(data?.message || 'The transaction contains invalid or missing information.', 'validation', 400);
      if (pgCode === 'PGRST202' || pgCode === '42P01') throw new AppError('Supabase is reachable, but the Friends Included database schema has not been installed.', 'configuration', 503);
      throw new AppError(`Supabase request failed (HTTP ${response.status}). No successful save is being claimed.`, 'database', 503);
    }
    return data;
  }
  rpc(name, args, signal) { return this.request(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args), signal }); }
  async listTransactions(role) {
    const where = role === 'svetlana' ? '' : `&submitted_by=eq.${encodeURIComponent(role)}`;
    return this.request(`fi_transactions?select=*&order=submitted_at.asc,reference.asc${where}`);
  }
  async getTransaction(ref, signal) { return (await this.request(`fi_transactions?reference=eq.${encodeURIComponent(ref)}&select=*`, { signal }))[0] || null; }
  async getByTelegramUpdate(updateId) { return (await this.request(`fi_transactions?telegram_update_id=eq.${encodeURIComponent(updateId)}&select=*`))[0] || null; }
  async listJobs(refs) {
    if (!refs.length) return [];
    return this.request(`fi_outbox?reference=in.(${refs.map(encodeURIComponent).join(',')})&select=id,reference,version,channel,event,status,last_error,attempts,created_at,completed_at,lease_until&order=id.asc`);
  }
  async getSettings(signal) { return (await this.request('fi_settings?id=eq.1&select=fail_sheets,fail_telegram', { signal }))[0] || { fail_sheets: false, fail_telegram: false }; }
  async listAccounts() { return this.request('fi_telegram_accounts?select=*&order=started_at.desc'); }
  async getAccount(userId) { return (await this.request(`fi_telegram_accounts?telegram_user_id=eq.${encodeURIComponent(userId)}&select=*`))[0] || null; }
  async hasPendingJobs() { return (await this.request('fi_outbox?status=eq.pending&select=id&limit=1')).length > 0; }
  async registerTelegram(userId, chatId, firstName) {
    // Do not include employee_id: subsequent /start messages preserve manager links.
    return this.request('fi_telegram_accounts?on_conflict=telegram_user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ telegram_user_id: String(userId), chat_id: String(chatId), first_name: String(firstName || '').slice(0, 100) }) });
  }
  async setFailure(channel, enabled) { return this.request('fi_settings?id=eq.1', { method: 'PATCH', body: JSON.stringify({ [channel === 'sheets' ? 'fail_sheets' : 'fail_telegram']: enabled }), headers: { Prefer: 'return=minimal' } }); }
}
