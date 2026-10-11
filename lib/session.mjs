import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, employee } from './domain.mjs';
const COOKIE = 'friends_role';
export function signRole(role, secret, now = Date.now()) {
  if (!employee(role)) throw new AppError('Choose one of the five demonstration employees.');
  if (!secret || secret.length < 32) throw new AppError('Server setup requires a SESSION_SECRET of at least 32 characters.', 'configuration', 503);
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(now / 1000) + 43200 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function verifyRole(token, secret, now = Date.now()) {
  if (!secret || !token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.exp > Math.floor(now / 1000) && employee(data.role) ? data.role : null; } catch { return null; }
}
export function roleFromRequest(req, env = process.env) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(pair => { const pos = pair.indexOf('='); return [pair.slice(0, pos).trim(), pair.slice(pos + 1)]; }));
  return verifyRole(cookies[COOKIE], env.SESSION_SECRET);
}
export function setRoleCookie(res, req, role, env = process.env) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || !!env.VERCEL;
  res.setHeader('Set-Cookie', `${COOKIE}=${signRole(role, env.SESSION_SECRET)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
}
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (new URL(origin).host !== host) throw new AppError('Cross-origin actions are not allowed.', 'forbidden', 403);
}
