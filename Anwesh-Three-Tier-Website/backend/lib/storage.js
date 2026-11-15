'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET;
const region = process.env.AWS_REGION || 'ap-southeast-2';
const s3 = bucket ? new S3Client({ region }) : null;
const localUploadDir = path.join(__dirname, '..', 'uploads');

function safeOriginalName(originalName) {
  return path.basename(String(originalName || 'document.pdf'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'document.pdf';
}

async function storePdf(file) {
  const id = randomUUID();
  const fileName = safeOriginalName(file.originalname);

  if (s3) {
    const key = `contact-uploads/${new Date().toISOString().slice(0, 7)}/${id}.pdf`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentLength: file.size,
      ContentType: 'application/pdf',
      ContentDisposition: `attachment; filename="${fileName}"`,
    }));
    return { key, storageProvider: 's3', localPath: null };
  }

  // Local storage is permitted only for development. Production uploads must
  // go to a private S3 bucket so files survive EC2 replacement/Auto Scaling.
  if (process.env.NODE_ENV !== 'production') {
    await fs.mkdir(localUploadDir, { recursive: true });
    const localFileName = `${id}.pdf`;
    const localPath = path.join(localUploadDir, localFileName);
    await fs.writeFile(localPath, file.buffer, { flag: 'wx', mode: 0o600 });
    return { key: `local/${localFileName}`, storageProvider: 'local', localPath };
  }

  const error = new Error('PDF uploads are not configured yet. Set S3_BUCKET for the production API.');
  error.statusCode = 503;
  throw error;
}

async function deleteStoredPdf(storedFile) {
  if (!storedFile) return;
  if (storedFile.storageProvider === 's3' && s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storedFile.key }));
  } else if (storedFile.storageProvider === 'local' && storedFile.localPath) {
    await fs.unlink(storedFile.localPath).catch(() => {});
  }
}

module.exports = { storePdf, deleteStoredPdf };
