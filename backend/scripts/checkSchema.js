import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:2002@localhost:5432/vaidyadrishti'
});

try {
    await client.connect();
    console.log('Connected to PostgreSQL');

    const { rows } = await client.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('tenants','prescription_logs','processing_jobs','medicines') ORDER BY table_name, ordinal_position"
    );

    const grouped = {};
    for (const r of rows) {
        if (!grouped[r.table_name]) grouped[r.table_name] = [];
        grouped[r.table_name].push(`${r.column_name} (${r.data_type})`);
    }

    for (const [table, cols] of Object.entries(grouped)) {
        console.log(`\nTable: ${table}`);
        cols.forEach(c => console.log(`  - ${c}`));
    }

    if (rows.length === 0) {
        console.log('\nNo tables found! Run: npm run db:setup');
    }
} catch (err) {
    console.error('Error:', err.message);
} finally {
    await client.end();
}
