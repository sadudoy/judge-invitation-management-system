'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function seedDatabase(targetUrl, options = { silent: false }) {
  const isTest = process.argv.includes('--test') || process.env.NODE_ENV === 'test';
  const url = targetUrl || (isTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL);

  if (!url) {
    throw new Error('Database connection URL not found. Check .env configuration.');
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    if (!options.silent) {
      console.log('Seeding database structure and reference data...');
    }

    const seedSqlPath = path.join(__dirname, 'seed.sql');
    const seedSql = fs.readFileSync(seedSqlPath, 'utf8');

    // Execute base seed SQL (events, venues, competitions, sessions, judges, availability, conflicts, invitations)
    await client.query(seedSql);

    if (!options.silent) {
      console.log('  ✓ Base seed SQL executed.');
    }

    // Insert Users with dynamic bcrypt hashing (ChangeMe123!)
    const bcryptCost = parseInt(process.env.BCRYPT_COST, 10) || 12;
    const defaultPassword = 'ChangeMe123!';
    const passwordHash = await bcrypt.hash(defaultPassword, bcryptCost);

    const users = [
      {
        email: 'admin@csefest.edu',
        password_hash: passwordHash,
        full_name: 'CSE Fest Admin',
        role: 'admin',
      },
      {
        email: 'coordinator@csefest.edu',
        password_hash: passwordHash,
        full_name: 'Event Coordinator',
        role: 'coordinator',
      },
    ];

    for (const u of users) {
      await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             full_name = EXCLUDED.full_name,
             role = EXCLUDED.role;`,
        [u.email, u.password_hash, u.full_name, u.role]
      );
    }

    if (!options.silent) {
      console.log(`  ✓ Inserted 2 users with bcrypt cost ${bcryptCost} (email: admin@csefest.edu, coordinator@csefest.edu).`);
      console.log('Database seeding completed successfully.');
    }

    return true;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

module.exports = { seedDatabase };
