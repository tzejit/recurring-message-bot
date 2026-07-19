/// <reference types="@cloudflare/workers-types" />

/**
 * Telegram "recurring message" bot — Cloudflare Worker.
 *
 * Commands:
 *   /help          - how to use this bot
 *   /set           - create a recurring message (message text -> hour -> minute ->
 *                    optional day-of-week / day-of-month / month filters)
 *   /settimezone   - set the UTC offset used for this chat's schedule (default +8:00)
 *   /view          - list all recurring messages for this chat
 *   /remove        - pick a recurring message to delete
 *
 * Storage: Cloudflare D1 (free tier). See schema.sql.
 * Delivery: a cron trigger (`* * * * *`) runs every minute, computes each chat's
 * local time from its UTC offset, and sends any message whose schedule matches.
 */

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  /** Optional. If set, the worker verifies the Telegram secret-token header. */
  WEBHOOK_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Constants / small helpers
// ---------------------------------------------------------------------------

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DEFAULT_OFFSET_MINUTES = 8 * 60; // +8:00
/** Safety cap on how many (dow x dom x month) rows a single /set can expand into. */
const MAX_COMBOS = 60;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function formatOffset(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Parses strings like "+8", "-5", "5:30", "+05:30" into a signed minute offset. */
function parseOffset(text: string): number | null {
  const m = text.trim().match(/^([+-]?)(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  if (hours > 14 || minutes >= 60) return null;
  return sign * (hours * 60 + minutes);
}

interface ScheduleRow {
  id: number;
  chat_id: number;
  message: string;
  hour: number;
  minute: number;
  day_of_week: number | null; // 0=Sunday..6=Saturday, NULL = any
  day_of_month: number | null; // 1-31, NULL = any
  month: number | null; // 1-12, NULL = any
  message_thread_id: number | null;
  last_sent_key: string | null;
}

/** Joins items with commas and "and" before the last one, e.g. ["a","b","c"] -> "a, b and c". */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

interface FilterCombo {
  dow: number | null;
  dom: number | null;
  month: number | null;
}

/**
 * Expands multi-select dow/dom/month arrays into the cartesian product of
 * single-value combinations — one row per exact trigger instant. An unset
 * (null/empty) dimension contributes a single `null` ("any") to the product.
 */
function expandCombos(dow: number[] | null | undefined, dom: number[] | null | undefined, month: number[] | null | undefined): FilterCombo[] {
  const dows: (number | null)[] = dow && dow.length ? dow : [null];
  const doms: (number | null)[] = dom && dom.length ? dom : [null];
  const months: (number | null)[] = month && month.length ? month : [null];
  const combos: FilterCombo[] = [];
  for (const dw of dows) {
    for (const dm of doms) {
      for (const mo of months) {
        combos.push({ dow: dw, dom: dm, month: mo });
      }
    }
  }
  return combos;
}

function formatSchedule(m: {
  hour: number;
  minute: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  month?: number | null;
}): string {
  const time = `${pad(m.hour)}:${pad(m.minute)}`;
  const dow = m.day_of_week ?? null;
  const dom = m.day_of_month ?? null;
  const month = m.month ?? null;

  const parts: string[] = [];
  if (month !== null && month !== undefined) parts.push(MONTH_NAMES[month - 1]);
  if (dom !== null && dom !== undefined) parts.push(`date ${dom}`);
  if (dow !== null && dow !== undefined) parts.push(`every ${DOW_NAMES[dow]}`);

  if (parts.length === 0) return `Daily at ${time}`;
  return `${parts.join(", ")} at ${time}`;
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function tg(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function sendText(env: Env, chatId: number, text: string, threadId?: number | null) {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, "sendMessage", payload);
}

function sendTextKb(
  env: Env,
  chatId: number,
  text: string,
  reply_markup: unknown,
  threadId?: number | null
) {
  const payload: Record<string, unknown> = { chat_id: chatId, text, reply_markup };
  if (threadId != null) payload.message_thread_id = threadId;
  return tg(env, "sendMessage", payload);
}

function editText(env: Env, chatId: number, messageId: number, text: string) {
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

function editTextKb(env: Env, chatId: number, messageId: number, text: string, reply_markup: unknown) {
  return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup });
}

function answerCallback(env: Env, callbackQueryId: string, text?: string) {
  return tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// ---------------------------------------------------------------------------
// Inline keyboards
// ---------------------------------------------------------------------------

function hourKeyboard() {
  const rows: any[] = [];
  for (let r = 0; r < 4; r++) {
    const row = [];
    for (let c = 0; c < 6; c++) {
      const h = r * 6 + c;
      row.push({ text: pad(h), callback_data: `h:${h}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Cancel", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

function minuteKeyboard() {
  const mins = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const rows: any[] = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const m = mins[r * 4 + c];
      row.push({ text: pad(m), callback_data: `m:${m}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "❌ Cancel", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

function menuText(d: SetWizardData): string {
  return (
    `Message: "${d.message}"\n` +
    `Time: ${pad(d.hour!)}:${pad(d.minute!)}\n\n` +
    `Optionally narrow this down with the buttons below (day of week / day of month / month) — ` +
    `tap multiple to select more than one, then tap Save. Leave any of them as "Any" to repeat every day / month.`
  );
}

function menuKeyboard(d: SetWizardData) {
  const dowText = d.dow && d.dow.length ? joinWithAnd(d.dow.map((i) => DOW_NAMES[i])) : "Any";
  const domText = d.dom && d.dom.length ? joinWithAnd(d.dom.map(String)) : "Any";
  const monText = d.month && d.month.length ? joinWithAnd(d.month.map((i) => MONTH_NAMES[i - 1])) : "Any";
  return {
    inline_keyboard: [
      [{ text: `📅 Day of week: ${dowText}`, callback_data: "dow:menu" }],
      [{ text: `📆 Day of month: ${domText}`, callback_data: "dom:menu" }],
      [{ text: `📆 Month: ${monText}`, callback_data: "mon:menu" }],
      [
        { text: "✅ Save", callback_data: "confirm" },
        { text: "❌ Cancel", callback_data: "cancel" },
      ],
    ],
  };
}

function dowKeyboard(selected: number[] | null) {
  const sel = new Set(selected ?? []);
  const label = (i: number) => `${sel.has(i) ? "✅ " : ""}${DOW_NAMES[i].slice(0, 3)}`;
  const row1 = [];
  for (let i = 0; i < 4; i++) row1.push({ text: label(i), callback_data: `dow:t:${i}` });
  const row2 = [];
  for (let i = 4; i < 7; i++) row2.push({ text: label(i), callback_data: `dow:t:${i}` });
  return {
    inline_keyboard: [
      row1,
      row2,
      [{ text: "Any (clear)", callback_data: "dow:any" }, { text: "Done ✅", callback_data: "dow:done" }],
    ],
  };
}

function domKeyboard(selected: number[] | null) {
  const sel = new Set(selected ?? []);
  const rows: any[] = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const day = r * 7 + c + 1;
      if (day > 31) break;
      row.push({ text: `${sel.has(day) ? "✅" : day}`, callback_data: `dom:t:${day}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "Any (clear)", callback_data: "dom:any" }, { text: "Done ✅", callback_data: "dom:done" }]);
  return { inline_keyboard: rows };
}

function monthKeyboard(selected: number[] | null) {
  const sel = new Set(selected ?? []);
  const rows: any[] = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 4; c++) {
      const month = r * 4 + c + 1;
      const label = `${sel.has(month) ? "✅ " : ""}${MONTH_NAMES[month - 1].slice(0, 3)}`;
      row.push({ text: label, callback_data: `mon:t:${month}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "Any (clear)", callback_data: "mon:any" }, { text: "Done ✅", callback_data: "mon:done" }]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Session (conversation state) storage — kept in D1 so it survives across
// stateless worker invocations. One active flow per chat at a time.
// ---------------------------------------------------------------------------

type WizardStep = "awaiting_message" | "awaiting_hour" | "awaiting_minute" | "menu";

interface SetWizardData {
  message?: string;
  hour?: number;
  minute?: number;
  dow?: number[] | null;
  dom?: number[] | null;
  month?: number[] | null;
}

type SessionState = { threadId?: number } & (
  | { step: "awaiting_timezone" }
  | { step: WizardStep; data: SetWizardData }
);

async function getSession(env: Env, chatId: number): Promise<SessionState | null> {
  const row = await env.DB.prepare("SELECT state FROM sessions WHERE chat_id = ?")
    .bind(chatId)
    .first<{ state: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.state) as SessionState;
  } catch {
    return null;
  }
}

async function setSession(env: Env, chatId: number, state: SessionState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (chat_id, state, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  )
    .bind(chatId, JSON.stringify(state))
    .run();
}

async function clearSession(env: Env, chatId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE chat_id = ?").bind(chatId).run();
}

// ---------------------------------------------------------------------------
// Chat settings (timezone)
// ---------------------------------------------------------------------------

async function getUtcOffsetMinutes(env: Env, chatId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT utc_offset_minutes FROM chats WHERE chat_id = ?")
    .bind(chatId)
    .first<{ utc_offset_minutes: number }>();
  if (row) return row.utc_offset_minutes;
  await env.DB.prepare(
    "INSERT INTO chats (chat_id, utc_offset_minutes) VALUES (?, ?) ON CONFLICT(chat_id) DO NOTHING"
  )
    .bind(chatId, DEFAULT_OFFSET_MINUTES)
    .run();
  return DEFAULT_OFFSET_MINUTES;
}

async function setUtcOffsetMinutes(env: Env, chatId: number, minutes: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chats (chat_id, utc_offset_minutes) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET utc_offset_minutes = excluded.utc_offset_minutes`
  )
    .bind(chatId, minutes)
    .run();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const HELP_TEXT =
  "*Recurring Message Bot*\n\n" +
  "/set — create a new recurring message. I'll ask for the text, then let you " +
  "pick the time, and optionally specific day(s) of week, day(s) of month, and/or month(s).\n\n" +
  "/settimezone — set this chat's UTC offset (default +8:00), used to work out " +
  "when your scheduled times actually fire.\n\n" +
  "/view — list all recurring messages set for this chat.\n\n" +
  "/remove — pick a recurring message to delete.\n\n" +
  "/help — show this message.";

async function cmdHelp(env: Env, chatId: number, threadId?: number) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: HELP_TEXT,
    parse_mode: "Markdown",
  };
  if (threadId != null) payload.message_thread_id = threadId;
  await tg(env, "sendMessage", payload);
}

async function cmdSet(env: Env, chatId: number, threadId?: number) {
  await setSession(env, chatId, { step: "awaiting_message", data: {}, threadId });
  await sendText(
    env,
    chatId,
    "What message would you like me to send? Just type it and send it to me.",
    threadId
  );
}

async function cmdSettimezone(env: Env, chatId: number, threadId?: number) {
  const offset = await getUtcOffsetMinutes(env, chatId);
  await setSession(env, chatId, { step: "awaiting_timezone", threadId });
  await sendText(
    env,
    chatId,
    `Current timezone: UTC${formatOffset(offset)}\n` +
      `Send your new UTC offset, e.g. "+8", "-5", or "+5:30".`,
    threadId
  );
}

async function cmdView(env: Env, chatId: number, threadId?: number) {
  const offset = await getUtcOffsetMinutes(env, chatId);
  const rows = await env.DB.prepare(
    "SELECT * FROM recurring_messages WHERE chat_id = ? ORDER BY hour, minute"
  )
    .bind(chatId)
    .all<ScheduleRow>();

  if (!rows.results || rows.results.length === 0) {
    await sendText(env, chatId, "You don't have any recurring messages yet. Use /set to create one.", threadId);
    return;
  }

  const lines = rows.results.map(
    (m, i) => `${i + 1}. ${formatSchedule(m)}\n   "${m.message}"`
  );
  await sendText(
    env,
    chatId,
    `🕰️ Recurring messages (timezone UTC${formatOffset(offset)}):\n\n${lines.join("\n\n")}`,
    threadId
  );
}

async function cmdRemove(env: Env, chatId: number, threadId?: number) {
  const rows = await env.DB.prepare(
    "SELECT * FROM recurring_messages WHERE chat_id = ? ORDER BY hour, minute"
  )
    .bind(chatId)
    .all<ScheduleRow>();

  if (!rows.results || rows.results.length === 0) {
    await sendText(env, chatId, "You don't have any recurring messages to remove.", threadId);
    return;
  }

  const buttons = rows.results.map((m) => [
    { text: truncate(`${formatSchedule(m)} — ${m.message}`, 60), callback_data: `rm:${m.id}` },
  ]);
  buttons.push([{ text: "❌ Cancel", callback_data: "rm:cancel" }]);
  await sendTextKb(
    env,
    chatId,
    "Which recurring message would you like to remove?",
    { inline_keyboard: buttons },
    threadId
  );
}

// ---------------------------------------------------------------------------
// Update handling
// ---------------------------------------------------------------------------

async function handleMessage(message: any, env: Env): Promise<void> {
  const chatId: number = message.chat.id;
  const text: string | undefined = message.text;
  // Present when the message was sent inside a supergroup forum topic thread.
  const threadId: number | undefined = message.message_thread_id;
  if (!text) return;

  if (text.startsWith("/")) {
    const cmd = text.split(" ")[0].split("@")[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        return cmdHelp(env, chatId, threadId);
      case "/set":
        return cmdSet(env, chatId, threadId);
      case "/settimezone":
        return cmdSettimezone(env, chatId, threadId);
      case "/view":
        return cmdView(env, chatId, threadId);
      case "/remove":
        return cmdRemove(env, chatId, threadId);
      default:
        await sendText(env, chatId, "Unknown command. Send /help to see what I can do.", threadId);
        return;
    }
  }

  // Not a command — check whether we're mid-conversation with this chat.
  const session = await getSession(env, chatId);
  if (!session) return;

  // Keep replying in whichever thread the /set or /settimezone flow was started in.
  const flowThreadId = session.threadId;

  if (session.step === "awaiting_message") {
    const newSession: SessionState = {
      step: "awaiting_hour",
      data: { message: text },
      threadId: flowThreadId,
    };
    await setSession(env, chatId, newSession);
    await sendTextKb(
      env,
      chatId,
      "Got it! Now pick the hour to send this message (24h):",
      hourKeyboard(),
      flowThreadId
    );
    return;
  }

  if (session.step === "awaiting_timezone") {
    const offset = parseOffset(text);
    if (offset === null) {
      await sendText(
        env,
        chatId,
        `Sorry, I couldn't understand "${text}". Please send an offset like "+8", "-5", or "+5:30".`,
        flowThreadId
      );
      return;
    }
    await setUtcOffsetMinutes(env, chatId, offset);
    await clearSession(env, chatId);
    await sendText(env, chatId, `✅ Timezone set to UTC${formatOffset(offset)}.`, flowThreadId);
    return;
  }

  // Any other free text while mid-wizard (e.g. during button steps) is ignored.
}

async function handleCallbackQuery(cq: any, env: Env): Promise<void> {
  const chatId: number = cq.message.chat.id;
  const messageId: number = cq.message.message_id;
  const data: string = cq.data ?? "";

  await answerCallback(env, cq.id);

  // Removal flow is independent of the /set wizard session.
  if (data.startsWith("rm:")) {
    const idPart = data.slice(3);
    if (idPart === "cancel") {
      await editText(env, chatId, messageId, "Cancelled.");
      return;
    }
    const id = parseInt(idPart, 10);
    await env.DB.prepare("DELETE FROM recurring_messages WHERE id = ? AND chat_id = ?")
      .bind(id, chatId)
      .run();
    await editText(env, chatId, messageId, "🗑 Removed.");
    return;
  }

  if (data === "cancel") {
    await clearSession(env, chatId);
    await editText(env, chatId, messageId, "Cancelled.");
    return;
  }

  const session = await getSession(env, chatId);
  if (!session || session.step === "awaiting_timezone" || !("data" in session)) {
    await editText(env, chatId, messageId, "This action has expired. Please start again with /set.");
    return;
  }

  if (data.startsWith("h:") && session.step === "awaiting_hour") {
    session.data.hour = parseInt(data.slice(2), 10);
    session.step = "awaiting_minute";
    await setSession(env, chatId, session);
    await editTextKb(env, chatId, messageId, "Now pick the minute:", minuteKeyboard());
    return;
  }

  if (data.startsWith("m:") && session.step === "awaiting_minute") {
    session.data.minute = parseInt(data.slice(2), 10);
    session.step = "menu";
    await setSession(env, chatId, session);
    await editTextKb(env, chatId, messageId, menuText(session.data), menuKeyboard(session.data));
    return;
  }

  if (session.step !== "menu") return;

  if (data === "menu") {
    await editTextKb(env, chatId, messageId, menuText(session.data), menuKeyboard(session.data));
    return;
  }
  if (data === "dow:menu") {
    await editTextKb(env, chatId, messageId, "Select day(s) of week (tap to toggle):", dowKeyboard(session.data.dow ?? null));
    return;
  }
  if (data === "dom:menu") {
    await editTextKb(env, chatId, messageId, "Select day(s) of month (tap to toggle):", domKeyboard(session.data.dom ?? null));
    return;
  }
  if (data === "mon:menu") {
    await editTextKb(env, chatId, messageId, "Select month(s) (tap to toggle):", monthKeyboard(session.data.month ?? null));
    return;
  }

  // dow / dom / mon share the same toggle / any / done pattern.
  const filterMatch = data.match(/^(dow|dom|mon):(t:(\d+)|any|done)$/);
  if (filterMatch) {
    const [, prefix, action, numStr] = filterMatch;
    const field: "dow" | "dom" | "month" = prefix === "mon" ? "month" : (prefix as "dow" | "dom");

    if (action === "any") {
      session.data[field] = null;
      await setSession(env, chatId, session);
      await editTextKb(env, chatId, messageId, menuText(session.data), menuKeyboard(session.data));
      return;
    }
    if (action === "done") {
      await editTextKb(env, chatId, messageId, menuText(session.data), menuKeyboard(session.data));
      return;
    }
    // toggle
    const n = parseInt(numStr, 10);
    const set = new Set(session.data[field] ?? []);
    if (set.has(n)) set.delete(n);
    else set.add(n);
    const arr = Array.from(set).sort((a, b) => a - b);
    session.data[field] = arr.length ? arr : null;
    await setSession(env, chatId, session);

    const keyboard =
      prefix === "dow"
        ? dowKeyboard(session.data.dow ?? null)
        : prefix === "dom"
        ? domKeyboard(session.data.dom ?? null)
        : monthKeyboard(session.data.month ?? null);
    const promptText =
      prefix === "dow"
        ? "Select day(s) of week (tap to toggle):"
        : prefix === "dom"
        ? "Select day(s) of month (tap to toggle):"
        : "Select month(s) (tap to toggle):";
    await editTextKb(env, chatId, messageId, promptText, keyboard);
    return;
  }

  if (data === "confirm") {
    const d = session.data;
    const combos = expandCombos(d.dow, d.dom, d.month);

    if (combos.length > MAX_COMBOS) {
      await editTextKb(
        env,
        chatId,
        messageId,
        `That selection would create ${combos.length} separate schedule entries, which is more than the ${MAX_COMBOS} limit. ` +
          `Please narrow down your day/date/month selections.\n\n${menuText(d)}`,
        menuKeyboard(d)
      );
      return;
    }

    const insert = env.DB.prepare(
      `INSERT INTO recurring_messages
         (chat_id, message, hour, minute, day_of_week, day_of_month, month, message_thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(
      combos.map((c) =>
        insert.bind(chatId, d.message, d.hour, d.minute, c.dow, c.dom, c.month, session.threadId ?? null)
      )
    );

    await clearSession(env, chatId);
    const summary = combos.map((c) => formatSchedule({ hour: d.hour!, minute: d.minute!, ...c })).join("\n");
    const plural = combos.length > 1 ? `${combos.length} entries` : "1 entry";
    await editText(env, chatId, messageId, `✅ Saved (${plural})!\n${summary}\n"${d.message}"`);
    return;
  }
}

async function handleUpdate(update: any, env: Env): Promise<void> {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
  }
}

// ---------------------------------------------------------------------------
// Cron: send any recurring message due for the current minute, per chat's
// own local time (based on its stored UTC offset).
// ---------------------------------------------------------------------------

async function runScheduledSend(env: Env): Promise<void> {
  const now = new Date();

  const chats = await env.DB.prepare("SELECT chat_id, utc_offset_minutes FROM chats").all<{
    chat_id: number;
    utc_offset_minutes: number;
  }>();

  for (const chat of chats.results ?? []) {
    const local = new Date(now.getTime() + chat.utc_offset_minutes * 60_000);
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();
    const dow = local.getUTCDay(); // 0 = Sunday
    const dom = local.getUTCDate();
    const month = local.getUTCMonth() + 1;
    const dateKey = `${local.getUTCFullYear()}-${month}-${dom} ${hour}:${minute}`;

    const due = await env.DB.prepare(
      `SELECT * FROM recurring_messages
       WHERE chat_id = ? AND hour = ? AND minute = ?
         AND (day_of_week IS NULL OR day_of_week = ?)
         AND (day_of_month IS NULL OR day_of_month = ?)
         AND (month IS NULL OR month = ?)
         AND (last_sent_key IS NULL OR last_sent_key != ?)`
    )
      .bind(chat.chat_id, hour, minute, dow, dom, month, dateKey)
      .all<ScheduleRow>();

    for (const m of due.results ?? []) {
      await sendText(env, chat.chat_id, m.message, m.message_thread_id);
      await env.DB.prepare("UPDATE recurring_messages SET last_sent_key = ? WHERE id = ?")
        .bind(dateKey, m.id)
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoints
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("This endpoint only accepts Telegram webhook POSTs.", { status: 200 });
    }

    if (env.WEBHOOK_SECRET) {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update: any;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Respond to Telegram immediately; process in the background.
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSend(env));
  },
};