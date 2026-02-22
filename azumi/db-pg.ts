import pg from 'pg';

const { Pool } = pg;

// Railway provides DATABASE_URL. Also support POSTGRES_URL, or individual vars.
const connectionString =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL;

const pool = connectionString
  ? new Pool({ connectionString })
  : new Pool({
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '',
      database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'postgres',
    });

// Normalize phone for consistent storage and lookup (digits and + only)
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

// ── Candidates table ─────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      normalized_phone TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Ensure normalized_phone exists (if table was created manually with only name, phone)
  try {
    await pool.query(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS normalized_phone TEXT NOT NULL DEFAULT ''
    `);
  } catch {
    // Column may already exist; ignore
  }
}

export async function saveCandidate(data: {
  name: string;
  phone: string;
}): Promise<number> {
  const normalized = normalizePhone(data.phone);
  const result = await pool.query(
    `INSERT INTO candidates (name, phone, normalized_phone)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [data.name, data.phone, normalized],
  );
  return result.rows[0].id as number;
}

export async function findCandidate(params: {
  phone?: string;
  name?: string;
}): Promise<{ id: number; name: string; phone: string; created_at?: Date } | null> {
  if (params.phone) {
    const normalized = normalizePhone(params.phone);
    const result = await pool.query(
      `SELECT id, name, phone, created_at
       FROM candidates
       WHERE normalized_phone = $1
       LIMIT 1`,
      [normalized],
    );
    return result.rows[0] || null;
  }
  if (params.name) {
    const result = await pool.query(
      `SELECT id, name, phone, created_at
       FROM candidates
       WHERE trim(name) ILIKE $1
       LIMIT 1`,
      [params.name.trim()],
    );
    return result.rows[0] || null;
  }
  return null;
}

// ── Telegram message logging (optional) ───────────────────────────────────

let messagesTableInitialized = false;

async function ensureMessagesTable(): Promise<void> {
  if (messagesTableInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_messages (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  messagesTableInitialized = true;
}

export async function logTelegramMessage(params: {
  chatId: number;
  userId: number;
  sender: 'user' | 'bot';
  text: string;
}): Promise<void> {
  try {
    await ensureMessagesTable();
    await pool.query(
      `INSERT INTO telegram_messages (chat_id, user_id, sender, text)
       VALUES ($1, $2, $3, $4)`,
      [params.chatId, params.userId, params.sender, params.text],
    );
  } catch (e) {
    console.warn('Failed to log Telegram message to Postgres:', e);
  }
}

export async function getRecentChats(): Promise<
  { chat_id: number; last_message_at: Date; last_text: string | null; first_name: string | null; message_count: number }[]
> {
  try {
    await ensureMessagesTable();
    await ensureActivityTable();
    const result = await pool.query(
      `
      SELECT
        m.chat_id,
        MAX(m.created_at) AS last_message_at,
        (ARRAY_AGG(m.text ORDER BY m.created_at DESC))[1] AS last_text,
        COUNT(*)::int AS message_count,
        ca.first_name
      FROM telegram_messages m
      LEFT JOIN candidate_activity ca ON ca.chat_id = m.chat_id
      GROUP BY m.chat_id, ca.first_name
      ORDER BY last_message_at DESC
      LIMIT 100
      `,
    );
    return result.rows as any[];
  } catch {
    return [];
  }
}

export async function getChatMessages(chatId: number): Promise<
  { sender: 'user' | 'bot'; text: string | null; created_at: Date }[]
> {
  try {
    await ensureMessagesTable();
    const result = await pool.query(
      `
      SELECT sender, text, created_at
      FROM telegram_messages
      WHERE chat_id = $1
      ORDER BY created_at ASC
      `,
      [chatId],
    );
    return result.rows as any[];
  } catch {
    return [];
  }
}

// ── Candidate activity tracking (for inactivity reminders) ──────────────

let activityTableInitialized = false;

async function ensureActivityTable(): Promise<void> {
  if (activityTableInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidate_activity (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      first_name TEXT,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      application_complete BOOLEAN NOT NULL DEFAULT FALSE,
      reminders_sent INT NOT NULL DEFAULT 0,
      last_reminder_at TIMESTAMPTZ,
      opted_out BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (chat_id)
    )
  `);
  activityTableInitialized = true;
}

export async function upsertCandidateActivity(params: {
  chatId: number;
  userId: number;
  firstName?: string;
}): Promise<void> {
  try {
    await ensureActivityTable();
    await pool.query(
      `INSERT INTO candidate_activity (chat_id, user_id, first_name, last_active_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (chat_id)
       DO UPDATE SET last_active_at = NOW(),
                     user_id = EXCLUDED.user_id,
                     first_name = COALESCE(EXCLUDED.first_name, candidate_activity.first_name)`,
      [params.chatId, params.userId, params.firstName ?? null],
    );
  } catch (e) {
    console.warn('Failed to upsert candidate activity:', e);
  }
}

export async function markApplicationComplete(chatId: number): Promise<void> {
  try {
    await ensureActivityTable();
    await pool.query(
      `UPDATE candidate_activity SET application_complete = TRUE WHERE chat_id = $1`,
      [chatId],
    );
  } catch (e) {
    console.warn('Failed to mark application complete:', e);
  }
}

export interface InactiveCandidate {
  chat_id: number;
  user_id: number;
  first_name: string | null;
  last_active_at: Date;
  reminders_sent: number;
}

export async function getInactiveCandidates(params: {
  inactiveForMs: number;
  maxReminders: number;
}): Promise<InactiveCandidate[]> {
  try {
    await ensureActivityTable();
    const cutoff = new Date(Date.now() - params.inactiveForMs);
    const result = await pool.query(
      `SELECT chat_id, user_id, first_name, last_active_at, reminders_sent
       FROM candidate_activity
       WHERE application_complete = FALSE
         AND opted_out = FALSE
         AND reminders_sent < $1
         AND last_active_at < $2
         AND (last_reminder_at IS NULL OR last_reminder_at < last_active_at OR last_reminder_at < $2)
       ORDER BY last_active_at ASC
       LIMIT 50`,
      [params.maxReminders, cutoff],
    );
    return result.rows as InactiveCandidate[];
  } catch (e) {
    console.warn('Failed to fetch inactive candidates:', e);
    return [];
  }
}

export async function recordReminderSent(chatId: number): Promise<void> {
  try {
    await ensureActivityTable();
    await pool.query(
      `UPDATE candidate_activity
       SET reminders_sent = reminders_sent + 1,
           last_reminder_at = NOW()
       WHERE chat_id = $1`,
      [chatId],
    );
  } catch (e) {
    console.warn('Failed to record reminder sent:', e);
  }
}
