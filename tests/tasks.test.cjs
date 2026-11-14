const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dreamina-tasks-'));
Object.assign(process.env,{JIMENG_LIBRARY_DIR:temporary,JIMENG_LIBRARY_ACCOUNT:'account-a',JIMENG_API_KEY:'private-key',JIMENG_ACCOUNT_TOKEN:'secret-token'});
let submitError,history={status:20},submissions=0,lastOptions,queue=2,cancelError,deliveries=[];
const mocks={
 '@/api/tasks/callback.ts':{destination:async value=>{if(!value.startsWith('https://')) load('@/api/library/store.ts').invalid('Invalid callback')},deliver:async(url,body)=>deliveries.push(body)},
 '@/api/controllers/core.ts':{tokenSplit:s=>s.replace(/^Bearer /,'').split(','),request:async(method,url)=>{if(url.includes('cancel_generate')) {if(cancelError) throw cancelError; return {}};return url.includes('queue_info')?{'native-id':{queue_info:{queue_status:queue}}}:{'native-id':history}}},
 '@/api/controllers/videos.ts':{submitVideo:async(m,p,o)=>{submissions++;lastOptions=o;if(submitError)throw submitError;return 'native-id'},fetchHighQualityVideoUrl:async()=>null,uploadImageForVideo:async()=> 'image-uri',uploadMediaForVideo:async()=>({vid:'vid',duration:4000})},
};
function loader(){const cache=new Map();return function load(filename){
 if(mocks[filename])return mocks[filename];
 if(filename.endsWith('/tasks/callback.ts'))return mocks['@/api/tasks/callback.ts'];
 const absolute=filename.startsWith('@/')?path.resolve(__dirname,'../src',filename.slice(2)):filename;
 if(cache.has(absolute))return cache.get(absolute);
 const exports={};cache.set(absolute,exports);
 const js=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{exports,process,Buffer,console,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(absolute),n)):n.startsWith('@/')?load(n):require(n)});return exports;
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
