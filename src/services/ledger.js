'use strict';

/** Calendar day in India Standard Time (YYYY-MM-DD) */
function istDay(date = new Date()) {
  return new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** Change a creator's available balance and write an immutable ledger row (inside a transaction). */
async function adjustBalance(t, { userId, delta, type, paymentId = null, withdrawalId = null, note = '', actorId = null }) {
  const { rows } = await t.query(
    'UPDATE users SET balance_paise = balance_paise + $2, updated_at = now() WHERE id = $1 RETURNING balance_paise',
    [userId, delta]
  );
  if (!rows[0]) throw new Error(`User ${userId} not found for ledger entry`);
  await t.query(
    `INSERT INTO wallet_ledger (user_id, entry_type, amount_paise, balance_after_paise, payment_id, withdrawal_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, type, delta, rows[0].balance_paise, paymentId, withdrawalId, String(note).slice(0, 255), actorId]
  );
  return rows[0].balance_paise;
}

async function audit(q, actorId, action, targetType = '', targetId = '', details = {}) {
  await q.query(
    'INSERT INTO audit_logs (actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, targetType, String(targetId), JSON.stringify(details)]
  );
}

module.exports = { istDay, adjustBalance, audit };

