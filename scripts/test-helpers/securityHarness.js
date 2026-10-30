require("./noNetwork");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const jwt = require("jsonwebtoken");
const ROOT = path.resolve(__dirname, "../..");

function clone(v) {
  if (v instanceof Date) return new Date(v);
  if (v && typeof v.toHexString === "function") return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}
function equal(a, b) {
  if (a instanceof Date || b instanceof Date) return Number(a) === Number(b);
  if (a?.toHexString || b?.toHexString) return String(a) === String(b);
  return a === b;
}
function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((q) => matches(doc, q));
    const val = key.split(".").reduce((v, k) => v?.[k], doc);
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected.toHexString) {
      return Object.entries(expected).every(([op, arg]) => {
        if (op === "$in") return arg.some((x) => equal(val, x));
        if (op === "$ne") return !equal(val, arg);
        if (op === "$exists") return (val !== undefined) === arg;
        if (op === "$lte") return val !== undefined && val <= arg;
        if (op === "$gte") return val !== undefined && val >= arg;
        if (op === "$gt") return val !== undefined && val > arg;
        throw new Error("Unsupported mock query operator: " + op);
      });
    }
    return equal(val, expected);
  });
}
function set(doc, values) {
  for (const [key, val] of Object.entries(values || {})) {
    const parts = key.split("."); let dest = doc;
    for (const p of parts.slice(0, -1)) dest = dest[p] ||= {};
    dest[parts.at(-1)] = clone(val);
  }
}
function mockDb(initial = {}) {
  const data = clone(initial); const calls = [];
  return { data, calls, collection(name) {
    const rows = data[name] ||= [];
    return {
      async countDocuments(query) { return rows.filter((r) => matches(r, query)).length; },
      async findOne(query, options = {}) {
        calls.push({ name, op: "findOne", query });
        let found = rows.filter((r) => matches(r, query));
        if (options.sort) found.sort((a, b) => {
          for (const [key, dir] of Object.entries(options.sort)) if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * dir;
          return 0;
        });
        return clone(found[0] || null);
      },
      async insertOne(doc) {
        calls.push({ name, op: "insertOne" });
        const copy = clone(doc); copy._id ||= "fixture-" + rows.length;
        if (rows.some((r) => equal(r._id, copy._id))) throw Object.assign(new Error("duplicate fixture ID"), { code: 11000, keyPattern: { _id: 1 } });
        rows.push(copy); return { insertedId: copy._id };
      },
      async updateOne(query, update, options = {}) {
        calls.push({ name, op: "updateOne", query });
        let row = rows.find((r) => matches(r, query)); let inserted = false;
        if (!row && options.upsert) {
          row = Object.fromEntries(Object.entries(query).filter(([, v]) => typeof v !== "object" || v === null));
          row._id ||= "fixture-" + rows.length;
          if (rows.some((r) => equal(r._id, row._id))) throw Object.assign(new Error("duplicate fixture ID"), { code: 11000, keyPattern: { _id: 1 } });
          inserted = true; rows.push(row); set(row, update.$setOnInsert);
        }
        if (row) {
 set(row, update.$set);
 for (const [key,val] of Object.entries(update.$inc || {})) row[key]=(row[key] || 0)+val;
 for (const key of Object.keys(update.$unset || {})) delete row[key];
}
        return { matchedCount: row && !inserted ? 1 : 0, upsertedCount: inserted ? 1 : 0 };
      },
      async findOneAndUpdate(query, update, options={}) {
 const result = await this.updateOne(query,update,options);
 if (!result.matchedCount && !result.upsertedCount) return null;
 return this.findOne(options.upsert ? {_id:query._id} : query._id ? {_id:query._id} : query);
},
async findOneAndDelete(query) {
        calls.push({ name, op: "findOneAndDelete", query });
        const index = rows.findIndex((r) => matches(r, query));
        return index < 0 ? null : clone(rows.splice(index, 1)[0]);
      },
    };
  } };
}
// Compile real application modules with a per-test dependency graph. Never import db.js.
function loader({ db, overrides = {}, fetchFn } = {}) {
  const cache = new Map();
  function load(file) {
    const abs = path.resolve(ROOT, file); if (cache.has(abs)) return cache.get(abs).exports;
    const module = { exports: {} }; cache.set(abs, module);
    const actualRequire = createRequire(abs);
    function isolatedRequire(id) {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      const resolved = actualRequire.resolve(id);
      if (resolved === path.join(ROOT, "api/_lib/db.js")) return { getDb: async () => { if (!db) throw new Error("Mock database unavailable"); return db; } };
      if (resolved.startsWith(ROOT + path.sep) && !resolved.includes(path.sep + "node_modules" + path.sep)) return load(resolved);
      return actualRequire(id);
    }
    const context = vm.createContext({
      console, process, Buffer, URL, URLSearchParams, Date, setTimeout, clearTimeout,
      fetch: (...args) => fetchFn ? fetchFn(...args) : global.fetch(...args),
    });
    const fn = vm.runInContext("(function(require,module,exports,__filename,__dirname){\n" + fs.readFileSync(abs, "utf8") + "\n})", context, { filename: abs });
    fn(isolatedRequire, module, module.exports, abs, path.dirname(abs));
    return module.exports;
  }
  return load;
}
function token(email = "owner@example.com", extra = {}, options = {}) {
  return jwt.sign({ email, purpose: "session", av: "fixture-version", ...extra }, process.env.JWT_SECRET, { expiresIn: "1h", ...options });
}
function request({ method = "POST", url = "/api/test", body = {}, email = "owner@example.com", bearer, headers = {}, query = {} } = {}) {
  return { method, url, body, query, socket: {remoteAddress:"127.0.0.1"}, headers: { host: "sharflow.online", ...(email ? { authorization: "Bearer " + (bearer || token(email)) } : {}), ...headers } };
}
async function call(handler, options) {
  const res = { statusCode: 200, headers: {}, body: null,
    status(n) { this.statusCode = n; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end() { return this; },
  };
  await handler(request(options), res); return res;
}
function user(extra = {}) {
  return { _id: "111111111111111111111111", email: "owner@example.com", name: "Owner",
    emailVerifiedAt: new Date(), authVersion: "fixture-version", active: true, trialEndsAt: new Date(Date.now() + 86400000),
    profile: { websiteUrl: "https://store.example", summary: "Saved profile" }, ...extra };
}
function response(data, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => data }; }
module.exports = { ROOT, clone, mockDb, loader, token, call, request, user, response };
