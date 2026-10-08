//! Task display snapshots and removal markers are independent of execution facts.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

fn open(root: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let db = Connection::open(root.join("task-archive.sqlite")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let version: i64 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version != 0 && version != 1 {
        return Err("Unsupported task archive version".into());
    }
    db.execute_batch("PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, disposition TEXT NOT NULL, snapshot TEXT NOT NULL);
      PRAGMA user_version=1;").map_err(|e| e.to_string())?;
    Ok(db)
}
fn validate(snapshot: &Value) -> Result<&str, String> {
    let id = snapshot["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Invalid task identity")?;
    if !snapshot["serverId"].is_string()
        || !snapshot["status"].is_string()
        || !snapshot["messages"].is_array()
        || !snapshot["plan"].is_array()
    {
        return Err("Invalid task snapshot".into());
    }
    Ok(id)
}
fn save(root: &Path, snapshots: &[Value], disposition: &str) -> Result<(), String> {
    if !["active", "removed", "legacy_recovery"].contains(&disposition) {
        return Err("Invalid task disposition".into());
    }
    let mut db = open(root)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for snapshot in snapshots {
        let id = validate(snapshot)?;
        // Background/stale saves can never resurrect a removed task or overwrite its backup.
        tx.execute(
            "INSERT INTO tasks(id,disposition,snapshot) VALUES(?1,?2,?3)
          ON CONFLICT(id) DO UPDATE SET disposition=excluded.disposition,snapshot=excluded.snapshot
          WHERE excluded.disposition != 'active' OR tasks.disposition = 'active'",
            params![id, disposition, snapshot.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
fn entry(id: String, disposition: String, raw: String, full: bool) -> Result<Value, String> {
    let snapshot: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if validate(&snapshot)? != id {
        return Err("Task archive identity mismatch".into());
    }
    let round_count = snapshot["planHistory"].as_array().map_or(0, Vec::len)
        + usize::from(snapshot["messages"].as_array().is_some_and(|messages| {
            messages.iter().any(|message| message["role"] == "user" && message["kind"] == "message")
        }));
    let mut value = json!({ "taskId": id, "title": snapshot["title"], "serverId": snapshot["serverId"], "disposition": disposition,
        "createdAt": snapshot["createdAt"], "status": snapshot["status"], "roundCount": round_count });
    if full {
        value["snapshot"] = snapshot;
    }
    Ok(value)
}
#[tauri::command]
pub fn save_task_snapshots(app: tauri::AppHandle, snapshots: Vec<Value>) -> Result<(), String> {
    save(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &snapshots,
        "active",
    )
}
#[tauri::command]
pub fn mark_task_archived(
    app: tauri::AppHandle,
    snapshot: Value,
    disposition: String,
) -> Result<(), String> {
    if disposition == "active" {
        return Err("Explicit archive disposition required".into());
    }
    save(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        &[snapshot],
        &disposition,
    )
}
#[tauri::command]
pub fn preserve_continued_legacy_task(
    app: tauri::AppHandle,
    snapshot: Value,
) -> Result<(), String> {
    let id = validate(&snapshot)?;
    let db = open(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    db.execute("UPDATE tasks SET disposition='active',snapshot=?2 WHERE id=?1 AND disposition='legacy_recovery'",
      params![id, snapshot.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn list_task_archives(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let db = open(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    let mut statement = db
        .prepare("SELECT id,disposition,snapshot FROM tasks ORDER BY rowid DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, disposition, raw) = row.map_err(|e| e.to_string())?;
        entry(id, disposition, raw, false)
    })
    .collect()
}
#[tauri::command]
pub fn read_task_archive(app: tauri::AppHandle, task_id: String) -> Result<Option<Value>, String> {
    let db = open(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    let row = db
        .query_row(
            "SELECT disposition,snapshot FROM tasks WHERE id=?1",
            [&task_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|(disposition, raw)| entry(task_id, disposition, raw, true))
        .transpose()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_entry_contains_display_metadata_without_task_details() {
        let snapshot = json!({"id":"task-list", "serverId":"s", "title":"Deploy",
            "status":"completed", "createdAt":"2026-09-30T09:00:00Z", "plan":[],
            "messages":[{"role":"user","kind":"message","content":"request body"}],
            "planHistory":[{}, {}]});
        let summary = entry("task-list".into(), "active".into(), snapshot.to_string(), false).unwrap();
        assert_eq!(summary["createdAt"], snapshot["createdAt"]);
        assert_eq!(summary["status"], "completed");
        assert_eq!(summary["roundCount"], 3);
        assert!(summary.get("snapshot").is_none());
        assert!(!summary.to_string().contains("request body"));
    }
    #[test]
    fn removal_survives_reopen_and_stale_save_and_batch_is_atomic() {
        let root =
            std::env::temp_dir().join(format!("opsark-archive-{}", crate::task_logs::call_id()));
        let snapshot = json!({"id":"task-original","title":"original goal","serverId":"s","status":"completed","plan":[],"messages":[]});
        save(&root, &[snapshot.clone()], "active").unwrap();
        save(&root, &[snapshot.clone()], "removed").unwrap();
        let mut stale = snapshot.clone();
        stale["title"] = json!("stale");
        save(&root, &[stale.clone()], "active").unwrap();
        let db = open(&root).unwrap();
        let (state, raw): (String, String) = db
            .query_row("SELECT disposition,snapshot FROM tasks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(state, "removed");
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), snapshot);
        stale["id"] = json!("second");
        assert!(save(&root, &[stale, json!({"id":"invalid"})], "active").is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM tasks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn future_archive_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!(
            "opsark-archive-version-{}",
            crate::task_logs::call_id()
        ));
        let db = open(&root).unwrap();
        db.pragma_update(None, "user_version", 9).unwrap();
        assert!(open(&root).is_err());
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            9
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
