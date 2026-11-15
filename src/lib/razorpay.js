'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { HttpError } = require('./validators');
const { safeEqual } = require('./security');

/**
 * Minimal Razorpay REST client (https://razorpay.com/docs/api/).
 * Base URL is configurable so automated tests can point it at a local mock.
 */
async function call(method, path, body) {
  const { keyId, keySecret, apiBase } = config.razorpay;
  if (!keyId || !keySecret) throw new HttpError(503, 'Payments are not configured yet. Please try again later.');
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(apiBase + path, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    console.error('[razorpay] network error', err.message);
    throw new HttpError(502, 'Payment gateway is not reachable. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = data?.error?.description || `HTTP ${res.status}`;
    console.error(`[razorpay] ${method} ${path} failed: ${desc}`);
    throw new HttpError(502, `Payment gateway error: ${desc}`);
  }
  return data;
}

const createOrder = ({ amountPaise, receipt, notes }) =>
  call('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes });

const fetchPayment = (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}`);

const capturePayment = (paymentId, amountPaise) =>
  call('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });

const refundPayment = (paymentId, amountPaise, notes = {}) =>
  call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, speed: 'normal', notes });

function verifyCheckoutSignature(orderId, paymentId, signature) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, String(signature));
}

function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqual(expected, String(signature));
}

module.exports = {
  createOrder,
  fetchPayment,
  capturePayment,
  refundPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  isConfigured: () => Boolean(config.razorpay.keyId && config.razorpay.keySecret)
};

