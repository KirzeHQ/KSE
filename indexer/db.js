import fs from "fs";
import path from "path";

let impl = null;
let dbHandle = null;

async function open(dbPath) {
  if (impl) return impl;
  const resolved = dbPath || path.join(path.dirname(new URL(import.meta.url).pathname), "scraped.sqlite");

  try {
    if (typeof process !== "undefined" && process.versions && process.versions.bun) {
      const mod = await import("bun:sqlite");
      const DB = mod.DB || mod.default || mod;
      dbHandle = new DB(resolved);
      try {
        dbHandle.query(
          `CREATE TABLE IF NOT EXISTS seen (url TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, status_code INTEGER, title TEXT, hash TEXT)`,
        );
      } catch (e) {}

      impl = {
        has: async (url) => {
          try {
            const rows = dbHandle.query("SELECT url FROM seen WHERE url = ? LIMIT 1", [url]);
            return Array.isArray(rows) ? rows.length > 0 : !!rows;
          } catch (e) {
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
          } catch (e) {}
        },
        close: async () => {
          try {
            dbHandle.close();
          } catch (e) {}
        },
      };
      return impl;
    }
  } catch (e) {}

  try {
    const mod = await import("better-sqlite3");
    const Better = mod.default || mod;
    dbHandle = new Better(resolved);
    try {
      dbHandle.prepare(
        "CREATE TABLE IF NOT EXISTS seen (url TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, status_code INTEGER, title TEXT, hash TEXT)",
      ).run();
    } catch (e) {}

    impl = {
      has: async (url) => {
        try {
          const row = dbHandle.prepare("SELECT 1 FROM seen WHERE url = ? LIMIT 1").get(url);
          return !!row;
        } catch (e) {
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
        } catch (e) {}
      },
      close: async () => {
        try {
          dbHandle.close();
        } catch (e) {}
      },
    };
    return impl;
  } catch (e) {}

  let jsonPath = resolved + ".json";
  let store = new Map();
  try {
    if (fs.existsSync(jsonPath)) {
      const txt = fs.readFileSync(jsonPath, "utf8");
      const arr = JSON.parse(txt || "[]");
      store = new Map(arr);
    }
  } catch (e) {
    store = new Map();
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
      return store.has(url);
    },
    mark: async (url, meta = {}) => {
      const now = Date.now();
      const existing = store.get(url) || { first_seen: now, meta: {} };
      existing.last_seen = now;
      existing.meta = Object.assign({}, existing.meta || {}, meta || {});
      store.set(url, existing);
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
