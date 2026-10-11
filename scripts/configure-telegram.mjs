// Run privately after setting real environment variables. No credentials are printed.
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const baseUrl = process.argv[2];
if (!baseUrl || !/^https:\/\//.test(baseUrl) || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET) throw new Error('Provide an HTTPS deployment URL and server-side TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET.');
const url = `${baseUrl.replace(/\/$/, '')}/api/telegram`;
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: false }), signal: AbortSignal.timeout(10000) });
const data = await response.json();
if (!response.ok || !data.ok) throw new Error(`Telegram rejected webhook registration (${data.error_code || response.status}).`);
console.log(JSON.stringify({ ok: true, webhook: url }));
