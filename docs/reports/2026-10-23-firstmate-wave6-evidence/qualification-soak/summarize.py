import json, sqlite3, pathlib, hashlib
R=pathlib.Path(__file__).resolve().parent
s=json.loads((R/'full/summary.json').read_text());d=json.loads((R/'full/daemon-stats.json').read_text())
c=sqlite3.connect(f"file:{R}/full/home/state.db?mode=ro",uri=True);c.row_factory=sqlite3.Row
queries={"subjects":"select scope_id,kind,subject_id,admitted,generation,source_version,ordinal_cursor,payload_json from attention_subjects order by scope_id,kind,subject_id", "cursors":"select scope_id,run_id,last_seq,through_seq,gap,generation from attention_run_cursors order by run_id", "event_watermarks":"select run_id,count(*) count,min(seq) min_seq,max(seq) max_seq from events where run_id like 'r-%' group by run_id order by run_id", "session_versions":"select session_id,version from agent_sessions order by session_id"}
evidence={name:[dict(row) for row in c.execute(sql)] for name,sql in queries.items()}
(R/'full/final-source-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');c.close()
method=s['rpc_by_method'];internal={x['method']:x for x in d['rpc'] if x['method'] in method}
rows=['| Method | Socket count | Round trip p95 / max ms | Internal recent p95 / lifetime max ms |','|---|---:|---:|---:|']
for k,v in method.items():
 i=internal[k];rows.append(f"| `{k}` | {v['count']} | {v['p95_ms']:.3f} / {v['max_ms']:.3f} | {i['p95_ms']:.3f} / {i['max_ms']:.3f} |")
checks={'active_ten_minutes':s['active_wall_ms']>=600000,'rpc_zero_errors':s['counts']['rpc_errors']==0,'no_network_attempts':s['counts']['network_attempts']==0,'all_50_run_cursors_caught_up':all(x['pending']==0 and x['produced']==x['projected'] for x in s['convergence']['runs']),'all_30_session_versions_caught_up':all(x['pending']==0 and x['updated']==x['observed'] for x in s['convergence']['sessions']),'all_20_final_loop_snapshots_match':all(x['final_matches'] for x in s['convergence']['loops']),'no_projection_gaps':not s['failures'],'socket_roundtrip_p95_under_10ms':s['rpc_roundtrip']['p95_ms']<10,'all_recent_internal_read_rpc_p95_under_10ms':all(x['p95_ms']<10 for x in internal.values())}
(R/'verdict.json').write_text(json.dumps({'checks':checks,'slice_pass':all(checks.values()),'full_capacity_qualification':False,'original_plan_complete':False,'raw_harness_summary':str(R/'full/summary.json')},indent=2)+'\n')
con=s['convergence'];res=s['resources'];cpu=res['process_cpu_us'];total_cpu=(cpu['user']+cpu['system'])/1000
text=f'''# Q1: local mixed observation soak evidence

This bounded local synthetic slice {'passed' if all(checks.values()) else 'did not pass all checks'}. It is not full capacity qualification. Source: `{s['source_sha']}`, clean source manifest; Node `{s['node']}`, {s['platform']} {s['release']} {s['arch']}, {s['cpu']}, local APFS. Shared host, no isolated baseline. Wall-clock timestamps: {s['started_at']} to {s['ended_at']}.

## Workload actually exercised

- Real AF_UNIX framed daemon socket; daemon embedded in the same Vitest process as the fixture, client, and producer. Host health and Graph caller registration use explicit trusted test fixtures. No production home or real provider. Short socket symlink points into explicit scratch home and is removed after shutdown.
- 10 scopes / 100 admitted subjects: 30 session sources + 50 run sources + 20 on-disk Loop snapshots. Each session-bearing run counts once in each corresponding source type. All stayed admitted.
- {s['active_wall_ms']/1000:.3f} seconds active mixed traffic, {s['counts']['events_produced']} newly appended run events plus 50 seed events; {s['workload']['burst_10x_count']} ten-event bursts on one hot run. {s['counts']['session_updates']} session version updates and {s['counts']['loop_updates']} atomic Loop snapshot replacements.
- {s['counts']['rpc']} readonly socket requests (target 20/s), cycling recovery, session status, run status, Graph status/result, and inbox. {s['counts']['rpc_errors']} RPC errors; {s['counts']['network_attempts']} blocked fetch attempts. Triage disabled, adapters empty except explicitly registered synthetic Graph writer/reviewer, no publication provider.
- Two real artifact-only Graph deliveries completed during setup with synthetic workers and actual frozen candidate/reviewer/acceptance paths. Their stored status/result were queried continuously during measurement. Graph execution and cold worker startup were **not** under measured traffic. Source HEAD and tracked answer stayed unchanged.
- Facts were appended through the run repository helper, with synthetic direct session-version writes and atomic snapshot replacements. No dirty hint was injected after setup: the real 30-second timer had to discover changes. This intentionally measures the conservative polling fallback, not daemon event-ingestion latency.

## Latency

Whole-window socket round trip: p50 {s['rpc_roundtrip']['p50_ms']:.3f} ms, p95 {s['rpc_roundtrip']['p95_ms']:.3f} ms, p99 {s['rpc_roundtrip']['p99_ms']:.3f} ms, max {s['rpc_roundtrip']['max_ms']:.3f} ms. Includes socket creation/framing/client scheduling. Raw per-call samples are preserved.

{chr(10).join(rows)}

The internal recorder reports p95 over its last 512 observations per method, while its max is lifetime (including setup). Those are not whole-window internal percentiles. `attention.watch`, `attention.loop`, and Graph start setup timings remain in the raw daemon stats and are excluded from the readonly sustained-load gate. No product timeouts or thresholds changed.

## Fairness and convergence

Every one of the 50 run sources reached its exact final emitted sequence; every one of 30 session sources reached its final source version; every one of 20 Loop sources matched its last snapshot. No run sequence gap was reported. Per-source produced/projected counts and delays are in summary.json, and final SQL cursors plus source watermarks are separately preserved.

Run-event observation delay p95 {con['run_events']['p95_ms']/1000:.3f} s / max {con['run_events']['max_ms']/1000:.3f} s; session-version observation delay p95 {con['session_versions']['p95_ms']/1000:.3f} s / max {con['session_versions']['max_ms']/1000:.3f} s. Sampling adds up to approximately 250 ms. After the producer stopped, final convergence took {con['drain_ms']/1000:.3f} s. Version supersession does not prove that every transient session state was retained; Loop snapshots are explicitly lossy and only their final state is asserted. All run completeness fields remain `complete:false` / `unverified_retention`.

## Resource evidence

Peak sampled RSS {res['peak_rss_bytes']/1024/1024:.2f} MiB; combined fixture/client/daemon process CPU {total_cpu/1000:.3f} s ({total_cpu/s['active_wall_ms']*100:.2f}% of one core over the active interval). This is not isolated daemon CPU. Event-loop delay p95 {res['event_loop_delay_ms']['p95']:.3f} ms / max {res['event_loop_delay_ms']['max']:.3f} ms at 10-ms monitor resolution; that monitor is not a Loop-engine tick measurement. DB {res['db_bytes']} bytes / WAL {res['wal_bytes']} bytes. Observer step timings: {json.dumps(s['observer_steps'])}; includes discovery and SQLite and is not pure reduction cost per event.

## Remaining qualification gaps

No real provider/user workload, actual approval/clarification decision cycles, active concurrent Graph execution during sampling, Linux host, cross-process client contention, long retention proof, 1000-discovered/100-admitted overflow exercise, CI polling, notification-age measurement, or equivalent workload A/B Loop-engine overhead measurement. No `<1%` Loop tick claim and no pure reducer `<1 ms/event` claim. This one 100-subject point cannot establish maximum capacity. Existing deterministic tests and this soak support different claims. Full original R8/Q1 qualification remains partial.

## Reproduce and evidence

`soak.test.ts`, `vitest.config.mjs`, and `manifest.json` freeze the source/harness/environment. Use Node 22 and the recorded command, with a **fresh SOAK_TAG** to avoid reusing a previous synthetic home. Set SOAK_DURATION_MS=600000. `full.log` is the original test runner output; `full/rpc-samples.json`, `full/observer-steps.json`, `full/daemon-stats.json`, `full/summary.json`, `full/final-source-evidence.json`, and `verdict.json` preserve raw/derived evidence. `preflight` was a separate 2-second harness sanity run and is not counted in the ten-minute result. No source changes or feature commit were made.
'''
(R/'report.md').write_text(text)
manifest={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [R/'soak.test.ts',R/'vitest.config.mjs',R/'manifest.json',R/'full.log',R/'full/summary.json',R/'full/rpc-samples.json',R/'full/observer-steps.json',R/'full/daemon-stats.json',R/'full/final-source-evidence.json',R/'verdict.json',R/'report.md']}
(R/'evidence-sha256.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'checks':checks,'metrics':s['rpc_roundtrip'],'convergence_drain_ms':con['drain_ms'],'observer_steps':s['observer_steps'],'events':s['counts']['events_produced']},indent=2))
