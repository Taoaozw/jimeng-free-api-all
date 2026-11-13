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
