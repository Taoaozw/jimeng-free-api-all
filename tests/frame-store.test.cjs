const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dreamina-frame-store-'));
let account='a';class LibraryError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code}}
process.env.JIMENG_MEDIA_BASE_URL='https://api.example/media/dreamina/a';
const output={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/tasks/frame-store.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:output,process,URL,require:n=>n.includes('library/store')?{libraryStore:()=>({directory:path.join(root,account)}),LibraryError}:require(n)});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('capability URL preserves bytes, expires at 24 hours and rejects unknown or foreign-account tokens',async()=>{
 const bytes=Buffer.from([255,216,255,217]),before=Date.now(),saved=await output.saveFrame(bytes);
 assert.match(saved.id,/^[a-f0-9]{64}$/);assert.equal(saved.url,`https://api.example/media/dreamina/a/last-frames/${saved.id}.jpg`);
 assert(saved.expiresAt>=before+86400000&&saved.expiresAt<=Date.now()+86400000);
 const resource=await output.readFrame(saved.id),chunks=[];for await(const chunk of resource.stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
 account='b';await assert.rejects(output.readFrame(saved.id),e=>e.status===404);account='a';
 await assert.rejects(output.readFrame('../secret'),e=>e.status===404);
 await assert.rejects(output.readFrame('0'.repeat(64)),e=>e.status===404);
 fs.writeFileSync(path.join(root,account,'last-frames',saved.id+'.json'),JSON.stringify({expiresAt:Date.now()-1}));
 await assert.rejects(output.readFrame(saved.id),e=>e.status===404);assert(!fs.existsSync(path.join(root,account,'last-frames',saved.id+'.jpg')));
});
test('only exact read-only frame URLs bypass API-key auth; deletion and expiry cleanup remove files',async()=>{
 assert(output.isMediaRequest('GET','/last-frames/'+'a'.repeat(64)+'.jpg'));assert(output.isMediaRequest('HEAD','/last-frames/'+'a'.repeat(64)+'.jpg'));
 for(const method of ['POST','DELETE','PUT'])assert(!output.isMediaRequest(method,'/last-frames/'+'a'.repeat(64)+'.jpg'));
 for(const p of ['/v1/contents/generations/tasks','/last-frames/../secret','/last-frames/x.jpg','/last-frames/'+'a'.repeat(64)+'.jpg/extra'])assert(!output.isMediaRequest('GET',p));
 const saved=await output.saveFrame(Buffer.from('frame'));await output.removeFrame(saved.id);await assert.rejects(output.readFrame(saved.id),e=>e.status===404);
 const stale=await output.saveFrame(Buffer.from('frame'));for(const ext of ['json','jpg'])fs.utimesSync(path.join(root,account,'last-frames',stale.id+'.'+ext),0,0);
 await output.cleanFrames();await assert.rejects(output.readFrame(stale.id),e=>e.status===404);
});
test('silent MP4 uses account storage, expires and is removed with its metadata',async()=>{
 const filename=path.join(root,'silent.mp4');fs.writeFileSync(filename,'video-data');const saved=await output.saveVideo(filename);
 assert(!fs.existsSync(filename));assert(saved.url.endsWith('/silent-videos/'+saved.id+'.mp4'));assert(output.isMediaRequest('GET','/silent-videos/'+saved.id+'.mp4'));assert(!output.isMediaRequest('POST','/silent-videos/'+saved.id+'.mp4'));
 const resource=await output.readVideo(saved.id);assert.equal(fs.readFileSync(resource.filename,'utf8'),'video-data');
 account='b';await assert.rejects(output.readVideo(saved.id));account='a';
 fs.writeFileSync(path.join(root,account,'silent-videos',saved.id+'.json'),JSON.stringify({expiresAt:Date.now()-1}));await assert.rejects(output.readVideo(saved.id));assert(!fs.existsSync(resource.filename));
 fs.writeFileSync(filename,'video-data');const second=await output.saveVideo(filename);await output.removeVideo(second.id);await assert.rejects(output.readVideo(second.id));
});
test('video route serves bounded ranges, suffixes, HEAD and refuses invalid or expired resources',async()=>{
 const filename=path.join(root,'range.mp4');fs.writeFileSync(filename,'0123456789');const saved=await output.saveVideo(filename),route={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/routes/silent-videos.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:route,require:n=>n.includes('response/Response')?class Response{constructor(body,options){this.body=body;Object.assign(this,options)}}:n.includes('frame-store')?output:require(n)});
 const call=async(range,method='GET')=>route.default.get['/:name']({params:{name:saved.id+'.mp4'},headers:{range},method});
 for(const [range,expected,contentRange] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=7-','789','bytes 7-9/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=0-100','0123456789','bytes 0-9/10']]){const r=await call(range);assert.equal(r.statusCode,206);assert.equal(r.headers['Content-Range'],contentRange);const chunks=[];for await(const chunk of r.body)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),expected)}
 for(const range of ['bytes=10-','bytes=-0','bytes=8-2','bytes=0-1,3-4','bytes=-','bad'])assert.equal((await call(range)).statusCode,416);
 const head=await call('bytes=0-1','HEAD');assert.equal(head.statusCode,200);assert.equal(head.size,10);head.body.destroy();
 await output.removeVideo(saved.id);assert.equal((await call()).statusCode,404);
});
