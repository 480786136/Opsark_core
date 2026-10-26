//! Exercise the real Core request and business-repair chain against local HTTP only.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn provider(
    responses: Vec<(u16, Value)>,
) -> (String, std::thread::JoinHandle<(Vec<Value>, TcpListener)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let mut requests = vec![];
        for (status, response) in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "expected model request missing");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = vec![];
            loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        let body: Value =
                            serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                        assert!(!body.to_string().contains("_modelRecovery"));
                        let key = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("idempotency-key:"))
                            .unwrap()
                            .trim()
                            .to_owned();
                        requests.push(json!({"key":key,"body":body}));
                        break;
                    }
                }
            }
            let response = response.to_string();
            write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        (requests, listener)
    });
    (endpoint, thread)
}

fn context(generations: u64, strict: bool) -> String {
    let mut context: Value =
        serde_json::from_str(&model_budget::ensure_context("{}").unwrap()).unwrap();
    context["_modelRecovery"]["maxGenerations"] = json!(generations);
    context["_modelCapabilities"] = json!({"protocol":"chat_completions","version":"budget-tests",
        "structuredOutput":if strict {"json_schema"} else {"json_object"},"parameterAdapter":"portable",
        "tokenField":"max_tokens","defaultOutputTokens":5000,"maxOutputTokens":10000});
    context.to_string()
}

fn response(content: &str) -> Value {
    json!({"choices":[{"finish_reason":"stop","message":{"content":content}}],
        "usage":{"prompt_tokens":40,"completion_tokens":60,"total_tokens":100}})
}

fn error(value: String) -> Value {
    serde_json::from_str::<Value>(value.strip_prefix(MODEL_TRACE_ERROR_PREFIX).unwrap()).unwrap()
        ["modelError"]
        .clone()
}

#[test]
fn insufficient_repair_window_rejects_real_send_before_a_post_or_generation_slot() {
    let (endpoint, server) = provider(vec![]);
    let (_, listener) = server.join().unwrap();
    let mut context: Value = serde_json::from_str(&context(6,false)).unwrap();
    context["_modelRecovery"]["maxElapsedMs"] = json!(86000);
    context["_modelOutputRecovery"] = json!({"strategy":"regenerate"});
    let body = json!({"_opsarkContext":context.to_string(),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON"},{"role":"user","content":"plan"}]});
    let result = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
        .block_on(model::post_model_request(&format!("{endpoint}/v1/chat/completions"),"synthetic",&body,"计划生成",90,None));
    let diagnostic=error(result.unwrap_err());
    assert_eq!(diagnostic["code"],"MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(diagnostic["recoveryBudget"]["requiredWaitMs"],90000);
    assert_eq!(diagnostic["recoveryBudget"]["generations"],0);
    assert_eq!(diagnostic["recoveryBudget"]["candidateRegenerations"],0);
    assert_eq!(diagnostic["recoveryBudget"]["transportAttempts"],0);
    assert!(listener.accept().is_err(),"repair dispatch must not have connected");
}

#[test]
fn format_repair_and_next_invoke_share_budget_and_distinct_generation_ids() {
    let (endpoint, server) = provider(vec![(200, response("{")), (200, response("{"))]);
    let body = json!({"_opsarkContext":context(2,false),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON"}]});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let url = format!("{endpoint}/chat/completions");
    let first = runtime
        .block_on(post_model_request(
            &url,
            "fake-key",
            &body,
            "计划生成",
            5,
            None,
        ))
        .unwrap_err();
    assert_eq!(error(first)["code"], "MODEL_FORMAT_INVALID");
    let next = error(
        runtime
            .block_on(post_model_request(
                &url,
                "fake-key",
                &body,
                "计划生成",
                5,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(next["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(next["recoveryBudget"]["generations"], 2);
    assert_eq!(next["recoveryBudget"]["knownUsageTokens"], 200);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0]["key"], requests[1]["key"]);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn schema_downgrade_cannot_reset_budget_before_format_regeneration() {
    let (endpoint, server) = provider(vec![
        (
            400,
            json!({"error":{"message":"response_format json_schema is unavailable now"}}),
        ),
        (200, response("{")),
    ]);
    let body = json!({"_opsarkContext":context(2,true),"model":"test","max_tokens":5000,
        "messages":[{"role":"system","content":"Return JSON"}]});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let failure = error(
        runtime
            .block_on(post_model_request(
                &format!("{endpoint}/chat/completions"),
                "fake-key",
                &body,
                "计划生成",
                5,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["transportAttempts"], 2);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(
        requests[0]["body"]["response_format"]["type"],
        "json_schema"
    );
    assert_eq!(
        requests[1]["body"]["response_format"]["type"],
        "json_object"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn semantic_plan_repair_uses_the_original_operation_budget() {
    let plan = json!({"steps":[{"kind":"change","title":"Build","description":"Build app",
        "action":{"type":"shell","command":"npm run build | tail -20"},"expected":"Build output",
        "validation":"test -f dist/index.html","risk":"medium"}]})
    .to_string();
    let (endpoint, server) = provider(vec![(200, response(&plan))]);
    let mut trace = ModelDeveloperTrace::default();
    let failure = error(
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(generate_ai_plan_with_trace(
                "fake-key".into(),
                endpoint,
                "test".into(),
                "Build app".into(),
                context(1, false),
                None,
                5,
                &mut trace,
                None,
            ))
            .unwrap_err(),
    );
    assert_eq!(failure["code"], "MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(failure["recoveryBudget"]["generations"], 1);
    let (requests, listener) = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn task_admission_rejects_before_post_and_logs_safe_bound_diagnostics() {
    use sha2::{Digest, Sha256};
    crate::task_model_budget::initialize_test_runtime().unwrap();
    let task = crate::task_logs::call_id();
    let round = "admission-round";
    crate::task_model_budget::register(crate::task_model_budget::TaskBudgetRegistration {
        task_id: task.clone(), round_id: round.into(), max_task_tokens:250_000,
        max_round_tokens:250_000, safety_reserve_tokens:0,
    }).unwrap();
    let (endpoint, server) = provider(vec![(200, json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}],
        "usage":{"prompt_tokens":144_262,"completion_tokens":2131,"total_tokens":146_393}}))]);
    let url = format!("{endpoint}/chat/completions");
    let root = std::env::temp_dir().join("opsark-admission-tests").join(&task);
    std::fs::create_dir_all(&root).unwrap();
    let log = root.join("model-calls.jsonl");
    let make_body = |content: &str| {
        let mut ctx: Value = serde_json::from_str(&context(6,false)).unwrap();
        ctx["_log"] = json!({"taskId":task,"roundId":round});
        ctx["_taskModelBudget"] = json!({"version":1,"taskId":task,"roundId":round});
        let raw_context = ctx.to_string();
        json!({"model":"synthetic","max_tokens":5000,"_opsarkContext":raw_context,
            "messages":[{"role":"system","content":"Return JSON"},
                {"role":"user","content":format!("服务器上下文：\n{raw_context}\n\n用户需求：\n{content}")}]})
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(post_model_request(&url,"synthetic",&make_body("Return JSON"),"预算测试",5,Some(&log))).unwrap();
    let before = crate::task_model_budget::query(&task,round).unwrap();
    let secret = "SENTINEL_ADMISSION_CONTEXT_MUST_NOT_LEAK";
    let result = error(runtime.block_on(post_model_request(&url,"synthetic",&make_body(&format!("{secret}{}","x".repeat(120_000))),
        "预算测试",5,Some(&log))).unwrap_err());
    assert_eq!(result["code"],"MODEL_TASK_BUDGET_EXHAUSTED");
    assert_eq!(result["dispatchCertainty"],"not_dispatched");
    assert_eq!(result["taskBudgetAdmission"]["scopes"]["task"]["availableTokens"],103_607);
    assert_eq!(crate::task_model_budget::query(&task,round).unwrap(),before);
    let (requests,listener)=server.join().unwrap();
    assert_eq!(requests.len(),1);
    assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
    let task_log = root.join("logs/tasks").join(format!("task-{:x}",Sha256::digest(task.as_bytes()))).join("model-calls.jsonl");
    let events: Vec<Value> = std::fs::read_to_string(&task_log).unwrap().lines()
        .map(|line|serde_json::from_str(line).unwrap()).collect();
    assert_eq!(events.iter().filter(|e|e["event"]=="request_sent").count(),1);
    let rejections: Vec<_> = events.iter().filter(|e|e["event"]=="task_budget_rejected").collect();
    assert_eq!(rejections.len(),1);
    let rejection = rejections[0];
    assert_eq!(rejection["taskId"],task);
    assert_eq!(rejection["roundId"],round);
    assert_eq!(rejection["requestId"],result["taskBudgetAdmission"]["requestId"]);
    assert_eq!(rejection["callId"],result["taskBudgetAdmission"]["attemptId"]);
    assert_eq!(rejection["diagnostic"]["taskBudgetAdmission"],result["taskBudgetAdmission"]);
    assert_eq!(rejection["contextMetrics"]["requestBytes"],result["taskBudgetAdmission"]["requestBytes"]);
    assert_eq!(rejection["contextMetrics"]["layerPartitionValid"],true);
    assert_eq!(rejection["wireDigest"],result["taskBudgetAdmission"]["wireDigest"]);
    assert!(rejection.get("contextProjection").is_some());
    assert!(rejection.get("toolDirectoryProjection").is_some());
    assert!(rejection.get("outputBudgetAdjustment").is_some());
    assert!(rejection.get("request").is_none(), "拒绝诊断不额外保存请求正文");
    assert!(!rejection.to_string().contains(secret));
    let state = crate::model_request_lifecycle::Store::open(&root.join("model-requests.sqlite3"),"admission-proof").unwrap()
        .get(result["requestKey"].as_str().unwrap()).unwrap();
    assert_eq!(state.state,crate::model_request_lifecycle::RequestState::NotDispatched);
    assert!(state.attempt_ids.is_empty());
}

struct OutputCapCall {
    task: String,
    round: String,
    context: Value,
    root: std::path::PathBuf,
    budget: crate::task_model_budget::TaskBudget,
}
impl OutputCapCall {
    fn new(protocol: &str) -> Self {
        crate::task_model_budget::initialize_test_runtime().unwrap();
        let task=crate::task_logs::call_id();
        let round="output-budget-round".to_owned();
        crate::task_model_budget::register(crate::task_model_budget::TaskBudgetRegistration {
            task_id:task.clone(),round_id:round.clone(),max_task_tokens:250_000,max_round_tokens:250_000,safety_reserve_tokens:0,
        }).unwrap();
        let mut context: Value=serde_json::from_str(&context(6,false)).unwrap();
        context["_log"]=json!({"taskId":task,"roundId":round});
        context["_taskModelBudget"]=json!({"version":1,"taskId":task,"roundId":round});
        context["_modelCapabilities"]["maxOutputTokens"]=json!(16_384);
        if protocol=="responses" || protocol=="chat_v2" {
            let protocol=if protocol=="chat_v2" {"chat_completions"} else {protocol};
            context["_modelIntegration"]=json!({"apiProtocol":protocol,"outputPolicy":"require_schema","capabilitiesV2":{
                "version":"model-capabilities@2","revision":"output-budget-test","supportedProtocols":[protocol],"preferredProtocol":protocol,
                "outputModes":{"json_object":"supported","json_schema":"supported"},"parameterAdapter":"portable",
                "tokenField":if protocol=="responses" {"max_output_tokens"} else {"max_completion_tokens"},
                "defaultOutputTokens":5000,"maxOutputTokens":16_384,"budgetSemantics":"unknown",
                "strictFlag":"required","store":"unsupported","evidence":{"source":"user_declared"}
            }});
        }
        let budget=crate::task_model_budget::TaskBudget::for_context(&context).unwrap().unwrap();
        budget.reserve(&format!("prior-{task}"),&format!("prior-a-{task}"),&format!("prior-o-{task}"),
            &json!({"max_tokens":100,"messages":[]})).unwrap().settle_total(103_541).unwrap();
        let root=std::env::temp_dir().join("opsark-output-cap-tests").join(&task);
        std::fs::create_dir_all(&root).unwrap();
        Self {task,round,context,root,budget}
    }
    fn body(&self, content: &str) -> Value {
        let raw=self.context.to_string();
        json!({"model":"synthetic","_opsarkContext":raw,"messages":[{"role":"system","content":"Return a complete JSON plan."},
            {"role":"user","content":format!("服务器上下文：\n{raw}\n\n用户需求：\n{content}")}]})
    }
    fn body_with_wire_bytes(&self,url:&str,name:&str,bytes:usize,mut update:impl FnMut(&mut Value))->(Value,Value) {
        let mut base=self.body("");update(&mut base);
        let original=crate::model::preview_model_request(url,&base,name,false).unwrap()["request"].clone();
        let mut body=self.body(&"x".repeat(bytes-original.to_string().len()));update(&mut body);
        let wire=crate::model::preview_model_request(url,&body,name,false).unwrap()["request"].clone();
        assert_eq!(wire.to_string().len(),bytes);
        (body,wire)
    }
    fn events(&self)->Vec<Value> {
        use sha2::{Digest,Sha256};
        let path=self.root.join("logs/tasks").join(format!("task-{:x}",Sha256::digest(self.task.as_bytes()))).join("model-calls.jsonl");
        std::fs::read_to_string(path).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect()
    }
}

#[test]
fn automatic_cap_negotiation_sends_one_complete_contract_and_binds_final_wire_identity_and_reservation() {
    for protocol in ["legacy","chat_v2","responses"] {
        let call=OutputCapCall::new(protocol);
        let response=if protocol=="responses" {
            json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"{\"steps\":[]}"}]}],"usage":{"input_tokens":40,"output_tokens":60,"total_tokens":100}})
        } else { response("{\"steps\":[]}") };
        let (endpoint,server)=provider(vec![(200,response)]);
        let url=format!("{endpoint}/chat/completions");
        let (body,mut expected)=call.body_with_wire_bytes(&url,"计划生成",131_826,|_|{});
        let field=if protocol=="responses" {"max_output_tokens"} else if protocol=="chat_v2" {"max_completion_tokens"} else {"max_tokens"};
        expected[field]=json!(13_609);
        tokio::runtime::Runtime::new().unwrap().block_on(post_model_request(&url,"synthetic",&body,"计划生成",5,Some(&call.root.join("model-calls.jsonl")))).unwrap();
        let (requests,listener)=server.join().unwrap();
        assert_eq!(requests.len(),1);
        assert_eq!(requests[0]["body"],expected);
        assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
        assert!(!expected.to_string().contains("_opsarkBudgetOutputPolicy"));
        let request_id=requests[0]["key"].as_str().unwrap();
        let digest=crate::model_request_lifecycle::digest(expected.to_string().as_bytes());
        let lifecycle=crate::model_request_lifecycle::Store::open(&call.root.join("model-requests.sqlite3"),"cap-proof").unwrap().get(request_id).unwrap();
        assert_eq!(lifecycle.request_digest,digest);
        assert_eq!(lifecycle.state,crate::model_request_lifecycle::RequestState::Completed);
        assert_eq!(lifecycle.request_id,crate::model_request_lifecycle::digest(json!([lifecycle.operation_id,1]).to_string().as_bytes()));
        assert_eq!(lifecycle.attempt_ids.len(),1);
        let budget_records=call.budget.test_attempt_records(request_id).unwrap();
        assert_eq!(budget_records.len(),1);
        assert_eq!(budget_records[0]["wireDigest"],digest);
        assert_eq!(budget_records[0]["reservedTokens"],146_459);
        assert_eq!(budget_records[0]["actualTokens"],100);
        assert_eq!(budget_records[0]["operationId"],lifecycle.operation_id);
        let final_cost=call.budget.snapshot().unwrap();
        assert_eq!(final_cost["task"]["maxTotalTokens"],250_000);
        assert_eq!(final_cost["task"]["knownUsageTokens"],103_641);
        assert_eq!(final_cost["task"]["unknownUsageAttempts"],0);
        let events=call.events();
        let sent:Vec<_>=events.iter().filter(|event|event["event"]=="request_sent").collect();
        assert_eq!(sent.len(),1);
        assert_eq!(sent[0]["taskId"],call.task);
        assert_eq!(sent[0]["roundId"],call.round);
        assert_eq!(sent[0]["outputBudgetAdjustment"]["originalOutputTokenLimit"],16_384);
        assert_eq!(sent[0]["outputBudgetAdjustment"]["effectiveOutputTokenLimit"],13_609);
        assert_eq!(sent[0]["outputBudgetAdjustment"]["actualBillingLimitGuaranteed"],false);
        std::fs::write(call.root.join("协商与持久回执.json"),json!({"synthetic":true,"protocol":protocol,"taskId":call.task,
            "requestId":request_id,"finalWireDigest":digest,"finalWireBytes":expected.to_string().len(),
            "adjustment":sent[0]["outputBudgetAdjustment"],"nativeRequest":lifecycle,
            "persistentAttempts":budget_records,"finalBudget":final_cost}).to_string()).unwrap();
    }
}

#[test]
fn explicit_global_or_profile_output_caps_and_unknown_builders_cannot_reuse_stale_adaptation_marker() {
    for selector in ["global","outputBudget","max_tokens","max_completion_tokens","max_output_tokens","unknown"] {
        let mut call=OutputCapCall::new("legacy");
        if !matches!(selector,"global"|"unknown") {call.context["_requestParameters"]=json!({selector:16_384});}
        let (endpoint,server)=provider(vec![]);
        let url=format!("{endpoint}/chat/completions");
        let name=if selector=="unknown" {"unknown"} else {"计划生成"};
        let (body,_)=call.body_with_wire_bytes(&url,name,131_826,|body|{
            body["_opsarkBudgetOutputPolicy"]=json!({"version":1,"coreMinimumOutputTokens":4096,
                "declaredDefaultOutputTokens":5000,"source":"core_business_builder_without_explicit_output_override"});
            if selector=="global" {body["max_tokens"]=json!(16_384);}
        });
        let before=call.budget.snapshot().unwrap();
        let failure=error(tokio::runtime::Runtime::new().unwrap().block_on(post_model_request(&url,"synthetic",&body,name,5,
            Some(&call.root.join("model-calls.jsonl")))).unwrap_err());
        assert_eq!(failure["code"],"MODEL_TASK_BUDGET_EXHAUSTED","{selector}");
        assert_eq!(failure["taskBudgetAdmission"]["outputTokenLimit"],16_384);
        assert_eq!(failure["taskBudgetAdmission"]["requiredReservedTokens"],149_234);
        assert_eq!(call.budget.snapshot().unwrap(),before);
        let (requests,listener)=server.join().unwrap();
        assert!(requests.is_empty());
        assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
        assert!(call.events().iter().all(|event|event["event"]!="request_sent"));
    }
}

#[test]
fn output_cap_negotiation_cannot_reopen_an_unknown_original_operation_or_release_its_reservation() {
    let call=OutputCapCall::new("legacy");
    let (endpoint,server)=provider(vec![(503,json!({"error":{"message":"synthetic ambiguous upstream failure"}}))]);
    let url=format!("{endpoint}/chat/completions");
    let (body,_)=call.body_with_wire_bytes(&url,"计划生成",131_826,|_|{});
    let log=call.root.join("model-calls.jsonl");
    let runtime=tokio::runtime::Runtime::new().unwrap();
    let initial=error(runtime.block_on(post_model_request(&url,"synthetic",&body,"计划生成",5,Some(&log))).unwrap_err());
    assert_eq!(initial["code"],"MODEL_DISPATCH_UNKNOWN");
    let before=call.budget.snapshot().unwrap();
    assert_eq!(before["task"]["unknownUsageAttempts"],1);
    assert_eq!(before["task"]["estimatedReservedTokens"],146_459);
    assert_eq!(before["task"]["accountedTokens"],250_000);
    let repeated=error(runtime.block_on(post_model_request(&url,"synthetic",&body,"计划生成",5,Some(&log))).unwrap_err());
    assert_eq!(repeated["code"],"MODEL_RECOVERY_BUDGET_EXHAUSTED");
    assert_eq!(call.budget.snapshot().unwrap(),before);
    let (requests,listener)=server.join().unwrap();
    assert_eq!(requests.len(),1);
    assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
    let original=crate::model_request_lifecycle::Store::open(&call.root.join("model-requests.sqlite3"),"unknown-cap-proof")
        .unwrap().get(requests[0]["key"].as_str().unwrap()).unwrap();
    assert_eq!(original.request_id,crate::model_request_lifecycle::digest(json!([original.operation_id,1]).to_string().as_bytes()));
    assert_eq!(original.attempt_ids.len(),1);
}
