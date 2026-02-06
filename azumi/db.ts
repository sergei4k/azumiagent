import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
  user: process.env.MYSQL_USER || '',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || '',
});

export async function initDb() {
    // Create table if it doesn't exist
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS candidates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(255) NOT NULL,
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

    if (!existingColumns.includes('created_at')) {
        await pool.execute(`
            ALTER TABLE candidates 
            ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
    }
}

// Save a candidate to the database
export async function saveCandidate(data: {
    name: string;
    phone: string;
}): Promise<number> {
    const [result] = await pool.execute(
        `INSERT INTO candidates (name, phone) VALUES (?, ?)`,
        [data.name, data.phone]
    ) as any[];
    return result.insertId;
}

// Look up a candidate by phone or name
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
        const [rows] = await pool.execute(
            `SELECT * FROM candidates WHERE phone = ? LIMIT 1`,
            [params.phone]
        ) as any[];
        return rows.length > 0 ? rows[0] : null;
    }
    
    if (params.name) {
        const [rows] = await pool.execute(
            `SELECT * FROM candidates WHERE name = ? LIMIT 1`,
            [params.name]
        ) as any[];
        return rows.length > 0 ? rows[0] : null;
    }
    
    return null;
}