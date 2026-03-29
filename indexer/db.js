import fs from "fs";
import path from "path";

const DBG = (process && process.env && (process.env.DB_DEBUG === "1" || process.env.DB_DEBUG === "true")) || false;

let impl = null;
let dbHandle = null;

async function open(dbPath) {
  if (impl) return impl;
  const resolved = dbPath || path.join(path.dirname(new URL(import.meta.url).pathname), "scraped.sqlite");

  try {
    if (typeof process !== "undefined" && process.versions && process.versions.bun) {
      if (DBG) console.log(`[db] attempting bun:sqlite at ${resolved}`);
      const mod = await import("bun:sqlite");
      const DB = mod.DB || mod.default || mod;
      dbHandle = new DB(resolved);
      try {
        dbHandle.query(
          `CREATE TABLE IF NOT EXISTS seen (url TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, status_code INTEGER, title TEXT, hash TEXT)`,
        );
      } catch (e) {
        if (DBG) console.error("[db] create table (bun) failed:", e && e.message ? e.message : e);
      }

      impl = {
        has: async (url) => {
          try {
            const rows = dbHandle.query("SELECT url FROM seen WHERE url = ? LIMIT 1", [url]);
            let ok = false;
            if (Array.isArray(rows)) ok = rows.length > 0;
            else if (rows && typeof rows === "object") ok = (rows.length && rows.length > 0) || Object.keys(rows).length > 0 || !!rows;
            else ok = !!rows;
            if (DBG) console.log(`[db] has (bun) ${url} -> ${ok}`);
            return ok;
          } catch (e) {
            if (DBG) console.error("[db] has (bun) error:", e && e.message ? e.message : e);
            return false;
          }
        },
        mark: async (url, meta = {}) => {
          try {
            const now = Date.now();
            dbHandle.query(
              "INSERT OR IGNORE INTO seen (url, first_seen, last_seen, status_code, title, hash) VALUES (?, ?, ?, ?, ?, ?)",
              [url, meta.first_seen || now, now, meta.status_code || 0, meta.title || "", meta.hash || ""],
            );
            dbHandle.query(
              "UPDATE seen SET last_seen = ?, status_code = ?, title = ?, hash = ? WHERE url = ?",
              [now, meta.status_code || 0, meta.title || "", meta.hash || "", url],
            );
            if (DBG) console.log(`[db] mark (bun) ${url}`);
          } catch (e) {
            if (DBG) console.error("[db] mark (bun) error:", e && e.message ? e.message : e);
          }
        },
        close: async () => {
          try {
            dbHandle.close();
          } catch (e) {
            if (DBG) console.error("[db] close (bun) error:", e && e.message ? e.message : e);
          }
        },
      };
      return impl;
    }
  } catch (e) {
    if (DBG) console.error("[db] bun:sqlite import failed:", e && e.message ? e.message : e);
  }

  try {
    const mod = await import("better-sqlite3");
    const Better = mod.default || mod;
    if (DBG) console.log(`[db] attempting better-sqlite3 at ${resolved}`);
    dbHandle = new Better(resolved);
    try {
      dbHandle.prepare(
        "CREATE TABLE IF NOT EXISTS seen (url TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, status_code INTEGER, title TEXT, hash TEXT)",
      ).run();
    } catch (e) {
      if (DBG) console.error("[db] create table (better-sqlite3) failed:", e && e.message ? e.message : e);
    }

    impl = {
      has: async (url) => {
        try {
          const row = dbHandle.prepare("SELECT 1 FROM seen WHERE url = ? LIMIT 1").get(url);
          const ok = !!row;
          if (DBG) console.log(`[db] has (b3) ${url} -> ${ok}`);
          return ok;
        } catch (e) {
          if (DBG) console.error("[db] has (b3) error:", e && e.message ? e.message : e);
          return false;
        }
      },
      mark: async (url, meta = {}) => {
        try {
          const now = Date.now();
          dbHandle
            .prepare("INSERT OR IGNORE INTO seen (url, first_seen, last_seen, status_code, title, hash) VALUES (?, ?, ?, ?, ?, ?)")
            .run(url, now, now, meta.status_code || 0, meta.title || "", meta.hash || "");
          dbHandle
            .prepare("UPDATE seen SET last_seen = ?, status_code = ?, title = ?, hash = ? WHERE url = ?")
            .run(now, meta.status_code || 0, meta.title || "", meta.hash || "", url);
          if (DBG) console.log(`[db] mark (b3) ${url}`);
        } catch (e) {
          if (DBG) console.error("[db] mark (b3) error:", e && e.message ? e.message : e);
        }
      },
      close: async () => {
        try {
          dbHandle.close();
        } catch (e) {
          if (DBG) console.error("[db] close (b3) error:", e && e.message ? e.message : e);
        }
      },
    };
    return impl;
  } catch (e) {
    if (DBG) console.error("[db] better-sqlite3 import failed:", e && e.message ? e.message : e);
  }

  let jsonPath = resolved + ".json";
  let store = new Map();
  try {
    if (fs.existsSync(jsonPath)) {
      const txt = fs.readFileSync(jsonPath, "utf8");
      const arr = JSON.parse(txt || "[]");
      store = new Map(arr);
      if (DBG) console.log(`[db] loaded json fallback store (${store.size} entries)`);
    }
  } catch (e) {
    store = new Map();
    if (DBG) console.error("[db] json load failed:", e && e.message ? e.message : e);
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      try {
        fs.writeFileSync(jsonPath, JSON.stringify(Array.from(store.entries())), "utf8");
      } catch (e) {}
      flushTimer = null;
    }, 1000);
  }

  impl = {
    has: async (url) => {
      if (DBG) console.log(`[db] has (json) ${url} -> ${store.has(url)}`);
      return store.has(url);
    },
    mark: async (url, meta = {}) => {
      const now = Date.now();
      const existing = store.get(url) || { first_seen: now, meta: {} };
      existing.last_seen = now;
      existing.meta = Object.assign({}, existing.meta || {}, meta || {});
      store.set(url, existing);
      if (DBG) console.log(`[db] mark (json) ${url}`);
      scheduleFlush();
    },
    close: async () => {
      if (flushTimer) clearTimeout(flushTimer);
      try {
        fs.writeFileSync(jsonPath, JSON.stringify(Array.from(store.entries())), "utf8");
      } catch (e) {}
    },
  };

  return impl;
}

export default {
  open,
  has: async (url) => {
    if (!impl) throw new Error("db not opened");
    return impl.has(url);
  },
  mark: async (url, meta) => {
    if (!impl) throw new Error("db not opened");
    return impl.mark(url, meta);
  },
  close: async () => {
    if (impl && impl.close) return impl.close();
  },
};
