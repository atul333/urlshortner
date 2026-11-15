'use strict';
const config = require('../config');

let transporter = null;

function isConfigured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    if (!config.isProd) console.log(`[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    else console.warn(`[mail] SMTP not configured - could not send "${subject}" to ${to}`);
    return false;
  }
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass }
    });
  }
  try {
    await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
    return true;
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return false;
  }
}

module.exports = { sendMail, isConfigured };

