import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalPresentationBackend, writePresentationText } from "./worker-presentation.js";
const request = { repo_path: '/repo', default_tenant: true as const, view_id: 'token' };
const response = () => ({ schema_version:1, mode:'readonly_state_view',scope:{repo_path:'/repo',tenant:'default',scope_id:'a'.repeat(64)},sampled_at_ms:1000,
  coverage:{graph:'unsupported_authenticated_registration_required',unbound_runs:'excluded_not_bound',repository_binding:'canonical_stored_paths_only',content:'structured_metadata_only',counting:'source_views_not_unique_workers'},
  view:{view_id:'fresh_token',source_kind:'session',state:'running',revision:1,latest_turn:null,last_updated_at_ms:1000,freshness:'recent',process_liveness:'unknown',wait_reason:'none',uncertain_delivery_recorded:false,controls:'unsupported'} });
afterEach(() => vi.useRealTimers());
function sink() {let text=''; const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}}); return {output,text:()=>text};}
it('reads only the original view token and suppresses unchanged metadata', async()=>{
  vi.useFakeTimers(); const out=sink(); const reads: unknown[]=[];
  const backend=createTerminalPresentationBackend({inspect:async value=>{reads.push(value);return response();},output:out.output});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:3000});
  await vi.advanceTimersByTimeAsync(2001); backend.closeView(handle); const result=await handle.done;
  expect(result.reason).toBe('closed'); expect(reads).toHaveLength(3); expect(reads.every(value=>(value as typeof request).view_id==='token')).toBe(true);
  expect(out.text().match(/snapshot=/g)).toHaveLength(1); expect(backend.focus(handle)).toBe('unsupported');
  expect(backend.capabilities()).toMatchObject({view:true,focus:false,archive:false});
});
it('closes a pending reader without outputting its late result',async()=>{
  let resolve!: (value:unknown)=>void; const out=sink();
  const backend=createTerminalPresentationBackend({inspect:()=>new Promise(done=>{resolve=done;}),output:out.output});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:5000}); await vi.waitFor(()=>expect(resolve).toBeTypeOf("function")); backend.closeView(handle); await handle.done;
  resolve(response()); await Promise.resolve(); expect(out.text()).not.toContain('snapshot=');
});
it('ends unknown on expired token without acquiring another token or invoking controls',async()=>{
  const out=sink(); const inspect=vi.fn(async()=>{throw Error('invalid_view');});
  const handle=createTerminalPresentationBackend({inspect,output:out.output}).open(request,{interval_ms:1000,duration_ms:3000});
  expect(await handle.done).toMatchObject({reason:'unknown',detail:'invalid_view'}); expect(inspect).toHaveBeenCalledTimes(1); expect(out.text()).toContain('unknown');
});
it('stops on unknown source observation and escapes terminal controls in paths',async()=>{
  const out=sink(); const raw=response();raw.scope.repo_path='/repo\u001b]0;title\u0007\u009b31m\u202e\u2066\u200b\ufeff';raw.view.state='unknown';
  const result=await createTerminalPresentationBackend({inspect:async()=>raw,output:out.output}).open(request,{interval_ms:1000,duration_ms:3000}).done;
  expect(result.reason).toBe('unknown'); expect(out.text()).not.toContain(String.fromCharCode(27)); expect(out.text()).not.toContain(String.fromCharCode(155));for(const code of [7,0x202e,0x2066,0x200b,0xfeff])expect(out.text()).not.toContain(String.fromCharCode(code));
});
it('honors output backpressure and closing never destroys the shared terminal stream',async()=>{
  let callback!:()=>void;const output=new Writable({highWaterMark:1,write(_chunk,_encoding,done){callback=done;}});
  const inspect=vi.fn(async()=>response());const backend=createTerminalPresentationBackend({inspect,output});const handle=backend.open(request,{interval_ms:1000,duration_ms:5000});
  await vi.waitFor(()=>expect(callback).toBeTypeOf("function")); backend.closeView(handle);expect((await handle.done).reason).toBe('closed');expect(output.destroyed).toBe(false);callback();
});
it('handles EPIPE as local output closure, without a worker action',async()=>{
  const output=new Writable({write(_chunk,_encoding,done){const error=Object.assign(Error('pipe'),{code:'EPIPE'});done(error);}});
  const result=await createTerminalPresentationBackend({inspect:async()=>response(),output}).open(request,{interval_ms:1000,duration_ms:3000}).done;
  expect(result.reason).toBe('output_closed');
});
it('rejects a changed scope instead of following another worker observation',async()=>{
  vi.useFakeTimers();let calls=0;const out=sink();const backend=createTerminalPresentationBackend({output:out.output,inspect:async()=>{const raw=response();if(++calls>1)raw.scope.scope_id='b'.repeat(64);return raw;}});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:5000});await vi.advanceTimersByTimeAsync(1001);
  expect(await handle.done).toMatchObject({reason:'unknown'});expect(out.text()).not.toContain('b'.repeat(64));
});
it('bounds response floods and does not echo unvalidated output',async()=>{
  const out=sink();const raw=response();raw.scope.repo_path='secret'.repeat(20000);
  const result=await createTerminalPresentationBackend({inspect:async()=>raw,output:out.output}).open(request).done;
  expect(result.reason).toBe('unknown');expect(out.text().length).toBeLessThan(200);expect(out.text()).not.toContain('secret');
});
it('ends a never-settling read on duration and ignores a pre-aborted viewer',async()=>{
  vi.useFakeTimers();const out=sink();const inspect=vi.fn(()=>new Promise<unknown>(()=>{}));
  const handle=createTerminalPresentationBackend({inspect,output:out.output}).open(request,{interval_ms:1000,duration_ms:1000});
  await vi.advanceTimersByTimeAsync(1000);expect(await handle.done).toMatchObject({reason:'duration_elapsed'});
  const aborted=new AbortController();aborted.abort();const before=inspect.mock.calls.length;
  expect(await createTerminalPresentationBackend({inspect,output:out.output}).open(request,{signal:aborted.signal}).done).toMatchObject({reason:'interrupted'});
  expect(inspect.mock.calls.length).toBe(before);
});

it('locally times out a hung transport as unknown and aborts its read signal',async()=>{
  vi.useFakeTimers();const out=sink();let signal:AbortSignal|undefined;
  const handle=createTerminalPresentationBackend({output:out.output,inspect:async(_reference,readSignal)=>{signal=readSignal;return new Promise(()=>{});}}).open(request,{duration_ms:5000});
  await vi.advanceTimersByTimeAsync(1001);
  expect(await handle.done).toMatchObject({reason:'unknown',detail:'worker_read_timeout'});expect(signal?.aborted).toBe(true);
});
it('cleans a callback-only write error listener after the Node error dispatch turn',async()=>{
  const out=sink();vi.spyOn(out.output,'write').mockImplementation((_chunk,_encodingOrCallback,callback)=>{
    const done=typeof _encodingOrCallback==='function'?_encodingOrCallback:callback;done?.(Error('destroyed'));return false;
  });
  await expect(writePresentationText(out.output,'hello',new AbortController().signal)).rejects.toThrow('output_closed');
  await new Promise(resolve=>setImmediate(resolve));expect(out.output.listenerCount('error')).toBe(0);
});

it('preserves interruption when the final unknown diagnostic is backpressured',async()=>{
  let callback!:()=>void;const output=new Writable({write(_chunk,_encoding,done){callback=done;}});const abort=new AbortController();
  const handle=createTerminalPresentationBackend({output,inspect:async()=>({invalid:true})}).open(request,{signal:abort.signal});
  await vi.waitFor(()=>expect(callback).toBeTypeOf('function'));abort.abort();
  expect(await handle.done).toMatchObject({reason:'interrupted'});callback();
});
it('retains only one late-error guard when a pending output never calls back',async()=>{
  let written=false;const output=new Writable({write(){written=true;}});const backend=createTerminalPresentationBackend({output,inspect:async()=>response()});const handle=backend.open(request);
  await vi.waitFor(()=>expect(written).toBe(true));backend.closeView(handle);expect((await handle.done).reason).toBe('closed');
  expect(output.listenerCount('error')).toBe(1);expect(output.destroyed).toBe(false);
  output.emit('error',Error('late shared output error'));expect(output.listenerCount('error')).toBe(0);
});
