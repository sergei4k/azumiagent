import pg from 'pg';

const { Pool } = pg;

// Support common Postgres env var patterns:
// - POSTGRES_URL / DATABASE_URL (single URL)
// - PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({ connectionString })
  : new Pool({
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '',
      database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'postgres',
    });

// ── Shared helpers ───────────────────────────────────────────────────────

// Normalize phone for consistent storage and lookup (digits and + only)
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

// ── Candidates table (legacy, used for some scripts) ─────────────────────

export async function initDb() {
  // Create table if it doesn't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      normalized_phone TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Ensure normalized_phone is populated for existing rows
  await pool.query(`
    UPDATE candidates
    SET normalized_phone = regexp_replace(regexp_replace(phone, '[\\s\\-().]', '', 'g'), '^00', '+')
    WHERE (normalized_phone IS NULL OR normalized_phone = '')
      AND phone IS NOT NULL
  `);
}

// Save a candidate to the database (name + phone; normalized_phone used for returning vs new lookup)
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

// Look up a candidate by phone (normalized) or name. Used to decide returning vs new.
export async function findCandidate(params: {
  phone?: string;
  name?: string;
}): Promise<{
  id: number;
  name: string;
  phone: string;
  created_at: Date;
} | null> {
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
    const nameTrimmed = params.name.trim();
    const result = await pool.query(
      `SELECT id, name, phone, created_at
       FROM candidates
       WHERE trim(name) = $1
       LIMIT 1`,
      [nameTrimmed],
    );
    return result.rows[0] || null;
  }

  return null;
}

// ── Telegram message logging for dashboard ───────────────────────────────

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
  { chat_id: number; last_message_at: Date; last_text: string | null }[]
> {
  await ensureMessagesTable();
  const result = await pool.query(
    `
    SELECT
      chat_id,
      MAX(created_at) AS last_message_at,
      (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS last_text
    FROM telegram_messages
    GROUP BY chat_id
    ORDER BY last_message_at DESC
    LIMIT 100
    `,
  );
  return result.rows as any[];
}

export async function getChatMessages(chatId: number): Promise<
  { sender: 'user' | 'bot'; text: string | null; created_at: Date }[]
> {
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
}


