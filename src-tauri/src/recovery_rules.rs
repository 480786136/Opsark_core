//! Shared recovery policy. Rule data and conformance cases live in /shared;
//! shell tokenization mirrors services/recoveryRules.ts (not a shell sandbox).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

fn rules() -> &'static Value {
    static RULES: OnceLock<Value> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/recovery-rules.json"))
            .expect("checked-in recovery rules")
    })
}

pub fn version() -> u64 {
    rules()["version"].as_u64().expect("rule version")
}
fn contains(list: &Value, text: &str) -> bool {
    list.as_array()
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(text)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryProtocolIssue {
    pub code: String,
    pub step_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub field_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_token: Option<String>,
    pub expected: String,
    pub allowed_repair_paths: Vec<String>,
    pub rule_version: u64,
}

fn issue(code: &str, step: &Value, index: usize, matched: Option<String>) -> RecoveryProtocolIssue {
    let rule = &rules()["errors"][code];
    RecoveryProtocolIssue {
        code: code.into(),
        step_index: index,
        step_id: step["id"].as_str().map(str::to_string),
        field_path: format!("steps[{index}].{}", rule["field"].as_str().unwrap()),
        matched_token: matched,
        expected: rule["expected"].as_str().unwrap().into(),
        allowed_repair_paths: rule["repairFields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| format!("steps[{index}].{}", field.as_str().unwrap()))
            .collect(),
        rule_version: version(),
    }
}

pub fn metadata_issue(step: &Value, index: usize) -> Option<RecoveryProtocolIssue> {
    let observe_issue = || {
        if step["kind"].as_str() != Some("observe")
            || step["status"]
                .as_str()
                .is_some_and(|status| status != "pending")
        {
            return None;
        }
        command_mutation(step["command"].as_str().unwrap_or(""))
            .map(|matched| issue("OBSERVE_COMMAND_MUTATION", step, index, Some(matched)))
    };
    let relation = &step["recovery"];
    if relation.is_null() {
        return observe_issue();
    }
    if step
        .get("recoveryRuleVersion")
        .is_some_and(|value| value.as_u64() != Some(version()))
    {
        return Some(issue("RECOVERY_RULE_VERSION_MISMATCH", step, index, None));
    }
    if relation.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| !contains(&rules()["recoveryFields"], key))
    }) || relation["failedStepId"]
        .as_str()
        .is_none_or(|value| value.trim().is_empty())
        || relation["targetContext"]
            .as_str()
            .is_none_or(|value| value.trim().is_empty())
        || relation["purpose"]
            .as_str()
            .is_none_or(|value| rules()["purposeRules"].get(value).is_none())
        || (step["id"].is_string() && relation["failedStepId"] == step["id"])
    {
        return Some(issue("RECOVERY_INVALID_METADATA", step, index, None));
    }
    let purpose = &rules()["purposeRules"][relation["purpose"].as_str().unwrap()];
    if purpose
        .get("kind")
        .is_some_and(|kind| kind != &step["kind"])
    {
        return Some(issue("RECOVERY_KIND_MISMATCH", step, index, None));
    }
    if purpose["readonly"].as_bool() == Some(true) {
        if let Some(mutation) = command_mutation(step["command"].as_str().unwrap_or("")) {
            return Some(issue(
                "RECOVERY_DIAGNOSE_MUTATION",
                step,
                index,
                Some(mutation),
            ));
        }
    }
    observe_issue()
}

pub fn decode_issue(error: &str) -> Option<RecoveryProtocolIssue> {
    let value: Value = serde_json::from_str(error).ok()?;
    serde_json::from_value(value.get("issue").unwrap_or(&value).clone()).ok()
}

pub fn encode_issue(issue: &RecoveryProtocolIssue) -> String {
    json!({"issue":issue}).to_string()
}

#[derive(Debug)]
struct Token {
    value: String,
    operator: bool,
}
fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}
fn assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && name.chars().enumerate().all(|(index, c)| {
                c == '_' || c.is_ascii_alphabetic() || index > 0 && c.is_ascii_digit()
            })
    })
}
fn safe_target(word: &str) -> bool {
    contains(&rules()["shell"]["safeWriteTargets"], word)
        || word
            .strip_prefix('&')
            .is_some_and(|fd| fd == "-" || !fd.is_empty() && fd.chars().all(|c| c.is_ascii_digit()))
}
fn flush(tokens: &mut Vec<Token>, word: &mut String) {
    if !word.is_empty() {
        tokens.push(Token {
            value: std::mem::take(word),
            operator: false,
        });
    }
}

pub fn command_mutation(command: &str) -> Option<String> {
    mutation(command, 0)
}

fn mutation(command: &str, depth: u64) -> Option<String> {
    let shell = &rules()["shell"];
    if depth > shell["maxNestedDepth"].as_u64().unwrap() {
        return Some("nested-shell".into());
    }
    let chars: Vec<char> = command.chars().collect();
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && quote != Some('\'') {
            if let Some(&next) = chars.get(i + 1) {
                if next != '\n' {
                    word.push(next);
                }
            }
            i += 2;
            continue;
        }
        if Some(c) == quote {
            quote = None;
            i += 1;
            continue;
        }
        if quote.is_none() && matches!(c, '\'' | '"') {
            quote = Some(c);
            i += 1;
            continue;
        }
        if quote == Some('\'') {
            word.push(c);
            i += 1;
            continue;
        }
        if matches!(c, '$' | '<' | '>')
            && chars.get(i + 1) == Some(&'(')
            && (quote.is_none() || c == '$')
            || c == '`'
        {
            let backtick = c == '`';
            let mut nested = String::new();
            let mut nesting = 1;
            let mut nested_quote = None;
            let mut end = i + if backtick { 1 } else { 2 };
            while end < chars.len() {
                let current = chars[end];
                if current == '\\' {
                    nested.push(current);
                    end += 1;
                    if let Some(&next) = chars.get(end) {
                        nested.push(next);
                    }
                    end += 1;
                    continue;
                }
                if backtick && current == '`' {
                    break;
                }
                if Some(current) == nested_quote {
                    nested_quote = None;
                } else if nested_quote.is_none() && matches!(current, '\'' | '"') {
                    nested_quote = Some(current);
                } else if nested_quote.is_none() && !backtick && current == '(' {
                    nesting += 1;
                } else if nested_quote.is_none() && !backtick && current == ')' {
                    nesting -= 1;
                    if nesting == 0 {
                        break;
                    }
                }
                nested.push(current);
                end += 1;
            }
            if let Some(found) = mutation(&nested, depth + 1) {
                return Some(found);
            }
            word.push_str("__substitution__");
            i = end + 1;
            continue;
        }
        if quote.is_some() {
            word.push(c);
            i += 1;
            continue;
        }
        if c == '#' && word.is_empty() {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            flush(&mut tokens, &mut word);
            tokens.push(Token {
                value: "\n".into(),
                operator: true,
            });
            i += 1;
            continue;
        }
        for operator in shell["unsupportedShellOperators"].as_array().unwrap() {
            let op = operator.as_str().unwrap();
            if chars[i..]
                .iter()
                .copied()
                .take(op.chars().count())
                .eq(op.chars())
            {
                return Some(format!("unsupported:{op}"));
            }
        }
        if c == '>' {
            if !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()) {
                word.clear();
            } else {
                flush(&mut tokens, &mut word);
            }
            let mut op = ">".to_string();
            if chars.get(i + 1).is_some_and(|c| matches!(c, '>' | '|')) {
                i += 1;
                op.push(chars[i]);
            }
            if chars.get(i + 1) == Some(&'&') {
                i += 1;
                word.push('&');
            }
            tokens.push(Token {
                value: op,
                operator: true,
            });
            i += 1;
            continue;
        }
        if contains(&shell["separators"], &c.to_string()) || c == '<' {
            flush(&mut tokens, &mut word);
            tokens.push(Token {
                value: c.to_string(),
                operator: true,
            });
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            flush(&mut tokens, &mut word);
            i += 1;
            continue;
        }
        word.push(c);
        i += 1;
    }
    flush(&mut tokens, &mut word);
    let mut segment: Vec<String> = Vec::new();
    let mut piped = false;
    i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        if !token.operator {
            segment.push(token.value.clone());
            i += 1;
            continue;
        }
        if token.value.starts_with('>') {
            if let Some(found) = inspect(&segment, piped, depth) {
                return Some(found);
            }
            i += 1;
            if tokens
                .get(i)
                .is_none_or(|target| target.operator || !safe_target(&target.value))
            {
                return Some(token.value.clone());
            }
            i += 1;
            continue;
        }
        if token.value == "<" {
            i += 2;
            continue;
        }
        if let Some(found) = inspect(&segment, piped, depth) {
            return Some(found);
        }
        segment.clear();
        piped = token.value == "|";
        i += 1;
    }
    inspect(&segment, piped, depth)
}

fn inspect(segment: &[String], piped: bool, depth: u64) -> Option<String> {
    let shell = &rules()["shell"];
    let mut at = 0;
    while at < segment.len() {
        let value = basename(&segment[at]);
        if assignment(&segment[at]) || contains(&shell["prefixWords"], value) {
            at += 1;
            continue;
        }
        if contains(&shell["wrappers"], value) {
            at += 1;
            while at < segment.len() && (segment[at].starts_with('-') || assignment(&segment[at])) {
                if contains(&shell["wrapperValueOptions"], &segment[at]) {
                    at += 1;
                }
                at += 1;
            }
            continue;
        }
        break;
    }
    if at >= segment.len() {
        return None;
    }
    let name = basename(&segment[at]);
    let args = &segment[at + 1..];
    if shell["readOnlyCommandRules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|rule| {
            contains(&rule["commands"], name)
                && (rule["noArguments"].as_bool() == Some(true) && args.is_empty()
                    || args.iter().any(|arg| contains(&rule["options"], arg)))
        })
    {
        return None;
    }
    let found = || Some(name.to_string());
    if contains(&shell["mutationCommands"], name) {
        return found();
    }
    if contains(&shell["opaqueInterpreters"], name) {
        return if args.len() == 1 && contains(&shell["safeInterpreterOptions"], &args[0]) {
            None
        } else {
            found()
        };
    }
    if contains(&shell["shells"], name) {
        if let Some(flag) = args
            .iter()
            .position(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c'))
        {
            return mutation(args.get(flag + 1).map_or("", String::as_str), depth + 1);
        }
        return if piped || args.iter().any(|arg| !arg.starts_with('-')) {
            found()
        } else {
            None
        };
    }
    if name == "tee" {
        return if args
            .iter()
            .any(|arg| !arg.starts_with('-') && !safe_target(arg))
        {
            found()
        } else {
            None
        };
    }
    if contains(&shell["cacheQueryCommands"], name)
        && args
            .iter()
            .any(|arg| contains(&shell["cacheQueryWords"], arg))
        && !args
            .iter()
            .any(|arg| contains(&shell["cacheOnlyOptions"], arg))
    {
        return found();
    }
    if contains(&shell["sqlClients"], name)
        && args.iter().any(|arg| {
            arg.split(|c: char| !c.is_ascii_alphabetic())
                .any(|word| contains(&shell["sqlMutationWords"], &word.to_uppercase()))
        })
    {
        return found();
    }
    for rule in shell["commandRules"].as_array().unwrap() {
        if !contains(&rule["commands"], name) {
            continue;
        }
        if rule["always"].as_bool() == Some(true)
            || args.iter().any(|arg| contains(&rule["words"], arg))
            || rule["optionPrefixes"].as_array().is_some_and(|prefixes| {
                args.iter().any(|arg| {
                    prefixes
                        .iter()
                        .any(|prefix| arg.starts_with(prefix.as_str().unwrap()))
                })
            })
        {
            return found();
        }
        if let Some(options) = rule["outputOptions"].as_array() {
            if args.iter().enumerate().any(|(index, arg)| {
                options.iter().any(|option| {
                    let option = option.as_str().unwrap();
                    let target = if arg == option {
                        Some(args.get(index + 1).map_or("", String::as_str))
                    } else {
                        arg.strip_prefix(&format!("{option}="))
                    };
                    target.is_some_and(|target| {
                        target != "-" && !contains(&shell["safeWriteTargets"], target)
                    })
                })
            }) {
                return found();
            }
        }
        if args.iter().enumerate().any(|(index, arg)| {
            ["-X", "--request"].contains(&arg.as_str())
                && args
                    .get(index + 1)
                    .is_some_and(|method| contains(&rule["writeMethods"], method))
        }) {
            return found();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_shell_recovery_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../shared/recovery-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let matched = command_mutation(case["command"].as_str().unwrap());
            assert_eq!(
                matched.as_deref(),
                case["mutation"].as_str(),
                "{}",
                case["name"]
            );
            let step = json!({"id":"next", "kind":"observe", "command":case["command"], "recovery":{"failedStepId":"failed", "targetContext":"original", "purpose":"diagnose"}});
            let result = metadata_issue(&step, 2);
            assert_eq!(
                result.is_some(),
                !case["mutation"].is_null(),
                "{}",
                case["name"]
            );
            if let Some(result) = result {
                assert_eq!(result.code, "RECOVERY_DIAGNOSE_MUTATION");
                assert_eq!(result.field_path, "steps[2].command");
                assert_eq!(result.allowed_repair_paths, vec!["steps[2].command"]);
                assert_eq!(result.matched_token, matched);
                assert_eq!(
                    decode_issue(&encode_issue(&result)).unwrap().rule_version,
                    version()
                );
            }
        }
    }
    #[test]
    fn shared_metadata_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../shared/recovery-metadata-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let found = metadata_issue(&case["step"], 3);
            assert_eq!(
                found.as_ref().map(|issue| issue.code.as_str()),
                case["code"].as_str(),
                "{}",
                case["name"]
            );
            if let Some(found) = found {
                assert_eq!(
                    found.field_path,
                    format!("steps[3].{}", case["field"].as_str().unwrap())
                );
                assert_eq!(found.rule_version, version());
                if found.code == "OBSERVE_COMMAND_MUTATION" {
                    assert_eq!(found.allowed_repair_paths, vec!["steps[3].command"]);
                } else {
                    assert!(found.allowed_repair_paths.is_empty());
                }
            }
        }
    }
}
