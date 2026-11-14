const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),ts=require('typescript'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dreamina-frame-'));
const output={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/tasks/last-frame.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:output,Buffer,URL,AbortSignal,require:n=>n.includes('library/store')?{libraryStore:()=>({directory:root})}:n==='./callback.ts'?{destination:async()=>{throw Error('blocked')}}:n==='./frame-store.ts'?{}:require(n)});
const ffmpeg=(args)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:['ignore','pipe','pipe']});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('real extractor returns last video frame, not cover or trailing audio, preserving JPEG dimensions',async()=>{
 const video=path.join(root,'colors.mp4'),image=path.join(root,'last.jpg');
 ffmpeg(['-f','lavfi','-i','color=red:s=160x96:r=8:d=0.75','-f','lavfi','-i','color=blue:s=160x96:r=8:d=0.25','-f','lavfi','-i','sine=duration=3','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video]);
 const frame=await output.extractLastFrame(video,image);
 assert.equal(frame.width,160);assert.equal(frame.height,96);assert.equal(frame.bytes[0],255);assert.equal(frame.bytes[1],216);
 const rgb=ffmpeg(['-i',image,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 assert(rgb[2]>200&&rgb[0]<40,'The last frame must be blue rather than the red first frame');
});
test('4K extraction preserves original pixel dimensions',async()=>{
 const video=path.join(root,'4k.mp4'),image=path.join(root,'4k.jpg');
 ffmpeg(['-f','lavfi','-i','color=green:s=3840x2160:r=1:d=1','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',video]);
 const result=await output.extractLastFrame(video,image);assert.equal(result.width,3840);assert.equal(result.height,2160);
});
test('corrupt input and non-JPEG output are rejected',async()=>{
 const video=path.join(root,'invalid.mp4');fs.writeFileSync(video,'not video');
 await assert.rejects(output.extractLastFrame(video,path.join(root,'invalid.jpg')));
 assert.throws(()=>output.jpegDimensions(Buffer.from('invalid')));
 await assert.rejects(output.download('http://127.0.0.1/private',path.join(root,'private'),1024),/blocked/);
});
const mute={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/tasks/mute-video.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports:mute,Buffer,require:n=>n.includes('library/store')?{libraryStore:()=>({directory:root})}:n==='./last-frame.ts'?output:n==='./frame-store.ts'?{}:require(n)});
test('audio removal copies all video frames unchanged, removes multiple tracks, and accepts silent input',async()=>{
 const source=path.join(root,'sound.mp4'),silent=path.join(root,'silent.mp4'),again=path.join(root,'silent-again.mp4');
 ffmpeg(['-f','lavfi','-i','testsrc2=s=160x96:r=8:d=1','-f','lavfi','-i','sine=duration=2','-map','0:v','-map','1:a','-map','1:a','-c:v','libx264','-c:a','aac',source]);
 await mute.removeAudio(source,silent);await mute.removeAudio(silent,again);
 const streams=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',silent])).streams;
 assert.equal(streams.length,1);assert.equal(streams[0].codec_type,'video');assert.equal(streams[0].width,160);assert.equal(streams[0].height,96);
 const hash=f=>ffmpeg(['-i',f,'-map','0:v:0','-c','copy','-f','hash','-hash','sha256','pipe:1']).toString();
 assert.equal(hash(source),hash(silent));assert.equal(hash(source),hash(again));
 const frame=await output.extractLastFrame(silent,path.join(root,'silent-last.jpg'));assert.equal(frame.width,160);
 await assert.rejects(mute.removeAudio(path.join(root,'invalid.mp4'),path.join(root,'bad-silent.mp4')));
});
test('4K silent video keeps the original dimensions and codec',async()=>{
 const silent=path.join(root,'4k-silent.mp4');await mute.removeAudio(path.join(root,'4k.mp4'),silent);
 const stream=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',silent])).streams[0];assert.equal(stream.width,3840);assert.equal(stream.height,2160);assert.equal(stream.codec_name,'h264');
});
