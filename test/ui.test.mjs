import test from 'node:test';
import assert from 'node:assert/strict';
import { mountControl, safeImagePreviewUrl } from '../ui/control.js';
import { mountSettings, settingsSections } from '../ui/settings.js';
class FakeNode { constructor(tagName='#text',text=''){this.tagName=tagName.toUpperCase();this.children=[];this.attributes=new Map();this.listeners=new Map();this.parentNode=null;this._text=text;this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.className='';} append(...nodes){for(const value of nodes){const node=typeof value==='string'?new FakeNode('#text',value):value;node.parentNode=this;this.children.push(node);}} replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes);} setAttribute(name,value){const normalized=String(value);this.attributes.set(name,normalized);if(name==='id')this.id=normalized;if(name==='type')this.type=normalized;if(name==='role')this.role=normalized;} getAttribute(name){return this.attributes.get(name)??null;} addEventListener(type,listener){this.listeners.set(type,listener);} removeEventListener(type,listener){if(this.listeners.get(type)===listener)this.listeners.delete(type);} dispatchEvent(event){event.target=this;event.currentTarget=this;return this.listeners.get(event.type)?.(event);} remove(){if(!this.parentNode)return;this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;} reportValidity(){return true;} set textContent(value){this._text=String(value);this.children=[];} get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}}
const documentFixture={createElement:tag=>new FakeNode(tag),createTextNode:text=>new FakeNode('#text',text)};
const descendants=node=>[node,...node.children.flatMap(descendants)];
const byTag=(root,tag)=>descendants(root).filter(node=>node.tagName===tag.toUpperCase());
const byText=(root,tag,text)=>byTag(root,tag).find(node=>node.textContent===text);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test.beforeEach(()=>{globalThis.document=documentFixture;}); test.afterEach(()=>{delete globalThis.document;});
test('Control loads, refreshes, aborts, and cleans up',async()=>{const root=new FakeNode('div');const calls=[];const cleanup=mountControl({root,api:async(path,init)=>{if(path.startsWith('/images'))return path.endsWith('status')?{ok:true,available:false}:{ok:true,job:null};calls.push({path,init});return{ok:true,greeting:calls.length===1?'Hello.':'Again.',secretConfigured:calls.length>1};}});await settle();assert.equal(calls[0].path,'/status');assert.match(root.textContent,/Hello\./);const refresh=byText(root,'button','Refresh status');await refresh.dispatchEvent({type:'click'});assert.match(root.textContent,/Again\./);const signal=calls[0].init.signal;cleanup();assert.equal(signal.aborted,true);assert.equal(refresh.listeners.has('click'),false);assert.equal(root.children.length,0);});
test('Settings saves public values while keeping the secret write-only',async()=>{assert.deepEqual(settingsSections,[{id:'configuration',label:'Configuration'}]);const root=new FakeNode('div');const calls=[];const cleanup=mountSettings({section:'configuration',primary:{replace:node=>root.replaceChildren(node)},api:async(path,init)=>{calls.push({path,init});if(path==='/status')return{ok:true,greeting:'Welcome.',secretConfigured:true};return{ok:true,greeting:JSON.parse(init.body).greeting.trim(),secretConfigured:true};}});await settle();const [greeting,secret]=byTag(root,'input').filter(input=>input.type!=='checkbox');const clear=byTag(root,'input').find(input=>input.type==='checkbox');const form=byTag(root,'form')[0];assert.equal(greeting.value,'Welcome.');assert.equal(secret.value,'');assert.match(root.textContent,/write-only/i);greeting.value='Updated.';await form.dispatchEvent({type:'submit',preventDefault(){}});assert.deepEqual(JSON.parse(calls[1].init.body),{greeting:'Updated.'});clear.checked=true;clear.dispatchEvent({type:'change'});await form.dispatchEvent({type:'submit',preventDefault(){}});assert.deepEqual(JSON.parse(calls[2].init.body),{greeting:'Updated.',secret:''});const signal=calls[0].init.signal;cleanup();assert.equal(signal.aborted,true);assert.equal(root.children.length,0);});
test('Settings ignores unknown sections and exposes request errors as alerts',async()=>{assert.equal(mountSettings({section:'other',primary:{replace(){throw Error('must not mount');}},api:async()=>({})}),undefined);const root=new FakeNode('div');const cleanup=mountSettings({section:'configuration',primary:{replace:node=>root.replaceChildren(node)},api:async()=>{throw Error('Status unavailable');}});await settle();assert.equal(descendants(root).find(node=>node.getAttribute('role')==='alert')?.textContent,'Status unavailable');cleanup();});

test('image preview accepts only authenticated Core artifact paths', () => {
  assert.equal(safeImagePreviewUrl('/api/forge/jobs/job-1/artifacts/art-1'), '/api/forge/jobs/job-1/artifacts/art-1');
  for (const value of [null, 'javascript:alert(1)', 'data:image/png;base64,no', '//evil/api/forge/jobs/a/artifacts/b', 'https://evil/a', '/api/forge/jobs/a/artifacts/b?download=1', '/api/forge/jobs/a/artifacts/../secret', '/api/forge/jobs/a/artifacts/b#token', '/api/forge/jobs/a/artifacts/b?token=secret']) assert.equal(safeImagePreviewUrl(value), null);
});
test('Control images require consent, submit asynchronously, poll to terminal and restore after remount', async () => {
  const root = new FakeNode('div'); const calls = []; let job = null;
  const api = async (path, init) => {
    calls.push({ path, init });
    if (path === '/status') return { ok: true, greeting: 'Hello.', secretConfigured: false };
    if (path === '/images/status') return { ok: true, available: true, retryPending: false, jobId: job?.id || null };
    if (path === '/images/job') return { ok: true, job };
    if (path === '/images') { job = { id: 'job-1', status: 'queued', artifacts: [] }; return { ok: true, job, replayed: false }; }
    throw Error('unexpected route');
  };
  let cleanup = mountControl({ root, api }); await settle();
  const form = byTag(root, 'form')[0]; const consent = byTag(root, 'input')[0];
  byTag(root, 'textarea')[0].value = 'A burrow';
  await form.dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(calls.filter(c => c.path === '/images').length, 0);
  consent.checked = true; await form.dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.deepEqual(JSON.parse(calls.find(c => c.path === '/images').init.body), { prompt: 'A burrow', confirmCost: true });
  assert.match(root.textContent, /queued.*poll again later/);
  assert.equal(byText(root, 'button', 'Create image (may incur cost)').disabled, true);
  assert.equal(calls.filter(c => c.path === '/images/job').length, 1); // No wait loop after create.
  job = { id: 'job-1', status: 'succeeded', artifacts: [{ kind: 'image', previewUrl: '/api/forge/jobs/job-1/artifacts/art-1' }, { kind: 'image', previewUrl: 'https://evil/private?token=secret' }] };
  cleanup(); cleanup = mountControl({ root, api }); await settle();
  assert.match(root.textContent, /succeeded \(terminal\)/);
  assert.equal(byTag(root, 'img').length, 1);
  assert.equal(byTag(root, 'img')[0].getAttribute('src'), '/api/forge/jobs/job-1/artifacts/art-1');
  job = { id: 'job-1', status: 'failed', error: 'generation_failed', artifacts: [] };
  await byText(root, 'button', 'Poll saved image job').dispatchEvent({ type: 'click' });
  assert.match(root.textContent, /failed \(terminal\).*generation_failed/);
  assert.equal(byTag(root, 'img').length, 0);
  const signals = calls.map(c => c.init.signal); cleanup(); assert.ok(signals.every(s => s.aborted));
});
test('Control unavailable images never submit automatically; pending retry sends no replacement prompt', async () => {
  const root = new FakeNode('div'); const posts = []; let available = false; let pending = false;
  const cleanup = mountControl({ root, api: async (path, init) => {
    if (path === '/status') return { ok: true, greeting: 'Hi', secretConfigured: false };
    if (path === '/images/status') return { ok: true, available, reason: 'forge_selection_missing', retryPending: pending };
    if (path === '/images/job') return { ok: true, job: null };
    posts.push(JSON.parse(init.body)); return { ok: true, job: { id: 'job-1', status: 'running' } };
  } });
  await settle(); assert.match(root.textContent, /unavailable: forge_selection_missing/);
  assert.equal(byText(root, 'button', 'Create image (may incur cost)').disabled, true); assert.equal(posts.length, 0);
  available = true; pending = true;
  await byText(root, 'button', 'Poll saved image job').dispatchEvent({ type: 'click' });
  assert.match(root.textContent, /receipt unknown/);
  byTag(root, 'input')[0].checked = true;
  await byText(root, 'button', 'Retry saved submission').dispatchEvent({ type: 'click', preventDefault() {} });
  assert.deepEqual(posts, [{ confirmCost: true }]); cleanup();
});

test('Control failed job reads fail closed instead of offering a new paid request', async () => {
  const root = new FakeNode('div');
  const cleanup = mountControl({ root, api: async path => {
    if (path === '/status') return { ok: true, greeting: 'Hi', secretConfigured: false };
    if (path === '/images/status') return { ok: true, available: true, jobId: 'job-1', retryPending: false };
    throw Error('private-provider-details');
  } });
  await settle(); assert.match(root.textContent, /do not assume completion/);
  assert.doesNotMatch(root.textContent, /private-provider/);
  assert.equal(byText(root, 'button', 'Create image (may incur cost)').disabled, true);
  cleanup();
});
