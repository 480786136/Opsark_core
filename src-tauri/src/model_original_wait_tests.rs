//! Real loopback HTTP, production polling constants and isolated SQLite budgets.
//! No external provider, SSH, wall-clock mocking, or cfg(test) time compression.
use super::*;
use crate::model_request_lifecycle::{RequestHandle, RequestState, Store};
use crate::model_budget::OperationBudget;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

#[derive(Clone, Copy)]
enum ReplyMode { CompleteAt(u64), Running, Unknown, Lost, WrongDigest, SlowBody }
struct Adapter {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Adapter {
    fn new(mode: ReplyMode) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1/chat/completions",listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = requests.clone(); let done = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut began = None;
            let mut identity = None;
            let mut queries = 0;
            while !done.load(Ordering::SeqCst) {
                let (mut socket,_) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(2)); continue; },
                    Err(error) => panic!("{error}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0u8;4096]; let count = socket.read(&mut buffer).unwrap();
                    assert!(count>0); bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end)=bytes.windows(4).position(|part|part==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length=headers.lines().find_map(|line|line.strip_prefix("content-length:").and_then(|n|n.trim().parse::<usize>().ok())).unwrap_or(0);
                        if bytes.len()>=end+4+length { break; }
                    }
                }
                let request=String::from_utf8(bytes).unwrap();
                captured.lock().unwrap().push(request.clone());
                if request.starts_with("POST /v1/chat/completions ") {
                    assert!(began.is_none(),"original generation must never be re-POSTed");
                    began=Some(Instant::now());
                    let lower=request.to_ascii_lowercase();
                    let id=lower.lines().find_map(|line|line.strip_prefix("x-opsark-client-request-id: ")).unwrap().to_owned();
                    let digest=lower.lines().find_map(|line|line.strip_prefix("x-opsark-request-digest: ")).unwrap().to_owned();
                    assert_eq!(crate::model_request_lifecycle::digest(request.split_once("\r\n\r\n").unwrap().1.as_bytes()),digest);
                    identity=Some((id,digest));
                    // The configured POST really times out; its socket is not
                    // replaced with a mocked error. Production 15s is unchanged.
                    std::thread::sleep(Duration::from_millis(1100));
                    continue;
                }
                if request.starts_with("POST ") {
                    assert!(request.lines().next().unwrap().contains("/cancel "));
                    let body=r#"{"cancelRequested":true}"#;
                    let _=write!(socket,"HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    continue;
                }
                queries+=1;
                let (id,digest)=identity.as_ref().unwrap();
                assert!(request.starts_with(&format!("GET /opsark/requests/{id} ")));
                let lower=request.to_ascii_lowercase();
                assert!(lower.contains(&format!("x-opsark-request-digest: {digest}")));
                assert!(lower.contains("authorization: bearer synthetic"));
                if queries>1 && matches!(mode,ReplyMode::Lost) { continue; }
                let complete=matches!(mode,ReplyMode::CompleteAt(ms) if began.unwrap().elapsed()>=Duration::from_millis(ms));
                let state=if complete {"completed"} else if queries>1 && matches!(mode,ReplyMode::Unknown) {"unknown"} else {"running"};
                let result=complete.then(completion);
                let body=json!({"protocol":"opsark-local-v1","requestId":id,
                    "requestDigest":if queries>1 && matches!(mode,ReplyMode::WrongDigest) {"different"} else {digest},
                    "state":state,"httpStatus":200,"response":result,"usage":result.as_ref().and_then(|r|r.get("usage"))}).to_string();
                if queries>1 && matches!(mode,ReplyMode::SlowBody) {
                    let _=write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                    std::thread::sleep(Duration::from_secs(2));
                    let _=write!(socket,"{body}");
                } else { let _=write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()); }
            }
        });
        Self {url,requests,stop,thread:Some(thread)}
    }
    fn count(&self,prefix:&str)->usize {self.requests.lock().unwrap().iter().filter(|r|r.starts_with(prefix)).count()}
}
impl Drop for Adapter {
    fn drop(&mut self) {self.stop.store(true,Ordering::SeqCst);if let Some(thread)=self.thread.take(){let result=thread.join();if !std::thread::panicking(){result.unwrap();}}}
}
fn completion()->Value {
    let answer=json!({"intent":"execute","answer":"","selectedSkillIds":[],"constraints":{
        "changePolicy":"read_only","environmentPolicy":"unspecified","failurePolicy":"unspecified",
        "prohibitedActions":[],"requiredConditions":[],"userDirectives":[]}});
    json!({"choices":[{"message":{"content":answer.to_string()},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}})
}
struct Call {
    body: Value, budget: OperationBudget, log: std::path::PathBuf,
    handle: RequestHandle, task: String, round: String, started: u64,
}
impl Call {
    fn new(url:&str,elapsed:u64)->Self {
        crate::task_model_budget::initialize_test_runtime().unwrap();
        let task=crate::task_logs::call_id(); let round="original-round".to_owned();
        crate::task_model_budget::register(crate::task_model_budget::TaskBudgetRegistration {
            task_id:task.clone(),round_id:round.clone(),max_task_tokens:100000,max_round_tokens:100000,safety_reserve_tokens:0 }).unwrap();
        let operation=crate::task_logs::call_id(); let started=unix_millis() as u64;
        let context=json!({"_log":{"taskId":task,"roundId":round},"_taskModelBudget":{"version":1,"taskId":task,"roundId":round},
            "_modelRecovery":{"operationId":operation,"startedAtMs":started,"maxElapsedMs":elapsed},
            "_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":url.strip_suffix("/v1/chat/completions").unwrap()}}});
        let body=json!({"model":"synthetic","max_tokens":128,"_opsarkContext":context.to_string(),
            "messages":[{"role":"user","content":format!("服务器上下文：\n{context}\n\n用户需求：\ninspect CPU, memory, disk without changes")} ]});
        let budget=OperationBudget::for_request(url,"synthetic",&body,1).unwrap();
        let dir=std::env::temp_dir().join("opsark-original-wait-tests").join(&operation);std::fs::create_dir_all(&dir).unwrap();
        let id=crate::model_request_lifecycle::digest(json!([operation,1]).to_string().as_bytes());
        let handle=RequestHandle::from_test_path(dir.join("model-requests.sqlite3"),id);
        Self {body,budget,log:dir.join("model-calls.jsonl"),handle,task,round,started}
    }
    async fn run(&self,url:&str)->Result<Value,String>{post_model_request(url,"synthetic",&self.body,"需求理解",1,Some(&self.log)).await}
    fn cost(&self)->Value{crate::task_model_budget::query(&self.task,&self.round).unwrap()}
    fn store(&self)->Store{Store::open(&self.log.parent().unwrap().join("model-requests.sqlite3"),"fixture").unwrap()}
}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}

#[test]
fn original_wait_consumes_one_result_after_production_fifteen_second_window() {
    let adapter=Adapter::new(ReplyMode::CompleteAt(17000));let call=Call::new(&adapter.url,24000);
    let original_deadline=call.budget.recovery_deadline().unwrap();let began=Instant::now();
    let result=runtime().block_on(call.run(&adapter.url)).unwrap();
    let elapsed=began.elapsed();assert!(elapsed>Duration::from_secs(16));assert!(elapsed<Duration::from_secs(24));
    let classification:Value=serde_json::from_str(result["choices"][0]["message"]["content"].as_str().unwrap()).unwrap();
    assert_eq!(classification["intent"],"execute");
    assert_eq!(call.budget.recovery_deadline().unwrap(),original_deadline);
    let snapshot=call.budget.snapshot();assert_eq!(snapshot["generations"],1);assert_eq!(snapshot["transportAttempts"],1);assert_eq!(snapshot["knownUsageTokens"],19);
    let record=call.handle.read().unwrap();assert_eq!(record.operation_started_at_ms,call.started);assert!(record.operation_started_at_ms>0);
    assert_eq!(record.state,RequestState::Completed);assert_eq!(record.attempt_ids.len(),1);
    let cost=call.cost();assert_eq!(cost["task"]["knownUsageTokens"],19);assert_eq!(cost["round"]["knownUsageTokens"],19);
    runtime().block_on(recover_local_adapter(&call.handle,"synthetic",15)).unwrap();assert_eq!(call.cost(),cost);
    assert_eq!(adapter.count("POST /v1/chat/completions "),1);
    let requests=adapter.requests.lock().unwrap();let wire=requests[0].split_once("\r\n\r\n").unwrap().1;
    for private in ["_modelRecovery","_taskModelBudget","_modelRequestLifecycle"] {assert!(!wire.contains(private), "Core private metadata leaked to wire: {private}");}
    drop(requests);
    let events=serde_json::to_value(crate::task_logs::query(call.log.parent().unwrap(),
        serde_json::from_value(json!({"stream":"model-calls","taskId":call.task})).unwrap()).unwrap()).unwrap();
    let events=events["items"].as_array().unwrap();
    assert_eq!(events.iter().filter(|e|e["event"]=="request_sent").count(),1);
    let recovered:Vec<_>=events.iter().filter(|e|e["event"]=="response_received").collect();assert_eq!(recovered.len(),1);
    assert_eq!(recovered[0]["requestId"],record.request_id);assert_eq!(recovered[0]["callId"],record.attempt_ids[0]);assert_eq!(recovered[0]["tokenUsage"]["total"],19);assert_eq!(recovered[0]["status"],200);
    assert_eq!(recovered[0]["taskId"],call.task);assert_eq!(recovered[0]["roundId"],call.round);
    let index:Vec<Value>=std::fs::read_to_string(call.log.parent().unwrap().join("logs/index.jsonl")).unwrap()
        .lines().map(|line|serde_json::from_str(line).unwrap()).collect();
    assert_eq!(index.iter().filter(|event|event["event"]=="response_received"&&event["taskId"]==call.task
        &&event["requestId"]==record.request_id&&event["usage"]["total_tokens"]==19).count(),1);
    let log_file=index.iter().find(|event|event["event"]=="response_received").unwrap()["file"].as_str().unwrap();
    let raw:Vec<Value>=std::fs::read_to_string(call.log.parent().unwrap().join("logs").join(log_file)).unwrap()
        .lines().map(|line|serde_json::from_str(line).unwrap()).collect();
    let original=raw.iter().find(|event|event["event"]=="response_received").unwrap();
    assert_eq!(original["recoveredOriginal"],true);assert_eq!(original["source"],"bound_adapter_status");
    assert_eq!(original["contractValidation"],"pending");assert_eq!(original["roundId"],call.round);
    println!("real_loopback_original_wait elapsed_ms={} generation_posts=1 generations=1 attempts=1 tokens=19 request_id={} deadline_unchanged=true",elapsed.as_millis(),record.request_id);
}

#[test]
fn original_wait_running_and_slow_body_never_extend_the_original_deadline() {
    for mode in [ReplyMode::Running,ReplyMode::SlowBody] {
        let adapter=Adapter::new(mode);let call=Call::new(&adapter.url,2400);let began=Instant::now();
        let error=runtime().block_on(call.run(&adapter.url)).unwrap_err();let elapsed=began.elapsed();
        assert!(elapsed<Duration::from_millis(3300),"remaining deadline exceeded: {elapsed:?}");
        assert!(error.contains("MODEL_RECOVERY_BUDGET_EXHAUSTED")||error.contains("MODEL_DISPATCH_UNKNOWN"));
        assert_eq!(call.budget.snapshot()["generations"],1);assert_eq!(adapter.count("POST /v1/chat/completions "),1);
        assert!(call.cost()["task"]["estimatedReservedTokens"].as_u64().unwrap()>0);assert_eq!(call.cost()["task"]["knownUsageTokens"],0);
    }
}

#[test]
fn accounting_only_query_after_deadline_and_cancel_is_get_only_and_settles_original_once() {
    let adapter=Adapter::new(ReplyMode::CompleteAt(3000)); let call=Call::new(&adapter.url,1500);
    assert!(runtime().block_on(call.run(&adapter.url)).is_err());
    assert!(call.cost()["task"]["estimatedReservedTokens"].as_u64().unwrap()>0);
    call.handle.cancel_for_test(&call.task).unwrap();
    let response=runtime().block_on(recover_local_adapter_with_budget(&call.handle,"synthetic",Duration::from_secs(5),None,true)).unwrap();
    assert!(response.is_some());
    assert!(call.handle.assert_deliverable().unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
    assert_eq!(call.cost()["task"]["knownUsageTokens"],19);
    let cost=call.cost();
    runtime().block_on(recover_local_adapter_with_budget(&call.handle,"synthetic",Duration::from_secs(5),None,true)).unwrap();
    assert_eq!(call.cost(),cost);
    assert_eq!(adapter.count("POST /v1/chat/completions "),1);
    assert_eq!(adapter.count("POST "),1,"accounting must never send a cancel or new generation POST");
    assert_eq!(call.handle.read().unwrap().state,RequestState::Completed);
}

#[test]
fn original_wait_lost_unknown_or_wrong_identity_ends_without_reposting() {
    for mode in [ReplyMode::Lost,ReplyMode::Unknown,ReplyMode::WrongDigest] {
        let adapter=Adapter::new(mode);let call=Call::new(&adapter.url,20000);let began=Instant::now();
        assert!(runtime().block_on(call.run(&adapter.url)).unwrap_err().contains("MODEL_DISPATCH_UNKNOWN"));
        assert!(began.elapsed()<Duration::from_secs(5));assert_eq!(call.handle.read().unwrap().state,RequestState::Unknown);
        assert_eq!(adapter.count("GET "),2);assert_eq!(adapter.count("POST /v1/chat/completions "),1);assert_eq!(call.budget.snapshot()["generations"],1);
    }
}

#[test]
fn original_wait_cancel_or_requirement_cutoff_keeps_late_usage_without_consuming_response() {
    for changed_requirement in [false,true] {
        let adapter=Adapter::new(ReplyMode::CompleteAt(1800));let call=Call::new(&adapter.url,12000);
        let result=runtime().block_on(async {
            let handle=call.handle.clone();let task=call.task.clone();let started=call.started;
            let path=call.log.parent().unwrap().join("model-requests.sqlite3");
            let control=tokio::spawn(async move {
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {if handle.read().is_ok_and(|r|r.state==RequestState::Accepted){break;}assert!(Instant::now()<deadline);tokio::time::sleep(Duration::from_millis(10)).await;}
                let mut store=Store::open(&path,"fixture").unwrap();
                if changed_requirement {store.cancel_before_for_test(&task,started).unwrap();}
                else {store.cancel(&task,Some(&handle.id)).unwrap();}
            });
            let result=call.run(&adapter.url).await;control.await.unwrap();result
        });
        assert!(result.unwrap_err().contains("MODEL_REQUEST_CANCELLED"));
        let record=call.handle.read().unwrap();assert_eq!(record.state,RequestState::Completed);assert!(record.late&&record.cancel_requested);
        assert_eq!(call.cost()["task"]["knownUsageTokens"],19);assert_eq!(call.cost()["round"]["knownUsageTokens"],19);
        assert_eq!(adapter.count("POST /v1/chat/completions "),1);
    }
}

#[test]
fn original_wait_real_prepare_uses_budget_start_for_current_and_late_operation_cutoff() {
    for old_operation in [false,true] {
        let adapter=Adapter::new(ReplyMode::CompleteAt(0));let call=Call::new(&adapter.url,10000);
        // This is the actual transport entry, not a manually manufactured record.
        call.store().cancel_before_for_test(&call.task,if old_operation{call.started}else{call.started-1}).unwrap();
        let result=runtime().block_on(call.run(&adapter.url));
        if old_operation {assert!(result.unwrap_err().contains("MODEL_REQUEST_CANCELLED"));assert_eq!(adapter.count("POST /v1/chat/completions "),0);}
        else {result.unwrap();assert_eq!(call.handle.read().unwrap().operation_started_at_ms,call.started);assert_eq!(adapter.count("POST /v1/chat/completions "),1);}
    }
}

#[test]
fn original_wait_manual_reconciliation_keeps_its_short_allowance_after_running() {
    let adapter=Adapter::new(ReplyMode::Running);let call=Call::new(&adapter.url,1800);
    runtime().block_on(call.run(&adapter.url)).unwrap_err();
    let before=call.cost();let generation_count=call.budget.snapshot()["generations"].clone();
    let began=Instant::now();assert!(runtime().block_on(recover_local_adapter(&call.handle,"synthetic",1)).unwrap().is_none());
    assert!(began.elapsed()>=Duration::from_millis(900));assert!(began.elapsed()<Duration::from_millis(1600));
    assert_eq!(call.cost(),before);assert_eq!(call.budget.snapshot()["generations"],generation_count);
    assert_eq!(adapter.count("POST /v1/chat/completions "),1);
}
