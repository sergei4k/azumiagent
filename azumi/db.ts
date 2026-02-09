import mysql from 'mysql2/promise';

// Support both MYSQL_* and Railway-style MYSQL* (no underscore)
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || process.env.MYSQLHOST || '',
  port: process.env.MYSQL_PORT || process.env.MYSQLPORT ? Number(process.env.MYSQL_PORT || process.env.MYSQLPORT) : 3306,
  user: process.env.MYSQL_USER || process.env.MYSQLUSER || '',
  password: process.env.MYSQL_PASSWORD || process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || '',
});

// Normalize phone for consistent storage and lookup (digits and + only)
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

export async function initDb() {
    // Create table if it doesn't exist
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS candidates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(255) NOT NULL,
        normalized_phone VARCHAR(64) NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    await pool.execute(createTableQuery);

    // Check if columns exist and add them if missing (for tables created manually)
    const [columns] = await pool.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'candidates'
    `) as any[];

    const existingColumns = columns.map((col: any) => col.COLUMN_NAME);

    if (!existingColumns.includes('name')) {
        await pool.execute(`
            ALTER TABLE candidates 
            ADD COLUMN name VARCHAR(255) NOT NULL
        `);
    }

    if (!existingColumns.includes('phone')) {
        await pool.execute(`
            ALTER TABLE candidates 
            ADD COLUMN phone VARCHAR(255) NOT NULL
        `);
    }

    if (!existingColumns.includes('normalized_phone')) {
        await pool.execute(`
            ALTER TABLE candidates 
            ADD COLUMN normalized_phone VARCHAR(64) NOT NULL DEFAULT ''
        `);
        // Backfill existing rows
        const [rows] = await pool.execute(`SELECT id, phone FROM candidates`) as any[];
        for (const row of rows || []) {
            const norm = normalizePhone(row.phone || '');
            await pool.execute(`UPDATE candidates SET normalized_phone = ? WHERE id = ?`, [norm, row.id]);
        }
    }

    if (!existingColumns.includes('created_at')) {
        await pool.execute(`
            ALTER TABLE candidates 
            ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
    }
}

// Save a candidate to the database (name + phone; normalized_phone used for returning vs new lookup)
export async function saveCandidate(data: {
    name: string;
    phone: string;
}): Promise<number> {
    const normalized = normalizePhone(data.phone);
    const [result] = await pool.execute(
        `INSERT INTO candidates (name, phone, normalized_phone) VALUES (?, ?, ?)`,
        [data.name, data.phone, normalized]
    ) as any[];
    return result.insertId;
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
        const [rows] = await pool.execute(
            `SELECT id, name, phone, created_at FROM candidates WHERE normalized_phone = ? LIMIT 1`,
            [normalized]
        ) as any[];
        return rows.length > 0 ? rows[0] : null;
    }
    
    if (params.name) {
        const nameTrimmed = params.name.trim();
        const [rows] = await pool.execute(
            `SELECT id, name, phone, created_at FROM candidates WHERE TRIM(name) = ? LIMIT 1`,
            [nameTrimmed]
        ) as any[];
        return rows.length > 0 ? rows[0] : null;
    }
    
    return null;
}