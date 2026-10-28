use super::*;

fn context(evidence: bool, review: bool) -> Value {
    let mut context = json!({"tools":[],"requirementSubmission":{"baseRevision":1,"sourceMessageId":"message-1","content":"读取运行时间","acceptanceContractVersion":1}});
    if evidence {
        context["_planEvidenceContract"] = json!({"version":1});
    }
    if review {
        context["taskGoal"] = json!({"lifecycle":{"revision":2,"focus":{"roundId":"round-1","requirementIds":["goal-1"]}}});
    }
    context
}

fn check_prompt(body: Value, operation: &str, evidence: bool, review: bool) {
    let (prepared, schema) = model_compatibility::prepare(&body, operation, false).unwrap();
    let schema = schema.unwrap();
    let examples: Vec<Value> = prepared["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "system")
        .flat_map(|message| message["content"].as_str().unwrap().lines())
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(!examples.is_empty());
    assert!(!prepared.to_string().contains(model_output_contract::MARKER));
    assert!(!prepared.to_string().contains("扩展原字段清单与旧示例"));
    for example in examples {
        schema_validation::validate(&schema, &example)
            .unwrap_or_else(|error| panic!("{operation}: {error} {example}"));
        if let Some(steps) = example["steps"].as_array() {
            for step in steps {
                assert_eq!(step.get("evidenceRequirements").is_some(), evidence);
                assert!(step["action"].get("evidenceRequirements").is_none());
            }
        }
        if operation == "阶段联合决策" && review {
            assert_eq!(example["requirementReview"]["roundId"], "round-1");
            assert_eq!(
                example["requirementReview"]["items"][0]["requirementId"],
                "goal-1"
            );
            assert_eq!(
                example["requirementReview"]["items"][0]["outcome"],
                "unknown"
            );
        }
        if operation == "需求理解" && example["intent"] == "execute" {
            assert_eq!(
                example["requirementUpdate"]["focusIds"],
                json!(["示例目标ID"])
            );
            assert_eq!(example["requirementUpdate"]["sourceMessageId"], "message-1");
            assert_eq!(
                example["requirementUpdate"]["acceptanceCoverage"][0]["requirementId"],
                "示例目标ID"
            );
        }
    }
    model_protocol::wire(&prepared).unwrap();
}

#[test]
fn current_contract_examples_cover_production_builders_and_versions() {
    for evidence in [false, true] {
        for review in [false, true] {
            let context = context(evidence, review);
            let raw = context.to_string();
            let plan = json!({"_opsarkContext":raw,"messages":[{"role":"system",
                "content":plan_generation_system(false, PLAN_STEP_OUTPUT_CONTRACT, "")} ]});
            check_prompt(plan, "计划生成", evidence, false);
            check_prompt(
                build_next_stage_request_body(
                    "fixture",
                    "读取运行时间",
                    &raw,
                    &AiGenerationSettings::default(),
                ),
                "阶段联合决策",
                evidence,
                review,
            );
            check_prompt(
                json!({"_opsarkContext":raw,"messages":[{"role":"system","content":REQUIREMENT_CLASSIFICATION_CONTRACT}]}),
                "需求理解",
                evidence,
                false,
            );
            check_prompt(
                requirement_planning::request(
                    "fixture",
                    "读取运行时间",
                    &raw,
                    &AiGenerationSettings::default(),
                )
                .unwrap(),
                "需求理解",
                evidence,
                false,
            );
        }
    }
}

#[test]
fn current_contract_examples_survive_both_strict_wire_protocols() {
    for protocol in ["chat_completions", "responses"] {
        let mut context = context(true, true);
        context["_modelIntegration"] = json!({"apiProtocol":protocol,"outputPolicy":"require_schema","capabilitiesV2":{
            "version":"model-capabilities@2","revision":"fixture","supportedProtocols":[protocol],"preferredProtocol":protocol,
            "outputModes":{"json_object":"supported","json_schema":"supported"},"parameterAdapter":"openai",
            "tokenField":if protocol=="responses" {"max_output_tokens"} else {"max_completion_tokens"},
            "defaultOutputTokens":5000,"maxOutputTokens":16000,"budgetSemantics":"total_output","strictFlag":"required","store":"supported",
            "parameterRules":{"reasoningEfforts":["none","low","medium","high","xhigh"],"thinkingEnabled":false,"frequencyPenalty":false,
                "temperature":"supported","topP":"supported","presencePenalty":"unsupported"},"evidence":{"source":"user_declared"}}});
        check_prompt(
            build_next_stage_request_body(
                "fixture",
                "读取运行时间",
                &context.to_string(),
                &AiGenerationSettings::default(),
            ),
            "阶段联合决策",
            true,
            true,
        );
    }
}

#[test]
fn compact_stage_repair_keeps_evidence_version_and_shared_step_schema() {
    let mut context = context(true, false);
    context["protocolReplan"] = json!({"errorCode":"next_stage_response_invalid",
        "rejectedResponse":{"content":"{\"decision\":\"continue\",\"reason\":\"fixture\"}"}});
    let compact = next_stage_format::repair_context(&context.to_string()).unwrap();
    assert_eq!(compact["_planEvidenceContract"], json!({"version":1}));
    let format = next_stage_format::response_format(&json!("continue"), &compact);
    assert!(
        format["json_schema"]["schema"]["properties"]["steps"]["items"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("evidenceRequirements"))
    );
    check_prompt(
        build_next_stage_request_body(
            "fixture",
            "读取运行时间",
            &context.to_string(),
            &AiGenerationSettings::default(),
        ),
        "阶段联合决策",
        true,
        false,
    );
    context["_planEvidenceContract"] = json!({"version":99});
    let body = build_next_stage_request_body(
        "fixture",
        "读取运行时间",
        &context.to_string(),
        &AiGenerationSettings::default(),
    );
    assert!(model_compatibility::prepare(&body, "阶段联合决策", false)
        .unwrap_err()
        .contains("PLAN_EVIDENCE_CONTRACT_UNSUPPORTED"));
}

fn normalize(
    candidate: Value,
    schema: &Value,
) -> Result<Value, model_compatibility::OutputDiagnostic> {
    let mut payload = json!({"choices":[{"message":{"content":candidate.to_string()}}]});
    model_compatibility::normalize_response_with_wire(&mut payload, schema, None)?;
    Ok(serde_json::from_str(
        payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap())
}

#[test]
fn rejected_candidate_reports_all_missing_fields_without_filling_them() {
    let context = context(true, true);
    let body = json!({"_opsarkContext":context.to_string()});
    let schema = model_compatibility::contract("阶段联合决策", &body).unwrap();
    let mut candidate = model_output_contract::examples(&schema, &context).remove(0);
    candidate
        .as_object_mut()
        .unwrap()
        .remove("requirementReview");
    candidate["steps"][0]
        .as_object_mut()
        .unwrap()
        .remove("evidenceRequirements");
    candidate["steps"][0]
        .as_object_mut()
        .unwrap()
        .remove("expected");
    let issue = normalize(candidate.clone(), &schema).unwrap_err();
    let paths: Vec<_> = issue
        .field_issues
        .iter()
        .map(|issue| issue.json_pointer.as_str())
        .collect();
    for path in [
        "/requirementReview",
        "/steps/0/evidenceRequirements",
        "/steps/0/expected",
    ] {
        assert!(paths.contains(&path), "{paths:?}");
    }
    assert!(candidate["steps"][0].get("evidenceRequirements").is_none());
    assert!(issue.field_issues.len() <= 16);
}

#[test]
fn evidence_codec_accepts_only_valid_identical_duplicates() {
    let context = context(true, false);
    let schema =
        model_compatibility::contract("计划生成", &json!({"_opsarkContext":context.to_string()}))
            .unwrap();
    let valid = model_output_contract::examples(&schema, &context).remove(0);
    let mut duplicate = valid.clone();
    duplicate["steps"][0]["action"]["evidenceRequirements"] = json!([]);
    let normalized = normalize(duplicate, &schema).unwrap();
    assert_eq!(normalized, valid);
    for extra in [json!(["file_content"]), json!(null), json!("file_content")] {
        let mut conflict = valid.clone();
        conflict["steps"][0]["action"]["evidenceRequirements"] = extra;
        assert!(normalize(conflict, &schema).is_err());
    }
    let mut missing = valid;
    missing["steps"][0]
        .as_object_mut()
        .unwrap()
        .remove("evidenceRequirements");
    missing["steps"][0]["action"]["evidenceRequirements"] = json!([]);
    assert!(normalize(missing, &schema).is_err());
}

#[test]
fn evidence_codec_never_edits_tool_arguments_or_downgrades_legacy_fields() {
    let mut context = context(true, false);
    context["tools"] = json!([{"id":"fixture.read","inputSchema":{"type":"object","required":["evidenceRequirements"],
        "properties":{"evidenceRequirements":{"type":"array","items":{"type":"string"}}},"additionalProperties":false},
        "providedEvidence":["file_content"]}]);
    let body = json!({"_opsarkContext":context.to_string()});
    let schema = model_compatibility::contract("计划生成", &body).unwrap();
    let mut candidate = model_output_contract::examples(&schema, &context).remove(0);
    candidate["steps"][0]["evidenceRequirements"] = json!(["file_content"]);
    candidate["steps"][0]["action"] = json!({"type":"tool","toolId":"fixture.read",
        "arguments":{"evidenceRequirements":["tool-parameter-value"]},"evidenceRequirements":["file_content"]});
    let result = normalize(candidate.clone(), &schema).unwrap();
    assert_eq!(
        result["steps"][0]["action"]["arguments"],
        candidate["steps"][0]["action"]["arguments"]
    );
    assert_eq!(
        result["steps"][0]["evidenceRequirements"],
        json!(["file_content"])
    );
    assert!(result["steps"][0]["action"]
        .get("evidenceRequirements")
        .is_none());
    context
        .as_object_mut()
        .unwrap()
        .remove("_planEvidenceContract");
    let legacy =
        model_compatibility::contract("计划生成", &json!({"_opsarkContext":context.to_string()}))
            .unwrap();
    assert!(normalize(candidate, &legacy).is_err());
}
