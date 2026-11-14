const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
let dns=[{address:'93.184.216.34',family:4}], target, responses=0;
const exported={};
const source=ts.transpileModule(fs.readFileSync('src/api/tasks/callback.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(source,{exports:exported,URL,AbortSignal,require:name=>{
 if(name==='node:dns/promises')return {lookup:async()=>dns};
 if(name==='@/api/library/store.ts')return {invalid:message=>{throw Object.assign(Error(message),{status:400})}};
 if(name==='undici')return {Agent:class{constructor(options){target=options}async destroy(){}},request:async(url,options)=>{assert.equal(options.maxRedirections,0);assert.equal(options.method,'POST');responses++;return {statusCode:204,body:{dump:async()=>{}}}}};
 return require(name);
}});
test('callbacks reject private destinations and pin a validated DNS result',async()=>{
 for(const url of ['http://127.0.0.1/a','http://10.0.0.1','http://169.254.169.254','http://[::1]','file:///etc/passwd','http://user:password@example.com','https://example.com/#secret'])await assert.rejects(exported.destination(url),e=>e.status===400);
 await exported.deliver('https://example.com/callback',{id:'fxt_1',status:'succeeded'});
 assert.equal(responses,1);
 dns=[{address:'127.0.0.1',family:4}];
 const pinned=await new Promise((resolve,reject)=>target.connect.lookup('example.com',{all:false},(e,address)=>e?reject(e):resolve(address)));
 assert.equal(pinned,'93.184.216.34');
 await assert.rejects(exported.deliver('https://example.com/callback',{}),e=>e.status===400);
 assert.equal(responses,1);
});
