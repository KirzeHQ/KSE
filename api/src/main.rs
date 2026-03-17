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
use sha2::Sha256 as Sha256Inner;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

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
    bind_addr: String,
    db_file: String,
    hot_dir: String,
    cold_dir: String,
    s3_bucket: Option<String>,
    s3_endpoint: Option<String>,
}

struct AppState {
    config: Config,
    db: Mutex<Connection>,
}

async fn register_scraper(
    state: web::Data<AppState>,
    body: web::Json<RegisterRequest>,
) -> impl Responder {
    let id = Uuid::new_v4().to_string();
    let api_key: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(api_key.as_bytes());
    let api_key_hash = format!("{:x}", hasher.finalize());

    let created_at = Utc::now().timestamp();

    let conn = state.db.lock().unwrap();
    let res = conn.execute(
        "INSERT INTO scrapers (id, name, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, body.name.clone(), api_key_hash, created_at],
    );

    if let Err(e) = res {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": e.to_string()}));
    }

    HttpResponse::Ok().json(serde_json::json!({"id": id, "api_key": api_key}))
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

    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let token_hash = format!("{:x}", hasher.finalize());

    let conn = state.db.lock().unwrap();
    let mut stmt = match conn.prepare("SELECT id FROM scrapers WHERE api_key_hash = ?1") {
        Ok(s) => s,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut rows = match stmt.query(params![token_hash]) {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let scraper_id: Option<String> = match rows.next() {
        Ok(Some(row)) => row.get::<usize, String>(0).ok(),
        Ok(None) => None,
        Err(_) => None,
    };

    if scraper_id.is_none() {
        return HttpResponse::Unauthorized().json(Message {
            message: "Invalid API key",
        });
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

    let source = q.get("source").cloned().unwrap_or_else(|| "unknown".into());

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut path = PathBuf::from(&state.config.hot_dir);
    path.push(&source);
    let _ = fs::create_dir_all(&path);
    path.push(format!("{}.bin", ts));

    match fs::write(&path, &body) {
        Ok(_) => {
            let local_path_s = path.to_string_lossy().to_string();

            let s3_bucket = state.config.s3_bucket.clone();
            let s3_endpoint = state.config.s3_endpoint.clone();

            let upload_result = if let Some(bucket_name) = s3_bucket.clone() {
                let data = match fs::read(&local_path_s) {
                    Ok(d) => d,
                    Err(e) => {
                        return HttpResponse::InternalServerError()
                            .json(serde_json::json!({"error": e.to_string()}));
                    }
                };

                let key_in_bucket =
                    format!("{}/{}", source, path.file_name().unwrap().to_string_lossy());
                let endpoint = s3_endpoint.unwrap_or_else(|| {
                    format!("https://{}/{}", "r2.cloudflarestorage.com", bucket_name)
                });

                let base = endpoint.trim_end_matches('/');
                let upload_url = if base.ends_with(&bucket_name) {
                    format!("{}/{}", base, key_in_bucket)
                } else {
                    format!("{}/{}/{}", base, bucket_name, key_in_bucket)
                };

                let access_key = std::env::var("AWS_ACCESS_KEY_ID")
                    .or_else(|_| std::env::var("ACCESS_KEY_ID"))
                    .unwrap_or_default();
                let secret_key = std::env::var("AWS_SECRET_ACCESS_KEY")
                    .or_else(|_| std::env::var("SECRET_ACCESS_KEY"))
                    .unwrap_or_default();
                let region = std::env::var("AWS_REGION")
                    .or_else(|_| std::env::var("REGION"))
                    .unwrap_or_else(|_| "auto".into());

                let url = match Url::parse(&upload_url) {
                    Ok(u) => u,
                    Err(e) => {
                        return HttpResponse::InternalServerError()
                            .json(serde_json::json!({"error": e.to_string()}));
                    }
                };

                let host = match url.host_str() {
                    Some(h) => {
                        if let Some(port) = url.port() {
                            format!("{}:{}", h, port)
                        } else {
                            h.to_string()
                        }
                    }
                    None => {
                        return HttpResponse::InternalServerError()
                            .json(serde_json::json!({"error": "invalid upload URL host"}));
                    }
                };

                let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
                let datestamp = Utc::now().format("%Y%m%d").to_string();

                let payload_hash = {
                    let mut hasher = Sha256Inner::new();
                    hasher.update(&data);
                    hex_encode(hasher.finalize())
                };

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

                let mut hasher = Sha256Inner::new();
                hasher.update(canonical_request.as_bytes());
                let canonical_request_hash = hex_encode(hasher.finalize());

                let scope = format!("{}/{}/s3/aws4_request", datestamp, region);
                let string_to_sign = format!(
                    "AWS4-HMAC-SHA256\n{}\n{}\n{}",
                    amz_date, scope, canonical_request_hash
                );

                type HmacSha256 = Hmac<Sha256Inner>;
                fn hmac(key: &[u8], msg: &str) -> Vec<u8> {
                    let mut mac =
                        HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
                    mac.update(msg.as_bytes());
                    mac.finalize().into_bytes().to_vec()
                }

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
                headers.insert(HOST, HeaderValue::from_str(&host).unwrap());
                headers.insert("x-amz-date", HeaderValue::from_str(&amz_date).unwrap());
                headers.insert(
                    "x-amz-content-sha256",
                    HeaderValue::from_str(&payload_hash).unwrap(),
                );
                headers.insert(
                    "authorization",
                    HeaderValue::from_str(&authorization).unwrap(),
                );
                headers.insert(
                    CONTENT_TYPE,
                    HeaderValue::from_static("application/octet-stream"),
                );

                match client.put(url).headers(headers).body(data).send().await {
                    Ok(resp) => {
                        if resp.status().is_success() {
                            Ok(format!("{}", upload_url))
                        } else {
                            Err(format!("upload failed: {}", resp.status()))
                        }
                    }
                    Err(e) => Err(e.to_string()),
                }
            } else {
                Ok(local_path_s.clone())
            };

            match upload_result {
                Ok(remote_path) => {
                    let conn = state.db.lock().unwrap();
                    let ts = Utc::now().timestamp();
                    let scraper = scraper_id.unwrap();
                    let r = conn.execute(
                        "INSERT INTO scrapes (source, path, timestamp, scraper_id) VALUES (?1, ?2, ?3, ?4)",
                        params![source, remote_path, ts, scraper],
                    );
                    if let Err(e) = r {
                        return HttpResponse::InternalServerError()
                            .json(serde_json::json!({"error": e.to_string()}));
                    }
                    HttpResponse::Ok().json(serde_json::json!({"saved": remote_path}))
                }
                Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({"error": e})),
            }
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
struct ScraperEntry {
    id: String,
    name: String,
    created_at: i64,
}

async fn trusted_scrapers(state: web::Data<AppState>) -> impl Responder {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        match conn.prepare("SELECT id, name, created_at FROM scrapers ORDER BY created_at DESC") {
            Ok(s) => s,
            Err(e) => {
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({"error": e.to_string()}));
            }
        };

    let rows = match stmt.query_map([], |row| {
        Ok(ScraperEntry {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
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

    HttpResponse::Ok().json(serde_json::json!({"scrapers": items}))
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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS scrapes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            path TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            scraper_id TEXT
        )",
        [],
    )
    .unwrap();

    let config = Config {
        bind_addr: bind_addr.clone(),
        db_file: db_file.clone(),
        hot_dir: hot_dir.clone(),
        cold_dir,
        s3_bucket,
        s3_endpoint,
    };
    let state = AppState {
        config,
        db: Mutex::new(conn),
    };
    let shared = web::Data::new(state);

    HttpServer::new(move || {
        App::new()
            .app_data(shared.clone())
            .wrap(Logger::default())
            .wrap(Cors::permissive())
            .route("/", web::get().to(index))
            .route("/register", web::post().to(register_scraper))
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
    })
    .bind(&bind_addr)?
    .run()
    .await
}
