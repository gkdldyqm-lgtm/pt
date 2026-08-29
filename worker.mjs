import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const TOKEN = String(process.env.HUESTERIA_TOKEN || '').trim();
const POD_ID = String(process.env.RUNPOD_POD_ID || '').trim();
const JOB_ID = String(process.env.HUESTERIA_JOB_ID || POD_ID || crypto.randomUUID()).trim();
const TEMP_ROOT = path.resolve(process.env.HUESTERIA_TEMP_ROOT || `/tmp/huesteria/${JOB_ID}`);
const PARTS_DIR = path.join(TEMP_ROOT, 'parts');
const SCENE_ZIP = path.join(TEMP_ROOT, 'scene.zip');
const STATUS_PATH = path.join(TEMP_ROOT, 'status.json');
const PREVIEW_PATH = path.join(TEMP_ROOT, 'preview.jpg');
const WORKER_LOG_PATH = path.join(TEMP_ROOT, 'worker.log');
const RESULT_ROOT = path.resolve(process.env.HUESTERIA_RESULT_ROOT || '/workspace/huesteria-results');
const RESULT_DIR = path.join(RESULT_ROOT, JOB_ID);
const RESULT_PNG = path.join(RESULT_DIR, 'final.png');
const RESULT_META = path.join(RESULT_DIR, 'meta.json');
const RESULT_PREVIEW = path.join(RESULT_DIR, 'preview.jpg');
const APP_HTML = path.join(__dirname, 'huesteria.html');
const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome';
const CHUNK_MAX_BYTES = 32 * 1024 * 1024;
const IDLE_TTL_MS = Math.max(2, Number(process.env.HUESTERIA_IDLE_TTL_MINUTES || 5)) * 60_000;
const HARD_TTL_MS = Math.max(30, Number(process.env.HUESTERIA_HARD_TTL_MINUTES || 720)) * 60_000;

let renderConfig = {};
try { renderConfig = JSON.parse(process.env.HUESTERIA_RENDER_CONFIG || '{}'); } catch (_) {}

let browser = null;
let renderPromise = null;
let cancelRequested = false;
let previewRevision = 0;
let lastActivityAt = Date.now();
let selfDeleteScheduled = false;
let staticServer = null;

await fsp.mkdir(TEMP_ROOT, { recursive: true });
await fsp.mkdir(PARTS_DIR, { recursive: true });
await fsp.mkdir(RESULT_ROOT, { recursive: true });

function nowIso() { return new Date().toISOString(); }
function touchActivity() { lastActivityAt = Date.now(); }
function safeName(value, fallback = 'file.bin') {
  const out = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return out || fallback;
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return fallback; }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}
async function statusPatch(patch = {}) {
  const prev = await readJson(STATUS_PATH, {});
  const next = { ...prev, ...patch, id: JOB_ID, podId: POD_ID, updatedAt: nowIso(), previewRevision };
  await atomicJson(STATUS_PATH, next);
  return next;
}
async function currentStatus() {
  return await readJson(STATUS_PATH, {
    id: JOB_ID,
    podId: POD_ID,
    state: fs.existsSync(SCENE_ZIP) ? 'ready' : 'waiting_upload',
    stage: fs.existsSync(SCENE_ZIP) ? 'uploaded' : 'waiting_upload',
    progress: 0,
    samplesDone: 0,
    samplesRequested: Math.max(1, Number(renderConfig?.render?.samples || 20)),
    message: fs.existsSync(SCENE_ZIP) ? '장면 ZIP 준비 완료' : 'GPU 준비 완료 · 장면 업로드 대기',
    previewRevision,
    updatedAt: nowIso()
  });
}

if (!fs.existsSync(STATUS_PATH)) await atomicJson(STATUS_PATH, await currentStatus());

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Huesteria-Chunk-Count,X-Huesteria-Total-Bytes,X-Huesteria-Chunk-Bytes');
  res.setHeader('Access-Control-Expose-Headers', 'ETag,Content-Length,Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJson(res, code, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = code;
  cors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}
function sendText(res, code, text) {
  const body = Buffer.from(String(text || ''));
  res.statusCode = code;
  cors(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}
function authorized(req) {
  if (!TOKEN) return false;
  return String(req.headers.authorization || '') === `Bearer ${TOKEN}`;
}
async function readRequestBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readRequestJson(req, maxBytes = 1_000_000) {
  const body = await readRequestBody(req, maxBytes);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}
function partPath(index) { return path.join(PARTS_DIR, `${String(index).padStart(6, '0')}.part`); }
async function receivedParts() {
  const names = await fsp.readdir(PARTS_DIR).catch(() => []);
  const indexes = [];
  let bytes = 0;
  for (const name of names) {
    const m = /^(\d{6})\.part$/.exec(name);
    if (!m) continue;
    indexes.push(Number(m[1]));
    try { bytes += (await fsp.stat(path.join(PARTS_DIR, name))).size; } catch (_) {}
  }
  indexes.sort((a,b)=>a-b);
  return { indexes, bytes };
}
async function streamRequestToFile(req, destination, maxBytes) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  const out = fs.createWriteStream(temp, { flags: 'w' });
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`chunk too large (${total} bytes)`);
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    await fsp.rename(temp, destination);
    return total;
  } catch (error) {
    try { out.destroy(); } catch (_) {}
    try { await fsp.rm(temp, { force: true }); } catch (_) {}
    throw error;
  }
}
async function assembleScene({ totalChunks, totalBytes }) {
  totalChunks = Math.max(1, Math.min(10000, Number(totalChunks) | 0));
  totalBytes = Math.max(1, Number(totalBytes) || 0);
  const have = await receivedParts();
  const missing = [];
  for (let i = 0; i < totalChunks; i++) if (!have.indexes.includes(i)) missing.push(i);
  if (missing.length) return { ok: false, missing };
  const tmp = `${SCENE_ZIP}.${process.pid}.tmp`;
  const out = fs.createWriteStream(tmp, { flags: 'w' });
  let written = 0;
  for (let i = 0; i < totalChunks; i++) {
    const data = await fsp.readFile(partPath(i));
    written += data.length;
    if (!out.write(data)) await new Promise(resolve => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  if (totalBytes && written !== totalBytes) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`assembled size mismatch: expected ${totalBytes}, got ${written}`);
  }
  await fsp.rename(tmp, SCENE_ZIP);
  await statusPatch({ state:'ready', stage:'uploaded', sceneBytes:written, totalChunks, progress:0, message:'장면 ZIP 업로드 완료' });
  return { ok:true, bytes:written };
}

async function selfDelete(reason) {
  if (selfDeleteScheduled) return;
  selfDeleteScheduled = true;
  const apiKey = String(process.env.RUNPOD_API_KEY || '').trim();
  if (!POD_ID || !apiKey) {
    console.warn('[Huesteria] self delete skipped: RUNPOD_POD_ID or RUNPOD_API_KEY missing');
    return;
  }
  try {
    const response = await fetch(`https://rest.runpod.io/v1/pods/${encodeURIComponent(POD_ID)}`, {
      method:'DELETE', headers:{ Authorization:`Bearer ${apiKey}` }
    });
    console.log(`[Huesteria] self delete (${reason}) -> ${response.status}`);
  } catch (error) {
    console.warn('[Huesteria] self delete failed', error);
    selfDeleteScheduled = false;
  }
}
function scheduleSelfDelete(reason, delayMs = 15_000) {
  setTimeout(() => selfDelete(reason), delayMs).unref();
}
async function closeBrowser() {
  try { await browser?.close(); } catch (_) {}
  browser = null;
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
}
async function startStaticServer() {
  if (staticServer) return staticServer;
  staticServer = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname !== '/' && pathname !== '/huesteria.html') { res.statusCode=404; res.end('not found'); return; }
      try {
        const stat = await fsp.stat(APP_HTML);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentTypeFor(APP_HTML));
        res.setHeader('Content-Length', String(stat.size));
        fs.createReadStream(APP_HTML).pipe(res);
      } catch (error) { res.statusCode=500; res.end(error?.message || String(error)); }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url:`http://127.0.0.1:${server.address().port}/huesteria.html` }));
  });
  return staticServer;
}

const backendCandidates = [
  { name:'angle-vulkan', args:['--use-angle=vulkan','--enable-features=Vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist','--enable-webgl','--disable-software-rasterizer'] },
  { name:'angle-gl', args:['--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist','--enable-webgl','--disable-software-rasterizer'] },
  { name:'desktop-gl', args:['--use-gl=desktop','--ignore-gpu-blocklist','--enable-webgl','--disable-software-rasterizer'] }
];
function isSoftwareRenderer(text='') { return /swiftshader|llvmpipe|software raster|softpipe|lavapipe/i.test(String(text)); }
async function probeGpu(page) {
  return await page.evaluate(() => {
    const canvas=document.createElement('canvas'); canvas.width=64; canvas.height=64;
    const gl=canvas.getContext('webgl2',{antialias:false});
    if(!gl) return {webgl2:false,vendor:'',renderer:'',version:''};
    const dbg=gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2:true,
      vendor:String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) || ''),
      renderer:String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || ''),
      version:String(gl.getParameter(gl.VERSION) || '')
    };
  });
}
async function launchHardwareBrowser(url, viewportWidth, viewportHeight) {
  const attempts=[];
  for (const backend of backendCandidates) {
    let candidate=null;
    try {
      candidate = await chromium.launch({
        executablePath:CHROME_EXECUTABLE,
        headless:true,
        args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu-sandbox',`--window-size=${viewportWidth},${viewportHeight}`,...backend.args]
      });
      const context = await candidate.newContext({ viewport:{width:viewportWidth,height:viewportHeight}, acceptDownloads:true });
      const page = await context.newPage();
      page.setDefaultTimeout(120_000);
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:120_000});
      await page.waitForFunction(()=>!!window.__huesteriaExportHooks,null,{timeout:120_000});
      const probe=await probeGpu(page);
      let gpuInfo=null;
      try { const cdp=await candidate.newBrowserCDPSession(); gpuInfo=await cdp.send('SystemInfo.getInfo'); } catch (_) {}
      const combined=`${probe.vendor} ${probe.renderer} ${JSON.stringify(gpuInfo?.gpu?.devices || [])}`;
      attempts.push({backend:backend.name,probe,devices:gpuInfo?.gpu?.devices || []});
      if(probe.webgl2 && !isSoftwareRenderer(combined) && /nvidia|geforce|rtx/i.test(combined)) {
        browser=candidate;
        return { browser:candidate, context, page, backend:backend.name, probe, gpuInfo, attempts };
      }
      await candidate.close(); candidate=null;
    } catch(error) {
      attempts.push({backend:backend.name,error:error?.stack || String(error)});
      try { await candidate?.close(); } catch (_) {}
    }
  }
  const error=new Error('NVIDIA hardware WebGL2를 확보하지 못했습니다.');
  error.attempts=attempts;
  throw error;
}

async function writeLivePreview(page) {
  try {
    const dataUrl = await page.evaluate(() => {
      const src = document.querySelector('#viewport canvas');
      if (!src || !src.width || !src.height) return null;
      const maxEdge=768;
      const scale=Math.min(1,maxEdge/Math.max(src.width,src.height));
      const w=Math.max(1,Math.round(src.width*scale));
      const h=Math.max(1,Math.round(src.height*scale));
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const ctx=c.getContext('2d',{alpha:false});
      if(!ctx) return null;
      ctx.imageSmoothingEnabled=true;
      ctx.drawImage(src,0,0,w,h);
      return c.toDataURL('image/jpeg',0.72);
    });
    if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) return false;
    const bytes=Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64');
    const tmp=`${PREVIEW_PATH}.${process.pid}.tmp`;
    await fsp.writeFile(tmp,bytes);
    await fsp.rename(tmp,PREVIEW_PATH);
    previewRevision += 1;
    const st=await currentStatus();
    await statusPatch({ ...st, previewRevision });
    return true;
  } catch (_) { return false; }
}

async function cleanupTemp({ keepStatus=false } = {}) {
  try { await fsp.rm(PARTS_DIR,{recursive:true,force:true}); } catch (_) {}
  try { await fsp.rm(SCENE_ZIP,{force:true}); } catch (_) {}
  if (!keepStatus) {
    try { await fsp.rm(PREVIEW_PATH,{force:true}); } catch (_) {}
  }
}

async function runRender() {
  touchActivity();
  const cfg=renderConfig || {};
  const frame=(cfg.frame && typeof cfg.frame==='object') ? cfg.frame : {};
  const render=(cfg.render && typeof cfg.render==='object') ? cfg.render : {};
  const frameWidth=Math.max(240,Math.min(2560,Math.round(Number(frame.width)||1280)));
  const frameHeight=Math.max(240,Math.min(2560,Math.round(Number(frame.height)||900)));
  const longEdge=Math.max(256,Math.min(4096,Math.round(Number(render.longEdge)||1024)));
  const samples=Math.max(1,Math.min(1000,Math.round(Number(render.samples)||20)));
  const bounces=Math.max(1,Math.min(64,Math.round(Number(render.bounces)||20)));
  const mode=render.mode==='background'?'background':'full';
  const includeMmdXps=render.includeMmdXps!==false;
  const ptExpressionEnhance=!!render.ptExpressionEnhance;
  const includeCameraFrame=render.includeCameraFrame!==false;
  const disablePathTraceCropTiles=render.disablePathTraceCropTiles!==false;
  const disablePathTraceTiles=render.disablePathTraceTiles!==false;
  const resultFilename=safeName(cfg.resultFilename || `huesteria_${JOB_ID}.png`,`huesteria_${JOB_ID}.png`);
  const report={ startedAt:nowIso(), jobId:JOB_ID, podId:POD_ID, config:{frame,render:{...render,longEdge,samples,bounces,mode,includeMmdXps,ptExpressionEnhance,includeCameraFrame,disablePathTraceCropTiles,disablePathTraceTiles}}, success:false };
  let page=null;
  try {
    if (!fs.existsSync(SCENE_ZIP)) throw new Error('scene.zip not assembled');
    if (!fs.existsSync(APP_HTML)) throw new Error(`huesteria.html missing: ${APP_HTML}`);
    if (!fs.existsSync(CHROME_EXECUTABLE)) throw new Error(`Chrome missing: ${CHROME_EXECUTABLE}`);
    await statusPatch({state:'starting',stage:'gpu-probe',samplesDone:0,samplesRequested:samples,progress:0,message:'GPU 브라우저 준비 중…'});
    const staticInfo=await startStaticServer();
    const launched=await launchHardwareBrowser(staticInfo.url,frameWidth,frameHeight);
    page=launched.page;
    report.backend=launched.backend; report.webgl=launched.probe; report.gpuAttempts=launched.attempts;
    const browserConsole=[]; const pageErrors=[];
    page.on('console',msg=>{if(browserConsole.length<1000)browserConsole.push(`[${msg.type()}] ${msg.text()}`);});
    page.on('pageerror',err=>{if(pageErrors.length<200)pageErrors.push(err?.stack||String(err));});
    page.on('dialog',async d=>{try{await d.dismiss();}catch(_){}});

    await statusPatch({state:'restoring',stage:'scene-load',message:'장면 ZIP 복원 중…'});
    await page.evaluate(()=>document.getElementById('shellPresetBtn')?.click());
    await page.waitForSelector('#sceneProjectLoadZipBtn',{state:'attached',timeout:60_000});
    await page.evaluate(()=>document.getElementById('sceneProjectLoadZipBtn')?.click());
    await page.waitForSelector('#sceneProjectLoadInput',{state:'attached',timeout:30_000});
    await page.locator('#sceneProjectLoadInput').setInputFiles(SCENE_ZIP);
    await page.waitForFunction(()=>(document.getElementById('sceneProjectStatusLine')?.textContent||'').includes('ZIP 불러오기 완료'),null,{timeout:10*60_000});
    report.sceneStatus=await page.locator('#sceneProjectStatusLine').textContent();

    await statusPatch({state:'rendering',stage:'pathtrace',samplesDone:0,samplesRequested:samples,progress:0,message:`${longEdge}px / ${samples}spp PT 시작`});
    const renderStart=Date.now();
    const downloadPromise=page.waitForEvent('download',{timeout:12*60*60*1000});
    const evalPromise=page.evaluate(async opts => {
      return await window.__huesteriaExportHooks.capturePathTracePng({
        longEdge:opts.longEdge,
        samples:opts.samples,
        bounces:opts.bounces,
        mode:opts.mode,
        includeMmdXps:opts.includeMmdXps,
        ptExpressionEnhance:opts.ptExpressionEnhance,
        disablePathTraceCropTiles:opts.disablePathTraceCropTiles,
        disablePathTraceTiles:opts.disablePathTraceTiles,
        pathTraceTiles:1,
        includeCameraFrame:opts.includeCameraFrame,
        executionProfile:'cloud-4090',
        cloudFrame:opts.frame,
        filename:opts.resultFilename,
        onProgress:payload=>{window.__huesteriaCloudLiveProgress=payload;}
      });
    },{longEdge,samples,bounces,mode,includeMmdXps,ptExpressionEnhance,disablePathTraceCropTiles,disablePathTraceTiles,includeCameraFrame,resultFilename,frame:{width:frameWidth,height:frameHeight,aspect:frameWidth/frameHeight}});

    let busy=false; let lastPreviewAt=0; let lastPreviewSample=-1;
    const progressTimer=setInterval(async()=>{
      if(busy||!page) return; busy=true;
      try {
        const p=await page.evaluate(()=>window.__huesteriaCloudLiveProgress||null);
        if(p){
          const done=Math.max(0,Number(p.samplesDone||0));
          const requested=Math.max(1,Number(p.samplesRequested||samples));
          const progress=Number.isFinite(Number(p.progress))?Number(p.progress):done/requested;
          await statusPatch({state:'rendering',stage:p.stage||'rendering',samplesDone:done,samplesRequested:requested,progress,message:p.message||'클라우드 PT 렌더 중…'});
          const now=Date.now();
          if(done!==lastPreviewSample && now-lastPreviewAt>=1500){
            if(await writeLivePreview(page)){lastPreviewAt=now;lastPreviewSample=done;}
          }
        }
        if(cancelRequested) await closeBrowser();
      } catch(_){} finally{busy=false;}
    },700);

    let download,result;
    try { [download,result]=await Promise.all([downloadPromise,evalPromise]); }
    finally { clearInterval(progressTimer); }
    if(cancelRequested) throw new Error('cancelled');

    await fsp.mkdir(RESULT_DIR,{recursive:true});
    const finalTmp=path.join(RESULT_DIR,`final.${process.pid}.tmp`);
    await download.saveAs(finalTmp);
    await fsp.rename(finalTmp,RESULT_PNG);
    const stat=await fsp.stat(RESULT_PNG);
    if(stat.size<=0) throw new Error('final PNG is empty');
    if(fs.existsSync(PREVIEW_PATH)) await fsp.copyFile(PREVIEW_PATH,RESULT_PREVIEW);
    const renderMs=Date.now()-renderStart;
    const meta=await page.evaluate(()=>window.__huesteriaExportHooks.getLastPathTraceMeta?.()||null);
    report.success=true; report.finishedAt=nowIso(); report.renderMs=renderMs; report.renderSeconds=renderMs/1000; report.result=result; report.meta=meta; report.output={path:RESULT_PNG,bytes:stat.size}; report.browserConsole=browserConsole.slice(-300); report.pageErrors=pageErrors.slice(-100);
    await atomicJson(RESULT_META,report);
    await statusPatch({state:'completed',stage:'completed',samplesDone:meta?.samplesDone??samples,samplesRequested:meta?.samplesRequested??samples,progress:1,message:'렌더 완료 · 영구 저장 확인',resultKey:`huesteria-results/${JOB_ID}/final.png`,resultFilename,width:result?.width||0,height:result?.height||0,bytes:stat.size,renderSeconds:renderMs/1000,meta});
    await cleanupTemp({keepStatus:true});
    scheduleSelfDelete('completed',20_000);
    return report;
  } catch(error){
    const cancelled=cancelRequested || String(error?.message||'').toLowerCase()==='cancelled';
    report.success=false; report.finishedAt=nowIso(); report.error=error?.stack||String(error);
    try{await fsp.rm(RESULT_DIR,{recursive:true,force:true});}catch(_){}
    await statusPatch({state:cancelled?'cancelled':'failed',stage:cancelled?'cancelled':'failed',message:cancelled?'렌더 취소됨':(error?.message||String(error)),error:cancelled?undefined:(error?.stack||String(error))}).catch(()=>{});
    await cleanupTemp({keepStatus:true});
    scheduleSelfDelete(cancelled?'cancelled':'failed',15_000);
    throw error;
  } finally {
    await closeBrowser();
    if(staticServer?.server){try{staticServer.server.close();}catch(_){} staticServer=null;}
  }
}

const apiServer=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    const pathname=url.pathname;
    if(req.method==='OPTIONS'){res.statusCode=204;cors(res);res.end();return;}
    if(pathname==='/health'){
      const st=await currentStatus();
      sendJson(res,200,{ok:true,service:'huesteria-ghcr-worker-v1',jobId:JOB_ID,podId:POD_ID,state:st.state,stage:st.stage,rendererReady:fs.existsSync(APP_HTML)&&fs.existsSync(CHROME_EXECUTABLE),resultPersistent:fs.existsSync(RESULT_PNG)});return;
    }
    if(!authorized(req)){sendJson(res,401,{error:'unauthorized'});return;}
    touchActivity();
    const prefix=`/v1/jobs/${encodeURIComponent(JOB_ID)}`;
    if(pathname===`${prefix}/status` && req.method==='GET'){sendJson(res,200,await currentStatus());return;}
    if(pathname===`${prefix}/upload` && req.method==='GET'){
      const parts=await receivedParts();
      const st=await currentStatus();
      sendJson(res,200,{ok:true,jobId:JOB_ID,receivedChunks:parts.indexes,receivedBytes:parts.bytes,totalChunks:st.totalChunks||null,sceneReady:fs.existsSync(SCENE_ZIP)});return;
    }
    const chunkMatch=new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/chunks/(\\d+)$`).exec(pathname);
    if(chunkMatch && req.method==='PUT'){
      if(renderPromise){sendJson(res,409,{error:'render already started'});return;}
      const index=Number(chunkMatch[1]);
      const totalChunks=Math.max(1,Math.min(10000,Number(req.headers['x-huesteria-chunk-count'])||0));
      const totalBytes=Math.max(1,Number(req.headers['x-huesteria-total-bytes'])||0);
      if(!Number.isInteger(index)||index<0||index>=totalChunks){sendJson(res,400,{error:'invalid chunk index'});return;}
      const bytes=await streamRequestToFile(req,partPath(index),CHUNK_MAX_BYTES);
      const parts=await receivedParts();
      await statusPatch({state:'uploading',stage:'uploading',totalChunks,totalBytes,receivedChunks:parts.indexes.length,receivedBytes:parts.bytes,progress:Math.min(0.99,parts.bytes/Math.max(1,totalBytes)),message:`장면 전송 ${parts.indexes.length}/${totalChunks}`});
      sendJson(res,201,{ok:true,index,bytes,receivedChunks:parts.indexes.length});return;
    }
    if(pathname===`${prefix}/assemble` && req.method==='POST'){
      if(renderPromise){sendJson(res,409,{error:'render already started'});return;}
      const body=await readRequestJson(req);
      const result=await assembleScene(body);
      if(!result.ok){sendJson(res,409,result);return;}
      sendJson(res,201,result);return;
    }
    if(pathname===`${prefix}/start` && req.method==='POST'){
      if(!fs.existsSync(SCENE_ZIP)){sendJson(res,409,{error:'scene not assembled'});return;}
      if(renderPromise){sendJson(res,202,{ok:true,state:(await currentStatus()).state});return;}
      cancelRequested=false;
      renderPromise=runRender().catch(error=>console.error('[Huesteria render failed]',error)).finally(()=>{renderPromise=null;});
      sendJson(res,202,{ok:true,state:'starting'});return;
    }
    if(pathname===`${prefix}/cancel` && req.method==='POST'){
      cancelRequested=true;
      await statusPatch({state:'cancelling',stage:'cancelling',message:'렌더 취소 중…'});
      await closeBrowser();
      if(!renderPromise) scheduleSelfDelete('cancelled-before-start',5_000);
      sendJson(res,202,{ok:true,state:'cancelling'});return;
    }
    if(pathname===`${prefix}/preview` && req.method==='GET'){
      const source=fs.existsSync(PREVIEW_PATH)?PREVIEW_PATH:(fs.existsSync(RESULT_PREVIEW)?RESULT_PREVIEW:null);
      if(!source){sendJson(res,404,{error:'preview not ready'});return;}
      const etag=`\"${previewRevision}-${(await fsp.stat(source)).size}\"`;
      if(req.headers['if-none-match']===etag){res.statusCode=304;cors(res);res.setHeader('ETag',etag);res.end();return;}
      const stat=await fsp.stat(source);res.statusCode=200;cors(res);res.setHeader('Content-Type','image/jpeg');res.setHeader('Content-Length',String(stat.size));res.setHeader('ETag',etag);fs.createReadStream(source).pipe(res);return;
    }
    if(pathname===`${prefix}/result` && req.method==='GET'){
      if(!fs.existsSync(RESULT_PNG)){sendJson(res,404,{error:'result not ready'});return;}
      const stat=await fsp.stat(RESULT_PNG);res.statusCode=200;cors(res);res.setHeader('Content-Type','image/png');res.setHeader('Content-Length',String(stat.size));res.setHeader('Content-Disposition',`attachment; filename="${safeName(renderConfig.resultFilename||'huesteria.png','huesteria.png')}"`);fs.createReadStream(RESULT_PNG).pipe(res);return;
    }
    sendJson(res,404,{error:'not found'});
  }catch(error){console.error(error);if(!res.headersSent)sendJson(res,500,{error:error?.message||String(error)});else try{res.destroy();}catch(_){} }
});

apiServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`[Huesteria GHCR Worker] listening 0.0.0.0:${PORT}`);
  console.log(`[Huesteria GHCR Worker] job=${JOB_ID} pod=${POD_ID}`);
});

setInterval(async()=>{
  const st=await currentStatus().catch(()=>null);
  if(!st) return;
  const active=['starting','restoring','rendering','cancelling'].includes(st.state);
  if(!active && Date.now()-lastActivityAt>IDLE_TTL_MS) scheduleSelfDelete('idle-timeout',1_000);
},30_000).unref();
setTimeout(()=>scheduleSelfDelete('hard-timeout',1_000),HARD_TTL_MS).unref();

process.on('SIGTERM',async()=>{cancelRequested=true;await closeBrowser();process.exit(0);});
process.on('SIGINT',async()=>{cancelRequested=true;await closeBrowser();process.exit(0);});
