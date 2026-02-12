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

// Normalize phone for consistent storage and lookup (digits and + only)
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

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

