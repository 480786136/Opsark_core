use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/joint-requirement-stage30.json"
    ))
    .unwrap()
}
fn rejected(payload: Value) -> model::RejectedRequirementCandidate {
    model::RejectedRequirementCandidate {
        payload,
        error: "original-typed-plan-rejection".into(),
    }
}
fn classify(
    f: &Value,
    payload: Value,
    context: &Value,
) -> Result<RequirementProcessingResult, String> {
    classification_from_rejected_plan(
        &rejected(payload),
        &json!({"_opsarkContext":context.to_string()}),
        &context.to_string(),
        f["requirement"].as_str().unwrap(),
        &Default::default(),
        &[],
    )
}
fn modified(f: &Value, edit: impl FnOnce(&mut Value)) -> Value {
    let mut payload = f["payload"].clone();
    let mut v = f["response"].clone();
    edit(&mut v);
    payload["choices"][0]["message"]["content"] = json!(v.to_string());
    payload
}

#[test]
fn stage31_real_rejected_plan_yields_only_fully_validated_classification() {
    let f = fixture();
    let frozen = f.clone();
    let result = classify(&f, f["payload"].clone(), &f["context"]).unwrap();
    assert_eq!(result.intent, "execute");
    assert_eq!(result.relation.as_deref(), Some("new_goal"));
    assert_eq!(result.constraints.unwrap().change_policy, "confirm_changes");
    let mut update = f["response"]["requirementUpdate"].clone();
    for coverage in update["acceptanceCoverage"].as_array_mut().unwrap() {
        coverage.as_object_mut().unwrap().remove("staticSite");
    }
    assert_eq!(result.requirement_update, Some(update));
    assert!(result.plan.is_empty());
    assert_eq!(
        result.plan_error.as_deref(),
        Some("original-typed-plan-rejection")
    );
    assert_eq!(f, frozen);
}

#[test]
fn stage31_classification_guard_rejects_policy_relation_revision_quote_and_unknown_fields() {
    let f = fixture();
    for edit in 0..6 {
        let p = modified(&f, |v| match edit {
            0 => v["constraints"]["environmentPolicy"] = json!(""),
            1 => v["relation"] = json!("side_question"),
            2 => v["requirementUpdate"]["baseRevision"] = json!(99),
            3 => v["requirementUpdate"]["sourceMessageId"] = json!("stale-message"),
            4 => {
                v["requirementUpdate"]["additions"][0]["sourceQuote"] = json!("invented authority")
            }
            _ => v["unexpectedAuthority"] = json!("must-not-pass"),
        });
        assert!(classify(&f, p, &f["context"]).is_err(), "edit={edit}");
    }
}

#[test]
fn stage31_answers_skills_refusals_and_native_tools_cannot_use_plan_handoff() {
    let f = fixture();
    for (field, value) in [
        ("intent", json!("answer")),
        ("selectedSkillIds", json!(["selected-skill"])),
    ] {
        assert!(classify(&f, modified(&f, |v| v[field] = value), &f["context"]).is_err());
    }
    for key in ["refusal", "tool_calls"] {
        let mut p = f["payload"].clone();
        p["choices"][0]["message"][key] = if key == "refusal" {
            json!("refused")
        } else {
            json!([{}])
        };
        assert!(classify(&f, p, &f["context"]).is_err());
    }
}

#[test]
fn stage31_json_only_optional_omissions_keep_the_same_classification_gate() {
    let f = fixture();
    let p = modified(&f, |v| {
        v.as_object_mut().unwrap().remove("terminalContextLines");
        for x in v["requirementUpdate"]["acceptanceCoverage"]
            .as_array_mut()
            .unwrap()
        {
            x.as_object_mut().unwrap().remove("staticSite");
        }
    });
    assert!(classify(&f, p, &f["context"]).unwrap().plan.is_empty());
}

#[test]
fn stage31_newer_lifecycle_or_source_message_prevents_reusing_old_classification() {
    let f = fixture();
    for field in ["revision", "sourceMessageId"] {
        let mut ctx = f["context"].clone();
        if field == "revision" {
            ctx["requirementSubmission"]["baseLifecycle"]["revision"] = json!(1);
        } else {
            ctx["requirementSubmission"]["sourceMessageId"] = json!("new-source-message");
        }
        assert!(classify(&f, f["payload"].clone(), &ctx).is_err(), "{field}");
    }
}
