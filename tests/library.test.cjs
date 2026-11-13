const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dreamina-library-'));
process.env.JIMENG_LIBRARY_DIR=temporary;
process.env.JIMENG_LIBRARY_ACCOUNT='test-account';
process.env.JIMENG_API_KEY='test-private-key';
process.env.JIMENG_ACCOUNT_TOKEN='test-token';
const cache=new Map(), calls=[];
let failUpstream=false;
const mocks={
 '@/api/controllers/core.ts': {tokenSplit:s=>s.replace(/^Bearer /,'').split(','),parseRegionFromToken:()=>({}),request:async(method,url,token,{data})=>{
   calls.push({url,data}); if(failUpstream)throw Error('ret=2001');
   return {uid:'test-uid',subject_id:data.subject_id||'subject-id',data_id:'data-'+calls.length,content:data.content};
 }},
 '@/api/controllers/videos.ts':{uploadImageBufferForVideo:async()=> 'image-uri',uploadMediaForVideo:async()=>({vid:'video-id',duration:3000,width:1280,height:720,fps:24})},
};
function load(filename){
 if(mocks[filename])return mocks[filename];
 const absolute=filename.startsWith('@/')?path.resolve(__dirname,'../src',filename.slice(2)):filename;
 if(cache.has(absolute))return cache.get(absolute);
 const exports={};cache.set(absolute,exports);
 const source=fs.readFileSync(absolute,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{exports,process,Buffer,console,require:name=>name.startsWith('.')?load(path.resolve(path.dirname(absolute),name)):name.startsWith('@/')?load(name):require(name)});
 return exports;
}
const service=load('@/api/library/service.ts'), storage=load('@/api/library/store.ts'), refs=load('@/api/library/references.ts'), media=load('@/api/library/media.ts');
const ctx=service.context({authorization:'Bearer token','x-flowxy-library-owner':'org-a'});
const other=service.context({authorization:'Bearer token','x-flowxy-library-owner':'org-b'});
const upload={name:'fixture.png',data:'data:image/png;base64,iVBORw0KGgo=',width:1280,height:720};

test('library upload, official element CRUD, isolation and persistence',async()=>{
 const a=await service.upload(ctx,upload);
 assert.equal(a.kind,'image');assert.equal(a.uri,undefined);assert.equal(a.owner,undefined);
 assert.equal((await service.list(other,'assets')).data.length,0);
 await assert.rejects(service.rename(other,a.id,{name:'stolen'}),e=>e.status===404);
 await assert.rejects(service.content(other,a.id),e=>e.status===404);
 const e=await service.saveElement(ctx,{name:'Boat',category:'prop',description:'Synthetic',assetIds:[a.id]});
 assert.equal(e.subjectId,undefined);assert.equal(calls.at(-1).data.content.main_image.image_uri,'image-uri');
 await assert.rejects(service.removeAsset(ctx,a.id),error=>error.status===409);
 await assert.rejects(service.removeElement(other,e.id),error=>error.status===404);
 await assert.rejects(service.saveElement(other,{name:'Boat',category:'prop',description:'',assetIds:[a.id]}),error=>error.status===404);
 const resolved=await refs.resolveReferences(ctx,{model:'jimeng-video-seedance-2.5',library_id:'fxl_test',references:[e.id,a.id],prompt:'@1 floats beside @2'});
 assert.equal(resolved.material_list[0].subject_data.uid,'test-uid');
 assert.equal(resolved.material_list[0].subject_data.content.main_image.uri,'image-uri');
 assert.deepEqual(Array.from(resolved.meta_list.filter(x=>x.material_ref),x=>x.material_ref.material_idx),[0,1]);
 await assert.rejects(refs.resolveReferences(other,{model:'jimeng-video-seedance-2.5',library_id:'fxl_test',references:[e.id],prompt:'@1'}),error=>error.status===404);
 failUpstream=true;
 await assert.rejects(service.saveElement(ctx,{name:'Changed',category:'prop',description:'',assetIds:[a.id]},e.id));
 await assert.rejects(service.removeElement(ctx,e.id));
 assert.equal((await service.list(ctx,'elements')).data[0].name,'Boat');
 failUpstream=false;
 const updated=await service.saveElement(ctx,{name:'Changed',category:'scene',description:'Updated',assetIds:[a.id]},e.id);
 assert.equal(updated.name,'Changed');
 const fresh=new storage.LibraryStore(temporary,'test-account');
 assert.equal((await fresh.read()).elements[0].name,'Changed');
 assert.equal(fs.readFileSync(fresh.file(a.id)).length,8);
 await service.removeElement(ctx,e.id);assert.deepEqual(Array.from(calls.at(-1).data.subject_id_list),['subject-id']);
 await service.removeAsset(ctx,a.id);assert.equal(fs.existsSync(fresh.file(a.id)),false);
});
test('invalid references and uploads fail explicitly',async()=>{
 assert.throws(()=>media.decodeUpload('data:image/png;base64,aGVsbG8='),/contents/);
 assert.throws(()=>media.decodeUpload('https://example.com/image.png'),/Supported/);
 assert.throws(()=>media.dimension(0),/dimensions/);
 assert.throws(()=>storage.identifier('../../etc/passwd'),e=>e.status===404);
 assert.throws(()=>service.context({authorization:'Bearer token'}),e=>e.status===403);
 assert.throws(()=>refs.buildReferences('@2',[{material_type:'image'}]),/Unknown reference/);
 for(const body of [{references:[]},{references:['x','x']},{references:['x'],file_paths:['image']},{references:['x'],library_id:null}]){
  await assert.rejects(refs.resolveReferences(ctx,{model:'jimeng-video-seedance-2.5',library_id:'fxl_test',prompt:'test',...body}));
 }
});
test('serialized writes survive an operation failure without lost updates',async()=>{
 const store=new storage.LibraryStore(temporary,'concurrent');
 const results=await Promise.allSettled([
  store.change(async r=>{await new Promise(resolve=>setTimeout(resolve,10));r.assets.push({id:'first'});}),
  store.change(r=>{r.assets.push({id:'uncommitted'});throw Error('abort');}),
  store.change(r=>r.assets.push({id:'last'})),
 ]);
 assert.equal(results[1].status,'rejected');
 assert.deepEqual(Array.from((await store.read()).assets,a=>a.id),['first','last']);
});
process.on('exit',()=>fs.rmSync(temporary,{recursive:true,force:true}));


test('voice and video elements preserve seconds in subjects and milliseconds in generation drafts',()=>{
 const voice={source:'upload',audio_info:{vid:'audio-id',duration:3,title:'Tone'}};
 const base={name:'Actor',description:'',category:'character',uid:'u',subjectId:'s',dataId:'d'};
 const item=refs.elementMaterial({...base,content:{main_image:{image_uri:'uri',width:1280,height:720},voice_list:[voice],selected_voice:voice}});
 assert.equal(item.subject_data.content.selected_voice.audio_info.duration,3000);
 assert.equal(item.subject_data.content.voice_list[0].audio_info.vid,'audio-id');
 assert.equal(refs.assetMaterial({kind:'video',vid:'v',duration:3,width:1280,height:720}).video_info.duration,3000);
});
