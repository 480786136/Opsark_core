use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{create_dir_all, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static CALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const ROTATE_BYTES: u64 = 32 * 1024 * 1024;

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
        "timestampMs",
        "createdAt",
        "requestName",
        "attempt",
        "status",
        "id",
        "roundId",
        "stepId",
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

#[cfg(test)]
mod tests {
    use super::*;
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
        append(&root, "events", json!({"title":"system"}), &json!({})).unwrap();
        let index = std::fs::read_to_string(root.join("logs/index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 4);
        assert!(!index.contains("large payload"));
        assert!(root.join("logs/system/events.jsonl").exists());
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
