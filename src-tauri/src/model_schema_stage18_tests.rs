//! Local protocol checks only; no external inference or server operations.
use super::*;

fn tools() -> Value {
    json!([
        {"id":"files.read_content","outputDescription":"返回UTF-8文本正文content与截断状态。","inputSchema":{"type":"object","additionalProperties":false,
            "required":["path"],"properties":{"path":{"type":"string","minLength":1},"maxBytes":{"type":"integer","minimum":1,"maximum":262144}}}},
        {"id":"files.preview_deletion","outputDescription":"仅返回元数据；不含content，不提供配置正文。","inputSchema":{"type":"object","additionalProperties":false,
            "required":["paths"],"properties":{"paths":{"type":"array","minItems":1,"maxItems":100,"uniqueItems":true,"items":{"type":"string","minLength":1}}}}}
    ])
}
fn source(tools:Value)->Value {
    crate::model_compatibility::full_contract("计划生成",&json!({"_opsarkContext":json!({"tools":tools}).to_string()})).unwrap()
}
fn candidate(tool:&str,arguments:Value)->Value {
    json!({"steps":[{"kind":"observe","title":"读取配置正文","description":"计划正文不是执行证据","action":{"type":"tool","toolId":tool,"arguments":arguments},
        "expected":"取得实际证据","validation":"","risk":"low","executionScope":null,"validationScope":null,"runtimeClass":null,
        "sessionContextChange":null,"recovery":null,"retryBasis":null}]})
}

fn without_annotations(schema:&Value)->Value {
    let mut schema=schema.clone();
    if let Some(object)=schema.as_object_mut() {
        object.remove("description");
        if let Some(properties)=object.get_mut("properties").and_then(Value::as_object_mut) {
            for child in properties.values_mut() { *child=without_annotations(child); }
        }
        if let Some(items)=object.get_mut("items") { *items=without_annotations(items); }
        for key in ["anyOf","oneOf","allOf"] {
            if let Some(branches)=object.get_mut(key).and_then(Value::as_array_mut) {
                for child in branches { *child=without_annotations(child); }
            }
        }
    }
    schema
}

#[test]
fn stage18_choice_annotations_survive_actual_compiler_with_exact_tags_and_bounded_prose() {
    let mut tools=tools();tools[0]["outputDescription"]=json!("正文😀".repeat(100));
    let source=source(tools.clone());let original=source.clone();let wire=compile(&source).unwrap();
    assert_eq!(source,original);
    let branches=wire.schema.pointer("/properties/steps/items/properties/action/anyOf").unwrap().as_array().unwrap();
    assert_eq!(branches.len(),3);
    for (index,tool) in tools.as_array().unwrap().iter().enumerate() {
        let tag=&branches[index+1]["properties"]["toolId"];
        assert_eq!(tag["enum"],json!([tool["id"]]));
        assert!(tag["description"].as_str().unwrap().len()<=160);
        assert_eq!(branches[index+1]["required"],json!(["arguments","toolId","type"]));
    }
    assert!(branches[2]["properties"]["toolId"]["description"].as_str().unwrap().contains("不含content"));
}

#[test]
fn stage18_array_hint_is_advisory_and_original_nonempty_constraint_stays_enforced() {
    let source=source(tools());let compiled=compile(&source).unwrap();
    let paths=compiled.schema.pointer("/properties/steps/items/properties/action/anyOf/2/properties/arguments/properties/paths").unwrap();
    assert!(paths.get("minItems").is_none());
    assert!(paths["description"].as_str().unwrap().contains("minItems=1"));
    assert!(compiled.report["residualRules"].as_array().unwrap().iter().any(|rule|rule["keyword"]=="minItems"));
    let invalid=candidate("files.preview_deletion",json!({"paths":[]}));
    assert!(crate::schema_validation::validate(&compiled.schema,&invalid).is_ok(),"wire hint must not be mistaken for provider enforcement");
    let mut payload=json!({"choices":[{"message":{"content":invalid.to_string()},"finish_reason":"stop"}]});
    let issue=crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(&compiled.schema)).unwrap_err();
    assert_eq!(issue.stage,"business_validation");
    assert_eq!(issue.keyword.as_deref(),Some("minItems"));
}

#[test]
fn stage18_correct_read_and_valid_preview_stay_distinct_and_keep_nullable_optional_decoding() {
    let source=source(tools());let compiled=compile(&source).unwrap();
    for value in [candidate("files.read_content",json!({"path":"/srv/config.json","maxBytes":null})),candidate("files.preview_deletion",json!({"paths":["/srv/config.json"]}))] {
        let expected_id=value["steps"][0]["action"]["toolId"].clone();
        let mut payload=json!({"choices":[{"message":{"content":value.to_string()},"finish_reason":"stop"}]});
        crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(&compiled.schema)).unwrap();
        let decoded:Value=serde_json::from_str(payload["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
        assert_eq!(decoded["steps"][0]["action"]["toolId"],expected_id);
        assert!(decoded["steps"][0]["action"]["arguments"].get("maxBytes").is_none());
    }
    let mut mixed=candidate("files.read_content",json!({"path":"/srv/config.json","maxBytes":null}));
    mixed["steps"].as_array_mut().unwrap().push(candidate("files.preview_deletion",json!({"paths":["/srv/old.log"]}))["steps"][0].clone());
    assert!(crate::schema_validation::validate(&compiled.schema,&mixed).is_ok());
    assert!(crate::schema_validation::validate(&source,&candidate("files.read_content",json!({"paths":["/srv/config.json"]}))).is_err());
}

#[test]
#[ignore = "explicit local historical artifacts only; no provider or SSH calls"]
fn stage18_frozen_tool_contracts_offline_replay() {
    let path=std::env::var("OPSARK_STAGE18_FIXTURE").expect("frozen fixture path");
    let fixture:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut records=Vec::new();
    for sample in fixture["samples"].as_array().unwrap() {
        let original_body=&sample["body"];
        let context=&sample["context"];
        let source=crate::model_compatibility::full_contract("计划生成",&json!({"_opsarkContext":context.to_string()})).unwrap();
        let compiled=compile(&source).unwrap();
        let new=&compiled.schema;
        let old=&original_body["response_format"]["json_schema"]["schema"];
        assert_eq!(without_annotations(old),without_annotations(new),"all original structural constraints, branches and nullable fields must be preserved");
        let pointer="/properties/steps/items/properties/action/anyOf";
        let before=old.pointer(pointer).unwrap().as_array().unwrap();
        let after=new.pointer(pointer).unwrap().as_array().unwrap();
        assert_eq!(before.len(),after.len());
        let mut annotations=0;
        for (before,after) in before.iter().zip(after) {
            assert_eq!(before["properties"]["type"],after["properties"]["type"]);
            assert_eq!(before["required"],after["required"]);
            if before["properties"].get("toolId").is_some() {
                assert_eq!(before["properties"]["toolId"]["enum"],after["properties"]["toolId"]["enum"]);
                let hint=after["properties"]["toolId"]["description"].as_str().unwrap();
                assert!(hint.len()<=160);annotations+=1;
            }
        }
        let mut empty_rejected=0;let mut legal_preview=0;
        for candidate in sample["candidates"].as_array().unwrap() {
            let action=&candidate["steps"][0]["action"];
            let mut payload=json!({"choices":[{"message":{"content":candidate.to_string()},"finish_reason":"stop"}]});
            if action["toolId"]=="files.preview_deletion" && action["arguments"]["paths"]==json!([]) {
                let error=crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(new)).unwrap_err();
                assert_eq!(error.keyword.as_deref(),Some("minItems"));empty_rejected+=1;
            } else if action["toolId"]=="files.preview_deletion" {
                crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(new)).unwrap();legal_preview+=1;
            }
        }
        assert!(empty_rejected>0,"real empty candidate must remain rejected");
        let mut read=candidate("files.read_content",json!({"path":"/srv/config.json","maxBytes":null}));
        let read_tool=context["tools"].as_array().unwrap().iter().find(|tool|tool["id"]=="files.read_content").unwrap();
        // Use the original branch's optional field names, all absent optional values stay null on wire.
        let args=read["steps"][0]["action"]["arguments"].as_object_mut().unwrap();
        args.clear();args.insert("path".into(),json!("/srv/config.json"));
        for (key,_) in read_tool["inputSchema"]["properties"].as_object().unwrap() {
            if key!="path" {args.insert(key.clone(),Value::Null);}
        }
        let mut payload=json!({"choices":[{"message":{"content":read.to_string()},"finish_reason":"stop"}]});
        crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(new)).unwrap();
        let mut body=original_body.clone();body["response_format"]["json_schema"]["schema"]=new.clone();
        let old_bytes=original_body.to_string().len();let new_bytes=body.to_string().len();
        records.push(json!({"sample":sample["name"],"toolBranches":annotations,"actionBranchesUnchanged":true,"structuralSchemaUnchanged":true,"emptyCandidatesRejected":empty_rejected,
            "validPreviewCandidates":legal_preview,"correctReadAccepted":true,"oldWireBytes":old_bytes,"newWireBytes":new_bytes,
            "wireByteDelta":new_bytes as i64-old_bytes as i64,"providerCalls":0,"unit":"utf8_bytes_not_actual_tokens",
            "semanticToolChoiceProven":false}));
    }
    assert_eq!(records.len(),3);
    let output=std::env::var("OPSARK_STAGE18_RESULT").expect("unique output path");
    use std::io::Write;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(output).unwrap();
    file.write_all(serde_json::to_string_pretty(&records).unwrap().as_bytes()).unwrap();
    println!("离线回放结果 {}",json!(records));
}
