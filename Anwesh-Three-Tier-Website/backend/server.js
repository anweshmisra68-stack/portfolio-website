'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const { pool } = require('./db');
const contactRoutes = require('./routes/contact');

const app = express();
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1)); // Set to the real proxy hop count in AWS.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'anwesh-portfolio-api' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Readiness check failed:', error.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.use('/api', contactRoutes);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error && error.code && error.code.startsWith('LIMIT_')) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Each PDF must be 5 MB or smaller.'
      : 'You can upload up to 5 PDF files.';
    return res.status(400).json({ ok: false, message });
  }

  const statusCode = Number(error.statusCode) || 500;
  if (statusCode >= 500) {
    console.error('API error:', error);
  }
  res.status(statusCode).json({
    ok: false,
    message: statusCode >= 500
      ? 'The website could not process your message right now. Please try again later.'
      : error.message
  });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Anwesh portfolio API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing API server...`);
  server.close(async () => {
    await pool.end().catch(error => console.error('Database pool close error:', error.message));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
