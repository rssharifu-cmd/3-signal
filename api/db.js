/**
 * Signal — Database Connection Manager
 * 
 * Production-ready MongoDB connection manager.
 * Caches the connection promise globally across warm serverless function
 * invocations to prevent connection exhaustion.
 */

const { MongoClient } = require("mongodb");

const mongoUri = (process.env.MONGODB_URI || "").trim();

let clientPromise = null;

if (!mongoUri) {
  console.error("CRITICAL ERROR: MONGODB_URI environment variable is missing!");
} else {
  // Cache the client promise globally across warm serverless container instances
  if (!global._mongoClientPromise) {
    const client = new MongoClient(mongoUri);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
}

/**
 * Returns a real MongoDB database connection instance.
 * @returns {Promise<import('mongodb').Db>}
 */
async function getDb() {
  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is missing. Cannot establish database connection.");
  }
  try {
    const connectedClient = await clientPromise;
    return connectedClient.db();
  } catch (err) {
    console.error("[DB] Failed to connect to MongoDB Atlas cluster:", err.message);
    throw err;
  }
}

module.exports = { getDb };
