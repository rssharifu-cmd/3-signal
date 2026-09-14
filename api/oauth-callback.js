/**
 * Sharflow — OAuth Callback Route Handler
 *
 * Dedicated endpoint file matching /api/oauth-callback for Vercel serverless mapping.
 */

const oauthHandler = require("./oauth");

module.exports = async function handler(req, res) {
  // Ensure req.query.action is treated as callback if not specified
  req.query = req.query || {};
  if (!req.query.action && (req.query.code || req.query.error)) {
    req.query.action = "callback";
  }
  return oauthHandler(req, res);
};
