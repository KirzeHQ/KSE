use actix_cors::Cors;
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, Responder, http::header, middleware::Logger, web,
};
use chrono::Utc;
use dotenvy::dotenv;
use hex::encode as hex_encode;
use hmac::{Hmac, Mac};
use rand::{Rng, distributions::Alphanumeric};
use reqwest::Client as HttpClient;
use reqwest::Url;
use reqwest::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderValue};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use sha2::Sha256 as Sha256Inner;
use std::collections::HashMap;
use std::fs;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use publicsuffix::List;
use std::thread;
use uuid::Uuid;

fn ensure_auth_dbs() -> Result<(), rusqlite::Error> {
    let data_dir = PathBuf::from("data");
    let _ = std::fs::create_dir_all(&data_dir);
    let api_db = data_dir.join("api_keys.db");
    let scrapers_db = data_dir.join("scrapers.db");

    let aconn = Connection::open(api_db)?;
    aconn.execute(
        "CREATE TABLE IF NOT EXISTS api_keys (
            api_key TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    let sconn = Connection::open(scrapers_db)?;
    sconn.execute(
        "CREATE TABLE IF NOT EXISTS scrapers (
            id TEXT PRIMARY KEY,
            api_key TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;

    Ok(())
}

fn ensure_scrapes_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare("PRAGMA table_info('scrapes')")?;
    let cols: Result<Vec<String>, _> = stmt
        .query_map([], |row| row.get::<usize, String>(1))?
        .collect();
    let cols = cols.unwrap_or_default();

    if cols.is_empty() {
        conn.execute(
            "CREATE TABLE scrapes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                path TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                scraper_id TEXT,
                status TEXT DEFAULT 'pending',
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                remote_path TEXT,
                member_name TEXT
            )",
            [],
        )?;
        return Ok(());
    }

    let ensure_col = |name: &str, def: &str| -> Result<(), rusqlite::Error> {
        if !cols.iter().any(|c| c == name) {
            let q = format!("ALTER TABLE scrapes ADD COLUMN {} {}", name, def);
            conn.execute(&q, [])?;
        }
        Ok(())
    };

    ensure_col("status", "TEXT DEFAULT 'pending'")?;
    ensure_col("attempts", "INTEGER DEFAULT 0")?;
    ensure_col("last_error", "TEXT")?;
    ensure_col("remote_path", "TEXT")?;
    ensure_col("member_name", "TEXT")?;

    ensure_col("title", "TEXT")?;
    ensure_col("canonical", "TEXT")?;
    ensure_col("outlinks_count", "INTEGER DEFAULT 0")?;
    ensure_col("lang", "TEXT")?;
    ensure_col("description", "TEXT")?;
    ensure_col("fetches", "INTEGER DEFAULT 1")?;
    ensure_col("content_hash", "TEXT")?;
    ensure_col("http_status", "INTEGER")?;

    Ok(())
}

fn domain_path_for_host(host: &str, list_opt: Option<&List>) -> String {
    let host = host.trim().to_lowercase();
    if host.is_empty() {
        return host;
    }

    if let Some(list) = list_opt {
        if let Ok(domain) = list.parse_domain(&host) {
            let suffix = domain.suffix().unwrap_or("").to_string();
            let registrable_full = domain.root().unwrap_or(&host).to_string();

            let registrable =
                if !suffix.is_empty() && registrable_full.ends_with(&format!(".{}", suffix)) {
                    let cut = registrable_full.len() - suffix.len() - 1;
                    registrable_full[..cut].to_string()
                } else {
                    registrable_full.clone()
                };
            let full = domain.full();
            let sub = if let Some(root) = domain.root() {
                if full.ends_with(root) && full.len() > root.len() {
                    let cut = full.len() - root.len() - 1;
                    &full[..cut]
                } else {
                    ""
                }
            } else {
                ""
            };
            let mut filtered_vec: Vec<&str> = Vec::new();
            for label in sub.split('.') {
                if !label.is_empty() && label != "www" {
                    filtered_vec.push(label);
                }
            }
            if filtered_vec.is_empty() {
                return format!("{}/{}/@", suffix, registrable);
            } else {
                return format!("{}/{}/{}", suffix, registrable, filtered_vec.join("/"));
            }
        }
    }

    let parts: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return host;
    }
    if parts.len() == 1 {
        return parts[0].to_string();
    }
    let base_idx = parts.len().saturating_sub(2);
    let base = parts[base_idx].to_string();
    let subparts = &parts[..base_idx];
    let filtered: Vec<&str> = subparts.iter().copied().filter(|s| *s != "www").collect();
    if filtered.is_empty() {
        format!("{}/@", base)
    } else {
        format!(
            "{}/{}/{}",
            parts.last().unwrap_or(&""),
            base,
            filtered.join("/")
        )
    }
}

#[derive(Serialize)]
struct Message {
    message: &'static str,
}

#[derive(Serialize)]
struct SimpleList {
    items: Vec<String>,
}

async fn index() -> impl Responder {
    HttpResponse::Ok().json(Message {
        message: "Welcome to the KSE API!",
    })
}

#[derive(Deserialize)]
struct RegisterRequest {
    name: String,
}

#[derive(Clone)]
struct Config {
    hot_dir: String,
    cold_dir: String,
    s3_bucket: Option<String>,
    s3_endpoint: Option<String>,
    disable_s3: bool,
}

struct AppState {
    config: Config,
    db: Mutex<Connection>,
    ps_list: Mutex<Option<List>>,
}

async fn upload_bytes_signed(upload_url: &str, data: &[u8]) -> Result<String, String> {
    let url = Url::parse(upload_url).map_err(|e| e.to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "invalid upload URL host".to_string())
        .map(|h| {
            if let Some(port) = url.port() {
                format!("{}:{}", h, port)
            } else {
                h.to_string()
            }
        })?;

    let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let datestamp = Utc::now().format("%Y%m%d").to_string();

    let mut ph = Sha256Inner::new();
    ph.update(data);
    let payload_hash = hex_encode(ph.finalize());

    let canonical_uri = url.path();
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        canonical_uri, canonical_headers, signed_headers, payload_hash
    );

    let mut h = Sha256Inner::new();
    h.update(canonical_request.as_bytes());
    let canonical_request_hash = hex_encode(h.finalize());

    let region = std::env::var("AWS_REGION")
        .or_else(|_| std::env::var("REGION"))
        .unwrap_or_else(|_| "auto".into());
    let scope = format!("{}/{}/s3/aws4_request", datestamp, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date, scope, canonical_request_hash
    );

    type HmacSha256 = Hmac<Sha256Inner>;
    fn hmac(key: &[u8], msg: &str) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
        mac.update(msg.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .or_else(|_| std::env::var("SECRET_ACCESS_KEY"))
        .unwrap_or_default();
    let access_key = std::env::var("AWS_ACCESS_KEY_ID")
        .or_else(|_| std::env::var("ACCESS_KEY_ID"))
        .unwrap_or_default();

    let k_secret = format!("AWS4{}", secret_key);
    let k_date = hmac(k_secret.as_bytes(), &datestamp);
    let k_region = hmac(&k_date, &region);
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex_encode(hmac(&k_signing, &string_to_sign));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, scope, signed_headers, signature
    );

    let client = HttpClient::new();
    let mut headers = HeaderMap::new();
    headers.insert(
        HOST,
        HeaderValue::from_str(&host).map_err(|e| e.to_string())?,
    );
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(&amz_date).map_err(|e| e.to_string())?,
    );
    headers.insert(
        "x-amz-content-sha256",
        HeaderValue::from_str(&payload_hash).map_err(|e| e.to_string())?,
    );
    headers.insert(
        "authorization",
        HeaderValue::from_str(&authorization).map_err(|e| e.to_string())?,
    );
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );

    let resp = client
        .put(url)
        .headers(headers)
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        Ok(upload_url.to_string())
    } else {
        Err(format!("upload failed: {}", resp.status()))
    }
}

async fn create_and_upload_archive(
    state: &web::Data<AppState>,
    source: &str,
    items: &[(i64, String)],
) -> Result<(), String> {
    let domain_path = domain_path_for_host(source, state.ps_list.lock().unwrap().as_ref());

    let mut any_err: Option<String> = None;
    let conn = state.db.lock().unwrap();

    if state.config.disable_s3 || state.config.s3_bucket.is_none() {
        for (id, local_path) in items.iter() {
            let member_name = PathBuf::from(local_path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file.bin".into());

            let remote_path = local_path.clone();
            match conn.execute(
                "UPDATE scrapes SET status = 'uploaded', remote_path = ?1, member_name = ?2 WHERE id = ?3",
                params![remote_path, member_name, id],
            ) {
                Ok(_) => {}
                Err(e) => {
                    any_err = Some(e.to_string());
                }
            }
        }
        if let Some(e) = any_err {
            Err(e)
        } else {
            Ok(())
        }
    } else {
        let bucket = match &state.config.s3_bucket {
            Some(b) => b.clone(),
            None => return Err("no S3 bucket configured".into()),
        };
        for (id, local_path) in items.iter() {
            match fs::read(local_path) {
                Ok(data) => {
                    let member_name = PathBuf::from(local_path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "file.bin".into());

                    let endpoint = state.config.s3_endpoint.clone().unwrap_or_default();
                    let base = if endpoint.is_empty() {
                        format!("https://{}/{}", "r2.cloudflarestorage.com", bucket)
                    } else {
                        endpoint.trim_end_matches('/').to_string()
                    };

                    let upload_url = if base.ends_with(&bucket) {
                        format!("{}/{}/{}", base, domain_path, member_name)
                    } else {
                        format!("{}/{}/{}/{}", base, bucket, domain_path, member_name)
                    };

                    match upload_bytes_signed(&upload_url, &data).await {
                        Ok(remote) => {
                            let _ = conn.execute(
                                "UPDATE scrapes SET status = 'uploaded', remote_path = ?1, member_name = ?2 WHERE id = ?3",
                                params![remote, member_name, id],
                            );
                            let _ = fs::remove_file(local_path);
                        }
                        Err(e) => {
                            any_err = Some(e.clone());
                            let _ = conn.execute(
                                "UPDATE scrapes SET attempts = attempts + 1, last_error = ?1 WHERE id = ?2",
                                params![e.clone(), id],
                            );
                        }
                    }
                }
                Err(e) => {
                    any_err = Some(e.to_string());
                    let _ = conn.execute(
                        "UPDATE scrapes SET attempts = attempts + 1, last_error = ?1 WHERE id = ?2",
                        params![e.to_string(), id],
                    );
                }
            }
        }

        if let Some(e) = any_err {
            Err(e)
        } else {
            Ok(())
        }
    }
}

async fn register_scraper(
    _state: web::Data<AppState>,
    _body: web::Json<RegisterRequest>,
) -> impl Responder {
    let api_key: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    let _ = ensure_auth_dbs();
    let api_db = PathBuf::from("data").join("api_keys.db");
    match Connection::open(&api_db) {
        Ok(conn) => {
            let ts = Utc::now().timestamp();
            if let Err(e) = conn.execute(
                "INSERT INTO api_keys (api_key, created_at) VALUES (?1, ?2)",
                params![api_key.clone(), ts],
            ) {
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({"error": e.to_string()}));
            }
            HttpResponse::Ok().json(serde_json::json!({"api_key": api_key}))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()}))
        }
    }
}

async fn scraper_register(
    req: HttpRequest,
    _state: web::Data<AppState>,
    body: web::Json<RegisterRequest>,
) -> impl Responder {
    let auth_hdr = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let api_key = auth_hdr.strip_prefix("Bearer ").unwrap_or("");
    if api_key.is_empty() {
        return HttpResponse::Unauthorized().json(serde_json::json!({"error": "Missing API key"}));
    }
    let _ = ensure_auth_dbs();
    let api_db = PathBuf::from("data").join("api_keys.db");
    let scrapers_db = PathBuf::from("data").join("scrapers.db");

    match Connection::open(&api_db) {
        Ok(conn) => {
            let mut stmt = match conn.prepare("SELECT 1 FROM api_keys WHERE api_key = ?1") {
                Ok(s) => s,
                Err(_) => {
                    return HttpResponse::Unauthorized()
                        .json(serde_json::json!({"error": "invalid API key"}));
                }
            };
            let mut rows = match stmt.query_map(params![api_key], |_row| Ok(1)) {
                Ok(r) => r,
                Err(_) => {
                    return HttpResponse::Unauthorized()
                        .json(serde_json::json!({"error": "invalid API key"}));
                }
            };
            if rows.next().is_none() {
                return HttpResponse::Unauthorized()
                    .json(serde_json::json!({"error": "invalid API key"}));
            }
        }
        Err(_) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": "auth DB open failed"}));
        }
    }

    let new_id = Uuid::new_v4().to_string();
    let ts = Utc::now().timestamp();
    match Connection::open(&scrapers_db) {
        Ok(conn) => {
            if let Err(e) = conn.execute(
                "INSERT INTO scrapers (id, api_key, name, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![new_id.clone(), api_key, body.name.clone(), ts],
            ) {
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({"error": e.to_string()}));
            }
            HttpResponse::Ok().json(serde_json::json!({"id": new_id}))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()}))
        }
    }
}

async fn submit_data(
    req: HttpRequest,
    state: web::Data<AppState>,
    body: web::Bytes,
) -> impl Responder {
    let auth_hdr = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let token = auth_hdr.strip_prefix("Bearer ").unwrap_or("");
    if token.is_empty() {
        return HttpResponse::Unauthorized().json(Message {
            message: "Missing Authorization",
        });
    }

    let _ = ensure_auth_dbs();
    let api_db = PathBuf::from("data").join("api_keys.db");
    let scrapers_db = PathBuf::from("data").join("scrapers.db");

    match Connection::open(&api_db) {
        Ok(conn) => {
            let mut stmt = match conn.prepare("SELECT 1 FROM api_keys WHERE api_key = ?1") {
                Ok(s) => s,
                Err(_) => {
                    return HttpResponse::Unauthorized().json(Message {
                        message: "Invalid API key",
                    });
                }
            };
            let mut rows = match stmt.query_map(params![token], |_row| Ok(1)) {
                Ok(r) => r,
                Err(_) => {
                    return HttpResponse::Unauthorized().json(Message {
                        message: "Invalid API key",
                    });
                }
            };
            if rows.next().is_none() {
                return HttpResponse::Unauthorized().json(Message {
                    message: "Invalid API key",
                });
            }
        }
        Err(_) => {
            return HttpResponse::Unauthorized().json(Message {
                message: "Invalid API key",
            });
        }
    }

    let q_params: HashMap<String, String> = req
        .query_string()
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            match (parts.next(), parts.next()) {
                (Some(k), Some(v)) if !k.is_empty() => Some((k.to_string(), v.to_string())),
                _ => None,
            }
        })
        .collect();
    let scraper_id = req
        .headers()
        .get("X-Scraper-Id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q_params.get("scraper_id").cloned());

    if scraper_id.is_none() {
        return HttpResponse::Unauthorized().json(Message {
            message: "Missing scraper id",
        });
    }

    match Connection::open(&scrapers_db) {
        Ok(conn) => {
            let id = scraper_id.as_ref().unwrap();
            let row = conn.query_row(
                "SELECT api_key FROM scrapers WHERE id = ?1",
                params![id],
                |r| r.get::<usize, String>(0),
            );
            match row {
                Ok(owner_key) => {
                    if owner_key != token {
                        return HttpResponse::Unauthorized().json(Message {
                            message: "Scraper id not assigned to API key",
                        });
                    }
                }
                Err(_) => {
                    return HttpResponse::Unauthorized().json(Message {
                        message: "Scraper id not found",
                    });
                }
            }
        }
        Err(_) => {
            return HttpResponse::InternalServerError().json(Message {
                message: "auth DB error",
            });
        }
    }

    let q: HashMap<String, String> = req
        .query_string()
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            match (parts.next(), parts.next()) {
                (Some(k), Some(v)) if !k.is_empty() => Some((k.to_string(), v.to_string())),
                _ => None,
            }
        })
        .collect();

    let source_raw = q.get("source").cloned().unwrap_or_else(|| "unknown".into());

    let mut source_host = source_raw.clone();
    if source_host.contains('/') {
        if let Ok(u) = Url::parse(&source_host) {
            if let Some(h) = u.host_str() {
                source_host = h.to_string();
            }
        } else if let Ok(u) = Url::parse(&format!("https://{}", source_host)) {
            if let Some(h) = u.host_str() {
                source_host = h.to_string();
            }
        }
    }

    let domain_path = domain_path_for_host(&source_host, state.ps_list.lock().unwrap().as_ref());

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut path = PathBuf::from(&state.config.hot_dir);
    path.push(&domain_path);
    let _ = fs::create_dir_all(&path);
    path.push(format!("{}.bin", ts));

    match fs::write(&path, &body) {
        Ok(_) => {
            let local_path_s = path.to_string_lossy().to_string();
            let conn = state.db.lock().unwrap();
            let ts = Utc::now().timestamp();
            let scraper = scraper_id.unwrap();

            let mut title: Option<String> = None;
            let mut canonical: Option<String> = None;
            let mut outlinks_count: Option<i64> = None;
            let mut lang: Option<String> = None;
            let mut description: Option<String> = None;
            let mut fetches: Option<i64> = Some(1);
            let mut content_hash: Option<String> = None;
            let mut http_status: Option<i64> = None;

            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                if let Some(s) = v.get("title").and_then(|x| x.as_str()) {
                    title = Some(s.to_string());
                }
                if let Some(s) = v.get("canonical").and_then(|x| x.as_str()) {
                    canonical = Some(s.to_string());
                }
                if let Some(n) = v.get("outlinks_count").and_then(|x| x.as_i64()) {
                    outlinks_count = Some(n);
                }
                if let Some(s) = v.get("lang").and_then(|x| x.as_str()) {
                    lang = Some(s.to_string());
                }
                if let Some(s) = v.get("description").and_then(|x| x.as_str()) {
                    description = Some(s.to_string());
                }
                if let Some(n) = v.get("fetches").and_then(|x| x.as_i64()) {
                    fetches = Some(n);
                }
                if let Some(s) = v.get("content_hash").and_then(|x| x.as_str()) {
                    content_hash = Some(s.to_string());
                }
                if let Some(n) = v.get("status").and_then(|x| x.as_i64()) {
                    http_status = Some(n);
                }
            }

            let r = conn.execute(
                "INSERT INTO scrapes (source, path, timestamp, scraper_id, status, title, canonical, outlinks_count, lang, description, fetches, content_hash, http_status) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![source_host, local_path_s, ts, scraper, title, canonical, outlinks_count, lang, description, fetches, content_hash, http_status],
            );
            if let Err(e) = r {
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({"error": e.to_string()}));
            }
            HttpResponse::Accepted().json(serde_json::json!({"queued": path.to_string_lossy()}))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()}))
        }
    }
}

async fn search(query: web::Query<HashMap<String, String>>) -> impl Responder {
    let q = query.get("q").cloned().unwrap_or_default();
    let resp = serde_json::json!({"query": q, "results": []});
    HttpResponse::Ok().json(resp)
}

#[derive(Serialize)]
struct ScrapeEntry {
    id: i64,
    source: String,
    path: String,
    timestamp: i64,
    scraper_id: Option<String>,
}

async fn sources(state: web::Data<AppState>) -> impl Responder {
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT DISTINCT source FROM scrapes") {
        Ok(s) => s,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };
    let rows = match stmt.query_map([], |row| row.get::<usize, String>(0)) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            items.push(s);
        }
    }

    HttpResponse::Ok().json(serde_json::json!({"items": items}))
}

async fn scrapes_list(state: web::Data<AppState>) -> impl Responder {
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id, source, path, timestamp, scraper_id FROM scrapes ORDER BY timestamp DESC LIMIT 100") {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
    };

    let rows = match stmt.query_map([], |row| {
        Ok(ScrapeEntry {
            id: row.get(0)?,
            source: row.get(1)?,
            path: row.get(2)?,
            timestamp: row.get(3)?,
            scraper_id: row.get(4)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            items.push(s);
        }
    }
    HttpResponse::Ok().json(serde_json::json!({"scrapes": items}))
}

async fn scrapes_for_source(path: web::Path<String>, state: web::Data<AppState>) -> impl Responder {
    let source = path.into_inner();
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id, source, path, timestamp, scraper_id FROM scrapes WHERE source = ?1 ORDER BY timestamp DESC") {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
    };

    let rows = match stmt.query_map(params![source.clone()], |row| {
        Ok(ScrapeEntry {
            id: row.get(0)?,
            source: row.get(1)?,
            path: row.get(2)?,
            timestamp: row.get(3)?,
            scraper_id: row.get(4)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            items.push(s);
        }
    }

    HttpResponse::Ok().json(serde_json::json!({"source": source, "scrapes": items}))
}

async fn scrapes_for_source_date(
    path: web::Path<(String, String)>,
    state: web::Data<AppState>,
) -> impl Responder {
    let (source, date) = path.into_inner();

    let parsed = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d");
    if parsed.is_err() {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({"error": "date must be YYYY-MM-DD"}));
    }
    let nd = parsed.unwrap();
    let start = nd.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp();
    let end = nd.and_hms_opt(23, 59, 59).unwrap().and_utc().timestamp();

    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id, source, path, timestamp, scraper_id FROM scrapes WHERE source = ?1 AND timestamp BETWEEN ?2 AND ?3 ORDER BY timestamp DESC") {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
    };

    let rows = match stmt.query_map(params![source.clone(), start, end], |row| {
        Ok(ScrapeEntry {
            id: row.get(0)?,
            source: row.get(1)?,
            path: row.get(2)?,
            timestamp: row.get(3)?,
            scraper_id: row.get(4)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            items.push(s);
        }
    }

    HttpResponse::Ok().json(serde_json::json!({"source": source, "date": date, "scrapes": items}))
}

async fn queue() -> impl Responder {
    HttpResponse::Ok().json(SimpleList { items: vec![] })
}

#[derive(Serialize)]
struct PendingEntry {
    id: i64,
    source: String,
    path: String,
    timestamp: i64,
    attempts: i64,
    last_error: Option<String>,
}

async fn upload_queue(state: web::Data<AppState>) -> impl Responder {
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id, source, path, timestamp, attempts, last_error FROM scrapes WHERE status = 'pending' ORDER BY timestamp ASC") {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
    };

    let rows = match stmt.query_map([], |row| {
        Ok(PendingEntry {
            id: row.get(0)?,
            source: row.get(1)?,
            path: row.get(2)?,
            timestamp: row.get(3)?,
            attempts: row.get(4)?,
            last_error: row.get(5)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items: Vec<PendingEntry> = Vec::new();
    for r in rows {
        if let Ok(entry) = r {
            items.push(entry);
        }
    }

    HttpResponse::Ok().json(serde_json::json!({"pending": items}))
}

async fn trusted_scrapers(_state: web::Data<AppState>) -> impl Responder {
    let _ = ensure_auth_dbs();
    let scrapers_db = PathBuf::from("data").join("scrapers.db");
    match Connection::open(&scrapers_db) {
        Ok(conn) => {
            let mut stmt = match conn
                .prepare("SELECT id, name, created_at FROM scrapers ORDER BY created_at DESC")
            {
                Ok(s) => s,
                Err(e) => {
                    return HttpResponse::InternalServerError()
                        .json(serde_json::json!({"error": e.to_string()}));
                }
            };
            let rows = match stmt.query_map([], |row| {
                Ok(serde_json::json!({"id": row.get::<usize,String>(0)?, "name": row.get::<usize,String>(1)?, "created_at": row.get::<usize,i64>(2)?}))
            }) {
                Ok(r) => r,
                Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
            };
            let mut items = Vec::new();
            for r in rows {
                if let Ok(j) = r {
                    items.push(j);
                }
            }
            HttpResponse::Ok().json(serde_json::json!({"scrapers": items}))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()}))
        }
    }
}

fn list_files_recursive(dir: &PathBuf, base: &PathBuf, out: &mut Vec<String>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                list_files_recursive(&path, base, out);
            } else {
                if let Ok(rel) = path.strip_prefix(base) {
                    out.push(rel.to_string_lossy().to_string());
                } else {
                    out.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
}

async fn hot_storage(state: web::Data<AppState>) -> impl Responder {
    let base = PathBuf::from(&state.config.hot_dir);
    let mut items = Vec::new();
    list_files_recursive(&base, &base, &mut items);
    HttpResponse::Ok().json(serde_json::json!({"files": items}))
}

async fn cold_storage(state: web::Data<AppState>) -> impl Responder {
    let base = PathBuf::from(&state.config.cold_dir);
    let mut items = Vec::new();
    list_files_recursive(&base, &base, &mut items);
    HttpResponse::Ok().json(serde_json::json!({"files": items}))
}

async fn scraper_stats(path: web::Path<String>, state: web::Data<AppState>) -> impl Responder {
    let id = path.into_inner();
    let conn = state.db.lock().unwrap();
    let row = conn.query_row(
        "SELECT COUNT(*), MAX(timestamp) FROM scrapes WHERE scraper_id = ?1",
        params![id],
        |r| Ok((r.get::<usize, i64>(0)?, r.get::<usize, Option<i64>>(1)?)),
    );

    match row {
        Ok((count, last_ts)) => HttpResponse::Ok().json(
            serde_json::json!({"id": id, "stats": {"count": count, "last_timestamp": last_ts}}),
        ),
        Err(e) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()}))
        }
    }
}

async fn scraper_history(path: web::Path<String>, state: web::Data<AppState>) -> impl Responder {
    let id = path.into_inner();
    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id, source, path, timestamp, scraper_id FROM scrapes WHERE scraper_id = ?1 ORDER BY timestamp DESC") {
        Ok(s) => s,
        Err(e) => return HttpResponse::InternalServerError().json(serde_json::json!({"error": e.to_string()})),
    };

    let rows = match stmt.query_map(params![id.clone()], |row| {
        Ok(ScrapeEntry {
            id: row.get(0)?,
            source: row.get(1)?,
            path: row.get(2)?,
            timestamp: row.get(3)?,
            scraper_id: row.get(4)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut items = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            items.push(s);
        }
    }

    HttpResponse::Ok().json(serde_json::json!({"id": id, "history": items}))
}

async fn scraper_trust_level(path: web::Path<String>) -> impl Responder {
    let id = path.into_inner();
    let resp = serde_json::json!({"id": id, "trust_level": "unknown"});
    HttpResponse::Ok().json(resp)
}

async fn scraper_assigned_sources(path: web::Path<String>) -> impl Responder {
    let id = path.into_inner();
    let resp = serde_json::json!({"id": id, "assigned_sources": []});
    HttpResponse::Ok().json(resp)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let _ = dotenv();
    env_logger::init();

    if let Ok(access) = std::env::var("ACCESS_KEY_ID") {
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", access);
        }
    }
    if let Ok(secret) = std::env::var("SECRET_ACCESS_KEY") {
        unsafe {
            std::env::set_var("AWS_SECRET_ACCESS_KEY", secret);
        }
    }
    if let Ok(region) = std::env::var("REGION") {
        unsafe {
            std::env::set_var("AWS_REGION", region);
        }
    }

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let hot_dir = std::env::var("HOT_DIR").unwrap_or_else(|_| "hot".into());
    let cold_dir = std::env::var("COLD_DIR").unwrap_or_else(|_| "cold".into());

    let db_file = std::env::var("DB_FILE").unwrap_or_else(|_| "data/db.sqlite".into());
    let s3_bucket = std::env::var("S3_BUCKET").ok();
    let s3_endpoint = std::env::var("S3_ENDPOINT").ok();

    if let Some(parent) = PathBuf::from(&db_file).parent() {
        let _ = fs::create_dir_all(parent);
    }

    let conn = Connection::open(&db_file).map_err(|e| {
        eprintln!("Failed to open DB: {}", e);
        std::io::Error::new(std::io::ErrorKind::Other, "DB open failed")
    })?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS scrapers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            api_key_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )
    .unwrap();

    if let Err(e) = ensure_scrapes_schema(&conn) {
        eprintln!("failed to ensure scrapes schema: {}", e);
    }

    if let Err(e) = ensure_auth_dbs() {
        eprintln!("Failed to initialize auth DBs: {}", e);
    }

    let disable_s3 = std::env::var("DISABLE_S3")
        .ok()
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let config = Config {
        hot_dir: hot_dir.clone(),
        cold_dir,
        s3_bucket,
        s3_endpoint,
        disable_s3,
    };
    let state = AppState {
        config,
        db: Mutex::new(conn),
        ps_list: Mutex::new(None),
    };
    let shared = web::Data::new(state);

    {
        let pshared = shared.clone();
        actix_web::rt::spawn(async move {
            let refresh_hours: u64 = std::env::var("PSL_REFRESH_HOURS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(24);
            loop {
                {
                    let pshared2 = pshared.clone();
                    thread::spawn(move || match List::fetch() {
                        Ok(list) => {
                            let mut lock = pshared2.ps_list.lock().unwrap();
                            *lock = Some(list);
                            eprintln!("public suffix list updated");
                        }
                        Err(e) => {
                            eprintln!("failed to fetch public suffix list: {}", e);
                        }
                    });
                }
                actix_web::rt::time::sleep(Duration::from_secs(refresh_hours * 3600)).await;
            }
        });
    }

    {
        let worker_shared = shared.clone();
        actix_web::rt::spawn(async move {
            let interval_min: u64 = std::env::var("ARCHIVE_INTERVAL_MIN")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30);

            let mut interval =
                actix_web::rt::time::interval(std::time::Duration::from_secs(interval_min * 60));
            loop {
                interval.tick().await;

                let mut pending: Vec<(i64, String, String, u64)> = Vec::new();
                {
                    let db = worker_shared.db.lock().unwrap();
                    if let Ok(mut stmt) = db.prepare("SELECT id, source, path FROM scrapes WHERE status = 'pending' ORDER BY timestamp ASC") {
                        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<usize,i64>(0)?, row.get::<usize,String>(1)?, row.get::<usize,String>(2)?))) {
                            for r in rows.flatten() {
                                if let Ok(meta) = fs::metadata(&r.2) {
                                    pending.push((r.0, r.1, r.2, meta.len()));
                                }
                            }
                        }
                    }
                }

                use std::collections::BTreeMap;
                let mut groups: BTreeMap<String, Vec<(i64, String, u64)>> = BTreeMap::new();
                for (id, source, path, size) in pending.into_iter() {
                    groups.entry(source).or_default().push((id, path, size));
                }

                for (source, items) in groups {
                    let mut all: Vec<(i64, String)> = Vec::new();
                    for (id, path, _size) in items.into_iter() {
                        all.push((id, path));
                    }
                    if !all.is_empty() {
                        if let Err(e) =
                            create_and_upload_archive(&worker_shared, &source, &all).await
                        {
                            eprintln!("upload error: {}", e);
                        }
                    }
                }
            }
        });
    }

    HttpServer::new(move || {
        App::new()
            .app_data(shared.clone())
            .wrap(Logger::default())
            .wrap(Cors::permissive())
            .route("/", web::get().to(index))
            .route("/register", web::post().to(register_scraper))
            .route("/scraper/register", web::post().to(scraper_register))
            .route("/submit", web::patch().to(submit_data))
            .route("/search", web::get().to(search))
            .route("/sources", web::get().to(sources))
            .route("/scrapes", web::get().to(scrapes_list))
            .route("/scrapes/{source}", web::get().to(scrapes_for_source))
            .route(
                "/scrapes/{source}/{date}",
                web::get().to(scrapes_for_source_date),
            )
            .route("/queue", web::get().to(queue))
            .route("/trusted-scrapers", web::get().to(trusted_scrapers))
            .route("/hot-storage", web::get().to(hot_storage))
            .route("/cold-storage", web::get().to(cold_storage))
            .route("/scraper/{id}/stats", web::get().to(scraper_stats))
            .route("/scraper/{id}/history", web::get().to(scraper_history))
            .route(
                "/scraper/{id}/trust-level",
                web::get().to(scraper_trust_level),
            )
            .route(
                "/scraper/{id}/assigned-sources",
                web::get().to(scraper_assigned_sources),
            )
            .route("/upload/queue", web::get().to(upload_queue))
    })
    .bind(&bind_addr)?
    .run()
    .await
}
