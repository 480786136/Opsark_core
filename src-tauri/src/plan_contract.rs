//! Scope values shared by prompts, output schemas and execution admission.
pub(crate) const EXECUTION_SCOPES: &[&str] = &["agent_session", "isolated_exec", "managed_service", "user_action"];
pub(crate) const VALIDATION_SCOPES: &[&str] = &["isolated_exec", "fresh_interactive_shell", "fresh_login_shell"];
pub(crate) const RUNTIME_CLASSES: &[&str] = &["bounded", "progressive", "persistent_service"];

pub(crate) fn field_rules() -> String {
    format!("步骤字段契约：executionScope 只能为 {}；validationScope 只能为 {}；runtimeClass 只能为 {}。这三个字段可省略或为 null，使用安全默认值；不得写描述性句子。验收命令写在 validation，验收目标写在 expected。Shell action 仅允许 type=\"shell\" 和 command 两个字段；禁止 timeoutSeconds、shell、cwd 等额外字段，执行时限由执行器管理。工具 action 仅允许 type=\"tool\"、toolId、arguments；arguments 必须符合当前工具 inputSchema。",
        EXECUTION_SCOPES.join("|"), VALIDATION_SCOPES.join("|"), RUNTIME_CLASSES.join("|"))
}
