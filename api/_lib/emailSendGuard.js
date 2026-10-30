const { randomUUID } = require("crypto");

const COOLDOWN_MS = 60 * 1000;

// _id is already unique in MongoDB. Conditional upsert collisions deny the send.
// Keep the cooldown after failure too: provider timeouts can have ambiguous outcomes.
async function claimEmailSend(db, userId, now = new Date()) {
  const attemptId = randomUUID();
  try {
    const result = await db.collection("email_send_guards").updateOne(
      { _id: String(userId), nextAllowedAt: { $lte: now } },
      { $set: { nextAllowedAt: new Date(now.getTime() + COOLDOWN_MS), attemptId } },
      { upsert: true }
    );
    if (result.matchedCount === 1 || result.upsertedCount === 1) {
      return { allowed: true, idempotencyKey: `browser-email-${attemptId}` };
    }
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return { allowed: false, retryAfter: COOLDOWN_MS / 1000 };
}

module.exports = { claimEmailSend };
