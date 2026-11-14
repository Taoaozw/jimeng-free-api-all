const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const lodash = require('lodash');

function load(relative, mocks, setup = '') {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  const exports = {};
  vm.runInNewContext(output + '\n' + setup, {
    exports, require: name => name in mocks ? mocks[name] : require(name),
    process, Buffer, console, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }),
  });
  return exports;
}

const model = 'jimeng-video-seedance-2.5';
function controller(uploadSetup = 'uploadImageForVideo = async () => "test-image-uri";') {
  const calls = [];
  const stopped = new Error('Captured upstream submission');
  const exports = load('src/api/controllers/videos.ts', {
    '@/lib/exceptions/APIException.ts': class extends Error { constructor(code, message) { super(message); } },
    '@/api/consts/exceptions.ts': {},
    '@/lib/util.ts': { uuid: () => 'test-id' },
    '@/lib/logger.ts': { info() {}, warn() {}, error() {} },
    '@/lib/browser-service.ts': {},
    './core.ts': {
      getCredit: async () => ({ totalCredit: 10000 }),
      request: async (...args) => { calls.push(args); throw stopped; },
    },
  }, uploadSetup);
  return { exports, calls, stopped };
}

test('4K and 30 seconds reach the Seedance 2.5 upstream draft', async () => {
  const { exports, calls, stopped } = controller();
  await assert.rejects(exports.generateVideo(model, 'Test', {
    resolution: '4K', ratio: '16:9', duration: 30,
  }, 'test-token'), error => error === stopped);
  assert.equal(calls.length, 1);
  const payload = calls[0][3].data;
  const params = JSON.parse(payload.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(payload.extend.root_model, 'dreamina_seedance_45_pro');
  assert.equal(params.model_req_key, payload.extend.root_model);
  assert.equal(params.video_aspect_ratio, '16:9');
  assert.equal(params.video_gen_inputs[0].resolution, '4k');
  assert.equal(params.video_gen_inputs[0].duration_ms, 30000);
});

test('invalid duration and excess references fail before upstream submission', async () => {
  const { exports, calls } = controller();
  for (const duration of [3, 31, 5.5, NaN]) {
    await assert.rejects(exports.generateVideo(model, 'Test', { duration }, 'test-token'), /integer between 4 and 30/);
  }
  await assert.rejects(exports.generateVideo(model, 'Test', { filePaths: ['a', 'b', 'c'] }, 'test-token'), /up to two/);
  assert.equal(calls.length, 0);
});

test('two frame images retain Seedance 2.5 and use the requested 4K dimensions', async () => {
  const { exports, calls, stopped } = controller();
  await assert.rejects(exports.generateVideo(model, 'Test', {
    resolution: '4k', ratio: '16:9', duration: 5, filePaths: ['https://example.com/first.png', 'https://example.com/last.png'],
  }, 'test-token'), error => error === stopped);
  const payload = calls[0][3].data;
  const params = JSON.parse(payload.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(payload.extend.root_model, 'dreamina_seedance_45_pro');
  assert.equal(params.model_req_key, payload.extend.root_model);
  for (const frame of ['first_frame_image', 'end_frame_image']) {
    assert.equal(params.video_gen_inputs[0][frame].width, 3840);
    assert.equal(params.video_gen_inputs[0][frame].height, 2160);
  }
});

test('route accepts 4-30 integer seconds only for 2.5 and does not truncate multipart', async () => {
  const calls = [];
  const { default: routes } = load('src/api/routes/videos.ts', {
    '@/lib/request/Request.ts': {}, '@/lib/response/Response.ts': {},
    '@/api/library/service.ts': {},
    '@/api/library/references.ts': {},
    '@/api/library/store.ts': {},
    '@/api/controllers/core.ts': { tokenSplit: () => ['test-token'] },
    '@/lib/util.ts': { unixTimestamp: () => 1 },
    '@/api/controllers/videos.ts': {
      DEFAULT_MODEL: 'jimeng-video-3.0', isSeedanceModel: () => false,
      generateVideo: async (...args) => { calls.push(args); return 'https://example.com/video.mp4'; },
    },
  });
  function request(duration, multipart = false, requestModel = model) {
    return {
      body: { model: requestModel, duration, resolution: '4k', ratio: '16:9' }, files: [],
      headers: { authorization: 'Bearer test-token', 'content-type': multipart ? 'multipart/form-data' : 'application/json' },
      validate(key, predicate) { if (!predicate(lodash.get(this, key))) throw new Error(`Invalid ${key}`); return this; },
    };
  }
  for (const duration of [4, 15, 16, 30]) await routes.post['/generations'](request(duration));
  await routes.post['/generations'](request('30', true));
  assert.equal(calls.at(-1)[2].duration, 30);
  for (const duration of [3, 31, 5.5, '30']) await assert.rejects(routes.post['/generations'](request(duration)), /duration/);
  for (const duration of ['5.5', '30foo']) await assert.rejects(routes.post['/generations'](request(duration, true)), /duration/);
  await assert.rejects(routes.post['/generations'](request(30, false, 'jimeng-video-3.0')), /duration/);
});

test('21:9 and an explicit zero seed reach the upstream unchanged', async () => {
  const { exports, calls, stopped } = controller();
  await assert.rejects(exports.generateVideo(model, 'Test', {
    resolution: '480p', ratio: '21:9', duration: 4, seed: 0,
  }, 'test-token'), error => error === stopped);
  const params = JSON.parse(calls[0][3].data.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
  assert.equal(params.video_aspect_ratio, '21:9');
  assert.equal(params.seed, 0);
  await assert.rejects(exports.generateVideo(model, 'Test', { seed: -1 }, 'test-token'), /unsigned 32-bit/);
  await assert.rejects(exports.generateVideo(model, 'Test', { seed: 4294967296 }, 'test-token'), /unsigned 32-bit/);
});


test('a failed end-frame upload fails instead of silently generating from the first frame', async () => {
  const { exports, calls } = controller('let uploads = 0; uploadImageForVideo = async () => { if (++uploads === 2) throw new Error("end upload failed"); return "first-uri"; };');
  await assert.rejects(exports.generateVideo(model, 'Test', {
    duration: 4, filePaths: ['https://example.com/first.png', 'https://example.com/last.png'],
  }, 'test-token'), /end upload failed/);
  assert.equal(calls.length, 0);
});

test('library references reach the Seedance 2.5 unified draft without frame inputs', async () => {
  const { exports, calls, stopped } = controller();
  const unifiedEditInput = { material_list: [{ material_type: 'subject', subject_data: { subject_id: 's', data_id: 'd' } }], meta_list: [{ meta_type: 'subject', material_ref: { material_idx: 0 } }] };
  await assert.rejects(exports.generateVideo(model, 'Test', { duration: 4, resolution: '480p', unifiedEditInput }, 'test-token'), error => error === stopped);
  const draft = JSON.parse(calls[0][3].data.draft_content);
  assert.equal(draft.version, '3.3.39');
  assert.ok(draft.min_features.includes('AIGC_UnifiedEditSubject'));
  const input = draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  assert.equal(input.prompt, '');
  assert.deepEqual(input.unified_edit_input, unifiedEditInput);
  assert.equal(input.first_frame_image, undefined);
});


test('missing library references return HTTP 404 without generating a video', async () => {
  class LibraryError extends Error { constructor() { super('Material not found'); this.status=404; this.code='library.not_found'; } }
  let generated=false;
  const {default:routes}=load('src/api/routes/videos.ts', {
    '@/lib/request/Request.ts': {},
    '@/lib/response/Response.ts': class { constructor(body,options) {this.body=body; Object.assign(this,options);} },
    '@/api/library/service.ts': {context:()=>({})},
    '@/api/library/references.ts': {resolveReferences:async()=>{throw new LibraryError();}},
    '@/api/library/store.ts': {LibraryError},
    '@/api/controllers/core.ts': {tokenSplit:()=>['test-token']},
    '@/lib/util.ts': {},
    '@/api/controllers/videos.ts': {generateVideo:async()=>{generated=true;}},
  });
  const request={body:{model,references:['missing'],library_id:'library'},files:[],headers:{authorization:'Bearer test-token'},validate(){return this;}};
  const response=await routes.post['/generations'](request);
  assert.equal(response.statusCode,404);assert.equal(response.body.error.code,'library.not_found');assert.equal(generated,false);
});

test('failure bodies never return HTTP 200 and preserve explicit error status', () => {
  class Exception extends Error { constructor(code,message) {super(message);this.errcode=-1000;this.errmsg=message;} }
  const {default:FailureBody}=load('src/lib/response/FailureBody.ts',{
    './Body.ts':class {constructor(options){Object.assign(this,options);}},
    '../exceptions/Exception.ts':Exception,'../exceptions/APIException.ts':class extends Exception {},
    '../consts/exceptions.ts':{SYSTEM_ERROR:[]},'../http-status-codes.ts':{INTERNAL_SERVER_ERROR:500},
  });
  assert.equal(new FailureBody(new Error('upstream rejected')).statusCode,500);
  for(const status of [undefined,200,0,404,429,502]) {
    const error=new Exception([], 'upstream rejected');error.httpStatusCode=status;
    assert.equal(new FailureBody(error).statusCode,status>=400?status:500);
  }
});


test('Dreamina HTTP 200 business errors become HTTP 502 while numeric and string zero succeed', () => {
  class APIException extends Error {setHTTPStatusCode(status){this.httpStatusCode=status;return this;}}
  const {checkResult}=load('src/api/controllers/core.ts', {
    '@/lib/exceptions/APIException.ts':APIException,'@/api/consts/exceptions.ts':{},
    '@/lib/logger.ts':{},'@/lib/util.ts':{uuid:()=> 'test-id'},
    '@/lib/x-bogus.ts':{},'@/lib/x-gnarly.ts':{},
  });
  for(const ret of ['0',0]) assert.equal(checkResult({status:200,data:{ret,data:'ok'}}),'ok');
  for(const ret of ['2001',2001,'5000',5000]) assert.throws(()=>checkResult({status:200,data:{ret,errmsg:'rejected'}}),e=>e.httpStatusCode===502);
});


test('terminal generation rejection preserves the upstream failure code', async()=>{
 class APIException extends Error {constructor(code,message){super(message);}setHTTPStatusCode(status){this.httpStatusCode=status;return this;}}
 let calls=0;
 const exports=load('src/api/controllers/videos.ts',{
  '@/lib/exceptions/APIException.ts':APIException,'@/api/consts/exceptions.ts':{},
  '@/lib/util.ts':{uuid:()=> 'test-id'},'@/lib/logger.ts':{info(){},warn(){},error(){}},'@/lib/browser-service.ts':{},
  './core.ts':{getCredit:async()=>({totalCredit:10000}),request:async()=>++calls===1?{aigc_data:{history_record_id:'history'}}:{history:{status:30,fail_code:2052,item_list:[]}}},
 });
 await assert.rejects(exports.generateVideo(model,'Test',{duration:4},'test-token'),e=>e.httpStatusCode===502 && e.message.includes('2052'));
 assert.equal(calls,2);
});

test('draft finalization retains native parent inputs and the draft billing benefit', async () => {
  const { exports, calls, stopped } = controller();
  const parent={id:'source',process_type:1,abilities:{gen_video:{text_to_video_params:{model_req_key:'dreamina_seedance_45_pro_draft',video_gen_inputs:[{is_draft_mode:true,duration_ms:4000,unified_edit_input:{material_list:[{material_type:'video'}]}}]}}}};
  await assert.rejects(exports.submitVideo(model,'',{duration:4,resolution:'1080p',draftSource:{historyId:'history',itemId:'item',draftContent:JSON.stringify({main_component_id:'source',component_list:[parent]})}},'token'), e=>e===stopped);
  const payload=calls[0][3].data,draft=JSON.parse(payload.draft_content),final=draft.component_list[1];
  assert.equal(payload.extend.root_model,'dreamina_seedance_45_pro_draft');
  assert.equal(payload.extend.m_video_commerce_info.benefit_type,'seedance_25_draft_1080p_output');
  assert.equal(final.parent_id,'source');assert.equal(final.process_type,15);
  assert.equal(final.abilities.gen_video.text_to_video_params.model_req_key,undefined);
  const input=final.abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  assert.equal(input.origin_history_id,'history');assert.equal(input.v2v_opt.generate_from_draft.enable,true);
  assert.equal(draft.component_list[0].abilities.gen_video.text_to_video_params.video_gen_inputs[0].is_draft_mode,undefined);
});

test('native edit preserves the adaptive sentinel in milliseconds instead of multiplying it', async()=>{
 const {exports,calls,stopped}=controller();
 const unifiedEditInput={material_list:[{material_type:'video',video_info:{vid:'source',duration:4000}}],edit_input:{enable:true,edit_from_material_idx:0}};
 await assert.rejects(exports.submitVideo(model,'Edit the lighting',{ratio:'adaptive',duration:-1,resolution:'480p',unifiedEditInput},'token'),e=>e===stopped);
 const params=JSON.parse(calls[0][3].data.draft_content).component_list[0].abilities.gen_video.text_to_video_params;
 assert.equal(params.video_aspect_ratio,'adaptive');assert.equal(params.video_gen_inputs[0].duration_ms,-1);
 assert.equal(params.video_gen_inputs[0].unified_edit_input.edit_input.edit_from_material_idx,0);
});
