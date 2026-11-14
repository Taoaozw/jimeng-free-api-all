const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dreamina-tasks-'));
Object.assign(process.env,{JIMENG_LIBRARY_DIR:temporary,JIMENG_LIBRARY_ACCOUNT:'account-a',JIMENG_API_KEY:'private-key',JIMENG_ACCOUNT_TOKEN:'secret-token',JIMENG_MEDIA_BASE_URL:'https://media.example/account-a'});
let submitError,history={status:20},submissions=0,lastOptions,queue=2,cancelError,outputError,frameError,frameResolve,frameCalls=0,muteCalls=0,muteError,muteResolve,deliveries=[];
const mocks={
 '@/api/tasks/mute-video.ts':{muteVideo:async()=>{muteCalls++;if(muteError)throw muteError;return await new Promise(resolve=>{muteResolve=resolve})}},
 '@/api/tasks/last-frame.ts':{lastFrame:async()=>{frameCalls++;if(frameError)throw frameError;return await new Promise(resolve=>{frameResolve=resolve})}},
 '@/api/tasks/output.ts':{videoOutput:async item=>{if(outputError)throw outputError;return item?.video?.play_url??'https://example.com/result.mp4'}},
 '@/api/tasks/callback.ts':{destination:async value=>{if(!value.startsWith('https://')) load('@/api/library/store.ts').invalid('Invalid callback')},deliver:async(url,body)=>deliveries.push(body)},
 '@/api/controllers/core.ts':{tokenSplit:s=>s.replace(/^Bearer /,'').split(','),request:async(method,url)=>{if(url.includes('cancel_generate')) {if(cancelError) throw cancelError; return {}};return url.includes('queue_info')?{'native-id':{queue_info:{queue_status:queue}}}:{'native-id':history}}},
 '@/api/controllers/videos.ts':{submitVideo:async(m,p,o)=>{submissions++;lastOptions=o;if(submitError)throw submitError;return 'native-id'},fetchHighQualityVideoUrl:async()=>null,uploadImageForVideo:async()=> 'image-uri',uploadMediaForVideo:async()=>({vid:'vid',duration:4000})},
};
function loader(){const cache=new Map();return function load(filename){
 if(mocks[filename])return mocks[filename];
 if(filename.endsWith('/tasks/mute-video.ts'))return mocks['@/api/tasks/mute-video.ts'];
 if(filename.endsWith('/tasks/last-frame.ts'))return mocks['@/api/tasks/last-frame.ts'];
 if(filename.endsWith('/tasks/output.ts'))return mocks['@/api/tasks/output.ts'];
 if(filename.endsWith('/tasks/callback.ts'))return mocks['@/api/tasks/callback.ts'];
 const absolute=filename.startsWith('@/')?path.resolve(__dirname,'../src',filename.slice(2)):filename;
 if(cache.has(absolute))return cache.get(absolute);
 const exports={};cache.set(absolute,exports);
 const js=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{exports,process,Buffer,URL,console,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(absolute),n)):n.startsWith('@/')?load(n):require(n)});return exports;
}}
const load=loader(),service=load('@/api/tasks/service.ts'),parse=load('@/api/tasks/input.ts').parseInput;
const headers={authorization:'Bearer secret-token'},body={model:'jimeng-video-seedance-2.5',content:[{type:'text',text:'A paper boat floats'}],duration:4,resolution:'480p',seed:12};
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
test('Ark input keeps frames, seed and rejects unsupported capabilities before submission',()=>{
 const p=parse({...body,content:[...body.content,{type:'image_url',image_url:{url:'https://example.com/first.png'},role:'first_frame'},{type:'image_url',image_url:{url:'https://example.com/last.png'},role:'last_frame'}]});
 assert.equal(p.filePaths.length,2);assert.equal(p.seed,12);
 assert.equal(parse({...body,content:[...body.content,{type:'image_url',image_url:{url:'https://example.com/first.png'}}]}).filePaths.length,1);
 for(const extra of [{duration:31},{draft:true,resolution:'720p'},{ratio:'adaptive'},{content:[{type:'image_url',role:'last_frame',image_url:{url:'https://example.com/a.png'}}]}]) assert.throws(()=>parse({...body,...extra}),e=>e.status===400);
});
test('accepted tasks survive restart, preserve account binding and never store credentials',async()=>{
 const result=await service.create(headers,body);assert.match(result.id,/^dmt_/);assert.equal(lastOptions.duration,4);
 const restored=loader()('@/api/tasks/service.ts');
 assert.equal((await restored.get(headers,result.id)).status,'running');
 await assert.rejects(restored.get({authorization:'Bearer another-account'},result.id),e=>e.status===404);
 await assert.rejects(restored.remove(headers,result.id),e=>e.status===409);
 assert.equal(submissions,1);
 history={status:50,item_list:[{video:{play_url:'https://example.com/result.mp4'}}]};
 const done=await restored.get(headers,result.id);assert.equal(done.status,'succeeded');assert.equal(done.content.video_url,'https://example.com/result.mp4');assert.equal(done.usage,undefined);assert.equal(done.credential,undefined);assert.equal(done.historyId,undefined);
 const files=fs.readdirSync(temporary,{recursive:true}).filter(f=>f.endsWith('.json'));assert.equal(files.length,1);
 assert(!fs.readFileSync(path.join(temporary,files[0]),'utf8').includes('secret-token'));
 history={status:30,fail_code:2052};assert.equal((await service.get(headers,result.id)).status,'succeeded');
 await service.remove(headers,result.id);await assert.rejects(service.get(headers,result.id),e=>e.status===404);
 assert.equal((await service.get({...headers,'x-flowxy-task-reconcile':'true'},result.id)).status,'succeeded');
});
test('business rejection is not an accepted task and terminal errors retain upstream code',async()=>{
 submitError=Error('ret=2001');await assert.rejects(service.create(headers,body),/ret=2001/);submitError=undefined;
 const result=await service.create(headers,body);history={status:30,fail_code:2052};
 const failed=await service.get(headers,result.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'2052');assert.equal(failed.content,undefined);
 const restored=loader()('@/api/tasks/service.ts');assert.equal((await restored.get(headers,result.id)).error.code,'2052');
 await assert.rejects(service.get(headers,'../../etc/passwd'),e=>e.status===404);
});
test('Ark route returns real HTTP errors for invalid and failed submissions',async()=>{
 const route=load('@/api/routes/tasks.ts').default;
 const invalid=await route.post['']({headers,body:{...body,callback_url:'unsupported'}});assert.equal(invalid.statusCode,400);
 submitError={errcode:2001,errmsg:'Upstream rejected'};
 const failed=await route.post['']({headers,body});assert.equal(failed.statusCode,502);assert.equal(failed.body.error.code,'2001');submitError=undefined;
});

test('list ownership, public IDs, queued cancellation and persistent callbacks',async()=>{
 history={status:20};queue=0;deliveries=[];
 const owner={...headers,'x-flowxy-library-owner':'org-a','x-flowxy-task-scope':'channel:key','x-flowxy-task-public-id':'fxt-public','x-flowxy-task-model':'public-model'};
 const created=await service.create(owner,{...body,callback_url:'https://callback.example/test'});
 assert.equal((await service.get(headers,created.id)).status,'queued');
 assert.equal((await service.list(owner,{})).items[0].id,'fxt-public');
 assert.equal((await service.list({...owner,'x-flowxy-library-owner':'org-b'},{})).total,0);
 assert.equal((await service.list(owner,{'filter.status':'failed'})).total,0);
 await assert.rejects(service.list(owner,{page_size:501}),e=>e.status===400);
 cancelError=Error('native cancellation rejected');await assert.rejects(service.remove(headers,created.id),/rejected/);
 assert.equal((await service.get(headers,created.id)).status,'queued');cancelError=undefined;
 await service.remove(headers,created.id);assert.equal((await service.get(headers,created.id)).status,'cancelled');
 await loader()('@/api/tasks/service.ts').flushCallbacks();await service.flushCallbacks();
 assert.deepEqual(deliveries.map(d=>[d.id,d.status]),[['fxt-public','queued'],['fxt-public','cancelled']]);
 await service.remove(headers,created.id);
});
test('draft finalization inherits source parameters and account, without regenerating the prompt',async()=>{
 history={status:50,draft_content:'{"main_component_id":"original","component_list":[]}',item_list:[{item_id:'item-1',video:{play_url:'https://example.com/draft.mp4'}}]};
 const draft=await service.create(headers,{...body,draft:true});assert.equal(lastOptions.draft,true);
 await service.get(headers,draft.id);
 const finalBody={model:body.model,content:[{type:'draft_task',draft_task:{id:draft.id}}],resolution:'1080p'};
 await service.create(headers,finalBody);
 assert.equal(lastOptions.draftSource.historyId,'native-id');assert.equal(lastOptions.draftSource.itemId,'item-1');
 assert.equal(lastOptions.duration,4);assert.equal(lastOptions.seed,12);assert.equal(lastOptions.resolution,'1080p');
 await assert.rejects(service.create({authorization:'Bearer other'},finalBody),e=>e.status===404);
 assert.throws(()=>parse({...finalBody,duration:5}),e=>e.status===400);
 assert.throws(()=>parse({...finalBody,resolution:'4k'}),e=>e.status===400);
});

test('public deletion retains both settlement state and queued callback deliveries',async()=>{
 history={status:30,fail_code:2052};deliveries=[];
 const owned={...headers,'x-flowxy-task-public-id':'fxt-deleted'};
 const created=await service.create(owned,{...body,callback_url:'https://callback.example/deleted'});
 await service.get(headers,created.id);
 await service.remove(headers,created.id);
 await assert.rejects(service.get(headers,created.id),e=>e.status===404);
 assert.equal((await service.get({...headers,'x-flowxy-task-reconcile':'true'},created.id)).status,'failed');
 await loader()('@/api/tasks/service.ts').flushCallbacks();await service.flushCallbacks();
 assert.deepEqual(deliveries.map(d=>[d.id,d.status]),[['fxt-deleted','queued'],['fxt-deleted','failed']]);
});

test('edit and extend validate Ark constraints and preserve native source indexes', async()=>{
 const content=[...body.content,{type:'image_url',role:'reference_image',image_url:{url:'https://example.com/frame.png'}},{type:'video_url',role:'reference_video',video_url:{url:'data:video/mp4;base64,AAAAAGZ0eXBpc29t'}}];
 for(const [taskType,duration] of [['edit',-1],['extend',4]]) {
  const request={...body,content,ratio:'adaptive',duration,omni_reference_task_type:taskType};
  const result=await service.create(headers,request);
  assert.equal(lastOptions.unifiedEditInput[`${taskType}_input`][`${taskType}_from_material_idx`],1);
  assert.equal(lastOptions.duration,duration);assert.equal(lastOptions.ratio,'adaptive');
  assert.equal((await service.get(headers,result.id)).omni_reference_task_type,taskType);
  for(const patch of [{ratio:'16:9'},{content:body.content},{omni_reference_task_type:'invalid'}]) assert.throws(()=>parse({...request,...patch}),e=>e.status===400);
 }
 assert.throws(()=>parse({...body,content,ratio:'adaptive',duration:4,omni_reference_task_type:'edit'}),e=>e.status===400);
 assert.throws(()=>parse({...body,content,ratio:'adaptive',draft:true,omni_reference_task_type:'extend'}),e=>e.status===400);
 assert.equal(parse({...body,content,ratio:'adaptive',duration:-1,draft:true,omni_reference_task_type:'edit'}).draft,true);
 const before=submissions;
 await assert.rejects(service.create(headers,{...body,content:body.content,library_id:'x',references:['missing'],ratio:'adaptive',duration:4,omni_reference_task_type:'extend'}),e=>e.status===403);
 assert.equal(submissions,before);
});

test('adaptive task duration cannot become a negative or fabricated settlement',async()=>{
 const request={...body,content:[...body.content,{type:'video_url',role:'reference_video',video_url:{url:'data:video/mp4;base64,AAAAAGZ0eXBpc29t'}}],ratio:'adaptive',duration:-1,omni_reference_task_type:'edit'};
 history={status:20};
 const created=await service.create(headers,request);
 history={status:50,item_list:[{video:{play_url:'https://example.com/edited.mp4'}}]};
 await assert.rejects(service.get(headers,created.id),e=>e.status===502);
 history.item_list[0].video.duration_ms=4200;
 history.item_list[0].video.transcoded_video={origin:{width:854,height:480}};
 const done=await service.get(headers,created.id);
 assert.equal(done.duration,5);assert.equal(done.ratio,'16:9');assert.equal(done.status,'succeeded');
});


test('watermark selection persists through reload and never silently falls back',async()=>{
 history={status:50,item_list:[{item_id:'watermark-item',video:{video_id:'vid',play_url:'https://example.com/preview.mp4'}}]};
 for(const watermark of [false,true]) {
  const created=await service.create(headers,{...body,watermark});
  const done=await loader()('@/api/tasks/service.ts').get(headers,created.id);
  assert.equal(done.watermark,watermark);assert.equal(done.status,'succeeded');
 }
 assert.equal(parse(body).watermark,false);
 assert.throws(()=>parse({...body,watermark:'false'}),e=>e.status===400);
 const created=await service.create(headers,{...body,watermark:false,callback_url:'https://callback.example/output'});
 outputError=new (load('@/api/library/store.ts').LibraryError)(502,'task.output_unavailable','Requested variant unavailable');
 const failed=await service.get(headers,created.id);outputError=undefined;
 assert.equal(failed.status,'failed');assert.equal(failed.error.code,'task.output_unavailable');assert.equal(failed.content,undefined);
 assert.equal((await loader()('@/api/tasks/service.ts').get(headers,created.id)).status,'failed');
});


test('incomplete history remains retryable before selecting an output variant',async()=>{
 const created=await service.create(headers,body);history={status:50,item_list:[]};
 await assert.rejects(service.get(headers,created.id),e=>e.code==='task.upstream_unavailable');
 history={status:50,item_list:[{video:{play_url:'https://example.com/result.mp4'}}]};
 assert.equal((await service.get(headers,created.id)).status,'succeeded');
});


const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
test('last frame stays running, deduplicates polling, and persists URL in query list and callback',async()=>{
 history={status:50,item_list:[{item_id:'frame-item',video:{play_url:'https://example.com/video.mp4'}}]};deliveries=[];frameCalls=0;
 const owner={...headers,'x-flowxy-library-owner':'org-frame','x-flowxy-task-scope':'channel:key','x-flowxy-task-public-id':'fxt-frame'};
 const created=await service.create(owner,{...body,return_last_frame:true,callback_url:'https://callback.example/frame'});
 const pending=await service.get(headers,created.id);assert.equal(pending.status,'running');assert.equal(pending.content,undefined);
 await service.get(headers,created.id);assert.equal(frameCalls,1);
 frameResolve({id:'a'.repeat(64),url:'https://media.example/last.jpg',expiresAt:Date.now()+86400000});await tick();
 const done=await loader()('@/api/tasks/service.ts').get(headers,created.id);
 assert.equal(done.status,'succeeded');assert.equal(done.content.last_frame_url,'https://media.example/last.jpg');assert.equal(done.postprocess,undefined);
 assert.equal((await service.list(owner,{})).items[0].content.last_frame_url,done.content.last_frame_url);
 await service.flushCallbacks();await service.flushCallbacks();await service.flushCallbacks();
 assert.equal(deliveries.at(-1).content.last_frame_url,done.content.last_frame_url);
 await service.remove(headers,created.id);
});
test('last frame failure persists as failure and false never schedules postprocessing',async()=>{
 frameError=Error('decoder failed');const created=await service.create(headers,{...body,return_last_frame:true});
 await service.get(headers,created.id);await tick();frameError=undefined;
 const failed=await loader()('@/api/tasks/service.ts').get(headers,created.id);
 assert.equal(failed.status,'failed');assert.equal(failed.error.code,'task.last_frame_failed');assert.equal(failed.content,undefined);
 const calls=frameCalls, plain=await service.create(headers,{...body,return_last_frame:false});
 assert.equal((await service.get(headers,plain.id)).status,'succeeded');assert.equal(frameCalls,calls);
 for(const value of ['true',1,null])assert.throws(()=>parse({...body,return_last_frame:value}),e=>e.status===400);
});
test('persisted postprocessing resumes after restart and remains bound to the original account',async()=>{
 const created=await service.create(headers,{...body,return_last_frame:true});
 const directory=path.join(load('@/api/library/store.ts').libraryStore().directory,'tasks');
 const file=path.join(directory,created.id+'.json'),record=JSON.parse(fs.readFileSync(file));
 Object.assign(record,{status:'running',postprocess:{sourceUrl:'https://example.com/native.mp4',videoUrl:'https://example.com/marked.mp4'}});fs.writeFileSync(file,JSON.stringify(record));
 const restarted=loader()('@/api/tasks/service.ts');
 await assert.rejects(restarted.get({authorization:'Bearer wrong-account'},created.id),e=>e.status===404);
 assert.equal((await restarted.get(headers,created.id)).status,'running');
 frameResolve({id:'b'.repeat(64),url:'https://media.example/resumed.jpg',expiresAt:Date.now()+86400000});await tick();
 assert.equal((await restarted.get(headers,created.id)).content.last_frame_url,'https://media.example/resumed.jpg');
});
test('audio false waits for processing, survives restart, and combines with last frame and callbacks',async()=>{
 history={status:50,item_list:[{video:{play_url:'https://example.com/marked.mp4'}}]};deliveries=[];
 const owned={...headers,'x-flowxy-library-owner':'org-muted','x-flowxy-task-scope':'channel:key','x-flowxy-task-public-id':'fxt-muted'};
 const created=await service.create(owned,{...body,generate_audio:false,watermark:true,return_last_frame:true,callback_url:'https://callback.example/muted'});
 assert.equal((await service.get(headers,created.id)).status,'running');const calls=muteCalls;
 await service.get(headers,created.id);assert.equal(muteCalls,calls);
 muteResolve({id:'c'.repeat(64),url:'https://media.example/silent.mp4'});await tick();
 assert.equal((await service.get(headers,created.id)).content,undefined);
 frameResolve({id:'d'.repeat(64),url:'https://media.example/last.jpg'});await tick();
 const restored=loader()('@/api/tasks/service.ts'),done=await restored.get(headers,created.id);
 assert.equal(done.status,'succeeded');assert.equal(done.generate_audio,false);assert.equal(done.watermark,true);assert.equal(done.content.video_url,'https://media.example/silent.mp4');assert.equal(done.content.last_frame_url,'https://media.example/last.jpg');
 assert.equal((await service.list(owned,{})).items[0].content.video_url,done.content.video_url);
 await service.flushCallbacks();await service.flushCallbacks();await service.flushCallbacks();assert.equal(deliveries.at(-1).generate_audio,false);
 await service.remove(headers,created.id);
});
test('mute failure is terminal and true or omitted audio never starts a worker',async()=>{
 muteError=Error('remux failed');const created=await service.create(headers,{...body,generate_audio:false});await service.get(headers,created.id);await tick();muteError=undefined;
 const failed=await service.get(headers,created.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'task.audio_postprocess_failed');assert.equal(failed.content,undefined);
 for(const flag of [true,undefined]){const before=muteCalls;const task=await service.create(headers,{...body,generate_audio:flag});assert.equal((await service.get(headers,task.id)).status,'succeeded');assert.equal(muteCalls,before)}
 for(const flag of ['false',0,null])assert.throws(()=>parse({...body,generate_audio:flag}),e=>e.status===400);
});
test('pending mute resumes after restart only for the original account',async()=>{
 const created=await service.create(headers,{...body,generate_audio:false});
 const directory=path.join(load('@/api/library/store.ts').libraryStore().directory,'tasks'),file=path.join(directory,created.id+'.json'),record=JSON.parse(fs.readFileSync(file));
 Object.assign(record,{status:'running',postprocess:{sourceUrl:'https://example.com/raw.mp4',videoUrl:'https://example.com/marked.mp4'}});fs.writeFileSync(file,JSON.stringify(record));
 const restarted=loader()('@/api/tasks/service.ts');await assert.rejects(restarted.get({authorization:'Bearer wrong-account'},created.id),e=>e.status===404);
 assert.equal((await restarted.get(headers,created.id)).status,'running');muteResolve({id:'e'.repeat(64),url:'https://media.example/resumed.mp4'});await tick();
 const done=await restarted.get(headers,created.id);assert.equal(done.generate_audio,false);assert.equal(done.content.video_url,'https://media.example/resumed.mp4');assert.equal(done.content.last_frame_url,undefined);
});
test('a later frame failure removes the already muted video and exposes no partial result',async()=>{
 const store=load('@/api/tasks/frame-store.ts'),source=path.join(temporary,'partial.mp4');fs.writeFileSync(source,'video');const video=await store.saveVideo(source);
 frameError=Error('frame decoder failed');const task=await service.create(headers,{...body,generate_audio:false,return_last_frame:true});await service.get(headers,task.id);muteResolve(video);await tick();frameError=undefined;
 const failed=await service.get(headers,task.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'task.last_frame_failed');assert.equal(failed.content,undefined);await assert.rejects(store.readVideo(video.id),e=>e.status===404);
});
