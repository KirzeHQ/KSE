use actix_cors::Cors;
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, Responder, http::header, middleware::Logger, web,
};
use chrono::Utc;
use dotenvy::dotenv;
use flate2::Compression;
use flate2::write::GzEncoder;
use fs2::FileExt;
use hex::encode as hex_encode;
use hmac::{Hmac, Mac};
use rand::{Rng, distributions::Alphanumeric};
use reqwest::Client as HttpClient;
use reqwest::Url;
use reqwest::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderValue};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::Sha256 as Sha256Inner;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tar::Builder as TarBuilder;
use uuid::Uuid;

fn load_api_map(path: &PathBuf) -> std::io::Result<std::collections::HashMap<String, Vec<String>>> {
    let mut map = std::collections::HashMap::new();
    if !path.exists() {
        return Ok(map);
    }
    let f = OpenOptions::new().read(true).open(path)?;

    f.lock_shared()?;
    let mut s = String::new();
    std::io::Read::read_to_string(&mut &f, &mut s)?;

    f.unlock()?;

    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(pos) = line.find('=') {
            let key = line[..pos].to_string();
            let val = line[pos + 1..].trim();
            let ids: Vec<String> = if val.is_empty() {
                Vec::new()
            } else {
                val.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            };
            map.insert(key, ids);
        }
    }
    Ok(map)
}

fn save_api_map(
    path: &PathBuf,
    map: &std::collections::HashMap<String, Vec<String>>,
) -> std::io::Result<()> {
    let mut out = String::new();
    for (k, v) in map.iter() {
        out.push_str(&format!("{}={}\n", k, v.join(",")));
    }
    let f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;

    f.lock_exclusive()?;
    std::io::Write::write_all(&mut &f, out.as_bytes())?;
    f.sync_all()?;
    f.unlock()?;
    Ok(())
}

fn load_id_list(path: &PathBuf) -> std::io::Result<Vec<JsonValue>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let f = OpenOptions::new().read(true).open(path)?;
    f.lock_shared()?;
    let mut s = String::new();
    std::io::Read::read_to_string(&mut &f, &mut s)?;
    f.unlock()?;
    let v: Vec<JsonValue> = serde_json::from_str(&s).unwrap_or_else(|_| Vec::new());
    Ok(v)
}

fn save_id_list(path: &PathBuf, list: &Vec<JsonValue>) -> std::io::Result<()> {
    let s = serde_json::to_string_pretty(list).unwrap_or_else(|_| "[]".into());
    let f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    f.lock_exclusive()?;
    std::io::Write::write_all(&mut &f, s.as_bytes())?;
    f.sync_all()?;
    f.unlock()?;
    Ok(())
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
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/gzip"));

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
    let mut buf: Vec<u8> = Vec::new();
    {
        let enc = GzEncoder::new(&mut buf, Compression::default());
        let mut tar = TarBuilder::new(enc);
        for (_id, local_path) in items.iter() {
            let p = PathBuf::from(local_path);
            let file_name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file.bin".into());
            tar.append_path_with_name(&p, file_name)
                .map_err(|e| e.to_string())?;
        }

        let enc = tar.into_inner().map_err(|e| e.to_string())?;
        enc.finish().map_err(|e| e.to_string())?;
    }

    let ts = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let bucket = match &state.config.s3_bucket {
        Some(b) => b.clone(),
        None => return Err("no S3 bucket configured".into()),
    };
    let prefix = std::env::var("ARCHIVE_PREFIX").unwrap_or_else(|_| "archives".into());
    let archive_key = format!("{}/{}/{}.tar.gz", prefix, source, ts);
    let endpoint = state.config.s3_endpoint.clone().unwrap_or_default();
    let base = if endpoint.is_empty() {
        format!("https://{}/{}", "r2.cloudflarestorage.com", bucket)
    } else {
        endpoint.trim_end_matches('/').to_string()
    };
    let upload_url = if base.ends_with(&bucket) {
        format!("{}/{}", base, archive_key)
    } else {
        format!("{}/{}/{}", base, bucket, archive_key)
    };

    let res = upload_bytes_signed(&upload_url, &buf).await;
    match res {
        Ok(remote) => {
            let conn = state.db.lock().unwrap();
            for (id, local_path) in items.iter() {
                let member_name = PathBuf::from(local_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file.bin".into());
                let _ = conn.execute("UPDATE scrapes SET status = 'uploaded', remote_path = ?1, member_name = ?2 WHERE id = ?3", params![remote, member_name, id]);
                let _ = fs::remove_file(local_path);
            }
            Ok(())
        }
        Err(e) => {
            let conn = state.db.lock().unwrap();
            for (id, _path) in items.iter() {
                let _ = conn.execute(
                    "UPDATE scrapes SET attempts = attempts + 1, last_error = ?1 WHERE id = ?2",
                    params![e.clone(), id],
                );
            }
            Err(e)
        }
    }
}

async fn register_scraper(
    state: web::Data<AppState>,
    body: web::Json<RegisterRequest>,
) -> impl Responder {
    let api_key: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();

    let data_dir = PathBuf::from("data");
    let _ = fs::create_dir_all(&data_dir);
    let ini_path = data_dir.join("api.ini");

    let mut map = load_api_map(&ini_path).unwrap_or_else(|_| std::collections::HashMap::new());
    map.insert(api_key.clone(), Vec::new());
    if let Err(e) = save_api_map(&ini_path, &map) {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": e.to_string()}));
    }

    HttpResponse::Ok().json(serde_json::json!({"api_key": api_key}))
}

async fn scraper_register(
    req: HttpRequest,
    state: web::Data<AppState>,
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

    let data_dir = PathBuf::from("data");
    let _ = fs::create_dir_all(&data_dir);
    let ini_path = data_dir.join("api.ini");
    if !ini_path.exists() {
        return HttpResponse::Unauthorized().json(serde_json::json!({"error": "invalid API key"}));
    }

    let mut map = load_api_map(&ini_path).unwrap_or_else(|_| std::collections::HashMap::new());
    if !map.contains_key(api_key) {
        return HttpResponse::Unauthorized().json(serde_json::json!({"error": "invalid API key"}));
    }

    let new_id = Uuid::new_v4().to_string();
    let id_list_path = data_dir.join("id-list.json");
    let mut id_list: Vec<JsonValue> = load_id_list(&id_list_path).unwrap_or_else(|_| Vec::new());
    let entry = serde_json::json!({"id": new_id, "name": body.name.clone(), "created_at": Utc::now().timestamp()});
    id_list.push(entry);
    if let Err(e) = save_id_list(&id_list_path, &id_list) {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": e.to_string()}));
    }

    let list = map.entry(api_key.to_string()).or_default();
    list.push(new_id.clone());
    if let Err(e) = save_api_map(&ini_path, &map) {
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": e.to_string()}));
    }

    HttpResponse::Ok().json(serde_json::json!({"id": new_id}))
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

    let data_dir = PathBuf::from("data");
    let ini_path = data_dir.join("api.ini");
    if !ini_path.exists() {
        return HttpResponse::Unauthorized().json(Message {
            message: "Invalid API key",
        });
    }
    let map = load_api_map(&ini_path).unwrap_or_else(|_| std::collections::HashMap::new());
    if !map.contains_key(token) {
        return HttpResponse::Unauthorized().json(Message {
            message: "Invalid API key",
        });
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

    let assigned_ids = map.get(token).cloned().unwrap_or_default();
    if !assigned_ids.contains(&scraper_id.as_ref().unwrap().to_string()) {
        return HttpResponse::Unauthorized().json(Message {
            message: "Scraper id not assigned to API key",
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
            let conn = state.db.lock().unwrap();
            let ts = Utc::now().timestamp();
            let scraper = scraper_id.unwrap();
            let r = conn.execute(
                "INSERT INTO scrapes (source, path, timestamp, scraper_id, status) VALUES (?1, ?2, ?3, ?4, 'pending')",
                params![source, local_path_s, ts, scraper],
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

#[derive(Serialize)]
struct ScraperEntry {
    id: String,
    name: String,
    created_at: i64,
}

async fn trusted_scrapers(state: web::Data<AppState>) -> impl Responder {
    let data_dir = PathBuf::from("data");
    let id_list_path = data_dir.join("id-list.json");
    if !id_list_path.exists() {
        return HttpResponse::Ok().json(serde_json::json!({"scrapers": []}));
    }
    let vlist = load_id_list(&id_list_path).unwrap_or_else(|_| Vec::new());
    HttpResponse::Ok().json(serde_json::json!({"scrapers": vlist}))
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
            scraper_id TEXT,
            status TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            remote_path TEXT,
            member_name TEXT
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

    {
        let worker_shared = shared.clone();
        actix_web::rt::spawn(async move {
            let interval_min: u64 = std::env::var("ARCHIVE_INTERVAL_MIN")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30);
            let max_archive_bytes: u64 = std::env::var("MAX_ARCHIVE_BYTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5 * 1024 * 1024);
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
                    let mut chunk: Vec<(i64, String)> = Vec::new();
                    let mut cur: u64 = 0;
                    for (id, path, size) in items.into_iter() {
                        if cur + size > max_archive_bytes && !chunk.is_empty() {
                            let chunk_clone = chunk.clone();
                            if let Err(e) =
                                create_and_upload_archive(&worker_shared, &source, &chunk_clone)
                                    .await
                            {
                                eprintln!("archive upload error: {}", e);
                            }
                            chunk.clear();
                            cur = 0;
                        }
                        chunk.push((id, path));
                        cur += size;
                    }
                    if !chunk.is_empty() {
                        let chunk_clone = chunk.clone();
                        if let Err(e) =
                            create_and_upload_archive(&worker_shared, &source, &chunk_clone).await
                        {
                            eprintln!("archive upload error: {}", e);
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
