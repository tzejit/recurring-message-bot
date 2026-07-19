# Telegram Recurring Message Bot (Cloudflare Worker)

A Telegram bot that sends recurring messages to a chat/group on a schedule you
configure via chat commands. Uses Cloudflare D1 (free tier) for storage and a
5-minute cron trigger to dispatch due messages. Implementation available at https://t.me/recurringmsg_bot


## Files

- `worker.ts` — the Worker (webhook handler + cron handler)
- `schema.sql` — D1 table definitions
- `wrangler.toml` — Worker config (D1 binding + cron trigger)

## Setup

1. **Create the bot** with [@BotFather](https://t.me/BotFather) and grab the token.
   If you plan to use this in group chats, also send BotFather
   `/setprivacy` → `Disable` for your bot, so it can see plain (non-command)
   replies like the message text you type during `/set`.

2. **Install deps & login**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Create the D1 database**
   ```bash
   wrangler d1 create telegram-recurring-bot-db
   ```
   Copy the `database_id` it prints into `wrangler.toml`.

4. **Apply the schema**
   ```bash
   wrangler d1 execute telegram-recurring-bot-db --remote --file=./schema.sql
   ```

5. **Set secrets**
   ```bash
   wrangler secret put BOT_TOKEN
   wrangler secret put WEBHOOK_SECRET   # optional but recommended, any random string
   ```

6. **Deploy**
   ```bash
   wrangler deploy
   ```
   This also registers the cron trigger from `wrangler.toml` (`* * * * *`).

7. **Point Telegram at your worker** (replace values):
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-worker>.<your-subdomain>.workers.dev" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```

## Usage

- `/set` — bot asks for the message text, then lets you pick hour → minute via
  buttons, then an optional menu to narrow it to a specific day of week,
  day of month, and/or month (any combination, or leave all as "Any" for daily).
- `/settimezone` — send a UTC offset like `+8`, `-5`, or `+5:30`. Defaults to `+8`.
- `/view` — lists all recurring messages for the current chat.
- `/remove` — pick a message from a button list to delete it.
- `/help` — usage summary.

## Supergroup topics (forum threads)

If your group has [Topics](https://telegram.org/blog/topics-in-groups-collapsible-replies)
enabled, the bot replies in whichever topic thread a command was sent from, and any
message scheduled from within a topic is delivered back into that same topic.

If you're upgrading an existing deployment, add the new column before redeploying:

```bash
wrangler d1 execute telegram-recurring-bot-db --remote \
  --command "ALTER TABLE recurring_messages ADD COLUMN message_thread_id INTEGER"
```

(A fresh `schema.sql` apply on a new database already includes this column.)

## Multiple days / dates / months per schedule

`/set` supports selecting more than one value in each filter — e.g. every
Wednesday **and** Thursday, or the 4th **and** 5th of August **and** December.
Tap to toggle a value on/off (✅ marks it selected), then **Done**. **Any (clear)**
resets that filter back to "no restriction."

Under the hood, a single `/set` with multiple selections is expanded into the
**cartesian product** of your choices and saved as one row per exact
combination — e.g. selecting dates {4, 5} and months {Aug, Dec} saves 4 rows
(Aug 4, Aug 5, Dec 4, Dec 5). `day_of_week` / `day_of_month` / `month` stay
plain nullable `INTEGER` columns, so the cron job matches with simple equality
rather than string containment. To keep this from exploding on a very broad
selection, the total combination count is capped (`MAX_COMBOS` in `worker.ts`,
default 60) — past that the bot asks you to narrow your selection. The
upside of one row per combination: `/remove` can delete a single specific
instance (e.g. drop "Dec 5" while keeping "Aug 4") instead of only the whole rule.

## Notes / possible extensions

- Minute selection is offered in 5-minute increments to keep the keyboard
  usable; change `minuteKeyboard()` in `worker.ts` if you need exact-minute
  precision.
- Each chat has one D1 row for its own timezone, so a group and a DM can have
  different offsets.
- The `last_sent_key` column prevents double-sends if the cron tick and a
  chat's local minute line up more than once (e.g. clock drift).
- State for the multi-step `/set` wizard lives in the `sessions` D1 table
  (one in-progress flow per chat) so it survives across the stateless
  `fetch` invocations.