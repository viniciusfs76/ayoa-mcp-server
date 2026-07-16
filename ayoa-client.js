import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const CHROME_PATH = process.env.AYOA_CHROME_PATH || `${PREFIX}/lib/chromium/headless_shell`;
const DEFAULT_COOKIES = process.env.AYOA_COOKIES_FILE || '';
const MINDMAP_ID_RE = /\/mindmaps\/([0-9a-f-]{36})(?:[/?#]|$)/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normaliseCookie(cookie) {
  let sameSite = cookie.sameSite || 'Lax';
  if (sameSite === 'no_restriction') sameSite = 'None';
  const capitalised = sameSite.charAt(0).toUpperCase() + sameSite.slice(1);
  if (!['Lax', 'Strict', 'None'].includes(capitalised)) sameSite = 'Lax';
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: cookie.domain?.startsWith('.') ? cookie.domain : `.${cookie.domain || 'ayoa.com'}`,
    path: String(cookie.path || '/'),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: sameSite === 'no_restriction' ? 'None' : (sameSite.charAt(0).toUpperCase() + sameSite.slice(1)),
  };
}

export async function readCookies(file = DEFAULT_COOKIES) {
  if (!file) throw new Error('Ayoa authentication requires cookies_file or AYOA_COOKIES_FILE.');
  const resolved = path.resolve(file);
  const raw = JSON.parse(await fs.readFile(resolved, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`Ayoa cookies file is empty or invalid: ${resolved}`);
  return raw.filter((cookie) => cookie?.name && cookie?.value).map(normaliseCookie);
}

export function deriveMapName(opmlText, override) {
  if (override?.trim()) return override.trim();
  const title = opmlText.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1];
  if (title?.trim()) return title.trim();
  const first = opmlText.match(/<outline\b[^>]*\btext="([^"]+)"/i)?.[1];
  return first?.trim() || 'Imported Map';
}

export function extractMindmapId(url) {
  return url.match(MINDMAP_ID_RE)?.[1] || null;
}

export function defaultOutputDir(target) {
  const id = extractMindmapId(target) || 'untitled';
  return path.join(process.env.HOME || '.', 'storage', 'downloads', 'ayoa_skill', id);
}

async function gotoWithRetry(page, url, options, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function launchBrowser() {
  if (!fsSync.existsSync(CHROME_PATH)) throw new Error(`Ayoa Chromium headless_shell not found: ${CHROME_PATH}`);
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
    defaultViewport: { width: 1440, height: 900 },
  });
}

async function login(page, cookies) {
  await gotoWithRetry(page, 'https://www.ayoa.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (const cookie of cookies) {
    try { await page.setCookie(cookie); } catch { /* malformed tracking cookie; auth cookies continue */ }
  }
  await gotoWithRetry(page, 'https://app.ayoa.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/^https:\/\/auth\.ayoa\.com\/login(?:\?|$)/i.test(page.url())) {
    throw new Error('Ayoa authentication failed: cookies expired or incomplete.');
  }
}

async function withAuthenticatedPage(cookiesFile, callback) {
  const cookies = await readCookies(cookiesFile);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  try {
    await login(page, cookies);
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function dismissCookieBanner(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('button, [role="button"]')) {
      const text = (element.textContent || '').trim().toLowerCase();
      if (['accept', 'aceitar', 'decline', 'recusar'].includes(text)) {
        try { element.click(); return; } catch { /* continue */ }
      }
    }
  });
}

async function clickSemantic(page, matcher) {
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const elements = [...document.querySelectorAll('button, a, [role="button"], [aria-label], [title]')];
    for (const element of elements) {
      if (element.disabled || element.offsetParent === null) continue;
      const haystack = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ');
      if (re.test(haystack)) {
        element.click();
        return { clicked: true, text: (element.textContent || '').trim().slice(0, 100) };
      }
    }
    return { clicked: false };
  }, matcher.source);
}

async function waitForMindmapUrl(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const id = extractMindmapId(page.url());
    if (id) return id;
    await sleep(500);
  }
  throw new Error(`Ayoa did not navigate to a mind map URL; final URL: ${page.url()}`);
}

export async function createMindmap({ name, cookies_file }) {
  return withAuthenticatedPage(cookies_file, async (page) => {
    await gotoWithRetry(page, 'https://app.ayoa.com/mindmaps/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    await dismissCookieBanner(page);
    let clicked = await clickSemantic(page, /^(?:\+|＋|novo projeto|new project|create new)$/i);
    if (!clicked.clicked) clicked = await clickSemantic(page, /novo projeto|new project|create new/i);
    if (!clicked.clicked) throw new Error('Ayoa New Project control was not found.');
    await sleep(1500);

    const typed = await page.evaluate((mapName) => {
      const candidates = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')]
        .filter((element) => element.offsetParent !== null);
      const semantic = /digite o nome|nome do seu projeto|nome do projeto|project name|board name|novo mapa|new map|título/i;
      const input = candidates.find((element) => semantic.test(`${element.placeholder || ''} ${element.getAttribute('aria-label') || ''}`)) || candidates[0];
      if (!input) return false;
      const prototype = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, mapName); else input.value = mapName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }, name);
    if (!typed) throw new Error('Ayoa map-name input was not found.');
    await sleep(700);
    const tile = await clickSemantic(page, /mind map|mapa mental/i);
    if (!tile.clicked) throw new Error('Ayoa Mind Map template was not found.');
    await sleep(700);
    const submit = await clickSemantic(page, /^(?:ok|create|criar|confirm|next|save|salvar)$/i);
    if (!submit.clicked) throw new Error('Ayoa map creation confirmation control was not found.');
    const mindmapId = await waitForMindmapUrl(page, 45000);
    return { mindmapId, url: `https://app.ayoa.com/mindmaps/${mindmapId}`, name };
  });
}

async function waitForEditor(page) {
  await sleep(5000);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => Boolean(
      document.querySelector('.toggle-presenter, .slides-list-container, .sub-header-content-wrapper, svg .node, .project-board-item')
    ));
    if (ready) return;
    await sleep(1000);
  }
  throw new Error(`Ayoa editor did not become ready: ${page.url()}`);
}

export async function listMindmaps({ query = '', cookies_file }) {
  return withAuthenticatedPage(cookies_file, async (page) => {
    await gotoWithRetry(page, 'https://app.ayoa.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page).catch(() => undefined);
    await dismissCookieBanner(page);
    const maps = await page.evaluate(() => {
      const idPattern = /\/mindmaps\/([0-9a-f-]{36})(?:[/?#]|$)/i;
      const byId = new Map();
      for (const element of document.querySelectorAll('a[href*="/mindmaps/"], [data-href*="/mindmaps/"]')) {
        const href = element.href || element.getAttribute('data-href') || '';
        const id = href.match(idPattern)?.[1];
        if (!id) continue;
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        byId.set(id, { mindmapId: id, url: `https://app.ayoa.com/mindmaps/${id}`, name: text.slice(0, 300) || id });
      }
      return [...byId.values()];
    });
    const normalized = query.trim().toLowerCase();
    return normalized ? maps.filter((map) => map.name.toLowerCase().includes(normalized)) : maps;
  });
}

export async function getMindmap({ mindmap_id, cookies_file }) {
  return withAuthenticatedPage(cookies_file, async (page) => {
    const url = `https://app.ayoa.com/mindmaps/${mindmap_id}`;
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page);
    await dismissCookieBanner(page);
    return page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 4000),
      textNodes: [...document.querySelectorAll('text, [contenteditable="true"], [class*="node"], [class*="Node"]')]
        .map((element) => (element.textContent || '').trim()).filter(Boolean).slice(0, 200),
    }));
  });
}

async function captureAuthHeaders(page) {
  return new Promise(async (resolve, reject) => {
    let captured;
    const listener = (request) => {
      const headers = request.headers();
      if (!captured && headers['x-auth-token'] && headers['x-client-id']) captured = headers;
    };
    page.on('request', listener);
    const timer = setTimeout(() => { page.off('request', listener); reject(new Error('Ayoa auth headers not captured from dashboard.')); }, 10000);
    try { await page.evaluate(() => fetch(`/v2/import-jobs?t=${Date.now()}`, { credentials: 'include' }).catch(() => null)); } catch { /* listener still receives dashboard requests */ }
    await sleep(800);
    clearTimeout(timer);
    page.off('request', listener);
    if (!captured) reject(new Error('Ayoa auth headers not captured; the current UI/API contract may have changed.'));
    else resolve(captured);
  });
}

function apiHeaders(captured) {
  const headers = {
    'x-auth-token': captured['x-auth-token'],
    'x-client-id': captured['x-client-id'],
    'x-source': captured['x-source'] || 'web',
    'x-source-version': captured['x-source-version'] || process.env.AYOA_SOURCE_VERSION || '8.170.89',
    'x-agent': captured['x-agent'] || 'Mozilla/5.0',
    'x-request-id': randomUUID(),
    'x-requested-with': 'XMLHttpRequest',
  };
  if (!headers['x-auth-token'] || !headers['x-client-id']) throw new Error('Ayoa auth headers are incomplete.');
  return headers;
}

async function importOpmlInPage(page, opmlText, mapName) {
  const captured = await captureAuthHeaders(page);
  const filename = `${mapName.replace(/[^A-Za-z0-9_-]/g, '_') || 'map'}.opml`;
  const upload = await page.evaluate(async ({ filename, size, captured }) => {
    const response = await fetch('/v2/uploads', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...captured },
      body: JSON.stringify({ filename, filesize: size, contentType: '', useV2Upload: true }),
    });
    if (!response.ok) throw new Error(`/v2/uploads ${response.status}: ${await response.text()}`);
    return response.json();
  }, { filename, size: Buffer.byteLength(opmlText), captured: apiHeaders(captured) });

  const uploadUrl = upload.form?.url || upload.url;
  if (!uploadUrl) throw new Error('Ayoa /v2/uploads did not return an upload URL.');
  const uploaded = await page.evaluate(async ({ upload, opmlText }) => {
    if (upload.form) {
      const form = new FormData();
      for (const [key, value] of Object.entries(upload.form.fields || {})) form.set(key, value);
      form.set('file', new Blob([opmlText], { type: 'text/x-opml' }), upload.form.fields?.key || 'map.opml');
      const response = await fetch(upload.form.url, { method: 'POST', body: form, credentials: 'omit' });
      return { status: response.status, text: await response.text().catch(() => '') };
    }
    const response = await fetch(upload.url, { method: 'PUT', body: opmlText, credentials: 'omit', headers: { 'content-type': 'text/x-opml' } });
    return { status: response.status, text: await response.text().catch(() => '') };
  }, { upload, opmlText });
  if (uploaded.status >= 400) throw new Error(`Ayoa object upload failed: HTTP ${uploaded.status}`);

  const boardId = randomUUID();
  const fileUrl = upload.url || upload.form.url;
  const submit = await page.evaluate(async ({ fileUrl, filename, mapName, boardId, captured }) => {
    const response = await fetch('/v2/import/text', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...captured },
      body: JSON.stringify({ fileUrl, fileName: filename, type: 'TEXT_FILE', boardName: mapName, themeId: 'organic_v2', boardId }),
    });
    return { status: response.status, text: await response.text() };
  }, { fileUrl, filename, mapName, boardId, captured: apiHeaders(captured) });
  if (submit.status >= 400) throw new Error(`Ayoa /v2/import/text failed: HTTP ${submit.status} ${submit.text}`);

  let item;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const poll = await page.evaluate(async ({ boardId, captured }) => {
      const response = await fetch(`/v2/import-jobs?t=${Date.now()}`, { credentials: 'include', headers: captured });
      if (!response.ok) return { status: response.status, jobs: [] };
      return { status: response.status, jobs: (await response.json()).importJobs || [] };
    }, { boardId, captured: apiHeaders(captured) });
    const job = poll.jobs.find((candidate) => candidate.items?.some((candidateItem) => candidateItem.data?.boardId === boardId));
    item = job?.items?.find((candidateItem) => candidateItem.data?.boardId === boardId) || job?.items?.[0];
    if (item?.error) throw new Error(`Ayoa import failed: ${JSON.stringify(item.error)}`);
    if (item?.result?.paperIds?.[0]) return { boardId, jobId: job._id, mindmapId: item.result.paperIds[0], jobStatus: job.status };
    await sleep(2000);
  }
  throw new Error(`Ayoa import job did not produce a mindmap ID for boardId ${boardId}.`);
}

export async function importOpml({ opml_file, name, cookies_file }) {
  const opmlText = await fs.readFile(path.resolve(opml_file), 'utf8');
  const mapName = deriveMapName(opmlText, name);
  return withAuthenticatedPage(cookies_file, async (page) => {
    const result = await importOpmlInPage(page, opmlText, mapName);
    const url = `https://app.ayoa.com/mindmaps/${result.mindmapId}`;
    await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page);
    return { ...result, url, mapName };
  });
}

async function openPresenter(page) {
  const existing = await page.$('.slides-list-container');
  if (!existing) {
    const toggle = await page.$('.toggle-presenter');
    if (toggle) await toggle.click();
    else {
      const clicked = await clickSemantic(page, /present|apresent/i);
      if (!clicked.clicked) throw new Error('Ayoa Presenter control was not found.');
    }
  }
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await page.$('.slides-list-container')) return listSlides(page);
    await sleep(500);
  }
  throw new Error('Ayoa Presenter panel did not become ready.');
}

async function listSlides(page) {
  return page.evaluate(() => [...document.querySelectorAll('.slides-list-group-item')].map((element, index) => ({
    id: element.id, number: (element.querySelector('.slides-list-group-counter')?.innerText || String(index + 1)).trim(),
    title: (element.querySelector('.slides-list-group-content')?.innerText || '').trim(), selected: element.classList.contains('selected'),
  })));
}

export async function listPresenterSlides({ target, cookies_file }) {
  return withAuthenticatedPage(cookies_file, async (page) => {
    await gotoWithRetry(page, target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page);
    await dismissCookieBanner(page);
    return { target, slides: await openPresenter(page) };
  });
}

export async function preparePresenter({ target, cookies_file }) {
  return withAuthenticatedPage(cookies_file, async (page) => {
    await gotoWithRetry(page, target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page);
    let slides = await openPresenter(page);
    if (slides.length === 0) {
      const auto = await clickSemantic(page, /auto-create|criar automaticamente|add all/i);
      if (!auto.clicked) throw new Error('Ayoa Presenter is empty and Auto-create was not found.');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && slides.length === 0) { await sleep(700); slides = await listSlides(page); }
    }
    return { target, slideCount: slides.length, slides };
  });
}

export async function captureSlides({ target, output_dir, from = 1, to, wait_ms = 1200, cookies_file }) {
  const output = path.resolve(output_dir || defaultOutputDir(target));
  await fs.mkdir(output, { recursive: true });
  return withAuthenticatedPage(cookies_file, async (page) => {
    await gotoWithRetry(page, target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForEditor(page);
    const slides = await openPresenter(page);
    const start = Math.max(0, from - 1);
    const end = Math.min(slides.length, to || slides.length);
    const play = await page.$('.slides-play-stop-button');
    if (play && !(await page.$('.slides-list-container.presenting'))) await play.click();
    await sleep(300);
    const captured = [];
    for (let index = start; index < end; index += 1) {
      const slide = slides[index];
      const settled = await page.evaluate((id) => {
        const element = document.getElementById(id);
        if (!element) return false;
        element.scrollIntoView({ block: 'nearest' });
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }, slide.id);
      if (!settled) throw new Error(`Ayoa slide ${index + 1} could not be selected.`);
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (await page.evaluate((id) => document.querySelector('.slides-list-group-item.selected')?.id === id, slide.id)) break;
        await sleep(100);
      }
      await sleep(wait_ms);
      const filename = `slide-${String(index + 1).padStart(3, '0')}.png`;
      const filepath = path.join(output, filename);
      await page.screenshot({ path: filepath });
      captured.push({ ...slide, filepath });
    }
    return { target, outputDir: output, slideCount: captured.length, slides: captured };
  });
}

export async function makeVideo({ input_dir, output_file, fps = '1/3', crf = 23 }) {
  const input = path.resolve(input_dir);
  const files = (await fs.readdir(input)).filter((file) => /^slide-\d+\.png$/.test(file)).sort();
  if (files.length === 0) throw new Error(`No slide-*.png files found in ${input}`);
  const output = path.resolve(output_file || path.join(input, 'presentation.mp4'));
  const result = spawnSync('ffmpeg', ['-y', '-framerate', String(fps), '-pattern_type', 'glob', '-i', 'slide-*.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-crf', String(crf), output], { cwd: input, encoding: 'utf8', timeout: 300000 });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${(result.stderr || '').slice(-1200)}`);
  const stat = await fs.stat(output);
  return { inputDir: input, outputFile: output, slideCount: files.length, bytes: stat.size };
}

export const operations = { create_mindmap: createMindmap, list_mindmaps: listMindmaps, get_mindmap: getMindmap, import_opml: importOpml, list_presenter_slides: listPresenterSlides, prepare_presenter: preparePresenter, capture_slides: captureSlides, make_video: makeVideo };
