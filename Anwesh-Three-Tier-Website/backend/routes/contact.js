'use strict';

const { Router } = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { pool } = require('../db');
const { storePdf, deleteStoredPdf } = require('../lib/storage');
const { notifyOwner } = require('../lib/mailer');

const router = Router();
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, message: 'Too many messages from this connection. Please try again later.' }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
    fields: 8,
    fieldSize: 6000,
    parts: 16
  },
  fileFilter: (req, file, callback) => {
    const hasPdfExtension = file.originalname.toLowerCase().endsWith('.pdf');
    const allowedMime = ['application/pdf', 'application/octet-stream'].includes(file.mimetype);
    if (!hasPdfExtension || !allowedMime) {
      const error = new Error('PDF files only. Please remove any unsupported file and try again.');
      error.statusCode = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validWebsite(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

router.post('/contact', contactLimiter, upload.array('files', MAX_FILES), async (req, res) => {
  const name = cleanText(req.body.name);
  const organization = cleanText(req.body.organization);
  const website = cleanText(req.body.website);
  const description = cleanText(req.body.description);
  const files = req.files || [];

  if (!name || !description) {
    throw httpError('Please provide your name and a short description.');
  }
  if (name.length > 120 || organization.length > 160 || website.length > 300 || description.length > 5000) {
    throw httpError('One or more fields are longer than the allowed limit.');
  }
  if (!validWebsite(website)) {
    throw httpError('Please enter a valid website URL beginning with http:// or https://.');
  }

  for (const file of files) {
    if (file.buffer.length < 5 || file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw httpError(`The file "${file.originalname}" does not appear to be a valid PDF.`);
    }
  }

  const connection = await pool.getConnection();
  const storedFiles = [];
  let submissionId;
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    for (const file of files) {
      const stored = await storePdf(file);
      storedFiles.push({
        ...stored,
        originalName: file.originalname,
        sizeBytes: file.size
      });
    }

    const [submissionResult] = await connection.execute(
      `INSERT INTO contact_submissions (name, organization, website, description)
       VALUES (?, ?, ?, ?)`,
      [name, organization || null, website || null, description]
    );
    submissionId = submissionResult.insertId;

    for (const file of storedFiles) {
      await connection.execute(
        `INSERT INTO contact_attachments
          (submission_id, original_name, object_key, storage_provider, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, 'application/pdf', ?)`,
        [submissionId, file.originalName, file.key, file.storageProvider, file.sizeBytes]
      );
    }

    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    await Promise.allSettled(storedFiles.map(deleteStoredPdf));
    throw error;
  } finally {
    connection.release();
  }

  // Persisting the submission is the primary operation. Email notification is
  // optional and should not make a successfully stored message appear lost.
  try {
    await notifyOwner({ id: submissionId, name, organization, website, description, files: storedFiles });
  } catch (error) {
    console.error('Contact notification email failed:', error.message);
  }

  res.status(201).json({
    ok: true,
    message: 'Thank you. Your message has been received.'
  });
});

module.exports = router;
