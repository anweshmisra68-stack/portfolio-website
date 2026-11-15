'use strict';

const fs = require('node:fs');
const mysql = require('mysql2/promise');

const sslEnabled = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
let ssl;
if (sslEnabled) {
  ssl = { rejectUnauthorized: true };
  if (process.env.DB_SSL_CA_PATH) {
    ssl.ca = fs.readFileSync(process.env.DB_SSL_CA_PATH);
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
  charset: 'utf8mb4',
  ssl
});

module.exports = { pool };
