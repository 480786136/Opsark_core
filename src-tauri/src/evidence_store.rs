use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, sync::Mutex};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn directory(root: &Path, task_id: &str) -> std::path::PathBuf {
    root.join("evidence")
        .join(format!("{:x}", Sha256::digest(task_id.as_bytes())))
}

// A synced file followed by rename is not sufficient to persist the new name
// across a system crash. Sync the directories from the leaf up through the app
// data directory's parent, including newly created evidence/task directories.
// Windows std::fs cannot open directories for sync_all; that platform retains
// file syncing without claiming the same directory-entry durability guarantee.
#[cfg(unix)]
fn sync_directories(root: &Path, dir: &Path) -> Result<(), String> {
    for ancestor in dir.ancestors() {
        fs::File::open(ancestor)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Evidence directory sync failed: {error}"))?;
        if Some(ancestor) == root.parent() {
            break;
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn sync_directories(_root: &Path, _dir: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) fn save(root: &Path, task_id: &str, record: &Value) -> Result<String, String> {
    if task_id.is_empty() || !record["text"].is_string() {
        return Err("Invalid evidence record".into());
    }
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Evidence store unavailable")?;
    let dir = directory(root, task_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        if fs::read(&path).map_err(|e| e.to_string())? != bytes {
            return Err("Evidence integrity mismatch".into());
        }
        sync_directories(root, &dir)?;
        return Ok(id);
    }
    let temporary = dir.join(format!("{}.tmp", crate::task_logs::call_id()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    sync_directories(root, &dir)?;
    Ok(id)
}

pub(crate) fn read(
    root: &Path,
    task_id: &str,
    id: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    if task_id.is_empty()
        || id.len() != 64
        || !id.bytes().all(|c| c.is_ascii_hexdigit())
        || !(1..=12000).contains(&limit)
    {
        return Err("Invalid evidence reference or page size".into());
    }
    let bytes =
        fs::read(directory(root, task_id).join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err("Evidence integrity mismatch".into());
    }
    let mut record: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let text = record["text"].as_str().ok_or("Invalid evidence text")?;
    let total = text.chars().count();
    if offset > total {
        return Err("Evidence offset exceeds captured text".into());
    }
    let page: String = text.chars().skip(offset).take(limit).collect();
    let next = offset + page.chars().count();
    record.as_object_mut().unwrap().remove("text");
    Ok(
        json!({"evidenceId": id, "historical": true, "metadata": record, "text": page,
        "offset": offset, "totalCharacters": total, "nextOffset": if next < total { Some(next) } else { None },
        "instruction": "历史采集记录；读取成功不代表远端状态仍然有效。分页结束也不代表原始采集完整。"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_immutable_unicode_pages_and_integrity() {
        let root = std::env::temp_dir().join(crate::task_logs::call_id());
        let record = json!({"text": "甲😀乙尾", "capturedPartial": true});
        let id = save(&root, "task-a", &record).unwrap();
        assert_eq!(save(&root, "task-a", &record).unwrap(), id);
        let page = read(&root, "task-a", &id, 1, 2).unwrap();
        assert_eq!(page["text"], "😀乙");
        assert_eq!(page["nextOffset"], 3);
        assert_eq!(page["metadata"]["capturedPartial"], true);
        assert!(read(&root, "task-b", &id, 0, 10).is_err());
        assert!(read(&root, "task-a", "../escape", 0, 10).is_err());
        assert!(read(&root, "task-a", &id, 0, 12001).is_err());
        fs::write(directory(&root, "task-a").join(format!("{id}.json")), b"{}").unwrap();
        assert!(read(&root, "task-a", &id, 0, 10).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
