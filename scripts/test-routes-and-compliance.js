/**
 * Sharflow — Verification Suite for Routes, Legal Pages, and Compliance
 *
 * Verifies:
 * 1. Existence and integrity of all legal and public HTML pages:
 *    - /terms (terms.html)
 *    - /privacy (privacy.html)
 *    - /contact (contact.html)
 *    - /refund (refund.html)
 *    - /about (about.html)
 * 2. Presence of required legal footer links across all pages
 * 3. Absence of unapproved claims (e.g. 14-day money back guarantee)
 * 4. vercel.json routing configurations for all endpoints
 * 5. server.js Express routing for all endpoints
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    failed++;
  }
}

console.log("\n=== 1. Checking Static HTML Files & Canonical Links ===");

const pages = [
  { file: "index.html", path: "/" },
  { file: "terms.html", path: "/terms" },
  { file: "privacy.html", path: "/privacy" },
  { file: "refund.html", path: "/refund" },
  { file: "contact.html", path: "/contact" },
  { file: "about.html", path: "/about" },
];

for (const page of pages) {
  test(`File exists: ${page.file}`, () => {
    const fullPath = path.join(__dirname, "..", page.file);
    assert.ok(fs.existsSync(fullPath), `${page.file} does not exist`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert.ok(content.length > 200, `${page.file} is too short or empty`);
  });
}

console.log("\n=== 2. Verifying Refund & Legal Policy Compliance ===");

test("refund.html does not contain unapproved 14-day guarantee promises", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "refund.html"), "utf8");
  assert.strictEqual(
    content.toLowerCase().includes("14-day"),
    false,
    "refund.html must not promise a 14-day money-back guarantee without business approval"
  );
  assert.ok(content.includes("Paddle.com Market Ltd"), "Must mention Paddle Merchant of Record");
  assert.ok(content.includes("hello@sharflow.online"), "Must include support contact");
});

test("terms.html does not contain unapproved 14-day guarantee claims", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "terms.html"), "utf8");
  assert.strictEqual(
    content.toLowerCase().includes("14-day"),
    false,
    "terms.html must not promise a 14-day guarantee"
  );
  assert.ok(content.includes("/refund"), "terms.html must link to /refund");
});

test("Footer contains /refund link on all main HTML pages", () => {
  for (const page of ["index.html", "terms.html", "privacy.html", "contact.html", "about.html"]) {
    const content = fs.readFileSync(path.join(__dirname, "..", page), "utf8");
    assert.ok(
      content.includes('href="/refund"'),
      `${page} is missing link to /refund in footer`
    );
  }
});

console.log("\n=== 3. Verifying Routing Configurations ===");

test("server.js defines /refund, /terms, /privacy, /contact, /about", () => {
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(serverJs.includes('"/refund"'), "server.js missing /refund route");
  assert.ok(serverJs.includes('"/terms"'), "server.js missing /terms route");
  assert.ok(serverJs.includes('"/privacy"'), "server.js missing /privacy route");
  assert.ok(serverJs.includes('"/contact"'), "server.js missing /contact route");
  assert.ok(serverJs.includes('"/about"'), "server.js missing /about route");
  assert.ok(serverJs.includes("req.rawBody"), "server.js must preserve req.rawBody for signature verification");
});

test("vercel.json includes all required rewrite rules", () => {
  const vercelJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")
  );
  const rewrites = vercelJson.rewrites || [];
  const required = [
    { source: "/privacy", destination: "/privacy.html" },
    { source: "/terms", destination: "/terms.html" },
    { source: "/refund", destination: "/refund.html" },
    { source: "/contact", destination: "/contact.html" },
    { source: "/about", destination: "/about.html" },
    { source: "/api/paddle-webhook", destination: "/api/paddle-webhook.js" },
  ];

  for (const req of required) {
    const found = rewrites.find(
      (r) => r.source === req.source && r.destination === req.destination
    );
    assert.ok(found, `vercel.json missing rewrite for ${req.source} -> ${req.destination}`);
  }
});

console.log("\n========================================");
console.log(`Routes & Compliance Tests Completed: ${passed} passed, ${failed} failed`);
console.log("========================================\n");

if (failed > 0) {
  process.exit(1);
}
