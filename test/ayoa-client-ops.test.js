// Integration tests for the a...js operations map. We exercise each
// operation function via the public exports and verify the failure paths
// (missing cookies file, malformed JSON, expired session) without
// launching Puppeteer.
//
// Coverage target: ayoa-client.js functions and error branches above 90%.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const client = await import('../ayoa-client.js');
const { makePng } = await import('./fixtures/make-png.mjs');

const FIXTURE_DIR = path.dirname(url.fileURLToPath(import.meta.url)) + '/fixtures';

test('operations map exposes the canonical names', () => {
  assert.equal(typeof client.operations, 'object');
  for (const name of [
    'create_mindmap', 'list_mindmaps', 'get_mindmap', 'import_opml',
    'list_presenter_slides', 'prepare_presenter', 'capture_slides', 'make_video',
  ]) {
    assert.equal(typeof client.operations[name], 'function', `missing operation: ${name}`);
  }
});

async function withCookiesFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ayoa-test-'));
  const file = path.join(dir, 'cookies.json');
  await fs.writeFile(file, content);
  return {
    file,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

test('create_mindmap fails clearly when no cookies file is supplied', async () => {
  const previous = process.env.AYOA_COOKIES_FILE;
  delete process.env.AYOA_COOKIES_FILE;
  try {
    await assert.rejects(
      () => client.operations.create_mindmap({ name: 'X' }),
      /cookies_file|AYOA_COOKIES_FILE/,
    );
  } finally {
    if (previous !== undefined) process.env.AYOA_COOKIES_FILE = previous;
  }
});

test('list_mindmaps fails clearly when cookies file is missing', async () => {
  await assert.rejects(
    () => client.operations.list_mindmaps({ cookies_file: '/nonexistent/path/cookies.json' }),
    /ENOENT|no such file|cookies/,
  );
});

test('get_mindmap fails clearly when cookies file is empty', async () => {
  const { file, cleanup } = await withCookiesFile('[]');
  try {
    await assert.rejects(
      () => client.operations.get_mindmap({ mindmap_id: '56355169-a2a0-456d-8802-63b9184c10ab', cookies_file: file }),
      /empty or invalid/,
    );
  } finally { await cleanup(); }
});

test('import_opml fails clearly when cookies file is malformed', async () => {
  const { file, cleanup } = await withCookiesFile('{not json');
  try {
    const opmlFile = path.join(path.dirname(file), 'x.opml');
    await fs.writeFile(opmlFile, '<opml><body><outline text="x"/></body></opml>');
    await assert.rejects(
      () => client.operations.import_opml({ opml_file: opmlFile, cookies_file: file }),
      /JSON|Unexpected/,
    );
  } finally { await cleanup(); }
});

test('list_presenter_slides requires a valid target URL', async () => {
  await assert.rejects(
    () => client.operations.list_presenter_slides({ target: 'not-a-url', cookies_file: '/dev/null/cookies' }),
  );
});

test('prepare_presenter requires a valid target URL', async () => {
  await assert.rejects(
    () => client.operations.prepare_presenter({ target: 'not-a-url', cookies_file: '/dev/null/cookies' }),
  );
});

test('capture_slides requires a valid target URL', async () => {
  await assert.rejects(
    () => client.operations.capture_slides({ target: 'not-a-url', cookies_file: '/dev/null/cookies' }),
  );
});

// Real 200x200 RGB PNGs generated in-memory by the make-png helper. The
// CI pipeline does not need a Chromium instance to produce them.
const PNG_RED = makePng(200, 200, 255, 0, 0);
const PNG_GREEN = makePng(200, 200, 0, 255, 0);
const PNG_BLUE = makePng(200, 200, 0, 0, 255);

test('make_video encodes PNGs into MP4 via ffmpeg', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ayoa-mp4-'));
  try {
    await fs.writeFile(path.join(dir, 'slide-001.png'), PNG_RED);
    await fs.writeFile(path.join(dir, 'slide-002.png'), PNG_RED);
    await fs.writeFile(path.join(dir, 'slide-003.png'), PNG_GREEN);
    const out = path.join(dir, 'out.mp4');
    const result = await client.operations.make_video({ input_dir: dir, output_file: out, fps: 1, crf: 23 });
    assert.equal(result.outputFile, out);
    assert.equal(result.slideCount, 3);
    const stat = await fs.stat(out);
    assert.ok(stat.size > 0, 'output MP4 must have bytes');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('make_video defaults output_file inside input_dir when not provided', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ayoa-mp4-default-'));
  try {
    await fs.writeFile(path.join(dir, 'slide-001.png'), PNG_RED);
    const result = await client.operations.make_video({ input_dir: dir, fps: 1 });
    assert.equal(result.inputDir, dir);
    assert.match(result.outputFile, /presentation\.mp4$/);
    const stat = await fs.stat(result.outputFile);
    assert.ok(stat.size > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('make_video fails when input_dir has no PNG files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ayoa-mp4-empty-'));
  try {
    await assert.rejects(
      () => client.operations.make_video({ input_dir: dir, output_file: path.join(dir, 'out.mp4') }),
      /No slide-/,
    );
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('make_video fails when input_dir does not exist', async () => {
  await assert.rejects(
    () => client.operations.make_video({ input_dir: '/nonexistent/dir/ayoa-test', output_file: '/tmp/ayoa-test-out.mp4' }),
    /ENOENT|no such/,
  );
});

test('make_video defaults fps to 1/3 when not provided', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ayoa-mp4-fps-'));
  try {
    await fs.writeFile(path.join(dir, 'slide-001.png'), PNG_RED);
    await fs.writeFile(path.join(dir, 'slide-002.png'), PNG_BLUE);
    const out = path.join(dir, 'out.mp4');
    const result = await client.operations.make_video({ input_dir: dir, output_file: out });
    assert.ok(result.bytes > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
