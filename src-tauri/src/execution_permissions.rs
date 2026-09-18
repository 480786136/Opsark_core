use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
fn policies() -> &'static Mutex<HashMap<String, bool>> {
    static POLICIES: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    POLICIES.get_or_init(|| Mutex::new(HashMap::new()))
}
#[tauri::command]
pub(crate) fn configure_task_execution(task_id: String, allow_shell: bool) -> Result<(), String> {
    if task_id.is_empty() || task_id.len() > 160 {
        return Err("任务标识无效".into());
    }
    policies()
        .lock()
        .map_err(|_| "无法读取执行权限")?
        .insert(task_id, allow_shell);
    Ok(())
}
pub(crate) fn ensure_shell(task_id: &str) -> Result<(), String> {
    if policies()
        .lock()
        .map_err(|_| "无法读取执行权限")?
        .get(task_id)
        != Some(&true)
    {
        return Err("任务未获得 Agent Shell 权限，已在执行端阻止命令".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_denied_task_cannot_dispatch_shell() {
        assert!(ensure_shell("test-permissions-unregistered").is_err());
        configure_task_execution("test-permissions-granted".into(), true).unwrap();
        assert!(ensure_shell("test-permissions-granted").is_ok());
        configure_task_execution("test-permissions-granted".into(), false).unwrap();
        assert!(ensure_shell("test-permissions-granted").is_err());
    }
}
