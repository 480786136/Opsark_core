//! Offline regression for bounded annotations and exact historical byte comparisons.
use super::*;

fn source(tools:Value)->Value {
    crate::model_compatibility::full_contract("计划生成",&json!({"_opsarkContext":json!({"tools":tools}).to_string()})).unwrap()
}

fn structural(schema:&Value)->Value {
    let mut schema=schema.clone();
    if let Some(object)=schema.as_object_mut() {
        object.remove("description");
        if let Some(properties)=object.get_mut("properties").and_then(Value::as_object_mut) {
            for child in properties.values_mut() { *child=structural(child); }
        }
        if let Some(items)=object.get_mut("items") { *items=structural(items); }
        for key in ["anyOf","oneOf","allOf"] {
            if let Some(branches)=object.get_mut(key).and_then(Value::as_array_mut) {
                for child in branches { *child=structural(child); }
            }
        }
    }
    schema
}

#[test]
fn stage19_capability_annotations_preserve_short_text_and_mark_unicode_truncation() {
    for description in ["返回正文与截断状态。".to_owned(),"正文😀".repeat(100)] {
        let source=source(json!([{"id":"files.read_content","outputDescription":description,"inputSchema":{"type":"object","additionalProperties":false,"properties":{}}}]));
        let compiled=compile(&source).unwrap();
        let text=compiled.schema.pointer("/properties/steps/items/properties/action/anyOf/1/properties/toolId/description").unwrap().as_str().unwrap();
        assert!(text.len()<=160);
        assert!(text.starts_with("返回能力："));
        if description.len()+"返回能力：".len()<=160 {
            assert_eq!(text,format!("返回能力：{description}"));
        } else {
            assert!(text.ends_with('…'));
            assert!(description.starts_with(text.strip_prefix("返回能力：").unwrap().strip_suffix('…').unwrap()));
        }
    }
}

#[test]
fn stage19_compact_minimum_keeps_exact_bound_existing_prose_and_original_validation() {
    let original=json!({"type":"object","additionalProperties":false,"required":["values"],"properties":{
        "values":{"type":"array","minItems":2,"description":"原始业务边界不得丢失。","items":{"type":"string"}}}});
    let snapshot=original.clone();let compiled=compile(&original).unwrap();
    assert_eq!(original,snapshot);
    assert_eq!(compiled.schema["properties"]["values"]["description"],"原始业务边界不得丢失。 minItems=2; local check.");
    assert!(compiled.schema["properties"]["values"].get("minItems").is_none());
    assert!(crate::schema_validation::validate(&original,&json!({"values":["only-one"]})).is_err());
    assert!(crate::schema_validation::validate(&original,&json!({"values":["one","two"]})).is_ok());
    assert!(compiled.report["residualRules"].as_array().unwrap().iter().any(|r|r["keyword"]=="minItems"));
}

#[test]
#[ignore = "explicit frozen local inputs and previous result; no provider or server access"]
fn stage19_frozen_wire_cost_offline_replay() {
    let fixture:Value=serde_json::from_slice(&std::fs::read(std::env::var("OPSARK_STAGE19_FIXTURE").unwrap()).unwrap()).unwrap();
    let baseline:Value=serde_json::from_slice(&std::fs::read(std::env::var("OPSARK_STAGE19_BASELINE").unwrap()).unwrap()).unwrap();
    let mut records=Vec::new();
    for sample in fixture["samples"].as_array().unwrap() {
        let source=source(sample["context"]["tools"].clone());let compiled=compile(&source).unwrap();
        let original=&sample["body"];
        assert_eq!(structural(&original["response_format"]["json_schema"]["schema"]),structural(&compiled.schema));
        let mut wire=original.clone();wire["response_format"]["json_schema"]["schema"]=compiled.schema.clone();
        let before=baseline.as_array().unwrap().iter().find(|row|row["sample"]==sample["name"]).unwrap();
        assert_eq!(original.to_string().len() as u64,before["oldWireBytes"].as_u64().unwrap());
        let previous=before["newWireBytes"].as_u64().unwrap();let now=wire.to_string().len() as u64;
        assert!(now<previous,"new descriptions must shrink every frozen request");
        let branches=compiled.schema.pointer("/properties/steps/items/properties/action/anyOf").unwrap().as_array().unwrap();
        let tool_count=sample["context"]["tools"].as_array().unwrap().len();assert_eq!(branches.len(),tool_count+1);
        for branch in branches.iter().skip(1) {
            assert!(branch["properties"]["toolId"]["description"].as_str().unwrap().len()<=160);
        }
        let mut rejected=0;
        for candidate in sample["candidates"].as_array().unwrap() {
            let mut payload=json!({"choices":[{"message":{"content":candidate.to_string()},"finish_reason":"stop"}]});
            let action=&candidate["steps"][0]["action"];
            let result=crate::model_compatibility::normalize_response_with_wire(&mut payload,&source,Some(&compiled.schema));
            if action["toolId"]=="files.preview_deletion" && action["arguments"]["paths"]==json!([]) {
                assert_eq!(result.unwrap_err().keyword.as_deref(),Some("minItems"));rejected+=1;
            } else { result.unwrap(); }
        }
        assert!(rejected>0);
        records.push(json!({"sample":sample["name"],"stage18WireBytes":previous,"stage19WireBytes":now,"savedBytes":previous-now,
            "originalStage17WireBytes":original.to_string().len(),"remainingByteIncreaseFromStage17":now-original.to_string().len() as u64,
            "toolBranches":tool_count,"structuralSchemaUnchanged":true,"emptyPathsRejected":true,"providerCalls":0,"unit":"utf8_bytes_not_actual_tokens"}));
    }
    assert_eq!(records.len(),3);
    use std::io::Write;
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(std::env::var("OPSARK_STAGE19_RESULT").unwrap()).unwrap();
    file.write_all(serde_json::to_string_pretty(&records).unwrap().as_bytes()).unwrap();
    println!("第十九批离线字节对比 {}",json!(records));
}
