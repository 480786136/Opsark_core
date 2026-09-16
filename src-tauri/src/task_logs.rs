use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BinaryHeap, HashMap},
    fs::{create_dir_all, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static CALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static QUERY_SNAPSHOTS: OnceLock<Mutex<QuerySnapshotCache>> = OnceLock::new();
const ROTATE_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_QUERY_LIMIT: usize = 100;
const MAX_QUERY_LIMIT: usize = 200;
// Developer events can legitimately contain sizeable request/response diagnostics. Keep a
// bounded ceiling, but do not silently discard the common multi-hundred-KiB records that the
// writer already accepts.
const MAX_LOG_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CANDIDATE_BYTES: usize = 16 * 1024 * 1024;
const QUERY_SNAPSHOT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_QUERY_SNAPSHOTS: usize = 64;
const MAX_CACHED_SNAPSHOT_FILES: usize = 32 * 1024;
const SNAPSHOT_TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskLogQuery {
    stream: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    operation: Option<String>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskLogQueryResult {
    items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    has_more: bool,
    total: u64,
    malformed_lines: u64,
    oversized_lines: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
struct LogCursor {
    time: i64,
    id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageCursor {
    version: u8,
    snapshot: String,
    position: LogCursor,
}

struct Candidate {
    key: LogCursor,
    bytes: Vec<u8>,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Reverse the natural order so the oldest retained item is evicted first.
        other.key.cmp(&self.key)
    }
}

enum LimitedLine {
    Line(Vec<u8>),
    Oversized,
}

#[derive(Clone)]
struct LogFileSnapshot {
    path: PathBuf,
    bytes: u64,
}

struct CachedQuerySnapshot {
    binding: String,
    files: Vec<LogFileSnapshot>,
    expires_at: Instant,
}

#[derive(Default)]
struct QuerySnapshotCache {
    entries: HashMap<String, CachedQuerySnapshot>,
}

pub(crate) fn call_id() -> String {
    format!(
        "model-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        CALL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn task_directory(task_id: &str) -> String {
    // Fixed safe component, including for Windows reserved names and traversal attempts.
    format!("task-{:x}", Sha256::digest(task_id.as_bytes()))
}

fn write_line(path: &Path, event: &Value) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Missing log parent")?;
    create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut selected = path.to_path_buf();
    let mut part = 0;
    while selected
        .metadata()
        .map(|meta| meta.len() >= ROTATE_BYTES)
        .unwrap_or(false)
    {
        part += 1;
        selected = parent.join(format!(
            "{}-{part}.jsonl",
            path.file_stem().unwrap().to_string_lossy()
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&selected)
        .map_err(|error| error.to_string())?;
    let mut line = serde_json::to_vec(event).map_err(|error| error.to_string())?;
    line.push(b'\n');
    file.write_all(&line)
        .and_then(|_| file.flush())
        .map_err(|error| error.to_string())?;
    Ok(selected)
}

pub(crate) fn append(
    root: &Path,
    stream: &str,
    mut event: Value,
    context: &Value,
) -> Result<(), String> {
    if !["model-calls", "events", "developer-events"].contains(&stream) || !event.is_object() {
        return Err("Invalid log stream or event".into());
    }
    let _guard = WRITE_LOCK.lock().map_err(|_| "Log writer unavailable")?;
    let root = root.join("logs");
    let task_id = context
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let directory = match task_id {
        Some(id) => root.join("tasks").join(task_directory(id)),
        None => root.join("system"),
    };
    for key in [
        "taskId",
        "roundId",
        "stepId",
        "serverId",
        "phaseIndex",
        "requestId",
    ] {
        if let Some(value) = context.get(key).filter(|value| !value.is_null()) {
            event[key] = value.clone();
        }
    }
    // Keep API usage verbatim and expose cache accounting in the lightweight index.
    let usage = event.pointer("/response/usage").cloned();
    let path = write_line(&directory.join(format!("{stream}.jsonl")), &event)?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|error| error.to_string())?
        .to_string_lossy();
    let mut index = json!({"stream":stream, "file":relative, "taskId":task_id});
    for key in [
        "event",
        "callId",
        "requestId",
        "upstreamRequestId",
        "timestampMs",
        "createdAt",
        "requestName",
        "attempt",
        "status",
        "id",
        "roundId",
        "stepId",
        "serverId",
        "serverName",
        "taskTitle",
        "category",
        "level",
        "title",
        "operation",
        "phaseIndex",
        "durationMs",
        "contextMetrics",
    ] {
        if let Some(value) = event.get(key) {
            index[key] = value.clone();
        }
    }
    if let Some(usage) = usage {
        index["usage"] = usage;
    }
    write_line(&root.join("index.jsonl"), &index)?;
    Ok(())
}

pub(crate) fn query(root: &Path, query: TaskLogQuery) -> Result<TaskLogQueryResult, String> {
    if !["model-calls", "events", "developer-events"].contains(&query.stream.as_str()) {
        return Err("Invalid log stream".into());
    }
    let limit = query.limit.unwrap_or(DEFAULT_QUERY_LIMIT);
    if !(1..=MAX_QUERY_LIMIT).contains(&limit) {
        return Err(format!(
            "Log query limit must be between 1 and {MAX_QUERY_LIMIT}"
        ));
    }
    validate_filter_lengths(&query)?;

    let page_cursor = query
        .cursor
        .as_deref()
        .map(decode_page_cursor)
        .transpose()?;
    let from = parse_query_bound(query.from.as_deref(), false)?;
    let to = parse_query_bound(query.to.as_deref(), true)?;
    if matches!((from, to), (Some(from), Some(to)) if from > to) {
        return Err("Log query 'from' must not be later than 'to'".into());
    }

    let log_root = root.join("logs");
    let binding = query_snapshot_binding(root, &query, limit)?;
    let (snapshot_token, cursor, files) = if let Some(cursor) = page_cursor {
        let files = load_query_snapshot(&cursor.snapshot, &binding)?;
        (Some(cursor.snapshot), Some(cursor.position), files)
    } else {
        (
            None,
            None,
            snapshot_log_files(&log_root, &query.stream, query.task_id.as_deref())?,
        )
    };
    let mut state = QueryState {
        query: &query,
        cursor: cursor.as_ref(),
        from,
        to,
        retain: limit + 1,
        candidates: BinaryHeap::with_capacity(limit + 2),
        candidate_bytes: 0,
        total: 0,
        after_cursor: 0,
        malformed_lines: 0,
        oversized_lines: 0,
    };
    for snapshot in &files {
        if let Err(error) = scan_log_file(&log_root, snapshot, &mut state) {
            if let Some(token) = snapshot_token.as_deref() {
                release_query_snapshot(token);
            }
            return Err(error);
        }
    }

    let QueryState {
        candidates,
        total,
        after_cursor,
        malformed_lines,
        oversized_lines,
        ..
    } = state;
    let mut candidates = candidates.into_vec();
    candidates.sort_by(|left, right| right.key.cmp(&left.key));

    let mut items = Vec::with_capacity(limit.min(candidates.len()));
    let mut page_bytes = 0usize;
    let mut last_cursor = None;
    for candidate in candidates.into_iter().take(limit) {
        if !items.is_empty() && page_bytes.saturating_add(candidate.bytes.len()) > MAX_PAGE_BYTES {
            break;
        }
        page_bytes = page_bytes.saturating_add(candidate.bytes.len());
        last_cursor = Some(candidate.key);
        let value = match serde_json::from_slice(&candidate.bytes) {
            Ok(value) => value,
            Err(error) => {
                if let Some(token) = snapshot_token.as_deref() {
                    release_query_snapshot(token);
                }
                return Err(error.to_string());
            }
        };
        items.push(value);
    }
    let has_more = after_cursor > items.len() as u64;
    let next_cursor = if has_more {
        let position = match last_cursor {
            Some(position) => position,
            None => {
                if let Some(token) = snapshot_token.as_deref() {
                    release_query_snapshot(token);
                }
                return Err("Unable to advance log cursor".into());
            }
        };
        let token = match snapshot_token {
            Some(token) => {
                renew_query_snapshot(&token, &binding, &files)?;
                token
            }
            None => store_query_snapshot(&binding, &files)?,
        };
        match encode_page_cursor(&PageCursor {
            version: 1,
            snapshot: token.clone(),
            position,
        }) {
            Ok(cursor) => Some(cursor),
            Err(error) => {
                release_query_snapshot(&token);
                return Err(error);
            }
        }
    } else {
        if let Some(token) = snapshot_token.as_deref() {
            release_query_snapshot(token);
        }
        None
    };
    Ok(TaskLogQueryResult {
        items,
        next_cursor,
        has_more,
        total,
        malformed_lines,
        oversized_lines,
    })
}

struct QueryState<'a> {
    query: &'a TaskLogQuery,
    cursor: Option<&'a LogCursor>,
    from: Option<i64>,
    to: Option<i64>,
    retain: usize,
    candidates: BinaryHeap<Candidate>,
    candidate_bytes: usize,
    total: u64,
    after_cursor: u64,
    malformed_lines: u64,
    oversized_lines: u64,
}

fn validate_filter_lengths(query: &TaskLogQuery) -> Result<(), String> {
    for (name, value, maximum) in [
        ("cursor", query.cursor.as_deref(), 4096usize),
        ("taskId", query.task_id.as_deref(), 4096usize),
        ("serverId", query.server_id.as_deref(), 1024usize),
        ("category", query.category.as_deref(), 256usize),
        ("level", query.level.as_deref(), 256usize),
        ("operation", query.operation.as_deref(), 512usize),
        ("event", query.event.as_deref(), 256usize),
        ("search", query.search.as_deref(), 4096usize),
        ("from", query.from.as_deref(), 128usize),
        ("to", query.to.as_deref(), 128usize),
    ] {
        if value.is_some_and(|value| value.len() > maximum) {
            return Err(format!("Log query field '{name}' is too long"));
        }
    }
    Ok(())
}

fn scan_log_file(
    log_root: &Path,
    snapshot: &LogFileSnapshot,
    state: &mut QueryState<'_>,
) -> Result<(), String> {
    validate_snapshot_file(log_root, snapshot)?;
    let file = File::open(&snapshot.path).map_err(|error| error.to_string())?;
    let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !opened_metadata.is_file() || opened_metadata.len() < snapshot.bytes {
        return Err("Log snapshot file changed while it was being read".into());
    }
    let relative = snapshot
        .path
        .strip_prefix(log_root)
        .map_err(|_| "Log file escaped the configured root".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    // The length was captured while holding WRITE_LOCK. Reading exactly that prefix gives the
    // query a complete-line snapshot without keeping writers blocked during a historical scan.
    let mut reader = BufReader::new(file.take(snapshot.bytes));
    let mut line_number = 0u64;
    while let Some(line) =
        read_limited_line(&mut reader, MAX_LOG_LINE_BYTES).map_err(|error| error.to_string())?
    {
        line_number = line_number.saturating_add(1);
        let mut bytes = match line {
            LimitedLine::Line(bytes) => bytes,
            LimitedLine::Oversized => {
                state.oversized_lines = state.oversized_lines.saturating_add(1);
                continue;
            }
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(Value::Object(object)) => Value::Object(object),
            Ok(_) | Err(_) => {
                state.malformed_lines = state.malformed_lines.saturating_add(1);
                continue;
            }
        };
        let timestamp = event_timestamp(&value);
        let projected = (state.query.stream == "model-calls")
            .then(|| project_model_call_metadata(&value, &relative, line_number, timestamp));
        let searchable = projected.as_ref().unwrap_or(&value);
        if !matches_filters(&value, searchable, timestamp, state) {
            continue;
        }
        state.total = state.total.saturating_add(1);
        let key = LogCursor {
            time: timestamp,
            id: event_sort_id(&value, &relative, line_number),
        };
        if state.cursor.is_some_and(|cursor| key >= *cursor) {
            continue;
        }
        state.after_cursor = state.after_cursor.saturating_add(1);
        let candidate_bytes = if let Some(projected) = projected {
            serde_json::to_vec(&projected).map_err(|error| error.to_string())?
        } else {
            drop(value);
            bytes.shrink_to_fit();
            bytes
        };
        retain_candidate(
            &mut state.candidates,
            &mut state.candidate_bytes,
            state.retain,
            MAX_CANDIDATE_BYTES,
            Candidate {
                key,
                bytes: candidate_bytes,
            },
        );
    }
    Ok(())
}

fn validate_snapshot_file(log_root: &Path, snapshot: &LogFileSnapshot) -> Result<(), String> {
    let relative = snapshot
        .path
        .strip_prefix(log_root)
        .map_err(|_| "Log snapshot escaped the configured root".to_string())?;
    let root_metadata = std::fs::symlink_metadata(log_root).map_err(|error| error.to_string())?;
    if !root_metadata.file_type().is_dir() || root_metadata.file_type().is_symlink() {
        return Err("Configured log root is not a plain directory".into());
    }

    let mut current = log_root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(component) = component else {
            return Err("Log snapshot contains an invalid path".into());
        };
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if components.peek().is_some() {
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err("Log snapshot directory is not a plain directory".into());
            }
        } else if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Log snapshot contains an invalid file".into());
        } else if metadata.len() < snapshot.bytes {
            return Err("Log snapshot file was truncated".into());
        }
    }
    Ok(())
}

fn retain_candidate(
    candidates: &mut BinaryHeap<Candidate>,
    candidate_bytes: &mut usize,
    maximum_items: usize,
    maximum_bytes: usize,
    candidate: Candidate,
) {
    *candidate_bytes = candidate_bytes.saturating_add(candidate.bytes.len());
    candidates.push(candidate);
    while candidates.len() > maximum_items || *candidate_bytes > maximum_bytes {
        let Some(evicted) = candidates.pop() else {
            *candidate_bytes = 0;
            break;
        };
        *candidate_bytes = candidate_bytes.saturating_sub(evicted.bytes.len());
    }
}

impl QuerySnapshotCache {
    fn purge_expired(&mut self, now: Instant) {
        self.entries.retain(|_, snapshot| snapshot.expires_at > now);
    }

    fn cached_file_count(&self) -> usize {
        self.entries
            .values()
            .map(|snapshot| snapshot.files.len())
            .sum()
    }

    fn evict_oldest(&mut self) -> bool {
        let token = self
            .entries
            .iter()
            .min_by_key(|(_, snapshot)| snapshot.expires_at)
            .map(|(token, _)| token.clone());
        token
            .and_then(|token| self.entries.remove(&token))
            .is_some()
    }

    fn make_room(&mut self, added_files: usize) -> Result<(), String> {
        while self.entries.len() >= MAX_QUERY_SNAPSHOTS
            || self.cached_file_count().saturating_add(added_files) > MAX_CACHED_SNAPSHOT_FILES
        {
            if !self.evict_oldest() {
                return Err("Log query snapshot cache is full".into());
            }
        }
        Ok(())
    }
}

fn query_snapshot_cache() -> &'static Mutex<QuerySnapshotCache> {
    QUERY_SNAPSHOTS.get_or_init(|| Mutex::new(QuerySnapshotCache::default()))
}

fn store_query_snapshot(binding: &str, files: &[LogFileSnapshot]) -> Result<String, String> {
    if files.len() > MAX_CACHED_SNAPSHOT_FILES {
        return Err("Log query spans too many files to paginate safely".into());
    }
    let now = Instant::now();
    let mut cache = query_snapshot_cache()
        .lock()
        .map_err(|_| "Log query snapshot cache unavailable")?;
    cache.purge_expired(now);
    cache.make_room(files.len())?;

    let token = loop {
        let token = new_snapshot_token(binding);
        if !cache.entries.contains_key(&token) {
            break token;
        }
    };
    cache.entries.insert(
        token.clone(),
        CachedQuerySnapshot {
            binding: binding.to_owned(),
            files: files.to_vec(),
            expires_at: now + QUERY_SNAPSHOT_TTL,
        },
    );
    Ok(token)
}

fn load_query_snapshot(token: &str, binding: &str) -> Result<Vec<LogFileSnapshot>, String> {
    if !is_snapshot_token(token) {
        return Err("Invalid log cursor".into());
    }
    let now = Instant::now();
    let mut cache = query_snapshot_cache()
        .lock()
        .map_err(|_| "Log query snapshot cache unavailable")?;
    cache.purge_expired(now);
    let snapshot = cache
        .entries
        .get_mut(token)
        .ok_or("Invalid or expired log cursor")?;
    if snapshot.binding != binding {
        return Err("Log cursor does not match the current query".into());
    }
    snapshot.expires_at = now + QUERY_SNAPSHOT_TTL;
    Ok(snapshot.files.clone())
}

fn renew_query_snapshot(
    token: &str,
    binding: &str,
    files: &[LogFileSnapshot],
) -> Result<(), String> {
    if !is_snapshot_token(token) || files.len() > MAX_CACHED_SNAPSHOT_FILES {
        return Err("Invalid or expired log cursor".into());
    }
    let now = Instant::now();
    let mut cache = query_snapshot_cache()
        .lock()
        .map_err(|_| "Log query snapshot cache unavailable")?;
    cache.purge_expired(now);
    if let Some(snapshot) = cache.entries.get_mut(token) {
        if snapshot.binding != binding {
            return Err("Log cursor does not match the current query".into());
        }
        snapshot.expires_at = now + QUERY_SNAPSHOT_TTL;
        return Ok(());
    }

    cache.make_room(files.len())?;
    cache.entries.insert(
        token.to_owned(),
        CachedQuerySnapshot {
            binding: binding.to_owned(),
            files: files.to_vec(),
            expires_at: now + QUERY_SNAPSHOT_TTL,
        },
    );
    Ok(())
}

fn release_query_snapshot(token: &str) {
    if let Ok(mut cache) = query_snapshot_cache().lock() {
        cache.entries.remove(token);
    }
}

fn new_snapshot_token(binding: &str) -> String {
    let sequence = SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    encode_hex(&Sha256::digest(
        format!("{binding}\0{}\0{now}\0{sequence}", std::process::id()).as_bytes(),
    ))
}

fn query_snapshot_binding(
    root: &Path,
    query: &TaskLogQuery,
    limit: usize,
) -> Result<String, String> {
    let root = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(root)
    };
    let value = json!({
        "version": 1,
        "root": root.to_string_lossy(),
        "stream": query.stream,
        "limit": limit,
        "taskId": query.task_id,
        "serverId": query.server_id,
        "category": query.category,
        "level": query.level,
        "operation": query.operation,
        "event": query.event,
        "search": query.search,
        "from": query.from,
        "to": query.to,
    });
    let serialized = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(encode_hex(&Sha256::digest(serialized)))
}

fn encode_page_cursor(cursor: &PageCursor) -> Result<String, String> {
    serde_json::to_vec(cursor)
        .map(|value| encode_hex(&value))
        .map_err(|error| error.to_string())
}

fn decode_page_cursor(value: &str) -> Result<PageCursor, String> {
    let decoded = decode_hex(value).ok_or("Invalid log cursor")?;
    let cursor: PageCursor =
        serde_json::from_slice(&decoded).map_err(|_| "Invalid log cursor".to_string())?;
    if cursor.version != 1 || !is_snapshot_token(&cursor.snapshot) {
        return Err("Invalid log cursor".into());
    }
    Ok(cursor)
}

fn is_snapshot_token(token: &str) -> bool {
    token.len() == SNAPSHOT_TOKEN_BYTES * 2 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Some((hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?))
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn snapshot_log_files(
    log_root: &Path,
    stream: &str,
    task_id: Option<&str>,
) -> Result<Vec<LogFileSnapshot>, String> {
    snapshot_log_files_with_limits(
        log_root,
        stream,
        task_id,
        MAX_CACHED_SNAPSHOT_FILES,
        MAX_CACHED_SNAPSHOT_FILES,
    )
}

fn snapshot_log_files_with_limits(
    log_root: &Path,
    stream: &str,
    task_id: Option<&str>,
    maximum_directories: usize,
    maximum_files: usize,
) -> Result<Vec<LogFileSnapshot>, String> {
    // append() holds the same lock through both its stream and index writes. Capturing file names
    // and lengths under the lock ensures no snapshot ends in the middle of one of those writes.
    let _guard = WRITE_LOCK.lock().map_err(|_| "Log writer unavailable")?;
    if !log_root.exists() {
        return Ok(Vec::new());
    }
    let metadata = std::fs::symlink_metadata(log_root).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("Configured log root is not a directory".into());
    }

    let mut directories = Vec::new();
    if let Some(task_id) = task_id.filter(|value| !value.is_empty()) {
        let directory = log_root.join("tasks").join(task_directory(task_id));
        if is_plain_directory(&directory)? {
            push_bounded_scan_target(
                &mut directories,
                directory,
                maximum_directories,
                "directories",
            )?;
        }
    } else {
        let system = log_root.join("system");
        if is_plain_directory(&system)? {
            push_bounded_scan_target(&mut directories, system, maximum_directories, "directories")?;
        }
        let tasks = log_root.join("tasks");
        if is_plain_directory(&tasks)? {
            for entry in std::fs::read_dir(&tasks).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                let file_type = entry.file_type().map_err(|error| error.to_string())?;
                if is_task_directory_name(&name.to_string_lossy())
                    && file_type.is_dir()
                    && !file_type.is_symlink()
                {
                    push_bounded_scan_target(
                        &mut directories,
                        entry.path(),
                        maximum_directories,
                        "directories",
                    )?;
                }
            }
        }
    }

    let mut files = Vec::new();
    for directory in directories {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_file()
                && !file_type.is_symlink()
                && is_stream_file_name(&entry.file_name().to_string_lossy(), stream)
            {
                // Check the bound before looking up metadata for the next matching file. This
                // keeps first-page enumeration fail-fast even if an attacker creates many valid
                // rotated parts.
                if files.len() >= maximum_files {
                    return Err(scan_target_limit_error("files", maximum_files));
                }
                let path = entry.path();
                let metadata =
                    std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                    return Err("Log snapshot contains an invalid file".into());
                }
                files.push(LogFileSnapshot {
                    path,
                    bytes: metadata.len(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn push_bounded_scan_target<T>(
    targets: &mut Vec<T>,
    target: T,
    maximum: usize,
    kind: &str,
) -> Result<(), String> {
    if targets.len() >= maximum {
        return Err(scan_target_limit_error(kind, maximum));
    }
    targets.push(target);
    Ok(())
}

fn scan_target_limit_error(kind: &str, maximum: usize) -> String {
    format!("Log query spans too many {kind} to scan safely (maximum {maximum})")
}

fn is_plain_directory(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_dir() && !metadata.file_type().is_symlink()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn is_task_directory_name(name: &str) -> bool {
    name.len() == 69
        && name.starts_with("task-")
        && name[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_stream_file_name(name: &str, stream: &str) -> bool {
    if name == format!("{stream}.jsonl") {
        return true;
    }
    name.strip_prefix(stream)
        .and_then(|value| value.strip_prefix('-'))
        .and_then(|value| value.strip_suffix(".jsonl"))
        .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn read_limited_line<R: BufRead>(
    reader: &mut R,
    maximum: usize,
) -> io::Result<Option<LimitedLine>> {
    let mut bytes = Vec::new();
    let mut saw_bytes = false;
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if !saw_bytes {
                return Ok(None);
            }
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(if oversized {
                LimitedLine::Oversized
            } else {
                LimitedLine::Line(bytes)
            }));
        }
        saw_bytes = true;
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content_length = newline.unwrap_or(buffer.len());
        if !oversized {
            if bytes.len().saturating_add(content_length) > maximum {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&buffer[..content_length]);
            }
        }
        let consumed = content_length + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(Some(if oversized {
                LimitedLine::Oversized
            } else {
                LimitedLine::Line(bytes)
            }));
        }
    }
}

fn matches_filters(
    value: &Value,
    searchable: &Value,
    timestamp: i64,
    state: &QueryState<'_>,
) -> bool {
    if state.from.is_some_and(|from| timestamp < from) || state.to.is_some_and(|to| timestamp > to)
    {
        return false;
    }
    if !matches_string_field(value, "serverId", state.query.server_id.as_deref(), false)
        || !matches_string_field(value, "category", state.query.category.as_deref(), true)
        || !matches_string_field(value, "level", state.query.level.as_deref(), true)
        || !matches_string_field(value, "operation", state.query.operation.as_deref(), false)
        || !matches_string_field(searchable, "event", state.query.event.as_deref(), true)
    {
        return false;
    }
    let Some(search) = state
        .query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    serde_json::to_string(searchable)
        .map(|serialized| serialized.to_lowercase().contains(&search.to_lowercase()))
        .unwrap_or(false)
}

fn project_model_call_metadata(
    value: &Value,
    relative_path: &str,
    line_number: u64,
    timestamp: i64,
) -> Value {
    let mut projected = serde_json::Map::new();
    projected.insert(
        "recordId".into(),
        json!(format!(
            "model-call-{}",
            log_record_location(relative_path, line_number)
        )),
    );
    projected.insert("timestampMs".into(), json!(timestamp));

    let event = value
        .get("event")
        .and_then(Value::as_str)
        .filter(|event| {
            matches!(
                *event,
                "request_sent" | "response_received" | "request_failed" | "response_failed"
            )
        })
        .unwrap_or("unknown");
    projected.insert("event".into(), json!(event));

    for (field, maximum_chars) in [
        ("callId", 512usize),
        ("requestId", 512),
        ("upstreamRequestId", 512),
        ("requestName", 512),
        ("taskId", 4096),
        ("serverId", 1024),
        ("roundId", 1024),
        ("stepId", 1024),
        ("contentType", 256),
        ("contentEncoding", 256),
    ] {
        if let Some(field_value) = bounded_string_field(value, field, maximum_chars) {
            projected.insert(field.into(), json!(field_value));
        }
    }
    for field in [
        "attempt",
        "status",
        "durationMs",
        "timeoutSeconds",
        "contentLength",
        "phaseIndex",
    ] {
        if let Some(field_value) = value.get(field).filter(|value| value.is_number()) {
            projected.insert(field.into(), field_value.clone());
        }
    }

    if let Some(model_name) = value
        .pointer("/request/model")
        .or_else(|| value.pointer("/response/model"))
        .and_then(Value::as_str)
    {
        projected.insert("modelName".into(), json!(bounded_string(model_name, 512)));
    }
    if let Some(metrics) = project_context_metrics(value.get("contextMetrics")) {
        projected.insert("contextMetrics".into(), metrics);
    }
    if let Some(usage) = project_token_usage(value.pointer("/response/usage")) {
        projected.insert("tokenUsage".into(), usage);
    }

    Value::Object(projected)
}

fn project_context_metrics(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let mut projected = serde_json::Map::new();
    for field in ["requestBytes", "estimatedInputTokens", "stablePrefixBytes"] {
        if let Some(field_value) = value.get(field).filter(|value| value.is_number()) {
            projected.insert(field.into(), field_value.clone());
        }
    }
    if let Some(fingerprint) = value.get("stablePrefixFingerprint").and_then(Value::as_str) {
        projected.insert(
            "stablePrefixFingerprint".into(),
            json!(bounded_string(fingerprint, 256)),
        );
    }
    if let Some(sections) = value.get("sections").and_then(Value::as_array) {
        let sections: Vec<Value> = sections
            .iter()
            .filter_map(|section| {
                let section = section.as_object()?;
                let mut item = serde_json::Map::new();
                for field in ["messageIndex", "characters", "utf8Bytes"] {
                    if let Some(field_value) = section.get(field).filter(|value| value.is_number())
                    {
                        item.insert(field.into(), field_value.clone());
                    }
                }
                if let Some(role) = section.get("role").and_then(Value::as_str) {
                    item.insert("role".into(), json!(bounded_string(role, 64)));
                }
                (!item.is_empty()).then_some(Value::Object(item))
            })
            .collect();
        if !sections.is_empty() {
            projected.insert("sections".into(), Value::Array(sections));
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

fn project_token_usage(value: Option<&Value>) -> Option<Value> {
    let usage = value?.as_object()?;
    let input = first_u64(
        usage,
        &["prompt_tokens", "input_tokens", "promptTokenCount"],
    );
    let output = first_u64(
        usage,
        &["completion_tokens", "output_tokens", "candidatesTokenCount"],
    );
    let reported_total = first_u64(usage, &["total_tokens", "totalTokenCount"]);
    let cache_hit = first_u64(
        usage,
        &["prompt_cache_hit_tokens", "cache_read_input_tokens"],
    )
    .or_else(|| {
        usage
            .get("prompt_tokens_details")
            .and_then(Value::as_object)
            .and_then(|details| first_u64(details, &["cached_tokens"]))
    });
    let cache_miss = first_u64(
        usage,
        &["prompt_cache_miss_tokens", "cache_creation_input_tokens"],
    )
    .or_else(|| {
        usage
            .get("prompt_tokens_details")
            .and_then(Value::as_object)
            .and_then(|details| first_u64(details, &["cache_creation_input_tokens"]))
    });
    if input.is_none()
        && output.is_none()
        && reported_total.is_none()
        && cache_hit.is_none()
        && cache_miss.is_none()
    {
        return None;
    }

    let input = input.unwrap_or(0);
    let output = output.unwrap_or(0);
    let total = reported_total.unwrap_or_else(|| input.saturating_add(output));
    let mut projected = serde_json::Map::from_iter([
        ("input".into(), json!(input)),
        ("output".into(), json!(output)),
        ("total".into(), json!(total)),
        ("source".into(), json!("api")),
    ]);
    if let Some(cache_hit) = cache_hit {
        projected.insert("cacheHit".into(), json!(cache_hit));
    }
    if let Some(cache_miss) = cache_miss {
        projected.insert("cacheMiss".into(), json!(cache_miss));
    }
    Some(Value::Object(projected))
}

fn first_u64(object: &serde_json::Map<String, Value>, fields: &[&str]) -> Option<u64> {
    fields
        .iter()
        .find_map(|field| object.get(*field).and_then(Value::as_u64))
}

fn bounded_string_field(value: &Value, field: &str, maximum_chars: usize) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(|value| bounded_string(value, maximum_chars))
}

fn bounded_string(value: &str, maximum_chars: usize) -> String {
    value.chars().take(maximum_chars).collect()
}

fn matches_string_field(
    value: &Value,
    field: &str,
    expected: Option<&str>,
    ignore_ascii_case: bool,
) -> bool {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let Some(actual) = value.get(field).and_then(Value::as_str) else {
        return false;
    };
    if ignore_ascii_case {
        actual.eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

fn event_sort_id(value: &Value, relative_path: &str, line_number: u64) -> String {
    let identifier = ["id", "callId", "requestId", "upstreamRequestId"]
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .filter(|value| !value.is_empty());
    let location = log_record_location(relative_path, line_number);
    match identifier {
        Some(identifier) if identifier.chars().count() <= 128 => {
            format!("{identifier}\u{0}{location}")
        }
        Some(identifier) => {
            let prefix: String = identifier.chars().take(128).collect();
            format!(
                "{prefix}#{:x}\u{0}{location}",
                Sha256::digest(identifier.as_bytes())
            )
        }
        None => format!("synthetic-{location}"),
    }
}

fn log_record_location(relative_path: &str, line_number: u64) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{relative_path}\u{0}{line_number}").as_bytes())
    )
}

fn event_timestamp(value: &Value) -> i64 {
    value
        .get("createdAt")
        .and_then(parse_timestamp_value)
        .or_else(|| value.get("timestampMs").and_then(parse_timestamp_value))
        .unwrap_or(0)
}

fn parse_timestamp_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| {
                number.as_f64().and_then(|value| {
                    (value.is_finite() && value >= i64::MIN as f64 && value <= i64::MAX as f64)
                        .then_some(value as i64)
                })
            }),
        Value::String(value) => value
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| parse_rfc3339_millis(value, false)),
        _ => None,
    }
}

fn parse_query_bound(value: Option<&str>, end_of_day: bool) -> Result<Option<i64>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    value
        .parse::<i64>()
        .ok()
        .or_else(|| parse_rfc3339_millis(value, end_of_day))
        .map(Some)
        .ok_or_else(|| format!("Invalid log query timestamp: {value}"))
}

fn parse_rfc3339_millis(value: &str, end_of_day: bool) -> Option<i64> {
    let value = value.trim();
    if value.len() == 10 {
        let (year, month, day) = parse_date(value.as_bytes())?;
        let base = days_from_civil(year, month, day)?.checked_mul(86_400_000)?;
        return base.checked_add(if end_of_day { 86_399_999 } else { 0 });
    }
    let bytes = value.as_bytes();
    if bytes.len() < 19 || !matches!(bytes.get(10), Some(b'T' | b' ')) {
        return None;
    }
    let (year, month, day) = parse_date(&bytes[..10])?;
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let hour = parse_digits(bytes, 11, 2)?;
    let minute = parse_digits(bytes, 14, 2)?;
    let second = parse_digits(bytes, 17, 2)?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let mut index = 19usize;
    let mut milliseconds = 0i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return None;
        }
        for offset in 0..3 {
            milliseconds *= 10;
            if let Some(byte) = bytes
                .get(fraction_start + offset)
                .filter(|byte| byte.is_ascii_digit())
            {
                milliseconds += i64::from(*byte - b'0');
            }
        }
    }

    let offset_seconds = match bytes.get(index) {
        None => 0i64,
        Some(b'Z' | b'z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) if index + 6 == bytes.len() => {
            if bytes.get(index + 3) != Some(&b':') {
                return None;
            }
            let hours = parse_digits(bytes, index + 1, 2)?;
            let minutes = parse_digits(bytes, index + 4, 2)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = i64::from(hours * 3600 + minutes * 60);
            if *sign == b'+' {
                offset
            } else {
                -offset
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day)?;
    let local_seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour * 3600 + minute * 60 + second))?;
    local_seconds
        .checked_sub(offset_seconds)?
        .checked_mul(1000)?
        .checked_add(milliseconds)
}

fn parse_date(bytes: &[u8]) -> Option<(i64, u32, u32)> {
    if bytes.len() != 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let year = i64::from(parse_digits(bytes, 0, 4)?);
    let month = parse_digits(bytes, 5, 2)?;
    let day = parse_digits(bytes, 8, 2)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (day >= 1 && day <= maximum_day).then_some((year, month, day))
}

fn parse_digits(bytes: &[u8], start: usize, count: usize) -> Option<u32> {
    let end = start.checked_add(count)?;
    let mut result = 0u32;
    for byte in bytes.get(start..end)? {
        if !byte.is_ascii_digit() {
            return None;
        }
        result = result
            .checked_mul(10)?
            .checked_add(u32::from(*byte - b'0'))?;
    }
    Some(result)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_query(task_id: Option<&str>, limit: usize) -> TaskLogQuery {
        TaskLogQuery {
            stream: "events".into(),
            cursor: None,
            limit: Some(limit),
            task_id: task_id.map(str::to_string),
            server_id: None,
            category: None,
            level: None,
            operation: None,
            event: None,
            search: None,
            from: None,
            to: None,
        }
    }

    #[test]
    fn separates_tasks_and_system_without_duplicate_payloads_in_index() {
        let root = std::env::temp_dir().join(call_id());
        for id in ["../escape", "CON", "normal"] {
            append(
                &root,
                "model-calls",
                json!({"callId":id,"request":{"content":"large payload"}}),
                &json!({"taskId":id}),
            )
            .unwrap();
            assert!(root
                .join("logs/tasks")
                .join(task_directory(id))
                .join("model-calls.jsonl")
                .exists());
        }
        append(
            &root,
            "events",
            json!({
                "title":"system",
                "serverName":"production",
                "taskTitle":"inspection",
                "category":"ssh",
                "level":"info",
                "operation":"connect"
            }),
            &json!({"serverId":"server-1"}),
        )
        .unwrap();
        append(
            &root,
            "model-calls",
            json!({"event":"response_received","upstreamRequestId":"admin-request-1"}),
            &json!({"taskId":"normal"}),
        )
        .unwrap();
        let index = std::fs::read_to_string(root.join("logs/index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 5);
        assert!(!index.contains("large payload"));
        assert!(index.contains("admin-request-1"));
        for expected in [
            "server-1",
            "production",
            "inspection",
            "ssh",
            "info",
            "system",
            "connect",
        ] {
            assert!(index.contains(expected));
        }
        assert!(root.join("logs/system/events.jsonl").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn queries_newest_first_with_stable_cursor_pagination() {
        let root = std::env::temp_dir().join(call_id());
        for (id, timestamp) in [("old", 1000), ("new", 3000), ("middle", 2000)] {
            append(
                &root,
                "events",
                json!({"id":id,"timestampMs":timestamp,"title":id}),
                &json!({"taskId":"task-a"}),
            )
            .unwrap();
        }

        let first = query(&root, event_query(Some("task-a"), 2)).unwrap();
        assert_eq!(first.total, 3);
        assert!(first.has_more);
        assert_eq!(first.items[0]["id"], "new");
        assert_eq!(first.items[1]["id"], "middle");
        let cursor = first.next_cursor.clone().unwrap();
        append(
            &root,
            "events",
            json!({"id":"appended-after-first-page","timestampMs":4000}),
            &json!({"taskId":"task-a"}),
        )
        .unwrap();

        let mut second_query = event_query(Some("task-a"), 2);
        second_query.cursor = Some(cursor.clone());
        let second = query(&root, second_query).unwrap();
        assert_eq!(second.total, 3);
        assert!(!second.has_more);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0]["id"], "old");
        assert!(second.next_cursor.is_none());

        let fresh = query(&root, event_query(Some("task-a"), 10)).unwrap();
        assert_eq!(fresh.total, 4);
        assert_eq!(fresh.items[0]["id"], "appended-after-first-page");

        let mut replay = event_query(Some("task-a"), 2);
        replay.cursor = Some(cursor);
        assert!(query(&root, replay).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_invalid_and_cross_filter_snapshot_cursors() {
        let root = std::env::temp_dir().join(call_id());
        for (id, timestamp) in [("one", 1000), ("two", 2000)] {
            append(
                &root,
                "events",
                json!({"id":id,"timestampMs":timestamp,"level":"info"}),
                &json!({"taskId":"task-bound-cursor"}),
            )
            .unwrap();
        }

        let mut original = event_query(Some("task-bound-cursor"), 1);
        original.level = Some("info".into());
        let first = query(&root, original.clone()).unwrap();
        let cursor = first.next_cursor.unwrap();

        let mut decoded = decode_page_cursor(&cursor).unwrap();
        decoded.snapshot = "0".repeat(SNAPSHOT_TOKEN_BYTES * 2);
        let mut unknown_token = original.clone();
        unknown_token.cursor = Some(encode_page_cursor(&decoded).unwrap());
        assert!(query(&root, unknown_token)
            .unwrap_err()
            .contains("Invalid or expired"));

        let mut wrong_filter = original.clone();
        wrong_filter.level = Some("warn".into());
        wrong_filter.cursor = Some(cursor.clone());
        assert!(query(&root, wrong_filter)
            .unwrap_err()
            .contains("does not match"));

        original.cursor = Some(cursor);
        let second = query(&root, original).unwrap();
        assert_eq!(second.total, 2);
        assert_eq!(second.items.len(), 1);
        assert!(!second.has_more);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn returns_large_developer_events_that_exceeded_the_legacy_limit() {
        let root = std::env::temp_dir().join(call_id());
        let detail = "diagnostic".repeat(80 * 1024);
        assert!(detail.len() > 512 * 1024);
        append(
            &root,
            "developer-events",
            json!({
                "id":"large-developer-event",
                "timestampMs":2000,
                "detail":detail
            }),
            &json!({"taskId":"task-large"}),
        )
        .unwrap();

        let mut developer_query = event_query(Some("task-large"), 10);
        developer_query.stream = "developer-events".into();
        let result = query(&root, developer_query).unwrap();
        assert_eq!(result.oversized_lines, 0);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0]["id"], "large-developer-event");
        assert_eq!(
            result.items[0]["detail"].as_str().unwrap().len(),
            detail.len()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn candidate_retention_has_a_total_payload_byte_limit() {
        let mut candidates = BinaryHeap::new();
        let mut candidate_bytes = 0;
        for (time, bytes) in [(1, 6), (3, 6), (2, 4)] {
            retain_candidate(
                &mut candidates,
                &mut candidate_bytes,
                10,
                10,
                Candidate {
                    key: LogCursor {
                        time,
                        id: time.to_string(),
                    },
                    bytes: vec![b'x'; bytes],
                },
            );
        }

        assert_eq!(candidate_bytes, 10);
        assert_eq!(
            candidates
                .into_iter()
                .map(|candidate| candidate.key.time)
                .collect::<std::collections::BTreeSet<_>>(),
            [2, 3].into_iter().collect()
        );
    }

    #[test]
    fn file_length_snapshot_excludes_later_appends_without_blocking_writers() {
        let root = std::env::temp_dir().join(call_id());
        append(
            &root,
            "events",
            json!({"id":"before-snapshot","timestampMs":1000}),
            &json!({"taskId":"task-snapshot"}),
        )
        .unwrap();
        let log_root = root.join("logs");
        let snapshots = snapshot_log_files(&log_root, "events", Some("task-snapshot")).unwrap();
        append(
            &root,
            "events",
            json!({"id":"after-snapshot","timestampMs":2000}),
            &json!({"taskId":"task-snapshot"}),
        )
        .unwrap();

        let query = event_query(Some("task-snapshot"), 10);
        let mut state = QueryState {
            query: &query,
            cursor: None,
            from: None,
            to: None,
            retain: 11,
            candidates: BinaryHeap::new(),
            candidate_bytes: 0,
            total: 0,
            after_cursor: 0,
            malformed_lines: 0,
            oversized_lines: 0,
        };
        for snapshot in snapshots {
            scan_log_file(&log_root, &snapshot, &mut state).unwrap();
        }

        assert_eq!(state.total, 1);
        let only = state.candidates.pop().unwrap();
        let value: Value = serde_json::from_slice(&only.bytes).unwrap();
        assert_eq!(value["id"], "before-snapshot");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn snapshot_enumeration_fails_fast_when_directory_limit_is_exceeded() {
        let root = std::env::temp_dir().join(call_id());
        let log_root = root.join("logs");
        for task_id in ["task-limit-a", "task-limit-b", "task-limit-c"] {
            std::fs::create_dir_all(log_root.join("tasks").join(task_directory(task_id))).unwrap();
        }

        let error = snapshot_log_files_with_limits(&log_root, "events", None, 2, 10)
            .err()
            .expect("the third valid task directory must exceed the test limit");
        assert_eq!(
            error,
            "Log query spans too many directories to scan safely (maximum 2)"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn snapshot_enumeration_fails_fast_when_file_limit_is_exceeded() {
        let root = std::env::temp_dir().join(call_id());
        let system = root.join("logs/system");
        std::fs::create_dir_all(&system).unwrap();
        for name in ["events.jsonl", "events-1.jsonl", "events-2.jsonl"] {
            File::create(system.join(name)).unwrap();
        }

        let error = snapshot_log_files_with_limits(&root.join("logs"), "events", None, 2, 2)
            .err()
            .expect("the third valid rotated file must exceed the test limit");
        assert_eq!(
            error,
            "Log query spans too many files to scan safely (maximum 2)"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn renew_restores_a_snapshot_evicted_while_a_page_is_scanning() {
        let root = std::env::temp_dir().join(call_id());
        append(
            &root,
            "events",
            json!({"id":"snapshot-record","timestampMs":1000}),
            &json!({"taskId":"task-renew-snapshot"}),
        )
        .unwrap();
        let files =
            snapshot_log_files(&root.join("logs"), "events", Some("task-renew-snapshot")).unwrap();
        let binding = "test-renew-binding";
        let token = store_query_snapshot(binding, &files).unwrap();

        release_query_snapshot(&token);
        renew_query_snapshot(&token, binding, &files).unwrap();
        let restored = load_query_snapshot(&token, binding).unwrap();
        assert_eq!(restored.len(), files.len());

        release_query_snapshot(&token);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn filters_detail_records_by_metadata_search_and_time() {
        let root = std::env::temp_dir().join(call_id());
        append(
            &root,
            "events",
            json!({
                "id":"match",
                "createdAt":"2026-09-16T08:30:00+08:00",
                "category":"SSH",
                "level":"WARN",
                "operation":"ssh.exec",
                "title":"Needle found"
            }),
            &json!({"taskId":"task-filter","serverId":"server-1"}),
        )
        .unwrap();
        append(
            &root,
            "events",
            json!({
                "id":"other",
                "createdAt":"2026-09-17T00:00:00Z",
                "category":"agent",
                "level":"info",
                "operation":"agent.plan",
                "title":"unrelated"
            }),
            &json!({"taskId":"task-filter","serverId":"server-2"}),
        )
        .unwrap();

        let mut filtered = event_query(Some("task-filter"), 20);
        filtered.server_id = Some("server-1".into());
        filtered.category = Some("ssh".into());
        filtered.level = Some("warn".into());
        filtered.operation = Some("ssh.exec".into());
        filtered.search = Some("needle".into());
        filtered.from = Some("2026-09-16".into());
        filtered.to = Some("2026-09-16".into());
        let result = query(&root, filtered).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0]["id"], "match");

        let mut wrong_operation = event_query(Some("task-filter"), 20);
        wrong_operation.operation = Some("SSH.EXEC".into());
        assert_eq!(query(&root, wrong_operation).unwrap().total, 0);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn model_call_queries_return_only_safe_unique_metadata_and_search_it() {
        let root = std::env::temp_dir().join(call_id());
        let secret = "SENTINEL_PROMPT_RESPONSE_ERROR_MUST_NOT_LEAK";
        let context = json!({
            "taskId":"task-model-metadata",
            "serverId":"server-model-metadata",
            "roundId":"round-1",
            "stepId":"step-1",
            "phaseIndex":2
        });
        append(
            &root,
            "model-calls",
            json!({
                "event":"request_sent",
                "callId":"shared-call-id",
                "requestId":"request-group-id",
                "requestName":"Requirement processing",
                "attempt":1,
                "timestampMs":1000,
                "timeoutSeconds":120,
                "request":{"model":"safe-model-name","messages":[{"role":"user","content":secret}]},
                "contextMetrics":{
                    "requestBytes":1234,
                    "estimatedInputTokens":412,
                    "stablePrefixBytes":100,
                    "stablePrefixFingerprint":"abc123",
                    "sections":[{"messageIndex":0,"role":"user","characters":50,"utf8Bytes":50,"content":secret}]
                }
            }),
            &context,
        )
        .unwrap();
        append(
            &root,
            "model-calls",
            json!({
                "event":"response_received",
                "callId":"shared-call-id",
                "requestId":"request-group-id",
                "upstreamRequestId":"upstream-safe-id",
                "requestName":"Requirement processing",
                "attempt":1,
                "timestampMs":2000,
                "status":200,
                "durationMs":84,
                "contentType":"application/json",
                "contentLength":2048,
                "response":{
                    "model":"safe-response-model",
                    "choices":[{"message":{"content":secret}}],
                    "usage":{
                        "prompt_tokens":10,
                        "completion_tokens":5,
                        "total_tokens":15,
                        "prompt_cache_hit_tokens":4,
                        "prompt_cache_miss_tokens":6,
                        "provider_note":secret
                    }
                }
            }),
            &context,
        )
        .unwrap();
        append(
            &root,
            "model-calls",
            json!({
                "event":"response_failed",
                "callId":"failed-call-id",
                "requestName":"Summary generation",
                "attempt":2,
                "timestampMs":3000,
                "status":502,
                "responseText":secret,
                "error":secret
            }),
            &context,
        )
        .unwrap();

        let mut model_query = event_query(Some("task-model-metadata"), 20);
        model_query.stream = "model-calls".into();
        let result = query(&root, model_query.clone()).unwrap();
        assert_eq!(result.total, 3);
        let serialized = serde_json::to_string(&result.items).unwrap();
        assert!(!serialized.contains(secret));
        for item in &result.items {
            for forbidden in [
                "request",
                "response",
                "responseText",
                "error",
                "url",
                "file",
            ] {
                assert!(
                    item.get(forbidden).is_none(),
                    "returned forbidden field {forbidden}"
                );
            }
        }

        let record_ids: std::collections::BTreeSet<_> = result
            .items
            .iter()
            .filter_map(|item| item["recordId"].as_str())
            .collect();
        assert_eq!(record_ids.len(), 3);
        let shared: Vec<_> = result
            .items
            .iter()
            .filter(|item| item["callId"] == "shared-call-id")
            .collect();
        assert_eq!(shared.len(), 2);
        assert_ne!(shared[0]["recordId"], shared[1]["recordId"]);

        let response = result
            .items
            .iter()
            .find(|item| item["event"] == "response_received")
            .unwrap();
        assert_eq!(response["modelName"], "safe-response-model");
        assert_eq!(response["tokenUsage"]["input"], 10);
        assert_eq!(response["tokenUsage"]["output"], 5);
        assert_eq!(response["tokenUsage"]["total"], 15);
        assert_eq!(response["tokenUsage"]["cacheHit"], 4);
        assert_eq!(response["tokenUsage"]["cacheMiss"], 6);

        model_query.search = Some(secret.into());
        assert_eq!(query(&root, model_query.clone()).unwrap().total, 0);
        model_query.search = Some("upstream-safe-id".into());
        assert_eq!(query(&root, model_query.clone()).unwrap().total, 1);
        model_query.search = None;
        model_query.event = Some("REQUEST_SENT".into());
        let filtered = query(&root, model_query).unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0]["event"], "request_sent");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_numbered_parts_and_rejects_path_shaped_inputs_and_bad_lines() {
        let root = std::env::temp_dir().join(call_id());
        append(
            &root,
            "events",
            json!({"id":"base","timestampMs":1000}),
            &json!({"taskId":"../escape"}),
        )
        .unwrap();
        append(
            &root,
            "events",
            json!({"id":"other-task","timestampMs":9000}),
            &json!({"taskId":"normal"}),
        )
        .unwrap();
        let directory = root.join("logs/tasks").join(task_directory("../escape"));
        let mut part = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(directory.join("events-1.jsonl"))
            .unwrap();
        writeln!(part, "{{\"id\":\"part\",\"timestampMs\":2000}}").unwrap();
        writeln!(part, "{{broken").unwrap();
        part.write_all(&vec![b'x'; MAX_LOG_LINE_BYTES + 1]).unwrap();
        part.write_all(b"\n").unwrap();
        std::fs::write(
            directory.join("events-private.jsonl"),
            b"{\"id\":\"ignored\",\"timestampMs\":3000}\n",
        )
        .unwrap();

        let result = query(&root, event_query(Some("../escape"), 20)).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items[0]["id"], "part");
        assert_eq!(result.items[1]["id"], "base");
        assert_eq!(result.malformed_lines, 1);
        assert_eq!(result.oversized_lines, 1);

        let escaped = query(&root, event_query(Some("../../outside"), 20)).unwrap();
        assert_eq!(escaped.total, 0);
        let mut invalid_stream = event_query(None, 20);
        invalid_stream.stream = "../events".into();
        assert!(query(&root, invalid_stream).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn records_creation_and_hit_usage_and_rotates_without_deletion() {
        let root = std::env::temp_dir().join(call_id());
        let log_dir = root.join("logs/system");
        create_dir_all(&log_dir).unwrap();
        let old = log_dir.join("model-calls.jsonl");
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&old)
            .unwrap()
            .set_len(ROTATE_BYTES)
            .unwrap();
        let usage = json!({"prompt_tokens":2000,"prompt_tokens_details":{"cached_tokens":1024,"cache_creation_input_tokens":512}});
        append(
            &root,
            "model-calls",
            json!({"response":{"usage":usage}}),
            &json!({}),
        )
        .unwrap();
        let index: Value = serde_json::from_str(
            std::fs::read_to_string(root.join("logs/index.jsonl"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(index["usage"], usage);
        assert!(log_dir.join("model-calls-1.jsonl").exists());
        assert_eq!(old.metadata().unwrap().len(), ROTATE_BYTES);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
