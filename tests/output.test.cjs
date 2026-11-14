const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),path=require('node:path');
let result,calls=[];
class LibraryError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code}}
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/tasks/output.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject,require:n=>n.includes('core')?{request:async(method,url,token,options)=>{calls.push({url,options});if(result instanceof Error)throw result;return result}}:{LibraryError}});
const {videoOutput}=exportsObject,item={item_id:'item',video:{video_id:'vid',play_url:'https://example.com/preview.mp4'}};
test('unwatermarked output uses the authorized native video resource, not the preview',async()=>{
 result={vid2video:{vid:{origin_video:{logo_type:'',video_url:'https://example.com/original.mp4'},transcoded_video:{origin:{logo_type:'display_watermark_aigc',video_url:'https://example.com/marked.mp4'}}}}};
 assert.equal(await videoOutput(item,false,'token'),'https://example.com/original.mp4');
 assert.equal(calls.at(-1).url,'/mweb/v1/get_video_by_vid');
 assert.equal(calls.at(-1).options.data.vids[0],'vid');
});
test('watermarked output selects the AI-labeled variant without modifying account settings',async()=>{
 result={item_list:[{video:{origin_video:{logo_type:'',video_url:'https://example.com/original.mp4'},transcoded_video:{origin:{logo_type:'display_watermark_aigc',video_url:'https://example.com/marked.mp4'}}}}]};
 assert.equal(await videoOutput(item,true,'token'),'https://example.com/marked.mp4');
 assert.equal(calls.at(-1).url,'/mweb/v1/get_local_item_list');
 assert.equal(calls.at(-1).options.data.pack_item_opt.scene,1);
 assert(!calls.some(c=>c.url.includes('settings')));
});
test('missing, unknown or wrong watermark variants are explicit errors; transport errors remain retryable',async()=>{
 for(const video of [{},{logo_type:'display_watermark_aigc',video_url:'https://example.com/wrong.mp4'},{video_url:'https://example.com/unknown.mp4'},{logo_type:'',video_url:'http://example.com/invalid.mp4'}]) {
  result={vid2video:{vid:{origin_video:video}}};
  await assert.rejects(videoOutput(item,false,'token'),e=>e.code==='task.output_unavailable');
 }
 result=new Error('temporary network failure');await assert.rejects(videoOutput(item,false,'token'),/temporary network/);
});
