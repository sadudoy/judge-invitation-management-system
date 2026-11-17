'use strict';

const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { startOutboxWorker, stopOutboxWorker } = require('./worker/outbox');
const { startReminderWorker, stopReminderWorker } = require('./worker/reminders');

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`=======================================================`);
  console.log(`  CSE Fest — Judge Invitation & Assignment Management  `);
  console.log(`  Server running in [${config.nodeEnv}] mode           `);
  console.log(`  Listening on http://localhost:${config.port}         `);
  console.log(`  Health Check: http://localhost:${config.port}/health `);
  if (process.env.OUTBOX_WORKER === 'on') {
    console.log(`  Outbox & Reminder Workers: ENABLED                   `);
    startOutboxWorker();
    startReminderWorker();
  } else {
    console.log(`  Outbox & Reminder Workers: DISABLED (producer only)   `);
  }
  console.log(`=======================================================`);
});

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (process.env.OUTBOX_WORKER === 'on') {
    stopOutboxWorker();
    stopReminderWorker();
  }
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await db.close();
      console.log('Database pool closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error closing database pool:', err);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('Forced shutdown due to timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
