/**
 * Sharflow — Standalone Daily Website Watchdog Scheduler Script
 * Intended to be executed as a daily cron job via GitHub Actions.
 *
 * Flow:
 * 1. Loads environment variables (locally via dotenv, or directly in CI).
 * 2. Connects to MongoDB.
 * 3. Fetches all active users with configured websites or connected data sources.
 * 4. Processes users in parallel batches with concurrency control (max 3 concurrent).
 * 5. Uses atomic locking in delivery_logs to prevent duplicate runs on the same date.
 * 6. Executes the end-to-end Watchdog intelligence pipeline (fetch metrics, anomaly detection,
 *    conditional external research, AI interpretation, and MongoDB persistence).
 * 7. Dispatches the Watchdog intelligence report email via Resend if notifications are enabled.
 * 8. Logs detailed results and exits cleanly.
 */

require("dotenv").config();
const { getDb } = require("../api/_lib/db");
const { generateDailyIntelligence } = require("../api/_lib/generateDailyIntelligence");
const { sendWatchdogEmail } = require("../api/send");

const CONCURRENCY_LIMIT = 3;

/**
 * Splits an array into chunks of a specified size.
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function processUser(user, db, targetDate) {
  const email = user.email;
  const userId = String(user._id);
  const websiteUrl = user.profile?.websiteUrl || "";

  // 1. Verify user has website configured or connected data source
  const datasourcesCol = db.collection("datasources");
  const connectedCount = await datasourcesCol.countDocuments({
    userEmail: email,
    status: "connected",
  });

  if (!websiteUrl && connectedCount === 0) {
    console.log(`[Watchdog Scheduler] Skipping ${email}: No website or connected data source configured.`);
    return { status: "skipped", reason: "no_website_or_datasource" };
  }

  // 2. Atomic locking to prevent duplicate runs for the same targetDate
  const deliveryLogsCol = db.collection("delivery_logs");
  const lockKey = `watchdog_run_${email}_${targetDate}`;

  try {
    const lockResult = await deliveryLogsCol.updateOne(
      { lockKey },
      {
        $setOnInsert: {
          lockKey,
          userEmail: email,
          targetDate,
          status: "in_progress",
          startedAt: new Date(),
        },
      },
      { upsert: true }
    );

    if (lockResult.matchedCount > 0) {
      console.log(`[Watchdog Scheduler] Already processed today for ${email} (${targetDate}). Skipping duplicate.`);
      return { status: "skipped", reason: "already_processed" };
    }
  } catch (lockErr) {
    console.warn(`[Watchdog Scheduler] Lock check warning for ${email}:`, lockErr.message);
  }

  // 3. Run Watchdog Intelligence Pipeline
  try {
    console.log(`[Watchdog Scheduler] Running Watchdog pipeline for ${email}...`);
    const report = await generateDailyIntelligence(userId, { targetDate });

    let emailSent = false;
    let emailError = null;

    // 4. Send email if notifications enabled
    const notificationsEnabled = user.settings?.notifications !== false;
    const hasResendKey = Boolean(process.env.RESEND_API_KEY);

    if (notificationsEnabled && hasResendKey) {
      try {
        console.log(`[Watchdog Scheduler] Dispatching Watchdog email to ${email}...`);
        await sendWatchdogEmail({
          toEmail: email,
          userName: user.name || email.split("@")[0],
          report,
        });
        emailSent = true;
        console.log(`[Watchdog Scheduler] Email sent successfully to ${email}`);
      } catch (err) {
        emailError = err.message;
        console.error(`[Watchdog Scheduler] Failed to send email to ${email}:`, err.message);
      }
    } else if (!notificationsEnabled) {
      console.log(`[Watchdog Scheduler] Notifications disabled by user preference for ${email}. Email skipped.`);
    }

    // 5. Update delivery log
    await deliveryLogsCol.updateOne(
      { lockKey },
      {
        $set: {
          status: "completed",
          findingsCount: report.findingsCount || 0,
          reportStatus: report.status || "stable",
          emailSent,
          emailError,
          completedAt: new Date(),
        },
      }
    );

    return {
      status: "success",
      email,
      findingsCount: report.findingsCount || 0,
      reportStatus: report.status,
      emailSent,
    };
  } catch (err) {
    console.error(`[Watchdog Scheduler Error] Pipeline failed for ${email}:`, err.message);

    await deliveryLogsCol.updateOne(
      { lockKey },
      {
        $set: {
          status: "failed",
          error: err.message,
          failedAt: new Date(),
        },
      }
    );

    return { status: "error", email, error: err.message };
  }
}

async function run() {
  console.log("==================================================");
  console.log("  Sharflow — AI Website Watchdog Daily Scheduler  ");
  console.log("==================================================");

  const now = new Date();
  const targetDate = now.toISOString().split("T")[0];
  console.log(`[Watchdog Scheduler] Target date: ${targetDate}`);

  let db;
  try {
    db = await getDb();
    console.log("[Watchdog Scheduler] Connected to MongoDB database.");
  } catch (err) {
    console.error("[Watchdog Scheduler Fatal] MongoDB connection failed:", err.message);
    process.exit(1);
  }

  // Fetch active users
  const usersCol = db.collection("users");
  const users = await usersCol.find({ active: { $ne: false } }).toArray();
  console.log(`[Watchdog Scheduler] Found ${users.length} active users.`);

  if (users.length === 0) {
    console.log("[Watchdog Scheduler] No active users to process. Exiting.");
    process.exit(0);
  }

  const chunks = chunkArray(users, CONCURRENCY_LIMIT);
  let processedCount = 0;
  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let emailsSentCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[Watchdog Scheduler] Processing batch ${i + 1}/${chunks.length} (${chunk.length} users)...`);

    const results = await Promise.allSettled(
      chunk.map((user) => processUser(user, db, targetDate))
    );

    results.forEach((res) => {
      processedCount++;
      if (res.status === "fulfilled") {
        const val = res.value;
        if (val.status === "success") {
          successCount++;
          if (val.emailSent) emailsSentCount++;
        } else if (val.status === "skipped") {
          skippedCount++;
        } else {
          errorCount++;
        }
      } else {
        errorCount++;
        console.error("[Watchdog Scheduler Batch Error]:", res.reason?.message);
      }
    });
  }

  console.log("==================================================");
  console.log("  Sharflow Watchdog Scheduler Cycle Summary       ");
  console.log("==================================================");
  console.log(`Total users evaluated: ${users.length}`);
  console.log(`Successfully analyzed: ${successCount}`);
  console.log(`Emails dispatched:     ${emailsSentCount}`);
  console.log(`Skipped (no site/dup): ${skippedCount}`);
  console.log(`Errors encountered:    ${errorCount}`);
  console.log("==================================================");

  process.exit(errorCount > 0 && successCount === 0 ? 1 : 0);
}

run();
