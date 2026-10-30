//! Narrow compatibility coverage for a continuing stage's omitted display summary.
//! Local fixtures only: no credentials, model calls or remote command execution.

use crate::model_compatibility::{
    candidate_field_issues, contract, normalize_response_with_wire, OutputDiagnostic,
};
use serde_json::{json, Value};

#[test]
fn windows_logged_candidates_keep_the_original_pipeline_gate_and_admit_only_the_corrected_proposal() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/windows-summary-continue-20261028.json"
    )).unwrap();
    let schema = contract("阶段联合决策", &json!({"_opsarkContext":json!({
        "_planEvidenceContract":{"version":1},
        "tools":[{"id":"files.get_structure","inputSchema":{
            "type":"object","required":["rootPath"],"additionalProperties":false,
            "properties":{"rootPath":{"type":"string"},"maxDepth":{"type":"integer"},"maxNodes":{"type":"integer"}}
        }}]
    }).to_string()})).unwrap();
    let initial = normalized(&fixtures["initial"], &schema, None).unwrap();
    let original_validation = initial["steps"][0]["validation"].clone();
    let raw = serde_json::from_value::<crate::AiNextStageDecision>(initial).unwrap();
    let failure = crate::validate_and_convert_ai_next_stage(raw, &Default::default(), None).unwrap_err();
    assert!(failure.contains("PIPELINE_STATUS_LOST"), "the command gate must still reject the original plan: {failure}");
    assert_eq!(fixtures["initial"]["steps"][0]["validation"], original_validation);

    let mut expected = fixtures["regenerated"].clone();
    expected["summary"] = expected["reason"].clone();
    let corrected = normalized(&fixtures["regenerated"], &schema, None).unwrap();
    assert_eq!(corrected, expected, "only the absent summary is compatible");
    let raw = serde_json::from_value::<crate::AiNextStageDecision>(corrected).unwrap();
    let accepted = crate::validate_and_convert_ai_next_stage(raw, &Default::default(), None).unwrap();
    assert_eq!(accepted.decision, "continue");
    assert_eq!(accepted.steps.len(), 2);
    assert_eq!(accepted.requirement_review.unwrap(), fixtures["regenerated"]["requirementReview"]);
    assert_eq!(serde_json::to_value(&accepted.steps[0].action).unwrap(), fixtures["regenerated"]["steps"][0]["action"]);
    assert_eq!(accepted.steps[0].validation, fixtures["regenerated"]["steps"][0]["validation"].as_str().unwrap());
}

fn stage_contract() -> Value {
    contract(
        "阶段联合决策",
        &json!({"_opsarkContext":json!({"_planEvidenceContract":{"version":1}}).to_string()}),
    )
    .unwrap()
}

fn continuing_stage() -> Value {
    json!({
        "decision":"continue",
        "reason":"  \t前一步只读检查已结束；继续核对目录。\n  ",
        "steps":[{
            "kind":"observe",
            "title":"读取测试目录占用",
            "description":"仅生成待执行的只读候选",
            "action":{"type":"shell","command":"printf '%s\\n' 'summary-compat-fixture'"},
            "expected":"取得目录占用观察结果",
            "validation":"保留现有校验文本",
            "risk":"low",
            "evidenceRequirements":[],
            "sessionContextChange":{"reason":"保留模型原始元数据","fixture":true}
        }],
        "requirementReview":{
            "baseRevision":0,"roundId":"fixture-round",
            "focusOutcome":"pending","overallOutcome":"pending",
            "items":[{"requirementId":"fixture-goal","outcome":"unknown",
                "evidenceIds":[],"reason":"尚待执行，不声称目标已经完成"}]
        },
        "planUpdate":{"basePlanFingerprint":"fixture-plan","replaceStepIds":[],"reason":"保留原值"},
        "reconciliation":{"fixture":"仅用于验证字段不被改写"}
    })
}

fn envelope(value: &Value) -> Value {
    json!({"choices":[{"message":{"content":value.to_string()},"finish_reason":"stop"}]})
}

fn normalized(value: &Value, schema: &Value, wire: Option<&Value>) -> Result<Value, OutputDiagnostic> {
    let mut response = envelope(value);
    normalize_response_with_wire(&mut response, schema, wire)?;
    Ok(serde_json::from_str(response["choices"][0]["message"]["content"].as_str().unwrap()).unwrap())
}

fn assert_missing_summary_is_rejected(value: &Value, schema: &Value) {
    let original = value.clone();
    let mut response = envelope(value);
    let original_response = response.clone();
    assert!(normalize_response_with_wire(&mut response, schema, None).is_err());
    assert_eq!(response, original_response, "a rejected candidate must not replace the wire result");
    let issues = candidate_field_issues(value, schema);
    assert!(issues.iter().any(|issue| issue.instance_path == "/summary" && issue.keyword == "required"),
        "the missing summary must remain a real issue: {issues:?}");
    assert_eq!(value, &original, "candidate diagnostics must be read-only");
}

fn strict_wire_value(mut value: Value) -> Value {
    for field in ["planUpdate", "reconciliation", "requirementReview", "blocking", "issueResolutions"] {
        value.as_object_mut().unwrap().entry(field).or_insert(Value::Null);
    }
    for step in value["steps"].as_array_mut().unwrap() {
        for field in ["executionScope", "validationScope", "runtimeClass", "sessionContextChange", "recovery", "retryBasis"] {
            step.as_object_mut().unwrap().entry(field).or_insert(Value::Null);
        }
        if step["sessionContextChange"].is_object() {
            step["sessionContextChange"] = json!(step["sessionContextChange"].to_string());
        }
    }
    // Opaque metadata is JSON text in the compiled strict wire contract and
    // decoded back to the same business object after wire validation.
    for field in ["planUpdate", "reconciliation"] {
        if value[field].is_object() { value[field] = json!(value[field].to_string()); }
    }
    value
}

#[test]
fn missing_continue_summary_copies_current_reason_bytes_and_nothing_else() {
    let schema = stage_contract();
    let value = continuing_stage();
    let mut expected = value.clone();
    expected["summary"] = value["reason"].clone();
    let actual = normalized(&value, &schema, None).unwrap();
    assert_eq!(actual["summary"].as_str().unwrap().as_bytes(), value["reason"].as_str().unwrap().as_bytes());
    assert_eq!(actual, expected, "actions, validation, review, evidence and metadata must be untouched");
    assert_eq!(actual["decision"], "continue");
    assert_eq!(actual["requirementReview"]["overallOutcome"], "pending");
}

#[test]
fn existing_summary_including_empty_text_is_never_replaced() {
    let schema = stage_contract();
    for summary in ["原始摘要不同于原因", "", " \t\n "] {
        let mut value = continuing_stage();
        value["summary"] = json!(summary);
        assert_eq!(normalized(&value, &schema, None).unwrap(), value);
        assert!(candidate_field_issues(&value, &schema).is_empty());
    }
    // Empty text is currently a schema-valid string. Its consumer's semantic
    // non-empty check remains separate; this compatibility must not repair it.
}

#[test]
fn explicitly_invalid_summary_is_not_replaced_by_a_valid_reason() {
    let schema = stage_contract();
    for summary in [Value::Null, json!({}), json!([]), json!(7), json!(false)] {
        let mut value = continuing_stage();
        value["summary"] = summary.clone();
        assert!(normalized(&value, &schema, None).is_err(), "summary={summary}");
        let issues = candidate_field_issues(&value, &schema);
        assert!(issues.iter().any(|issue| issue.instance_path == "/summary" && issue.keyword == "type"));
        assert_eq!(value["summary"], summary);
    }
}

#[test]
fn completion_and_adjustment_never_gain_a_missing_summary() {
    let schema = stage_contract();
    for decision in ["complete", "adjust", "CONTINUE", "continue "] {
        let mut value = continuing_stage();
        value["decision"] = json!(decision);
        assert_missing_summary_is_rejected(&value, &schema);
    }
}

#[test]
fn absent_empty_or_non_array_steps_do_not_enable_summary_compatibility() {
    let schema = stage_contract();
    let mut absent = continuing_stage();
    absent.as_object_mut().unwrap().remove("steps");
    assert_missing_summary_is_rejected(&absent, &schema);
    for steps in [json!([]), Value::Null, json!({}), json!("not-an-array")] {
        let mut value = continuing_stage();
        value["steps"] = steps;
        assert_missing_summary_is_rejected(&value, &schema);
    }
}

#[test]
fn absent_non_string_or_blank_reason_cannot_supply_a_summary() {
    let schema = stage_contract();
    let mut absent = continuing_stage();
    absent.as_object_mut().unwrap().remove("reason");
    assert_missing_summary_is_rejected(&absent, &schema);
    for reason in [Value::Null, json!(0), json!(false), json!({}), json!([]), json!(""), json!(" \t\r\n "), json!("\u{3000}")] {
        let mut value = continuing_stage();
        value["reason"] = reason;
        assert_missing_summary_is_rejected(&value, &schema);
    }
}

#[test]
fn compatibility_requires_the_complete_root_stage_contract() {
    let value = continuing_stage();
    for field in ["decision", "reason", "steps"] {
        let mut schema = stage_contract();
        schema["required"].as_array_mut().unwrap().retain(|required| required.as_str() != Some(field));
        assert_missing_summary_is_rejected(&value, &schema);
    }
    let mut optional_summary = stage_contract();
    optional_summary["required"].as_array_mut().unwrap().retain(|required| required.as_str() != Some("summary"));
    let actual = normalized(&value, &optional_summary, None).unwrap();
    assert!(actual.get("summary").is_none(), "an optional summary must not be inserted");

    for field in ["reason", "summary"] {
        let mut schema = stage_contract();
        schema["properties"][field] = json!({"anyOf":[{"type":"string"},{"type":"null"}]});
        assert_missing_summary_is_rejected(&value, &schema);
    }
    let mut non_object_root = stage_contract();
    non_object_root["type"] = json!("array");
    assert_missing_summary_is_rejected(&value, &non_object_root);
}

#[test]
fn unrelated_and_nested_contracts_do_not_receive_stage_summary_compatibility() {
    let value = continuing_stage();
    let review = contract("结果复核", &json!({})).unwrap();
    assert_missing_summary_is_rejected(&value, &review);

    let schema = json!({"type":"object","properties":{"result":stage_contract()},"required":["result"],"additionalProperties":false});
    let nested = json!({"result":value});
    assert!(normalized(&nested, &schema, None).is_err());
    let issues = candidate_field_issues(&nested, &schema);
    assert!(issues.iter().any(|issue| issue.instance_path == "/result/summary" && issue.keyword == "required"));
}

#[test]
fn other_contract_failures_are_still_rejected_without_business_field_repair() {
    let schema = stage_contract();
    for (pointer, invalid) in [
        ("/steps/0/action/command", json!(7)),
        ("/steps/0/validation", json!({"invented":"validation"})),
        ("/steps/0/evidenceRequirements", json!(["invented_evidence"])),
        ("/requirementReview/overallOutcome", json!("completed_without_evidence")),
    ] {
        let mut value = continuing_stage();
        *value.pointer_mut(pointer).unwrap() = invalid;
        let original = value.clone();
        assert!(normalized(&value, &schema, None).is_err(), "{pointer}");
        assert!(!candidate_field_issues(&value, &schema).is_empty(), "{pointer}");
        assert_eq!(value, original);
    }
    let mut constraints = continuing_stage();
    constraints["constraints"] = json!({"inventedPermission":"allowed"});
    assert!(normalized(&constraints, &schema, None).is_err());
    assert!(candidate_field_issues(&constraints, &schema).iter().any(|issue| issue.instance_path == "/constraints"));
}

#[test]
fn invalid_metadata_stays_invalid_even_when_the_summary_can_be_copied() {
    let schema = stage_contract();
    for metadata in [json!("[]"), json!("not-json"), json!("42")] {
        let mut value = continuing_stage();
        value["planUpdate"] = metadata.clone();
        let error = normalized(&value, &schema, None).unwrap_err();
        assert_eq!(error.code, "MODEL_FORMAT_INVALID");
        assert_eq!(value["planUpdate"], metadata);
        assert!(value.get("summary").is_none());
    }
}

#[test]
fn malformed_json_and_rejected_envelopes_are_not_rescued_by_summary_compatibility() {
    let schema = stage_contract();
    let mut broken = json!({"choices":[{"message":{"content":"{\"decision\":\"continue\",\"reason\":\"r\",\"steps\":["}}]});
    assert_eq!(normalize_response_with_wire(&mut broken, &schema, None).unwrap_err().stage, "json_parse");
    let mut refused = envelope(&continuing_stage());
    refused["choices"][0]["message"]["refusal"] = json!("declined");
    assert_eq!(normalize_response_with_wire(&mut refused, &schema, None).unwrap_err().code, "MODEL_OUTPUT_REFUSED");
    let mut tools = envelope(&continuing_stage());
    tools["choices"][0]["message"]["tool_calls"] = json!([{"id":"not-a-business-response"}]);
    assert_eq!(normalize_response_with_wire(&mut tools, &schema, None).unwrap_err().code, "MODEL_RESPONSE_INVALID");
}

#[test]
fn strict_wire_validation_uses_the_same_narrow_summary_rule() {
    let schema = stage_contract();
    let wire = crate::model_schema::compile(&schema).unwrap().schema;
    let original = continuing_stage();
    let value = strict_wire_value(original.clone());
    let mut expected = original;
    expected["summary"] = expected["reason"].clone();
    assert_eq!(normalized(&value, &schema, Some(&wire)).unwrap(), expected);
    for decision in ["complete", "adjust"] {
        let mut forbidden = value.clone();
        forbidden["decision"] = json!(decision);
        assert!(normalized(&forbidden, &schema, Some(&wire)).is_err());
    }
    let mut explicit_null = value;
    explicit_null["summary"] = Value::Null;
    assert!(normalized(&explicit_null, &schema, Some(&wire)).is_err());
}

#[test]
fn candidate_diagnostics_match_compatibility_without_mutating_the_candidate() {
    let schema = stage_contract();
    let value = continuing_stage();
    let original = value.clone();
    assert!(candidate_field_issues(&value, &schema).is_empty());
    assert_eq!(value, original);
    assert!(normalized(&value, &schema, None).is_ok());

    let mut invalid_action = value;
    invalid_action["steps"][0]["action"].as_object_mut().unwrap().remove("command");
    let issues = candidate_field_issues(&invalid_action, &schema);
    assert!(issues.iter().all(|issue| issue.instance_path != "/summary"));
    assert!(issues.iter().any(|issue| issue.instance_path == "/steps/0/action/command"));
    assert!(normalized(&invalid_action, &schema, None).is_err());
}
