// Shared pure predicate; safe for scheduler and diagnostics imports without db.js.
function verified(user) { return Boolean(user?.emailVerifiedAt && user?.authVersion && user.active !== false); }
module.exports = {verified};
