'use strict';

const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (transporter) return transporter;

  const options = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'
  };

  if (process.env.SMTP_USER) {
    options.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    };
  }

  transporter = nodemailer.createTransport(options);
  return transporter;
}

async function notifyOwner(submission) {
  const mailer = getTransporter();
  if (!mailer) return { sent: false, reason: 'SMTP is not configured' };

  const owner = process.env.OWNER_EMAIL || 'anweshmisra68@gmail.com';
  const fileNames = submission.files.length
    ? submission.files.map(file => `- ${file.originalName}`).join('\n')
    : 'No files attached';

  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: owner,
    subject: `New portfolio enquiry — ${submission.name}`,
    text: [
      `Name: ${submission.name}`,
      `Organization: ${submission.organization || 'Not provided'}`,
      `Website: ${submission.website || 'Not provided'}`,
      '',
      'Reason of contact:',
      submission.description,
      '',
      'Uploaded PDF files (stored privately):',
      fileNames,
      '',
      `Submission ID: ${submission.id}`
    ].join('\n')
  });

  return { sent: true };
}

module.exports = { notifyOwner };
