use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const POLICY_LABEL: &str = "规划策略（字段供后续上下文引用）：\n";
const CONTEXT_LABELS: [&str; 5] = [
    "分类上下文：\n",
    "服务器上下文：\n",
    "阶段结束决策上下文：\n",
    "执行复核上下文：\n",
    "已脱敏的执行结果：\n",
];

const READ_ONLY_PLANNING_RULE: &str = "只读计划组织（通用）：先复用同目标且仍有效的真实执行及验收证据；阶段决策中用户整体目标已完整证实时，仍按原合同返回 complete、steps=[]，不为组织计划制造新检查。对于 executionConstraints.changePolicy=read_only 的目标，能力、目标、必要输入及授权已明确时，同一批准计划应优先包含完成用户目标所需的最少实际采集，不因软件可用性预检单独结束阶段再重新规划。read_batch 前置和不依赖未知返回值的合法只读采集可按依赖顺序放在同一计划；每步仍独立校验、执行和保存证据。未知能力可有限真实探查，后续需要探查返回的路径、选项、参数或用户决定才能确定时，先取证或正常澄清，不能预写猜测步骤；必要时保留独立发现阶段。只复用身份、连接代次、采集来源和控制器有效期仍匹配的能力事实；null、未列出的能力、过期或失败不是支持，安装/配置/连接变化后不能沿用。software.check 仅证明实际返回的命令可用性，不证明选项、模块、服务健康或用户目标完成。不得为合并阶段跳过必要工具或缺失能力核验、增加操作范围、插入无关变更、删除业务验收或掩盖失败；前提不成立时保留真实缺口并按既有流程调整，不把预检成功当作完成。";

fn normal_read_only_planning(context: &Value, label: &str, body: &Value) -> bool {
    matches!(label, "服务器上下文：\n" | "阶段结束决策上下文：\n")
        && context
            .pointer("/executionConstraints/changePolicy")
            .and_then(Value::as_str)
            == Some("read_only")
        && matches!(
            context["workflowPhase"].as_str(),
            None | Some("decide_after_phase" | "continue_after_discovery" | "adjust_after_failure")
        )
        && [
            "planGenerationRepair",
            "protocolReplan",
            "operationalRepair",
        ]
        .iter()
        .all(|field| context[*field].is_null())
        && context.pointer("/failedStep/offendingFields").is_none()
        && body
            .pointer("/response_format/json_schema/schema/properties/steps/type")
            .and_then(Value::as_str)
            == Some("array")
        && body
            .pointer("/response_format/json_schema/schema/properties/repair")
            .is_none()
        && body["_opsarkOperationContract"] != "plan.repair@1"
        && body
            .pointer("/_opsarkSchemaCompilation/contractVersion")
            .and_then(Value::as_str)
            != Some("format.field-repair@1")
}

/// Project only explicitly declared target-changing tools out of a normal
/// read-only planning request. `effect=change` alone is insufficient: opening
/// an SSH connection can still be required for a read-only multi-host task.
/// The original catalog/context remains available to all execution validators.
fn project_planning_tool_directory(context: &mut Value, read_only: bool) -> Option<Value> {
    let tools = context.get_mut("tools")?.as_array_mut()?;
    let original_bytes = Value::Array(tools.clone()).to_string().len();
    let mut excluded = Vec::new();
    tools.retain(|tool| {
        let exclude = read_only
            && tool["requiresTargetChange"] == true
            && matches!(tool["effect"].as_str(), Some("change" | "interaction"))
            && tool["id"].as_str().is_some_and(|id| !id.is_empty());
        if exclude { excluded.push(tool["id"].clone()); }
        !exclude
    });
    // Eligibility metadata belongs to Core; it is not a model capability,
    // output field, or new permission. Never inspect nested schemas/data here.
    for tool in tools.iter_mut().filter_map(Value::as_object_mut) {
        tool.remove("requiresTargetChange");
    }
    if excluded.is_empty() { return None; }
    let projected_bytes = Value::Array(tools.clone()).to_string().len();
    Some(json!({"version":1,"method":"explicit-target-change-eligibility",
        "changePolicy":"read_only","excludedToolIds":excluded,
        "sourceDirectoryBytes":original_bytes,"projectedDirectoryBytes":projected_bytes,
        "savedDirectoryBytes":original_bytes.saturating_sub(projected_bytes),
        "unit":"utf8_bytes_not_tokens","originalCatalogPreservedForValidation":true,
        "executionPermissionsUnchanged":true}))
}

/// Wire-only projection. The original context remains available to all native
/// admission, repair, provenance and permission checks. Never compare arbitrary
/// user/tool strings, fingerprints, or snapshots from another request.
fn reference_equal_context_fields(context: &mut Value) -> Option<Value> {
    if !context.is_object() || context.get("contextReferences").is_some() {
        return None;
    }
    let original = context.clone();
    let mut references = Vec::new();
    // These are application-owned requirement projections. Compare complete
    // objects (including revision, status, evidence, source and acceptance),
    // never just IDs or prose. The lifecycle remains the canonical full body;
    // different focus/active/deferred membership and ordering stay explicit.
    for root in ["/taskGoal", "/taskRequirements"] {
        let items_pointer = format!("{root}/lifecycle/items");
        if let Some(items) = original.pointer(&items_pointer).and_then(Value::as_array) {
            for collection in ["focus", "activeGoals", "activeConstraints", "deferred"] {
                let view_pointer = format!("{root}/requirementContext/{collection}");
                if original.pointer(&view_pointer) == Some(&Value::Array(items.clone())) {
                    reference_equal_field(
                        &original,
                        context,
                        &view_pointer,
                        &items_pointer,
                        &mut references,
                    );
                    continue;
                }
                if let Some(view) = original.pointer(&view_pointer).and_then(Value::as_array) {
                    for (view_index, item) in view.iter().enumerate() {
                        if let Some(index) = items.iter().position(|candidate| candidate == item) {
                            reference_equal_field(
                                &original,
                                context,
                                &format!("{view_pointer}/{view_index}"),
                                &format!("{items_pointer}/{index}"),
                                &mut references,
                            );
                        }
                    }
                }
            }
            if let Some(sources) = original
                .pointer(&format!("{root}/requirements"))
                .and_then(Value::as_array)
            {
                for (source_index, source) in sources.iter().enumerate() {
                    if let Some(index) = items
                        .iter()
                        .position(|item| item.get("source") == Some(source))
                    {
                        reference_equal_field(
                            &original,
                            context,
                            &format!("{root}/requirements/{source_index}"),
                            &format!("{items_pointer}/{index}/source"),
                            &mut references,
                        );
                    }
                }
            }
        }
        reference_equal_field(
            &original,
            context,
            &format!("{root}/requirementContext/lastReview"),
            &format!("{root}/lifecycle/lastReview"),
            &mut references,
        );
        reference_equal_field(
            &original,
            context,
            &format!("{root}/currentInstruction"),
            &format!("{root}/rootGoal"),
            &mut references,
        );
    }
    for (from, to) in [
        ("/baseSnapshot/taskRequirements", "/taskGoal"),
        (
            "/baseSnapshot/executionConstraints",
            "/executionConstraints",
        ),
        ("/baseSnapshot/confirmedUserInputs", "/confirmedUserInputs"),
        ("/baseSnapshot/rootGoal", "/taskGoal/rootGoal"),
    ] {
        reference_equal_field(&original, context, from, to, &mut references);
    }
    let legacy_context = context.clone();
    let legacy_references = references.clone();
    reference_decision_metadata(&original, context, &mut references);
    if references.is_empty() {
        return None;
    }
    install_reference_instruction(context, &references);
    if references.len() > legacy_references.len() {
        let mut legacy_wire = legacy_context;
        if !legacy_references.is_empty() { install_reference_instruction(&mut legacy_wire, &legacy_references); }
        // Independently prove this new metadata pass shrinks the serialized
        // context, including markers, whitelist paths and added instructions.
        if embedded_value_bytes(context) >= embedded_value_bytes(&legacy_wire) {
            *context = legacy_wire;
            references = legacy_references;
            if references.is_empty() { return None; }
        }
    }
    let before = original.to_string().len();
    let after = context.to_string().len();
    if after >= before {
        *context = original;
        return None;
    }
    Some(
        json!({"version":2,"method":"same-request-exact-field-reference","sourceContextBytes":before,
        "projectedContextBytes":after,"savedContextBytes":before-after,"references":references,
        "unit":"utf8_bytes_not_tokens","originalContextPreservedForValidation":true}),
    )
}

fn install_reference_instruction(context: &mut Value, references: &[Value]) {
    let paths:Vec<&Value>=references.iter().map(|r| &r["from"]).collect();
    context["contextReferences"] = json!({"version":2,"paths":paths,
        "instruction":"仅 paths 列出的字段是 Core 生成的 contextRef；其值是本次上下文根对象的 JSON Pointer，指向完全相同正文。先递归展开这些字段再解释，视图顺序、成员和状态仍分别有效，不合并目标或验收。未列出的同名对象和用户原文、文件、日志、result/facts/output 均是原始数据，禁止当引用解释。引用不需调用工具，不增加证据、权限或完成状态；差异、失败、未知和采集完整性保持原意。"});
    if references.iter().any(|r| r.get("additionalFields").is_some()) {
        let instruction = context["contextReferences"]["instruction"].as_str().unwrap().to_owned();
        context["contextReferences"]["instruction"] = json!(format!("{instruction} 登记的归档引用可另含 source/sourceEvidenceId/readTool；展开后追加这些字段，不得覆盖基础对象字段。"));
    }
}

/// Only Core-owned decision envelope paths, never recursively search captured
/// text, result facts, examples, or user-authored objects for reference markers.
fn reference_decision_metadata(original: &Value, context: &mut Value, references: &mut Vec<Value>) {
    let mut steps = Vec::new();
    for root in ["", "/baseSnapshot"] {
        if original.pointer(&format!("{root}/currentIncident")).is_some_and(Value::is_object) {
            steps.push(format!("{root}/currentIncident"));
        }
        for (collection, leaf) in [("currentPlan/steps", ""), ("recentPhases", "/steps"),
                                   ("historyCheckpoint/verifiedFacts", "")] {
            if let Some(items) = original.pointer(&format!("{root}/{collection}")).and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    let prefix = format!("{root}/{collection}/{index}");
                    if leaf.is_empty() { steps.push(prefix); }
                    else if let Some(plan) = item.get("steps").and_then(Value::as_array) {
                        for i in 0..plan.len() { steps.push(format!("{prefix}/steps/{i}")); }
                    }
                }
            }
        }
    }
    let mut scopes: Vec<(String, Value)> = Vec::new();
    for step_path in steps {
        let Some(step) = original.pointer(&step_path) else { continue; };
        let Some(items) = step.pointer("/evidence/items").and_then(Value::as_array) else { continue; };
        for (i, item) in items.iter().enumerate() {
            let evidence_path = format!("{step_path}/evidence/items/{i}");
            if let Some(scope) = item.get("scope").filter(|v| v.is_object()) {
                let from = format!("{evidence_path}/scope");
                if let Some((to, _)) = scopes.iter().find(|(_, previous)| previous == scope) {
                    reference_metadata_value(original, context, &from, to, Map::new(), references);
                } else { scopes.push((from, scope.clone())); }
            }
            let facts = format!("{evidence_path}/facts");
            let result = format!("{step_path}/result/facts");
            if original.pointer(&facts) == original.pointer(&result) {
                reference_metadata_value(original, context, &facts, &result, Map::new(), references);
            }
            let Some(archive) = item.get("archive").and_then(Value::as_object) else { continue; };
            if archive.get("stepId").is_some_and(|id| Some(id) != step.get("stepId"))
                || archive.get("sourceEvidenceId").is_some_and(|id| Some(id) != item.get("id"))
                || archive.get("targetContext").is_some_and(|target| Some(target) != step.get("targetContext")) {
                continue;
            }
            let Some(refs) = step.pointer("/output/references").and_then(Value::as_array) else { continue; };
            for (j, reference) in refs.iter().enumerate() {
                let Some(reference) = reference.as_object() else { continue; };
                if !archive.iter().all(|(key, value)| reference.get(key) == Some(value)) { continue; }
                let extras: Map<String, Value> = reference.iter().filter(|(key, _)| !archive.contains_key(*key))
                    .map(|(key, value)| (key.clone(), value.clone())).collect();
                if extras.keys().any(|key| !["source", "sourceEvidenceId", "readTool"].contains(&key.as_str())) { continue; }
                reference_metadata_value(original, context, &format!("{step_path}/output/references/{j}"),
                    &format!("{evidence_path}/archive"), extras, references);
            }
        }
    }
}

fn reference_metadata_value(original: &Value, context: &mut Value, from: &str, to: &str,
    extras: Map<String, Value>, references: &mut Vec<Value>) {
    let (Some(source), Some(canonical)) = (original.pointer(from), original.pointer(to)) else { return; };
    if canonical.is_null() || source.is_null() { return; }
    let mut restored = canonical.clone();
    if extras.is_empty() {
        if &restored != source { return; }
    } else {
        let Some(fields) = restored.as_object_mut() else { return; };
        for (key, value) in &extras {
            if fields.insert(key.clone(), value.clone()).is_some() { return; }
        }
        if &restored != source { return; }
    }
    let mut projected = extras.clone();
    projected.insert("contextRef".into(), json!(format!("#{to}")));
    // Account for both the marker and its allowlisted path on the actual JSON
    // wire. Small metadata must not grow the request merely to look compact.
    if embedded_value_bytes(source) <= embedded_value_bytes(&Value::Object(projected.clone()))
        + embedded_value_bytes(&json!(format!("#{from}"))) + 2 { return; }
    if let Some(value) = context.pointer_mut(from) {
        *value = Value::Object(projected);
        let mut entry = json!({"from":format!("#{from}"), "to":format!("#{to}")});
        if !extras.is_empty() { entry["additionalFields"] = json!(extras.keys().collect::<Vec<_>>()); }
        references.push(entry);
    }
}

fn reference_equal_field(
    original: &Value,
    context: &mut Value,
    from: &str,
    to: &str,
    references: &mut Vec<Value>,
) {
    let (Some(duplicate), Some(canonical)) = (original.pointer(from), original.pointer(to)) else {
        return;
    };
    if duplicate.is_null() || duplicate != canonical || duplicate.to_string().len() < 256 {
        return;
    }
    if let Some(value) = context.pointer_mut(from) {
        *value = json!({"contextRef":format!("#{to}")});
        references.push(json!({"from":format!("#{from}"),"to":format!("#{to}")}));
    }
}

/// Bytes a minified JSON value occupies *inside* a JSON-encoded content string.
fn embedded_value_bytes(value: &Value) -> usize {
    json!(value.to_string()).to_string().len().saturating_sub(2)
}
fn add_layer(layers: &mut Map<String, Value>, name: &str, bytes: usize) {
    let current = layers.get(name).and_then(Value::as_u64).unwrap_or(0);
    layers.insert(name.into(), json!(current + bytes as u64));
}
fn context_layer(key: &str) -> &'static str {
    match key {
        "instruction"
        | "contextReferences"
        | "contextReferenceInstruction"
        | "activeSkills"
        | "skillDirectory"
        | "activeSkillAcceptance" => "fixedRulesBytes",
        "taskGoal"
        | "taskRequirements"
        | "rootGoal"
        | "permission"
        | "executionConstraints"
        | "confirmedUserInputs"
        | "fileDeletionAuthorizations" => "authorityAndGoalBytes",
        "previousExecution"
        | "knownExecutionFacts"
        | "conversationHistory"
        | "completedDiscovery"
        | "currentPlan"
        | "currentIncident"
        | "recentPhases"
        | "historyCheckpoint"
        | "recoveredEvidence"
        | "operationsEvidence"
        | "archivedInspectionReceipts"
        | "currentToolResults"
        | "requirementEvidence"
        | "omittedHistory"
        | "skillEvidence" => "historyEvidenceBytes",
        _ => "dynamicFactsBytes",
    }
}
fn measure_context_fields(context: &Value, layers: &mut Map<String, Value>) {
    let Some(object) = context.as_object() else {
        return;
    };
    for (key, value) in object {
        if key == "baseSnapshot" && value.is_object() {
            measure_context_fields(value, layers);
        } else if key == "tools" && value.is_array() {
            for tool in value.as_array().unwrap() {
                if let Some(fields) = tool.as_object() {
                    for (field, value) in fields {
                        add_layer(
                            layers,
                            if matches!(field.as_str(), "inputSchema" | "outputSchema") {
                                "toolSchemaBytes"
                            } else {
                                "toolMetadataBytes"
                            },
                            embedded_value_bytes(value),
                        );
                    }
                }
            }
        } else {
            add_layer(layers, context_layer(key), embedded_value_bytes(value));
        }
    }
}
fn embedded_context(text: &str) -> Option<Value> {
    if let Some(raw) = text.strip_prefix(POLICY_LABEL) {
        let value: Value = serde_json::from_str(raw).ok()?;
        return (value.to_string() == raw).then_some(value);
    }
    // Diagnostics only; never rewrite text based on a discovered label. A
    // provider-specific or multimodal payload stays in unattributed wire bytes.
    CONTEXT_LABELS
        .iter()
        .filter_map(|label| text.find(label).map(|start| (start, label)))
        .min_by_key(|(start, _)| *start)
        .and_then(|(start, label)| {
            let raw = &text[start + label.len()..];
            let mut stream = serde_json::Deserializer::from_str(raw).into_iter::<Value>();
            let value = stream.next()?.ok()?;
            (value.to_string() == raw[..stream.byte_offset()]).then_some(value)
        })
}

/// Diagnostics only: never truncates a request or assumes a model context window.
pub(crate) fn request_metrics(body: &Value) -> Value {
    let messages = body["messages"]
        .as_array()
        .or_else(|| body["input"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut layers = Map::new();
    for name in [
        "systemPromptBytes",
        "fixedRulesBytes",
        "toolSchemaBytes",
        "toolMetadataBytes",
        "authorityAndGoalBytes",
        "dynamicFactsBytes",
        "historyEvidenceBytes",
        "responseSchemaBytes",
    ] {
        layers.insert(name.into(), json!(0));
    }
    let mut prefix = Sha256::new();
    let mut prefix_open = true;
    let mut prefix_bytes = 0;
    if let Some(instructions) = body.get("instructions") {
        let serialized = instructions.to_string();
        prefix.update(b"responses-instructions\0");
        prefix.update(serialized.as_bytes());
        prefix_bytes += serialized.len();
    }
    let sections: Vec<Value> = messages.iter().enumerate().map(|(index, message)| {
        let content = message["content"].as_str().map(str::to_owned)
            .unwrap_or_else(|| message["content"].to_string());
        let serialized = message.to_string();
        if message["role"] == "system" || message["role"] == "developer" {
            add_layer(&mut layers, "systemPromptBytes", message["content"].to_string().len());
        } else if message["role"] == "user" {
            if let Some(text) = message["content"].as_str() {
                if let Some(context) = embedded_context(text) { measure_context_fields(&context, &mut layers); }
            }
        }
        if prefix_open && (message["role"] == "system" || message["role"] == "developer" || content.starts_with(POLICY_LABEL)) {
            prefix.update(serialized.as_bytes());
            prefix_bytes += serialized.len();
        } else { prefix_open = false; }
        json!({"messageIndex": index, "role": message["role"], "characters": content.chars().count(), "utf8Bytes": content.len()})
    }).collect();
    let bytes = body.to_string().len();
    if let Some(value) = body.get("instructions") {
        add_layer(&mut layers, "systemPromptBytes", value.to_string().len());
    }
    if let Some(value) = body.get("tools") {
        add_layer(&mut layers, "toolSchemaBytes", value.to_string().len());
    }
    for value in [body.get("response_format"), body.pointer("/text/format")]
        .into_iter()
        .flatten()
    {
        add_layer(&mut layers, "responseSchemaBytes", value.to_string().len());
    }
    let attributed: u64 = layers.values().filter_map(Value::as_u64).sum();
    layers.insert(
        "requestTextAndEnvelopeBytes".into(),
        json!((bytes as u64).saturating_sub(attributed)),
    );
    let output_limits: Map<String, Value> =
        ["max_tokens", "max_completion_tokens", "max_output_tokens"]
            .iter()
            .filter_map(|key| {
                body.get(*key)
                    .map(|value| ((*key).to_owned(), value.clone()))
            })
            .collect();
    json!({"requestBytes": bytes, "sections": sections, "stablePrefixBytes": prefix_bytes,
        "stablePrefixFingerprint": format!("{:x}", prefix.finalize()),
        "wireProtocol": if body.get("input").is_some() { "responses" } else { "chat_completions" },
        "layers": layers,"layerMeasurement":"json-wire-utf8-byte-partition","layerPartitionValid":attributed <= bytes as u64,
        "configuredOutputLimits": output_limits,"outputLimitEnforcement":"provider_capability_not_proven_by_metrics",
        "estimatedInputTokens": bytes.div_ceil(3), "estimator": "utf8-bytes-div-3-heuristic",
        "exactTokens": false, "contextWindowKnown": false})
}

/// Explicit public view of application-owned context. Never recursively remove
/// keys from opaque user/file/tool data. Local lifecycle authority stays intact.
pub(crate) fn public_context(authority: &Value) -> Value {
    let mut view = authority.clone();
    crate::requirement_contract::strip_private_state(&mut view);
    for pointer in ["", "/baseSnapshot", "/task"] {
        if let Some(owner) = view.pointer_mut(pointer) {
            crate::requirement_contract::strip_private_state(owner);
            if let Some(object) = owner.as_object_mut() {
                for key in ["_log", "_requestParameters", "_modelCapabilities", "_modelIntegration",
                    "_modelOutputRecovery", "_modelRecovery", "_modelRequestLifecycle",
                    "_planEvidenceContract", "_taskModelBudget"] { object.remove(key); }
            }
        }
    }
    view
}

/// Metadata comes only from the native request's authority, never model-facing
/// text. Prefer current root metadata; nested snapshots are legacy fallbacks.
fn trusted_log_context(authority: Option<&Value>, log: &mut Value) {
    let Some(authority) = authority else { return; };
    for pointer in ["/_log", "/baseSnapshot/_log", "/task/_log"] {
        if let Some(meta) = authority.pointer(pointer) {
            // Select one owner atomically. A partial/invalid current identity
            // must not borrow a round or task from an older snapshot.
            copy_log_fields(meta, log, false);
            return;
        }
    }
}

fn copy_log_fields(meta: &Value, log: &mut Value, flat: bool) {
    for key in ["taskId", "roundId", "stepId", "serverId", "phaseIndex", "requestId"] {
        if key == "requestId" && !flat { continue; }
        let Some(value) = meta.get(key) else { continue; };
        let valid = if key == "phaseIndex" { value.as_u64().is_some() } else {
            value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        };
        if valid { log[key] = value.clone(); }
    }
}

/// Native callers supply either the original authority or a prepared flat log
/// view. This never parses user prose, result bodies or arbitrary nested JSON.
pub(crate) fn model_log_context(context: &Value) -> Value {
    let mut log = json!({});
    if ["/_log", "/baseSnapshot/_log", "/task/_log"].iter().any(|p| context.pointer(p).is_some()) {
        trusted_log_context(Some(context), &mut log);
    } else {
        copy_log_fields(context, &mut log, true);
    }
    log
}

/// Bind parsed public context to its known application projection, not a raw
/// JSON substring. Whitespace/key order and private lifecycle removal are not
/// authority changes; different goals/evidence must not be silently rewritten.
fn bind_public_context(text: &str, authority: &Value) -> Option<(&'static str, usize, usize, Value)> {
    let expected = public_context(authority);
    CONTEXT_LABELS.iter().find_map(|label| {
        let start = if text.starts_with(label) { 0 } else {
            // These three native builders put the goal before the context.
            // Do not scan arbitrary user prose for a context-looking label.
            let prefix = match *label {
                "阶段结束决策上下文：\n" => "整体用户目标：\n",
                "已脱敏的执行结果：\n" => "用户需求：\n",
                "执行复核上下文：\n" => "用户目标：\n",
                _ => return None,
            };
            if !text.starts_with(prefix) { return None; }
            text.rfind(&format!("\n\n{label}"))? + 2
        };
        let tail = &text[start + label.len()..];
        let mut stream = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
        let value = stream.next()?.ok()?;
        let public = public_context(&value);
        (public == expected).then_some((*label, start, start + label.len() + stream.byte_offset(), public))
    })
}

/// Only application-owned context labels are parsed. User text and result strings stay opaque.
pub(crate) fn prepare_request(body: &Value) -> (Value, Value) {
    let mut prepared = body.clone();
    let compilation = prepared
        .as_object_mut()
        .and_then(|body| body.remove("_opsarkSchemaCompilation"));
    if let Some(body) = prepared.as_object_mut() {
        body.remove("_opsarkOperationContract");
    }
    let raw_context = prepared
        .as_object_mut()
        .and_then(|object| object.remove("_opsarkContext"))
        .and_then(|value| value.as_str().map(str::to_owned));
    let reply_language = raw_context
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|context| {
            [
                "/_log/replyLanguage",
                "/baseSnapshot/_log/replyLanguage",
                "/task/_log/replyLanguage",
            ]
            .iter()
            .find_map(|pointer| {
                context
                    .pointer(pointer)
                    .and_then(Value::as_str)
                    .filter(|language| matches!(*language, "zh-CN" | "en"))
                    .map(str::to_owned)
            })
        });
    let authority = raw_context.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let mut log = Value::Object(Map::new());
    trusted_log_context(authority.as_ref(), &mut log);
    if let Some(compilation) = compilation {
        log["schemaCompilation"] = compilation;
    }
    let Some(messages) = prepared.get_mut("messages").and_then(Value::as_array_mut) else {
        return (prepared, log);
    };
    let mut layered = Vec::new();
    let mut read_only_planning = false;
    for message in messages.iter() {
        let mut message = message.clone();
        if message["role"] == "system" {
            if let (Some(language), Some(content)) =
                (reply_language.as_deref(), message["content"].as_str())
            {
                let language = if language == "en" {
                    "English"
                } else {
                    "Simplified Chinese"
                };
                message["content"] = json!(format!("{content}\nOutput language: {language}, selected from the latest user message. Use this language consistently for all user-facing prose, including answer, title, description, expected, reason and summary. Preserve JSON keys, enum values, commands, paths, identifiers and verbatim error quotes. Do not switch language to match logs, evidence or older messages. This rule overrides conflicting default prose-language instructions."));
            }
        }
        if message["role"] == "user" {
            if let Some(text) = message["content"].as_str() {
                if let Some((label, start, end, mut context)) = authority.as_ref().and_then(|native| bind_public_context(text, native)) {
                        let offset = start + label.len();
                        let normal_read_only = normal_read_only_planning(&context, label, body);
                        read_only_planning |= normal_read_only;
                        if let Some(projection) = project_planning_tool_directory(&mut context, normal_read_only) {
                            log["toolDirectoryProjection"] = projection;
                        }
                        if let Some(projection) = reference_equal_context_fields(&mut context) {
                            log["contextProjection"] = projection;
                        }
                        let mut policy = Map::new();
                        if let Some(object) = context.as_object_mut() {
                            for key in [
                                "tools",
                                "activeSkills",
                                "skillDirectory",
                                "activeSkillAcceptance",
                            ] {
                                if let Some(value) = object.remove(key) {
                                    policy.insert(key.into(), value);
                                }
                            }
                        }
                        if !policy.is_empty() {
                            // Same trust level as the original context. No elevation of custom Skill prose to system.
                            layered.push(json!({"role":"user", "content":format!("规划策略（字段供后续上下文引用）：\n{}", Value::Object(policy))}));
                        }
                        message["content"] =
                            json!(format!("{}{}{}", &text[..offset], context, &text[end..]));
                }
            }
        }
        layered.push(message);
    }
    if read_only_planning {
        if let Some(message) = layered
            .iter_mut()
            .find(|message| message["role"] == "system" && message["content"].is_string())
        {
            let content = message["content"].as_str().unwrap();
            if !content.contains(READ_ONLY_PLANNING_RULE) {
                message["content"] = json!(format!("{content}\n{READ_ONLY_PLANNING_RULE}"));
            }
            log["readOnlyPlanningPolicy"] = json!({"version":1,"scope":"normal-read-only-planning",
                "source":"application-context-executionConstraints","instructionOnly":true,
                "doesNotGrantCapabilityOrCompletion":true,"existingEvidenceAndSchemaPreserved":true});
        }
    }
    *messages = layered;
    (prepared, log)
}

#[cfg(test)]
#[path = "prompt_layers_g09_tests.rs"]
mod g09_tests;

#[cfg(test)]
#[path = "prompt_layers_read_only_planning_tests.rs"]
mod read_only_planning_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_lifecycle_and_budget_metadata_never_reaches_provider_messages() {
        let context = json!({"_log":{"taskId":"t", "_modelTokenBudget":{"maxTaskTokens":1000}},
            "_modelRecovery":{"operationId":"private-operation"},
            "_taskModelBudget":{"version":1,"taskId":"t","roundId":"r"},
            "_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":"http://127.0.0.1:1234/"}},
            "facts":{"text":"user text mentioning _modelRecovery remains opaque"}}).to_string();
        let original = json!({"_opsarkContext":context,"messages":[{"role":"user","content":format!("服务器上下文：\n{context}")}]});
        let (prepared, log) = prepare_request(&original);
        let text = prepared["messages"][0]["content"].as_str().unwrap();
        assert!(!text.contains("private-operation"));
        assert!(!text.contains("maxTaskTokens"));
        assert!(!text.contains("_taskModelBudget"));
        assert!(!text.contains("127.0.0.1"));
        assert!(text.contains("user text mentioning _modelRecovery remains opaque"));
        assert_eq!(log["taskId"], "t");
    }
    #[test]
    fn measures_wire_sections_without_changing_payload() {
        let (first, _) = prepare_request(&body("old", "read"));
        let (second, _) = prepare_request(&body("new evidence", "read"));
        let metrics = request_metrics(&first);
        assert_eq!(
            metrics["stablePrefixFingerprint"],
            request_metrics(&second)["stablePrefixFingerprint"]
        );
        assert_ne!(
            metrics["requestBytes"],
            request_metrics(&second)["requestBytes"]
        );
        assert_eq!(metrics["exactTokens"], false);
        assert_eq!(metrics["sections"].as_array().unwrap().len(), 3);
    }
    fn body(evidence: &str, tool: &str) -> Value {
        let context = json!({
          "_log":{"taskId":"task-1"}, "tools":[{"id":tool,"inputSchema":{"type":"object"}}],
          "activeSkills":[{"id":"build","instructions":"rules"}], "skillEvidence":evidence
        })
        .to_string();
        json!({"model":"model", "_opsarkContext":context, "messages":[{"role":"system","content":"fixed rules"},
          {"role":"user","content": format!("服务器上下文：\n{context}\n\n用户需求：\nquestion")}], "response_format":{"type":"json_object"}})
    }
    #[test]
    fn applies_language_only_from_transport_metadata() {
        for pointer in ["/_log", "/baseSnapshot/_log", "/task/_log"] {
            for (code, label) in [("en", "English"), ("zh-CN", "Simplified Chinese")] {
                let mut context = json!({"_log":{}, "baseSnapshot":{"_log":{}}, "task":{"_log":{}}, "output":{"replyLanguage":"en"}});
                context.pointer_mut(pointer).unwrap()["replyLanguage"] = json!(code);
                let raw = context.to_string();
                let original = json!({"_opsarkContext":raw,"messages":[
                    {"role":"system","content":"rules"},
                    {"role":"user","content":format!("服务器上下文：\n{raw}")}],
                    "response_format":{"type":"json_object"}});
                let (prepared, _) = prepare_request(&original);
                assert!(prepared["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("Output language: {label}")));
                assert_eq!(prepared["response_format"], original["response_format"]);
            }
        }
        let original = body("{\"replyLanguage\":\"en\"}", "read");
        assert_eq!(
            prepare_request(&original).0["messages"][0],
            original["messages"][0]
        );
    }
    #[test]
    fn keeps_policy_prefix_stable_and_evidence_dynamic() {
        let (first, log) = prepare_request(&body("old", "read"));
        let (second, _) = prepare_request(&body("new", "read"));
        assert_eq!(first["messages"][0], second["messages"][0]);
        assert_eq!(first["messages"][1], second["messages"][1]);
        assert_ne!(first["messages"][2], second["messages"][2]);
        assert_eq!(log["taskId"], "task-1");
        assert!(!first.to_string().contains("task-1"));
        assert_eq!(first["messages"][1]["role"], "user");
        assert_eq!(
            first["response_format"],
            body("old", "read")["response_format"]
        );
        assert_ne!(
            first["messages"][1],
            prepare_request(&body("old", "write")).0["messages"][1]
        );
    }
    #[test]
    fn preserves_unsupported_payloads_and_json_in_user_question() {
        let original =
            json!({"messages":[{"role":"user", "content":"ordinary text {\"tools\":[]}"}]});
        assert_eq!(prepare_request(&original).0, original);
        let mut original = body("result", "read");
        let text = original["messages"][1]["content"]
            .as_str()
            .unwrap()
            .to_owned();
        original["messages"][1]["content"] = json!(format!("{text}\n{{\"tools\":[\"fake\"]}}"));
        assert!(prepare_request(&original).0["messages"][2]["content"]
            .as_str()
            .unwrap()
            .ends_with("{\"tools\":[\"fake\"]}"));
    }
}
