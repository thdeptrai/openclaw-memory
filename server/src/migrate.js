const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('./config');

async function runMigrations() {
    const pool = new Pool({
        host: config.postgres.host,
        port: config.postgres.port,
        user: config.postgres.user,
        password: config.postgres.password,
        database: config.postgres.database,
    });

    try {
        console.log('🔄 Running migrations...');

        const migrationsDir = path.join(__dirname, '..', 'migrations');
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

        for (const file of files) {
            console.log(`  📄 Executing: ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
            await pool.query(sql);
            console.log(`  ✅ Done: ${file}`);
        }

        console.log('✅ All migrations completed!');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigrations();
