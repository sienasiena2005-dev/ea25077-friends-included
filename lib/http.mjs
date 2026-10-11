import { AppError } from './domain.mjs';
export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { throw new AppError('The request body must be valid JSON.'); } }
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new AppError('Request too large.', 'validation', 413); }
  try { return JSON.parse(body || '{}'); } catch { throw new AppError('The request body must be valid JSON.'); }
}
export function sendError(res, error) {
  return sendJson(res, error instanceof AppError ? error.status : 503, { ok: false, code: error instanceof AppError ? error.code : 'service', error: error instanceof AppError ? error.message : 'The service could not complete this request. Saved records are retained; refresh and check the record before retrying.' });
}
