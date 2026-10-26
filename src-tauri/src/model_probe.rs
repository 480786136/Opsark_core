//! Core-owned configuration probe identities. No OpsTask or task budget is invented.
use serde_json::{json, Value};

pub(crate) fn scope(endpoint:&str, model:&str, api_key:&str, protocol:Option<&str>) -> Result<(String,String),String> {
    let url=crate::model_protocol::endpoint(endpoint,protocol.unwrap_or("chat_completions"))?;
    let id=crate::model_request_lifecycle::digest(json!(["model-probe@1",url,model,
        crate::model_request_lifecycle::digest(api_key.as_bytes())]).to_string().as_bytes());
    Ok((url,format!("probe-{id}")))
}

/// The model's parameters/capabilities always come from probe_body's explicit
/// arguments. The optional IPC context carries only local lifecycle controls.
pub(crate) fn bind_context(body:&mut Value, raw:Option<&str>, probe:&str) -> Result<(),String> {
    let error=||crate::model_compatibility::error("MODEL_REQUEST_INVALID","模型测试生命周期上下文无效");
    let supplied:Value=serde_json::from_str(raw.unwrap_or("{}")).map_err(|_|error())?;
    let object=supplied.as_object().ok_or_else(error)?;
    if object.keys().any(|key|!matches!(key.as_str(),"_modelRecovery"|"_modelRequestLifecycle")) { return Err(error()); }
    if let Some(lifecycle)=object.get("_modelRequestLifecycle") {
        if lifecycle.as_object().is_none_or(|value|value.keys().any(|key|key!="adapter")) { return Err(error()); }
    }
    let mut context:Value=serde_json::from_str(body["_opsarkContext"].as_str().ok_or_else(error)?).map_err(|_|error())?;
    for (key,value) in object { context[key]=value.clone(); }
    if context.get("_modelRequestLifecycle").is_none() { context["_modelRequestLifecycle"]=json!({}); }
    context["_modelRequestLifecycle"]["probeId"]=json!(probe);
    body["_opsarkContext"]=json!(crate::model_budget::ensure_context(&context.to_string())?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_scope_survives_reopening_unsaved_drafts_but_separates_credentials_and_connections() {
        let original=scope("http://127.0.0.1:18767/v1","m","synthetic",None).unwrap();
        assert_eq!(original,scope("http://127.0.0.1:18767/v1/chat/completions","m","synthetic",None).unwrap());
        for (endpoint,model,key,protocol) in [
            ("http://127.0.0.1:18768/v1","m","synthetic",None),
            ("http://127.0.0.1:18767/v1","other","synthetic",None),
            ("http://127.0.0.1:18767/v1","m","other",None),
            ("http://127.0.0.1:18767/v1","m","synthetic",Some("responses")),
        ] { assert_ne!(original.1,scope(endpoint,model,key,protocol).unwrap().1); }
        assert!(!original.1.contains("synthetic"));
    }
    #[test]
    fn probe_context_preserves_adapter_and_operation_without_task_or_model_visible_controls() {
        let (mut body,operation)=crate::model::probe_body("m","parameters",None,None,None).unwrap();
        let original=body["messages"].clone();
        bind_context(&mut body,Some(r#"{"_modelRecovery":{"operationId":"test-operation","startedAtMs":1},"_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":"http://127.0.0.1:18767/"}}}"#),"probe-original").unwrap();
        let context:Value=serde_json::from_str(body["_opsarkContext"].as_str().unwrap()).unwrap();
        assert_eq!(context["_modelRecovery"]["operationId"],"test-operation");
        assert_eq!(context["_modelRequestLifecycle"]["probeId"],"probe-original");
        assert!(crate::task_model_budget::TaskBudget::for_context(&context).unwrap().is_none());
        assert_eq!(body["messages"],original);
        let preview=crate::model::preview_model_request("http://127.0.0.1:18767/v1",&body,operation,false).unwrap();
        assert!(!preview["request"].to_string().contains("probe-original"));
        assert!(!preview["request"].to_string().contains("test-operation"));
    }
    #[test]
    fn probe_context_rejects_injected_task_budget_or_scope_and_preserves_explicit_capabilities() {
        for raw in [r#"{"taskId":"fake"}"#,r#"{"_taskModelBudget":{}}"#,r#"{"_modelRequestLifecycle":{"probeId":"other"}}"#,
            r#"{"_modelRequestLifecycle":{"taskId":"other"}}"#,r#"{"_modelCapabilities":{}}"#,"null","[]"] {
            let (mut body,_)=crate::model::probe_body("m","parameters",None,None,None).unwrap();
            assert!(bind_context(&mut body,Some(raw),"probe-original").is_err());
        }
    }

    /// Exercises the actual Tauri command function and the real HTTP transport;
    /// the local fixture is deliberately not a running bridge or real model.
    fn command_fixture(state:&'static str, wrong_digest:bool) -> (Result<crate::ModelCheckResult,String>,Vec<String>) {
        use std::io::{Read,Write};
        use std::time::{Duration,Instant};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin=format!("http://{}/",listener.local_addr().unwrap());
        let endpoint=format!("{origin}v1");
        let server=std::thread::spawn(move || {
            let mut requests=Vec::<String>::new();
            for index in 0..2 {
                let deadline=Instant::now()+Duration::from_secs(5);
                let mut socket=loop {
                    match listener.accept() {
                        Ok((socket,_))=>break socket,
                        Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{
                            assert!(Instant::now()<deadline,"probe command did not send expected request");
                            std::thread::sleep(Duration::from_millis(2));
                        },
                        Err(e)=>panic!("{e}"),
                    }
                };
                // Windows inherits the listener's nonblocking flag on accept.
                // Read the finite request synchronously after polling accept.
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes=Vec::new();
                loop {
                    let mut chunk=[0u8;4096]; let count=socket.read(&mut chunk).unwrap();
                    assert!(count>0); bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end)=bytes.windows(4).position(|w|w==b"\r\n\r\n") {
                        let header=String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length=header.lines().find_map(|line|line.strip_prefix("content-length:")).map(|v|v.trim().parse::<usize>().unwrap()).unwrap_or(0);
                        if bytes.len()>=end+4+length {break;}
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let (status,payload)=if index==0 {
                    (503,json!({"error":{"message":"synthetic adapter interrupted wait"}}))
                } else {
                    let original=&requests[0];
                    let header=original.split_once("\r\n\r\n").unwrap().0;
                    let id=header.lines().find_map(|line|line.strip_prefix("x-opsark-client-request-id: ")).unwrap();
                    let digest=header.lines().find_map(|line|line.strip_prefix("x-opsark-request-digest: ")).unwrap();
                    let body=original.split_once("\r\n\r\n").unwrap().1;
                    assert_eq!(digest,crate::model_request_lifecycle::digest(body.as_bytes()));
                    assert!(requests[1].starts_with(&format!("GET /opsark/requests/{id} ")));
                    assert!(requests[1].contains(&format!("x-opsark-request-digest: {digest}")));
                    assert!(requests[1].contains("authorization: Bearer synthetic-probe-key"));
                    assert!(!body.contains("_modelRecovery") && !body.contains("probeId"));
                    (200,json!({"protocol":"opsark-local-v1","requestId":id,"requestDigest":if wrong_digest{"wrong"}else{digest},
                        "state":state,"httpStatus":200,"response":if state=="completed" {Some(json!({"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],"usage":{"total_tokens":9}}))}else{None},
                        "usage":if state=="cancelled"{Some(json!({"total_tokens":4}))}else{None}}))
                };
                let body=payload.to_string();
                write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        let context=json!({"_modelRequestLifecycle":{"adapter":{"protocol":"opsark-local-v1","baseUrl":origin}}}).to_string();
        let result=tokio::runtime::Runtime::new().unwrap().block_on(crate::check_ai_model("synthetic-probe-key".into(),endpoint,"synthetic-model".into(),None,None,None,Some("parameters".into()),Some(10),Some(context)));
        (result,server.join().unwrap())
    }
    #[test]
    fn actual_probe_command_recovers_original_completion_with_one_generation() {
        let (result,requests)=command_fixture("completed",false);
        assert!(result.unwrap().available);
        assert_eq!(requests.iter().filter(|r|r.starts_with("POST ")).count(),1);
        assert!(!requests.iter().any(|r|r.contains("/health")));
    }
    #[test]
    fn actual_probe_command_preserves_unknown_cancelled_and_binding_conflicts() {
        for (state,wrong,expected) in [("unknown",false,"MODEL_DISPATCH_UNKNOWN"),("cancelled",false,"MODEL_REQUEST_CANCELLED"),("completed",true,"MODEL_DISPATCH_UNKNOWN")] {
            let (result,requests)=command_fixture(state,wrong);
            assert!(result.unwrap_err().contains(expected));
            assert_eq!(requests.iter().filter(|r|r.starts_with("POST ")).count(),1);
        }
    }
}
