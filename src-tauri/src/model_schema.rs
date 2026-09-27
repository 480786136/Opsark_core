//! Bounded compilation from the local Draft-07 business contract to a deliberately
//! conservative strict-output wire profile. This is not provider capability discovery.
//! Projected constraints ALWAYS remain in the original local business contract.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fmt};

pub(crate) const DIALECT: &str = "opsark.strict-output.common.v1";
pub(crate) const COMPILER_REVISION: &str = "j0-a.1";
const METADATA_MARKER: &str = "opsark:json-object-metadata";
const MAX_DEPTH: usize = 10;
const MAX_PROPERTIES: usize = 5_000;
const MAX_ENUM_VALUES: usize = 1_000;
const MAX_STRING_BYTES: usize = 120_000;
const MAX_RAW_DEPTH: usize = 64;
const MAX_RAW_NODES: usize = 50_000;
const MAX_RAW_STRING_BYTES: usize = 2_000_000;

#[derive(Debug)]
pub(crate) struct CompiledSchema {
    pub(crate) schema: Value,
    pub(crate) report: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct CompileError {
    pub(crate) schema_path: String,
    pub(crate) keyword: String,
    pub(crate) message: String,
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {} ({})",
            self.schema_path, self.message, self.keyword
        )
    }
}

impl std::error::Error for CompileError {}

fn error(path: &str, keyword: &str, message: &str) -> CompileError {
    CompileError {
        schema_path: path.into(),
        keyword: keyword.into(),
        message: message.into(),
    }
}

fn child(path: &str, key: &str) -> String {
    format!("{}/{}", path, key.replace('~', "~0").replace('/', "~1"))
}

// Sort keys explicitly, including when another dependency enables preserve_order.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let mut result = Map::new();
            for key in keys {
                result.insert(key.clone(), canonical(&map[key]));
            }
            Value::Object(result)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

fn digest(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
}

#[derive(Default)]
struct RawBudget {
    nodes: usize,
    strings: usize,
}

fn check_raw_budget(
    value: &Value,
    path: &str,
    depth: usize,
    budget: &mut RawBudget,
) -> Result<(), CompileError> {
    budget.nodes += 1;
    if depth > MAX_RAW_DEPTH || budget.nodes > MAX_RAW_NODES {
        return Err(error(
            path,
            "resource_limit",
            "业务 Schema 超出编译深度或节点预算",
        ));
    }
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                budget.strings += key.len();
                check_raw_budget(value, &child(path, key), depth + 1, budget)?;
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                check_raw_budget(value, &child(path, &index.to_string()), depth + 1, budget)?;
            }
        }
        Value::String(value) => budget.strings += value.len(),
        _ => {}
    }
    if budget.strings > MAX_RAW_STRING_BYTES {
        return Err(error(
            path,
            "resource_limit",
            "业务 Schema 超出编译字符串预算",
        ));
    }
    Ok(())
}

fn metadata_schema(schema: &Value) -> bool {
    schema["$comment"] == METADATA_MARKER
}

// Check every schema location, including conditions that will only be enforced
// locally. A typo or reference must never disappear unnoticed in a projection.
fn inspect_source(schema: &Value, path: &str) -> Result<(), CompileError> {
    let map = schema
        .as_object()
        .ok_or_else(|| error(path, "schema", "该编译配置不支持布尔或非对象 Schema"))?;
    if metadata_schema(schema) {
        if map
            .keys()
            .any(|key| !matches!(key.as_str(), "$comment" | "anyOf" | "description"))
            || schema["anyOf"] != json!([{"type":"object"},{"type":"string"},{"type":"null"}])
            || map
                .get("description")
                .is_some_and(|value| !value.is_string())
        {
            return Err(error(
                path,
                "$comment",
                "元数据编码标记只能用于约定的元数据契约",
            ));
        }
        return Ok(());
    }
    for (key, value) in map {
        let location = child(path, key);
        match key.as_str() {
            "$schema" => {
                if !matches!(
                    value.as_str(),
                    Some(
                        "http://json-schema.org/draft-07/schema#"
                            | "https://json-schema.org/draft-07/schema#"
                    )
                ) {
                    return Err(error(
                        &location,
                        key,
                        "仅接受当前业务契约使用的 Draft-07 方言",
                    ));
                }
            }
            "type" => {
                let supported = |value: &Value| {
                    matches!(
                        value.as_str(),
                        Some(
                            "object"
                                | "array"
                                | "string"
                                | "integer"
                                | "number"
                                | "boolean"
                                | "null"
                        )
                    )
                };
                if !supported(value) {
                    return Err(error(
                        &location,
                        key,
                        "联合类型请使用显式 anyOf；此配置只接受单一 type",
                    ));
                }
            }
            "properties" => {
                let properties = value
                    .as_object()
                    .ok_or_else(|| error(&location, key, "properties 必须是对象"))?;
                for (name, rule) in properties {
                    inspect_source(rule, &child(&location, name))?;
                }
            }
            "items" | "not" | "if" | "then" | "else" => inspect_source(value, &location)?,
            "anyOf" | "oneOf" | "allOf" => {
                let branches = value
                    .as_array()
                    .filter(|branches| !branches.is_empty())
                    .ok_or_else(|| error(&location, key, "组合约束必须包含 Schema 分支"))?;
                for (index, branch) in branches.iter().enumerate() {
                    inspect_source(branch, &child(&location, &index.to_string()))?;
                }
            }
            "additionalProperties" => {
                if value != &json!(false) {
                    return Err(error(&location, key, "开放对象不能编译为此严格输出配置"));
                }
            }
            "required" => {
                let names = value
                    .as_array()
                    .ok_or_else(|| error(&location, key, "required 必须是字符串数组"))?;
                let mut seen = BTreeSet::new();
                if names
                    .iter()
                    .any(|name| name.as_str().is_none_or(|name| !seen.insert(name)))
                {
                    return Err(error(&location, key, "required 必须包含不重复的属性名"));
                }
            }
            "enum" => {
                if value.as_array().is_none_or(|values| {
                    values.is_empty() || values.iter().any(|v| v.is_object() || v.is_array())
                }) {
                    return Err(error(&location, key, "只接受非空标量枚举"));
                }
            }
            "const" => {
                if value.is_object() || value.is_array() {
                    return Err(error(&location, key, "只接受标量 const"));
                }
            }
            "format" => {
                return Err(error(
                    &location,
                    key,
                    "当前本地 Draft-07 校验未启用 format，不能将其投影为已保留的本地约束",
                ));
            }
            "description" | "title" | "$comment" | "pattern" => {
                if !value.is_string() {
                    return Err(error(&location, key, "该关键字必须是字符串"));
                }
            }
            "minLength" | "maxLength" | "minItems" | "maxItems" | "minProperties"
            | "maxProperties" => {
                if value.as_u64().is_none() {
                    return Err(error(&location, key, "长度或数量约束必须是非负整数"));
                }
            }
            "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "multipleOf" => {
                if !value.is_number()
                    || (key == "multipleOf" && value.as_f64().is_none_or(|n| n <= 0.0))
                {
                    return Err(error(&location, key, "数值约束无效"));
                }
            }
            "uniqueItems" | "readOnly" | "writeOnly" => {
                if !value.is_boolean() {
                    return Err(error(&location, key, "该关键字必须是布尔值"));
                }
            }
            "default" | "examples" => {}
            _ => {
                return Err(error(
                    &location,
                    key,
                    "严格输出编译器尚不支持此关键字；未发送请求",
                ))
            }
        }
    }
    if schema["type"] == "object"
        && (schema["additionalProperties"] != false || !schema["properties"].is_object())
    {
        return Err(error(
            path,
            "additionalProperties",
            "对象必须显式声明 properties 和 additionalProperties:false",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct Compiler {
    transformations: Vec<Value>,
    residual_rules: Vec<Value>,
}

fn scalar_choices(rule: &Value) -> Option<Vec<&Value>> {
    if let Some(value) = rule.get("const") {
        return (!value.is_array() && !value.is_object()).then_some(vec![value]);
    }
    rule["enum"]
        .as_array()
        .filter(|values| {
            !values.is_empty()
                && values
                    .iter()
                    .all(|value| !value.is_array() && !value.is_object())
        })
        .map(|values| values.iter().collect())
}

fn same_scalar(left: &Value, right: &Value) -> bool {
    // JSON Schema treats 1 and 1.0 as the same value. Rounding very large
    // numbers may conservatively reject a discriminator, never prove it false.
    if left.is_number() && right.is_number() {
        return left.as_f64() == right.as_f64();
    }
    left == right
}

fn disjoint_object_tags(left: &Value, right: &Value) -> bool {
    let left_required = left["required"].as_array();
    let right_required = right["required"].as_array();
    left_required
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|key| {
            right_required.is_some_and(|keys| keys.contains(&json!(key)))
                && scalar_choices(&left["properties"][key])
                    .zip(scalar_choices(&right["properties"][key]))
                    .is_some_and(|(left, right)| {
                        left.iter()
                            .all(|a| right.iter().all(|b| !same_scalar(a, b)))
                    })
        })
}

fn collect_codec_branches<'a>(schema: &'a Value, objects: &mut Vec<&'a Value>, arrays: &mut usize) {
    if metadata_schema(schema) {
        return;
    }
    match schema["type"].as_str() {
        Some("object") => objects.push(schema),
        Some("array") => *arrays += 1,
        None => {
            if let Some(branches) = schema["anyOf"].as_array() {
                for branch in branches {
                    collect_codec_branches(branch, objects, arrays);
                }
            }
        }
        _ => {}
    }
}

fn check_union_codec(schema: &Value, path: &str) -> Result<(), CompileError> {
    if schema["anyOf"].as_array().is_some_and(|branches| {
        branches.iter().any(|branch| {
            !metadata_schema(branch)
                && branch.get("type").is_none()
                && branch.get("anyOf").is_some()
        })
    }) {
        return Err(error(
            path,
            "anyOf",
            "联合分支再次包装联合的解码形态尚未登记",
        ));
    }
    let mut objects = Vec::new();
    let mut arrays = 0;
    collect_codec_branches(schema, &mut objects, &mut arrays);
    if arrays > 1 {
        return Err(error(path, "anyOf", "多个数组分支的可选值解码尚无确定规则"));
    }
    for (index, left) in objects.iter().enumerate() {
        for right in objects.iter().skip(index + 1) {
            if !disjoint_object_tags(left, right) {
                return Err(error(
                    path,
                    "anyOf",
                    "多个对象分支必须由共同必填的标量 enum/const 字段明确区分",
                ));
            }
        }
    }
    Ok(())
}

impl Compiler {
    fn record(&mut self, path: &str, keyword: &str, kind: &str, reason: &str) {
        self.transformations
            .push(json!({"schemaPath":path,"keyword":keyword,"kind":kind,"reason":reason}));
        if kind == "projection" {
            self.residual_rules.push(
                json!({"schemaPath":path,"keyword":keyword,"enforcement":"local_business_schema"}),
            );
        }
    }

    fn compile_node(&mut self, schema: &Value, path: &str) -> Result<Value, CompileError> {
        if metadata_schema(schema) {
            self.record(
                path,
                "$comment",
                "codec",
                "元数据对象使用 JSON 对象字符串/null 编码，响应按原契约路径解码",
            );
            return Ok(
                json!({"anyOf":[{"type":"string","description":"Business metadata encoded as a JSON object string; null when absent."},{"type":"null"}]}),
            );
        }
        let source = schema
            .as_object()
            .ok_or_else(|| error(path, "schema", "Schema 必须是对象"))?;
        let mut result = Map::new();
        for key in ["description", "type", "enum"] {
            if let Some(value) = source.get(key) {
                result.insert(key.into(), value.clone());
            }
        }
        if let Some(value) = source.get("const") {
            if source.contains_key("enum") {
                self.record(
                    &child(path, "const"),
                    "const",
                    "projection",
                    "const 与 enum 的交集保留在本地契约校验",
                );
            } else {
                result.insert("enum".into(), json!([value]));
                self.record(
                    &child(path, "const"),
                    "const",
                    "equivalent",
                    "标量 const 转换为单值 enum",
                );
            }
            if !result.contains_key("type") {
                let kind = match value {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
                    Value::Number(_) => "number",
                    Value::String(_) => "string",
                    _ => return Err(error(path, "const", "不支持的 const 类型")),
                };
                result.insert("type".into(), json!(kind));
            }
        }
        match result.get("type").and_then(Value::as_str) {
            Some("object") => {
                let properties = source["properties"].as_object().unwrap();
                let required: BTreeSet<&str> = source
                    .get("required")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                if required.iter().any(|key| !properties.contains_key(*key)) {
                    return Err(error(
                        &child(path, "required"),
                        "required",
                        "required 引用了未声明的对象属性",
                    ));
                }
                let mut compiled = Map::new();
                let mut keys: Vec<_> = properties.keys().collect();
                keys.sort();
                for key in &keys {
                    let location = child(&child(path, "properties"), key);
                    let mut value = self.compile_node(&properties[*key], &location)?;
                    if !required.contains(key.as_str()) {
                        if !accepts_null(&value) {
                            value = json!({"anyOf":[value,{"type":"null"}]});
                        }
                        self.record(
                            &location,
                            "required",
                            "codec",
                            "可选属性改为必填，以 null 表示省略；本地解码后按原契约校验",
                        );
                    }
                    compiled.insert((*key).clone(), value);
                }
                result.insert("properties".into(), Value::Object(compiled));
                result.insert("required".into(), json!(keys));
                result.insert("additionalProperties".into(), json!(false));
            }
            Some("array") => {
                let items = source
                    .get("items")
                    .ok_or_else(|| error(path, "items", "数组必须声明单一 items Schema"))?;
                result.insert(
                    "items".into(),
                    self.compile_node(items, &child(path, "items"))?,
                );
            }
            Some(_) => {
                if source.contains_key("properties")
                    || source.contains_key("required")
                    || source.contains_key("items")
                    || source.contains_key("additionalProperties")
                {
                    return Err(error(
                        path,
                        "type",
                        "不能把对象或数组关键字附加到其他实例类型",
                    ));
                }
            }
            None => {
                if source.contains_key("properties")
                    || source.contains_key("required")
                    || source.contains_key("items")
                    || source.contains_key("additionalProperties")
                {
                    return Err(error(
                        path,
                        "type",
                        "结构关键字必须属于显式类型，不能随联合分支静默丢弃",
                    ));
                }
            }
        }
        for (key, value) in source {
            let location = child(path, key);
            match key.as_str() {
                "type"
                | "enum"
                | "const"
                | "description"
                | "properties"
                | "required"
                | "additionalProperties"
                | "items" => {}
                "anyOf" if !result.contains_key("type") => {
                    check_union_codec(schema, &location)?;
                    let mut branches = Vec::new();
                    for (index, branch) in value.as_array().unwrap().iter().enumerate() {
                        branches.push(
                            self.compile_node(branch, &child(&location, &index.to_string()))?,
                        );
                    }
                    result.insert(key.clone(), json!(branches));
                }
                "anyOf" | "oneOf" | "allOf" | "not" | "if" | "then" | "else" => {
                    self.record(
                        &location,
                        key,
                        "projection",
                        "同一实例的组合/条件约束仅由原业务契约校验；不改写其条件分支为完整对象",
                    );
                }
                "$schema" | "$comment" | "title" | "default" | "examples" | "readOnly"
                | "writeOnly" => {
                    self.record(
                        &location,
                        key,
                        "annotation",
                        "注释或默认值不下发，不注入业务默认值",
                    );
                }
                _ => self.record(
                    &location,
                    key,
                    "projection",
                    "保守严格输出配置未承诺该约束；保留完整本地校验",
                ),
            }
        }
        if !result.contains_key("type") && !result.contains_key("anyOf") {
            return Err(error(
                path,
                "type",
                "此位置缺少可编译的完整类型；不能仅靠投影条件形成开放 Schema",
            ));
        }
        Ok(Value::Object(result))
    }
}

fn accepts_null(schema: &Value) -> bool {
    if schema["enum"]
        .as_array()
        .is_some_and(|values| !values.contains(&Value::Null))
    {
        return false;
    }
    schema["type"] == "null"
        || schema["anyOf"]
            .as_array()
            .is_some_and(|branches| branches.iter().any(accepts_null))
}

#[derive(Default)]
struct WireBudget {
    properties: usize,
    enum_values: usize,
    string_bytes: usize,
    max_depth: usize,
}

// A second pass checks the emitted schema, not just the compiler's input. It is
// intentionally narrower than any single provider's complete supported subset.
fn preflight_wire(
    schema: &Value,
    path: &str,
    depth: usize,
    budget: &mut WireBudget,
) -> Result<(), CompileError> {
    let map = schema
        .as_object()
        .ok_or_else(|| error(path, "schema", "输出 Schema 不是对象"))?;
    for key in map.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "enum"
                | "description"
                | "properties"
                | "required"
                | "additionalProperties"
                | "items"
                | "anyOf"
        ) {
            return Err(error(
                &child(path, key),
                key,
                "输出 Schema 含未允许的关键字",
            ));
        }
    }
    let container = matches!(schema["type"].as_str(), Some("object" | "array"));
    let depth = depth + usize::from(container);
    budget.max_depth = budget.max_depth.max(depth);
    if depth > MAX_DEPTH {
        return Err(error(path, "maxDepth", "输出 Schema 超过 10 层容器深度"));
    }
    if let Some(description) = schema["description"].as_str() {
        budget.string_bytes += description.len();
    }
    if let Some(values) = schema["enum"].as_array() {
        budget.enum_values += values.len();
        let bytes: usize = values.iter().filter_map(Value::as_str).map(str::len).sum();
        budget.string_bytes += bytes;
        if values.len() > 250 && bytes > 15_000 {
            return Err(error(
                &child(path, "enum"),
                "enum",
                "大型字符串枚举超过 15000 字节保守预算",
            ));
        }
    }
    match schema["type"].as_str() {
        Some("object") => {
            let props = schema["properties"]
                .as_object()
                .ok_or_else(|| error(path, "properties", "严格对象缺少属性定义"))?;
            let names = schema["required"]
                .as_array()
                .ok_or_else(|| error(path, "required", "严格对象缺少必填属性数组"))?;
            let required: BTreeSet<_> = names.iter().filter_map(Value::as_str).collect();
            if schema["additionalProperties"] != false
                || required.len() != names.len()
                || required.len() != props.len()
                || props.keys().any(|key| !required.contains(key.as_str()))
            {
                return Err(error(
                    path,
                    "required",
                    "严格对象必须关闭附加属性且所有属性必填",
                ));
            }
            budget.properties += props.len();
            for (key, value) in props {
                budget.string_bytes += key.len();
                preflight_wire(
                    value,
                    &child(&child(path, "properties"), key),
                    depth,
                    budget,
                )?;
            }
        }
        Some("array") => preflight_wire(&schema["items"], &child(path, "items"), depth, budget)?,
        Some("string" | "integer" | "number" | "boolean" | "null") => {}
        None if schema["anyOf"].is_array() => {}
        _ => return Err(error(path, "type", "输出 Schema 类型无效")),
    }
    if let Some(branches) = schema["anyOf"].as_array() {
        if branches.is_empty() {
            return Err(error(path, "anyOf", "输出分支不能为空"));
        }
        for (index, branch) in branches.iter().enumerate() {
            preflight_wire(
                branch,
                &child(&child(path, "anyOf"), &index.to_string()),
                depth,
                budget,
            )?;
        }
    }
    if budget.properties > MAX_PROPERTIES
        || budget.enum_values > MAX_ENUM_VALUES
        || budget.string_bytes > MAX_STRING_BYTES
    {
        return Err(error(
            path,
            "resource_limit",
            "输出 Schema 超出属性、枚举或字符串预算",
        ));
    }
    Ok(())
}

/// JSON-mode fallback may relax only the wire profile. Unknown vocabulary,
/// invalid local schemas and unbounded source inputs still fail before dispatch.
pub(crate) fn json_fallback_safe(schema: &Value) -> bool {
    check_raw_budget(schema, "", 0, &mut RawBudget::default()).is_ok()
        && inspect_source(schema, "").is_ok()
        && jsonschema::options().with_draft(jsonschema::Draft::Draft7)
            .should_validate_formats(false).build(schema).is_ok()
}

pub(crate) fn compile(schema: &Value) -> Result<CompiledSchema, CompileError> {
    check_raw_budget(schema, "", 0, &mut RawBudget::default())?;
    inspect_source(schema, "")?;
    // References and unknown vocabulary have already been rejected above, so
    // validation cannot resolve a remote schema. Never mutate the source.
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .should_validate_formats(false)
        .build(schema)
        .map_err(|_| error("", "schema", "业务 Schema 不是有效的 Draft-07 契约"))?;
    if schema["type"] != "object" {
        return Err(error("", "type", "结构化输出根 Schema 必须是对象"));
    }
    let mut compiler = Compiler::default();
    let wire = compiler.compile_node(schema, "")?;
    let mut budget = WireBudget::default();
    preflight_wire(&wire, "", 0, &mut budget)?;
    let report = json!({
        "dialect": DIALECT,
        "compilerRevision": COMPILER_REVISION,
        "businessSchemaDigest": digest(schema),
        "wireSchemaDigest": digest(&wire),
        "outcome": if compiler.residual_rules.is_empty() { "equivalent" } else { "projection" },
        "equivalence": "after_declared_codecs_and_local_business_validation",
        "transformations": compiler.transformations,
        "residualRules": compiler.residual_rules,
        "limits": {"maxContainerDepth":MAX_DEPTH,"maxProperties":MAX_PROPERTIES,"maxEnumValues":MAX_ENUM_VALUES,
            "maxStringBytes":MAX_STRING_BYTES,"maxRawDepth":MAX_RAW_DEPTH,"maxRawNodes":MAX_RAW_NODES},
        "usage": {"containerDepth":budget.max_depth,"properties":budget.properties,
            "enumValues":budget.enum_values,"stringBytes":budget.string_bytes}
    });
    Ok(CompiledSchema {
        schema: wire,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unenforced_local_formats_cannot_be_advertised_as_residual_rules() {
        let schema = json!({"type":"object","additionalProperties":false,"required":["address"],
            "properties":{"address":{"type":"string","format":"ipv4"}}});
        let error = compile(&schema).unwrap_err();
        assert_eq!(error.keyword, "format");
        assert_eq!(error.schema_path, "/properties/address/format");
    }

    fn object(properties: Value, required: Value) -> Value {
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
    }

    #[test]
    fn all_shipped_inputs_and_operations_compile_without_unsupported_keywords() {
        let catalog: Value =
            serde_json::from_str(include_str!("../../contracts/tool-contracts.json")).unwrap();
        for tool in catalog["tools"].as_array().unwrap() {
            let compiled = compile(&tool["inputSchema"])
                .unwrap_or_else(|error| panic!("{}: {error}", tool["id"]));
            preflight_wire(&compiled.schema, "", 0, &mut WireBudget::default()).unwrap();
        }
        let body = json!({"_opsarkContext":json!({"tools":catalog["tools"]}).to_string()});
        for operation in [
            "阶段联合决策",
            "阶段格式修复（兼容模式）",
            "计划生成",
            "需求理解",
            "结果复核",
            "Skill 生成",
            "模型结构测试",
        ] {
            let source = crate::model_compatibility::contract(operation, &body).unwrap();
            let original = source.clone();
            let compiled = compile(&source).unwrap_or_else(|error| panic!("{operation}: {error}"));
            assert_eq!(source, original);
            assert!(compiled.report["usage"]["containerDepth"].as_u64().unwrap() <= 10);
        }
        let focused = json!({"_opsarkContext":body["_opsarkContext"],"messages":[{"content":"本轮是局部计划修复，只允许返回"}]});
        compile(&crate::model_compatibility::contract("计划生成", &focused).unwrap()).unwrap();
    }

    #[test]
    fn presence_conditions_remain_local_without_making_partial_branches_objects() {
        let catalog: Value =
            serde_json::from_str(include_str!("../../contracts/tool-contracts.json")).unwrap();
        let source = &catalog["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["id"] == "server.connect")
            .unwrap()["inputSchema"];
        let compiled = compile(source).unwrap();
        assert!(compiled.schema.get("anyOf").is_none());
        assert_eq!(compiled.report["outcome"], "projection");
        assert!(compiled.report["residualRules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| rule["schemaPath"] == "/anyOf"));
        // Wire permits the presence sentinel; business validation still rejects
        // an absent credential choice after the declared null codec is applied.
        assert!(
            crate::schema_validation::validate(source, &json!({"host":"example.com"})).is_err()
        );
        assert!(crate::schema_validation::validate(
            source,
            &json!({"host":"example.com","credentialRef":"managed-server:a"})
        )
        .is_ok());
    }

    #[test]
    fn one_of_is_an_explicit_projection_not_an_any_of_rewrite() {
        let mut source = object(
            json!({"mode":{"type":"string","enum":["a","b"]}}),
            json!(["mode"]),
        );
        source["oneOf"] =
            json!([{"properties":{"mode":{"const":"a"}}},{"properties":{"mode":{"const":"b"}}}]);
        let compiled = compile(&source).unwrap();
        assert!(compiled.schema.get("oneOf").is_none());
        assert!(compiled.schema.get("anyOf").is_none());
        assert_eq!(compiled.report["residualRules"][0]["keyword"], "oneOf");
    }

    #[test]
    fn optional_fields_and_metadata_use_declared_codecs_without_default_insertion() {
        let source = object(
            json!({"port":{"type":"integer","default":22},"meta":{
            "$comment":METADATA_MARKER,"anyOf":[{"type":"object"},{"type":"string"},{"type":"null"}]}}),
            json!([]),
        );
        let compiled = compile(&source).unwrap();
        assert_eq!(compiled.report["outcome"], "equivalent");
        assert_eq!(compiled.schema["required"], json!(["meta", "port"]));
        assert_eq!(
            compiled.schema["properties"]["meta"]["anyOf"][0]["type"],
            "string"
        );
        assert_eq!(
            compiled.schema["properties"]["port"]["anyOf"][1]["type"],
            "null"
        );
        assert!(!compiled.schema.to_string().contains("default"));
        assert_eq!(source["properties"]["port"]["default"], 22);
    }

    #[test]
    fn digests_are_deterministic_and_separate_business_from_wire_semantics() {
        let source = object(
            json!({"name":{"type":"string","minLength":1}}),
            json!(["name"]),
        );
        let first = compile(&source).unwrap();
        assert_eq!(first.report, compile(&source).unwrap().report);
        let mut stricter = source.clone();
        stricter["properties"]["name"]["minLength"] = json!(2);
        let second = compile(&stricter).unwrap();
        assert_ne!(
            first.report["businessSchemaDigest"],
            second.report["businessSchemaDigest"]
        );
        assert_eq!(
            first.report["wireSchemaDigest"],
            second.report["wireSchemaDigest"]
        );
    }

    #[test]
    fn unknown_vocabulary_refs_and_open_objects_fail_before_emission() {
        for rule in [
            json!({"type":"object"}),
            json!({"$ref":"https://example.invalid/schema"}),
            json!({"type":"string","minLenght":1}),
            json!({"type":"array","items":[{"type":"string"}]}),
            json!({"type":["string","null"]}),
        ] {
            let source = object(json!({"x":rule}), json!(["x"]));
            assert!(compile(&source).is_err(), "{source}");
        }
        let mut source = object(json!({"x":{"type":"string"}}), json!(["x"]));
        source["oneOf"] = json!([{"not":{"$ref":"https://example.invalid/schema"}}]);
        assert_eq!(compile(&source).unwrap_err().keyword, "$ref");
    }

    #[test]
    fn keyword_errors_have_escaped_json_pointer_paths() {
        let source = object(json!({"a/b~c":{"type":"string","minLenght":1}}), json!([]));
        let error = compile(&source).unwrap_err();
        assert_eq!(error.schema_path, "/properties/a~1b~0c/minLenght");
        assert_eq!(error.keyword, "minLenght");
    }

    #[test]
    fn condition_only_schema_cannot_become_unconstrained_wire_output() {
        let source = object(
            json!({"x":{"oneOf":[{"type":"string"},{"type":"integer"}]}}),
            json!(["x"]),
        );
        assert!(compile(&source).is_err());
    }

    #[test]
    fn ambiguous_object_or_array_unions_fail_before_optional_null_decoding() {
        let optional = object(json!({"value":{"type":"string"}}), json!([]));
        let required_null = object(json!({"value":{"type":"null"}}), json!(["value"]));
        let source = object(
            json!({"choice":{"anyOf":[optional,required_null]}}),
            json!(["choice"]),
        );
        assert_eq!(compile(&source).unwrap_err().keyword, "anyOf");
        let arrays = object(
            json!({"choice":{"anyOf":[
                {"type":"array","items":{"type":"string"}},
                {"type":"array","items":{"type":"integer"}}
            ]}}),
            json!(["choice"]),
        );
        assert_eq!(compile(&arrays).unwrap_err().keyword, "anyOf");
        // Numeric representations cannot manufacture a false discriminator.
        let integer_tag = object(json!({"tag":{"type":"number","enum":[1]}}), json!(["tag"]));
        let decimal_tag = object(
            json!({"tag":{"type":"number","enum":[1.0]}}),
            json!(["tag"]),
        );
        let numeric = object(
            json!({"choice":{"anyOf":[integer_tag,decimal_tag]}}),
            json!(["choice"]),
        );
        assert_eq!(compile(&numeric).unwrap_err().keyword, "anyOf");
        let nested = object(
            json!({"choice":{"anyOf":[
                {"anyOf":[object(json!({"value":{"type":"string"}}),json!([])),{"type":"null"}]},
                {"type":"string"}
            ]}}),
            json!(["choice"]),
        );
        assert_eq!(compile(&nested).unwrap_err().keyword, "anyOf");
    }

    #[test]
    fn required_const_tags_and_single_nullable_array_have_deterministic_codecs() {
        let source = object(
            json!({"choice":{"anyOf":[
            object(json!({"tag":{"const":"a"},"value":{"type":"string"}}),json!(["tag"])),
            object(json!({"tag":{"const":"b"},"value":{"type":"null"}}),json!(["tag","value"]))
        ]},"optionalObject":{"anyOf":[
            object(json!({"kind":{"type":"string","enum":["x"]}}),json!([])),{"type":"null"}
        ]},"items":{"anyOf":[{"type":"array","items":
            object(json!({"kind":{"type":"string","enum":["x"]}}),json!([]))
        },{"type":"null"}]}}),
            json!(["choice", "items", "optionalObject"]),
        );
        let compiled = compile(&source).unwrap();
        let mut payload = json!({"choices":[{"message":{"content":json!({
            "choice":{"tag":"b","value":null},"items":[{"kind":null}],"optionalObject":{"kind":null}
        }).to_string()}}]});
        crate::model_compatibility::normalize_response_with_wire(
            &mut payload,
            &source,
            Some(&compiled.schema),
        )
        .unwrap();
        let decoded: Value = serde_json::from_str(
            payload["choices"][0]["message"]["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            decoded,
            json!({"choice":{"tag":"b","value":null},"items":[{}],"optionalObject":{}})
        );
    }

    // This fixture encoder only fills absent optional fields. It never adds a
    // required field, changes an existing value, or edits a conditional branch.
    fn encode_absent_fields(value: &mut Value, schema: &Value) {
        if let Some(values) = value.as_array_mut() {
            for value in values {
                encode_absent_fields(value, &schema["items"]);
            }
        } else if let Some(map) = value.as_object_mut() {
            let Some(properties) = schema["properties"].as_object() else {
                return;
            };
            let required = schema["required"].as_array();
            for (key, rule) in properties {
                if let Some(value) = map.get_mut(key) {
                    encode_absent_fields(value, rule);
                } else if !required.is_some_and(|names| names.contains(&json!(key))) {
                    map.insert(key.clone(), Value::Null);
                }
            }
        }
    }

    #[test]
    fn shipped_tool_input_cases_keep_local_business_rejections_after_wire_projection() {
        let catalog: Value =
            serde_json::from_str(include_str!("../../contracts/tool-contracts.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../contracts/schema-cases.json")).unwrap();
        let mut checked = 0;
        for case in cases["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["contract"] == "inputSchema")
        {
            let source = &catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["id"] == case["toolId"])
                .unwrap()["inputSchema"];
            let expected = case["valid"].as_bool().unwrap();
            let mut json_payload =
                json!({"choices":[{"message":{"content":case["value"].to_string()}}]});
            assert_eq!(
                crate::model_compatibility::normalize_response_with_wire(
                    &mut json_payload,
                    source,
                    None
                )
                .is_ok(),
                expected,
                "JSON mode: {}",
                case["name"]
            );
            let compiled = compile(source).unwrap();
            let mut wire_value = case["value"].clone();
            encode_absent_fields(&mut wire_value, source);
            let mut payload = json!({"choices":[{"message":{"content":wire_value.to_string()}}]});
            let result = crate::model_compatibility::normalize_response_with_wire(
                &mut payload,
                source,
                Some(&compiled.schema),
            );
            if case["name"] == "port None" {
                // This one business-invalid input is a legitimate strict-wire
                // omission sentinel. Its JSON-mode rejection was checked above.
                result.unwrap();
                let decoded: Value = serde_json::from_str(
                    payload["choices"][0]["message"]["content"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(decoded, json!({"host":"host"}));
            } else {
                assert_eq!(
                    result.is_ok(),
                    expected,
                    "strict mode: {} ({result:?})",
                    case["name"]
                );
                if expected {
                    let decoded: Value = serde_json::from_str(
                        payload["choices"][0]["message"]["content"]
                            .as_str()
                            .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(decoded, case["value"], "{}", case["name"]);
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 70,
            "shared input-case coverage unexpectedly shrank"
        );
    }

    #[test]
    fn wire_and_raw_resource_limits_are_enforced_locally() {
        let mut nested = json!({"type":"string"});
        for _ in 0..10 {
            nested = object(json!({"next":nested}), json!(["next"]));
        }
        compile(&nested).unwrap();
        let too_deep = object(json!({"next":nested}), json!(["next"]));
        assert_eq!(compile(&too_deep).unwrap_err().keyword, "maxDepth");
        let enums: Vec<_> = (0..1001).collect();
        let too_many = object(json!({"n":{"type":"integer","enum":enums}}), json!(["n"]));
        assert_eq!(compile(&too_many).unwrap_err().keyword, "resource_limit");
        let oversized = object(
            json!({"s":{"type":"string","description":"a".repeat(MAX_STRING_BYTES + 1)}}),
            json!(["s"]),
        );
        assert_eq!(compile(&oversized).unwrap_err().keyword, "resource_limit");
    }
}
