'use strict';
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const { randomAlias, sha256 } = require('../lib/security');
const { bad, normalizeUrl, validateAlias, parseWholeRupees, cleanText, HttpError } = require('../lib/validators');

function serializeLink(l, { includeDestination = true } = {}) {
  const out = {
    id: l.id,
    alias: l.alias,
    short_url: `${config.appUrl}/${l.alias}`,
    title: l.title,
    price_rupees: l.price_rupees,
    status: l.status,
    external_ref: l.external_ref || null,
    source: l.source,
    expires_at: l.expires_at,
    clicks: l.clicks,
    unlocks: l.unlocks,
    earned_rupees: Number(l.earned_paise) / 100,
    created_at: l.created_at,
    updated_at: l.updated_at
  };
  if (includeDestination) out.destination_url = l.destination_url;
  return out;
}

function parseExpiry(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad('expires_at must be a valid date/time (ISO 8601).');
  if (d.getTime() <= Date.now()) throw bad('expires_at must be in the future.');
  return d.toISOString();
}

/**
 * Creates a paid short link for a creator.
 * input: { url, title, price, alias, ref, expires_at }
 */
async function createLink(user, input, source = 'dashboard') {
  const s = await settings.getAll();
  const destination = normalizeUrl(input.url ?? input.destination_url);
  const price = input.price === undefined || input.price === null || input.price === ''
    ? Math.max(user.default_price_rupees, s.min_price_rupees)
    : parseWholeRupees(input.price, { min: s.min_price_rupees, max: s.max_price_rupees, field: 'Price per link' });
  const title = cleanText(input.title, 200, 'Title');
  const ref = input.ref !== undefined && input.ref !== null && input.ref !== '' ? cleanText(input.ref, 120, 'ref') : null;
  const expiresAt = parseExpiry(input.expires_at);
  const custom = input.alias ? validateAlias(input.alias) : null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const alias = custom || randomAlias(attempt < 3 ? 7 : 9);
    try {
      const row = await db.one(
        `INSERT INTO links (user_id, alias, title, destination_url, destination_hash, price_rupees, external_ref, source, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [user.id, alias, title, destination, sha256(destination), price, ref, source, expiresAt]
      );
      return row;
    } catch (err) {
      if (err.code === '23505') {
        if (custom) throw bad('This alias is already taken. Please choose another.');
        continue;
      }
      throw err;
    }
  }
  throw new HttpError(500, 'Could not generate a unique short link. Please retry.');
}

/** Used by Quick Link / Full-page script: reuse an existing link for the same URL+price to avoid duplicates. */
async function findOrCreateQuickLink(user, url, price) {
  const s = await settings.getAll();
  const destination = normalizeUrl(url);
  const p = price === undefined || price === null || price === ''
    ? Math.max(user.default_price_rupees, s.min_price_rupees)
    : parseWholeRupees(price, { min: s.min_price_rupees, max: s.max_price_rupees, field: 'Price per link' });
  const existing = await db.one(
    `SELECT * FROM links WHERE user_id = $1 AND destination_hash = $2 AND price_rupees = $3
       AND deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1`,
    [user.id, sha256(destination), p]
  );
  if (existing) return existing;
  return createLink(user, { url: destination, price: p }, 'quick');
}

async function updateLink(userId, alias, input) {
  const s = await settings.getAll();
  const link = await db.one(
    'SELECT * FROM links WHERE user_id = $1 AND lower(alias) = lower($2) AND deleted_at IS NULL',
    [userId, String(alias)]
  );
  if (!link) throw new HttpError(404, 'Link not found.');
  const sets = [];
  const vals = [link.id];
  const add = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.price !== undefined) add('price_rupees', parseWholeRupees(input.price, { min: s.min_price_rupees, max: s.max_price_rupees, field: 'Price per link' }));
  if (input.title !== undefined) add('title', cleanText(input.title, 200, 'Title'));
  if (input.url !== undefined || input.destination_url !== undefined) {
    const d = normalizeUrl(input.url ?? input.destination_url);
    add('destination_url', d);
    add('destination_hash', sha256(d));
  }
  if (input.status !== undefined) {
    if (link.status === 'blocked') throw new HttpError(403, 'This link was blocked by the moderation team.');
    if (!['active', 'paused'].includes(input.status)) throw bad('status must be "active" or "paused".');
    add('status', input.status);
  }
  if (input.ref !== undefined) add('external_ref', input.ref ? cleanText(input.ref, 120, 'ref') : null);
  if (input.expires_at !== undefined) add('expires_at', parseExpiry(input.expires_at));
  if (!sets.length) return link;
  return db.one(`UPDATE links SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
}

async function deleteLink(userId, alias) {
  const row = await db.one(
    `UPDATE links SET deleted_at = now(), status = CASE WHEN status = 'blocked' THEN status ELSE 'paused' END, updated_at = now()
      WHERE user_id = $1 AND lower(alias) = lower($2) AND deleted_at IS NULL RETURNING id`,
    [userId, String(alias)]
  );
  if (!row) throw new HttpError(404, 'Link not found.');
  return true;
}

async function listLinks(userId, { q = '', ref = '', status = '', limit, offset }) {
  const where = ['user_id = $1', 'deleted_at IS NULL'];
  const vals = [userId];
  if (q) {
    vals.push(`%${String(q).toLowerCase().slice(0, 100)}%`);
    where.push(`(lower(alias) LIKE $${vals.length} OR lower(title) LIKE $${vals.length} OR lower(destination_url) LIKE $${vals.length})`);
  }
  if (ref) {
    vals.push(String(ref).slice(0, 120));
    where.push(`external_ref = $${vals.length}`);
  }
  if (['active', 'paused', 'blocked'].includes(status)) {
    vals.push(status);
    where.push(`status = $${vals.length}`);
  }
  const total = (await db.one(`SELECT COUNT(*) AS c FROM links WHERE ${where.join(' AND ')}`, vals)).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT * FROM links WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  return { total, rows };
}

module.exports = { serializeLink, createLink, findOrCreateQuickLink, updateLink, deleteLink, listLinks };

