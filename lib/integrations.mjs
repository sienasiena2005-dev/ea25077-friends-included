import { createSign } from 'node:crypto';
import { AppError, notificationText } from './domain.mjs';
let tokenCache = null;
export function integrationConfig(env = process.env) {
  return { supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_BOT_USERNAME), sheets: !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_SHEET_ID), session: !!(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) };
}
export async function telegramSend(chatId, text, env = process.env, fetcher = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new AppError('Telegram bot token is not configured.', 'configuration', 503);
  const response = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new AppError(`Telegram delivery failed (${data.error_code || response.status}): ${String(data.description || 'No delivery confirmation').slice(0, 250)}`, 'telegram', 502);
  return data.result;
}
export function serviceAccountAssertion(env, now = Date.now()) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) throw new AppError('Google service-account credentials are not configured.', 'configuration', 503);
  const seconds = Math.floor(now / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: seconds, exp: seconds + 3600 })).toString('base64url');
  const body = `${head}.${claims}`;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n');
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}
export async function googleAccessToken(env = process.env, fetcher = fetch) {
  if (tokenCache?.email === env.GOOGLE_SERVICE_ACCOUNT_EMAIL && tokenCache.expires > Date.now() + 60000 && fetcher === fetch) return tokenCache.token;
  const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(env) }).toString(), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new AppError(`Google service-account authentication failed (${data.error || response.status}). Check the key and Sheets API access.`, 'sheets', 502);
  if (fetcher === fetch) tokenCache = { email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, token: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return data.access_token;
}
const SALES_HEADERS = ['Reference', 'Submission time (UTC)', 'Salesperson', 'Customer', 'Project', 'Description', 'Amount EUR', 'Proposed Richard %', 'Proposed Anastasia %', 'Proposed Jean-Claude %', 'Approved Richard %', 'Approved Anastasia %', 'Approved Jean-Claude %', 'Commission pool EUR', 'Richard earned EUR', 'Anastasia earned EUR', 'Jean-Claude earned EUR', 'Status', 'Source', 'Decision time (UTC)'];
const EXPENSE_HEADERS = ['Reference', 'Submission time (UTC)', 'Reporter', 'Description', 'Category', 'Amount EUR', 'Proposed allocation', 'Final allocation', 'Status', 'Source', 'Decision time (UTC)'];
export function sheetValues(record, employeeName) {
  if (record.kind === 'sale') return [record.reference, record.submitted_at, employeeName, record.customer, record.project, record.description, record.amount_cents / 100, ...record.proposed_split_bp.map(n => n / 100), ...(record.final_split_bp ? record.final_split_bp.map(n => n / 100) : ['', '', '']), record.commission_pool_cents / 100, ...record.commission_cents.map(n => n / 100), record.status === 'pending' ? 'Pending approval' : 'Approved', record.source, record.decision_at || ''];
  return [record.reference, record.submitted_at, employeeName, record.description, record.category, record.amount_cents / 100, record.proposed_allocation, record.final_allocation || '', record.status === 'awaiting_allocation' ? 'Awaiting allocation' : 'Allocated', record.source, record.decision_at || ''];
}
export async function syncSheetRecord(record, employeeName, env = process.env, fetcher = fetch) {
  if (!env.GOOGLE_SHEET_ID) throw new AppError('The Google Sheets spreadsheet ID is not configured.', 'configuration', 503);
  const token = await googleAccessToken(env, fetcher);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}`;
  const call = async (suffix, options = {}) => {
    const response = await fetcher(base + suffix, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(`Google Sheets update failed (HTTP ${response.status}). Check API enablement and Editor access for the service account.`, 'sheets', 502);
    return data;
  };
  const metadata = await call('?fields=sheets.properties');
  const names = new Set((metadata.sheets || []).map(s => s.properties.title));
  const missing = ['Sales', 'Expenses'].filter(name => !names.has(name));
  if (missing.length) {
    const added = await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) }) });
    metadata.sheets ||= [];
    metadata.sheets.push(...(added.replies || []).filter(r => r.addSheet).map(r => r.addSheet));
  }
  const formatRequests = [];
  for (const sheet of metadata.sheets || []) {
    const { sheetId, title } = sheet.properties;
    if (!['Sales', 'Expenses'].includes(title)) continue;
    formatRequests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    formatRequests.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.wrapStrategy' } });
    for (const [startColumnIndex, endColumnIndex] of title === 'Sales' ? [[6, 7], [13, 17]] : [[5, 6]]) {
      formatRequests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex, endColumnIndex }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '€#,##0.00' } } }, fields: 'userEnteredFormat.numberFormat' } });
    }
    if (title === 'Sales') formatRequests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 13 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.##"%"' } } }, fields: 'userEnteredFormat.numberFormat' } });
  }
  if (formatRequests.length) await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: formatRequests }) });
  const name = record.kind === 'sale' ? 'Sales' : 'Expenses';
  const headers = record.kind === 'sale' ? SALES_HEADERS : EXPENSE_HEADERS;
  const lastColumn = record.kind === 'sale' ? 'T' : 'K';
  await call(`/values/${encodeURIComponent(`${name}!A1:${lastColumn}1`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [headers] }) });
  const values = await call(`/values/${encodeURIComponent(`${name}!A2:A`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = values.values || [];
  const matching = rows.map((row, i) => row[0] === record.reference ? i + 2 : null).filter(Boolean);
  if (matching.length > 1) throw new AppError(`Sheets contains multiple rows for ${record.reference}. Resolve the duplicate rows before retrying.`, 'sheets', 409);
  // The durable DB lease serializes all Sheets jobs. Approval/retry updates this
  // exact reference rather than appending another row, including a lost reply.
  const rowNumber = matching[0] || rows.length + 2;
  await call(`/values/${encodeURIComponent(`${name}!A${rowNumber}:${lastColumn}${rowNumber}`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [sheetValues(record, employeeName)] }) });
  const sheetId = metadata.sheets.find(s => s.properties.title === name).properties.sheetId;
  await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [
    { repeatCell: { range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: 0, endColumnIndex: headers.length }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } },
  ] }) });
  return { tab: name, row: rowNumber };
}
export function jobNotification(job) { return notificationText(job.payload, job.event); }
