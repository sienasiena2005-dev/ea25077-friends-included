# Friends Included finance system

Elina Abdulmuslimova · ea25077 · Day 4

One finance application for Respectable Relatives (A) and Drunk University Friends (B). Vercel hosts the website and server functions. Supabase is the financial source of truth. The same server processing functions handle website and Telegram entries. Google Sheets receives a reference-based copy; spreadsheet edits do not change financial records.

The website supports the five assignment employees through **Demonstration role**. The selected role is signed in an HttpOnly cookie. Financial actions ignore client-supplied role, employee and source overrides, and the backend and database RPCs enforce permissions. This is the assignment's fictional demonstration access, not an identity-verification login.

## Run and verify the code

Use Node.js 22 or later. Production functions have no third-party runtime dependencies. PGlite is a development dependency for executing the actual PostgreSQL schema locally.

```sh
npm install
npm run check
npm test
npm run test:sql
npm start
```

The local preview is `http://127.0.0.1:8787`. Without real connections, it displays a setup message and cannot save transactions or manufacture test results. Local preview uses an ephemeral signing secret if one is absent; Vercel requires its own persistent `SESSION_SECRET`.

Tests use assignment fixtures exclusively inside `test/`; the live application never imports or seeds them. Domain and HTTP-adapter tests use explicit stubs/mocks. SQL tests execute the unmodified Supabase schema in a disposable PGlite PostgreSQL engine with one serialized connection. They do not prove live Supabase connectivity, multi-connection concurrency or Telegram/Sheets delivery. Actual assignment tests must be performed against the deployed, connected application.

## Connect Supabase

Create a Supabase project and run `supabase/schema.sql` in its SQL editor. It creates only the five fictional employees and settings, with no financial records. Tables use Row Level Security with no anonymous/browser policies. Database RPCs and table access are restricted to the backend `service_role`.

Set server-side Vercel environment variables:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Project API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Private server service-role key |
| `SESSION_SECRET` | At least 32 random characters for signed role sessions |
| `TELEGRAM_BOT_TOKEN` | Private BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Random letters/numbers/underscore/hyphen webhook secret |
| `TELEGRAM_BOT_USERNAME` | Public bot username, without `@` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google service-account email |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Private PEM key; real newlines or escaped `\n` work |
| `GOOGLE_SHEET_ID` | Spreadsheet ID containing Sales and Expenses tabs |
| `GITHUB_REPOSITORY_URL` | Public project repository URL |
| `CRON_SECRET` | Random secret for the authenticated daily delivery worker |

Keep all private credentials in Vercel environment variables. `.env` and credential files are ignored by Git. After changing Vercel variables, redeploy so the functions receive them. Do not put credentials into the website, spreadsheet, commit descriptions or screenshots.

## Connect Google Sheets

Create a Google Cloud project, enable the Google Sheets API, create a service account and a service-account JSON key. Share the finance spreadsheet with that account's email as **Editor**. Set only the server-side email, private key and spreadsheet ID above. The backend exchanges a signed RS256 service-account JWT for an OAuth token.

The finance spreadsheet prepared for this project is [Friends Included — Sales and Expenses](https://docs.google.com/spreadsheets/d/1DfOeVzViP4R754puT2cQuh6Q7Y3LN-p1d9Jouj7MOEU/edit). Its existence does not itself establish that API writes have been connected. Give the instructor Viewer access, without public editing access.

Sales columns keep three proposed percentages, three approved percentages and three earned amounts separate. Pending sales have blank approved shares and zero earned commission. Expenses keep proposed and final allocations separate. The backend searches the reference and updates its existing row. A database lease serializes Sheets writes. A retry after a lost response reads the reference again instead of appending a duplicate. Amounts use two-decimal euro formatting; raw percentage values use a literal percentage symbol.

## Connect Telegram

Create one bot through BotFather and set its username/token in Vercel. Register a Telegram webhook at the deployed URL followed by `/api/telegram`, with `secret_token` equal to `TELEGRAM_WEBHOOK_SECRET`. Use Telegram's authenticated `setWebhook` method in a private server-side setup tool; do not expose the token in shell history, URLs shown to others or Git. `scripts/configure-telegram.mjs` reads environment variables and accepts the deployment URL as its sole argument.

Each recipient must open the bot in a **private chat** and send `/start`. `/whoami` displays the Telegram user ID. In the website, select Svetlana and link that existing Telegram account to a fictional employee. Accounts cannot choose their own role through the bot. The manager can change or remove a link later.

Salesperson command:

```text
/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000.00 | 50 | 30 | 20
```

Kevin command:

```text
/expense E01 | Rented suit and fake pearl necklace for the relatives | 120.00 | Materials | A
```

Percentages are Richard / Anastasia / Jean-Claude. Fields are separated with `|`; descriptions must not contain that separator. References are unique across sales and expenses. A successful submission confirmation is sent only after Supabase saved the record. Validation errors explain what must be corrected.

Bot submissions permanently retain their original submitting employee and chat. Changing a Telegram employee link does not redirect their decision notifications. Website submissions use the employee's linked chat if present at submission; if absent, the decision resolves a current linked chat, supporting the assignment's late S03 link. Once a decision job is queued, its destination is frozen for retries. A record with no recipient shows **No Telegram recipient linked**.

## Financial decisions and delivery

Sales remain pending until Svetlana approves the original or corrected split. The commission pool is 10%, rounded to cents. Each share is rounded and the residual, positive or negative, goes to the largest share; ties follow Richard, Anastasia, Jean-Claude. Pending sales earn no commission. Commission is already included in the project's expense calculation and is never inserted again as a reported expense.

Every recorded paid expense reduces company result immediately. An A/B proposal awaits allocation and affects neither project's result until Svetlana decides. Overhead is allocated automatically. Allocation approval moves the project's attribution without deducting company expense twice. Original proposals remain unchanged. Row locks, unique references and versioned outbox keys make repeated/concurrent decisions financially idempotent.

Every submission/decision creates durable Sheets and Telegram outbox jobs in the same database transaction. Failed delivery cannot roll back a saved financial decision and is never reported as sent. Website actions trigger delivery automatically; the visible website polls state and drains healthy pending jobs. A daily Vercel Hobby-compatible cron invokes `/api/worker`, authenticated with `CRON_SECRET`. Failed jobs require the manager's explicit retry, preventing repeated notification spam. Expired processing leases become visibly retryable. A later successful notification does not hide an earlier failed confirmation.

To test interruptions, use Svetlana's manager setup to enable a Sheets or Telegram interruption, then submit or approve a legitimate record. Verify the saved record remains and delivery shows failure. Disable the interruption and use that record's retry control. Check the same Sheets reference remains a single row and financial totals stay unchanged. These controls intentionally stop actual outbound delivery; they do not synthesize success or change amounts.

## Perform the assignment tests

Start with no practice records. Link the real Telegram account to Richard and send S01 through the actual bot. Then link it to Kevin and send E01 through the actual bot. Enter the remaining Test 1 transactions on the website using their proper demonstration roles; check the pending-state company result before making decisions. Approve/correct exactly as instructed and inspect the actual returned bot messages and actual spreadsheet rows.

Keep Test 1 records and add Test 2 website entries. Link Jean-Claude before approving S03 and Kevin before confirming E04/E05. Leave S05 and E07 pending. Check the assignment's cumulative figures, refresh to verify persistence, and test denied actions at the API processing layer as well as in the interface. Also verify interrupted synchronization and failed notification recovery. Additional instructor transactions legitimately change results; nothing resets the database to assignment totals.

Publish this repository through Vercel's GitHub import and submit the one working Vercel URL in ea25077's own Day 4 course-spreadsheet cell only after the actual two-test results and all live integrations are verified. The application includes public bot, Sheets and GitHub links plus entry/approval instructions. No separate report or presentation is required.

## Primary technical references

[Telegram Bot API](https://core.telegram.org/bots/api), [Supabase database functions](https://supabase.com/docs/guides/database/functions), [Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account), [Google Sheets values update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update), [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [PGlite local PostgreSQL engine](https://pglite.dev/docs/).
