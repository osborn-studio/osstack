-- Schema-47 dispatch committed with no completion proof; all foreign keys valid.
INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','fixture','running',1,1);
INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','fixture','code','execute',1);
INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,state,resume_supported,version,updated_at,repo_path)
VALUES('s','t','r','fixture','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','running',1,2,1,'/fixture');
INSERT INTO session_messages VALUES('msg','s','turn','outbound','instruction','{}','accepted',1,NULL);
INSERT INTO daemon_owner VALUES(1,'fixture-home','fixture-owner',1);
INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES('scope','t','/fixture',1);
INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,created_at,updated_at)
VALUES('item','scope','s','turn','decision','hash','{}',1,1,1);
INSERT INTO attention_actions VALUES('action','scope','item','hash','msg','uncertain',1,1);
INSERT INTO engineering_missions(mission_id,scope_id,task_id,run_id,session_id,repo_path,source_instance_id,source_generation,owner_principal_id,owner_client_session_id,goal,completion_level,state,revision,created_at,updated_at,observed_at,policy_digest)
VALUES('mission','scope','t','r','s','/fixture','instance',1,'operator','cli','observe','observed_turn','needs_reconciliation',1,1,1,1,'policy');
INSERT INTO engineering_waits(wait_id,mission_id,item_id,revision,decision_ref_json,state,action_id,created_at,updated_at)
VALUES('wait','mission','item',1,'{}','delivery_unknown','action',1,1);
INSERT INTO attention_dispatch_phases(action_id,message_id,mission_id,principal_id,client_session_id,protocol_version,phase,source_instance_id,source_generation,original_turn_id,source_version,reservation_version,reserved_by_generation,committed_by_generation,created_at,updated_at)
VALUES('action','msg','mission','operator','cli',1,'dispatch_committed','instance',1,'turn',1,2,1,1,1,1);
INSERT INTO attention_receipt_resolutions VALUES('msg','s',2,'abandoned_unknown','fixture unresolved execution','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1);
