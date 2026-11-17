// UI/controller tests in a small DOM simulation; no live services or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function setup({connections=[{id:'ro',name:'Read replica',type:'postgresql',mcpReadOnly:true,connected:false},{id:'rw',name:'Writer',type:'hive',mcpReadOnly:false,connected:false}],tokens=[],storage=new Map()}={}) {
  let document;
  const observers=[];
  const notify = target => { for (const observer of observers) if (observer.targets.includes(target)) queueMicrotask(() => observer.callback()); };
  class Element {
    constructor(tag='div') {
      this.tagName=tag; this.children=[]; this.parentNode=null; this.listeners={}; this.attributes={}; this.dataset={}; this.className=''; this._text=''; this._value=''; this._hidden=false; this._open=false; this.disabled=false; this.checked=false; this.scrollTop=0; this.scrollLeft=0; this.selectionStart=0; this.selectionEnd=0;
      this.style={values:{},setProperty:(key,value)=>{this.style.values[key]=value;}};
      this.classList={add:name=>this.classList.toggle(name,true),remove:name=>this.classList.toggle(name,false),toggle:(name,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));on??=!set.has(name);if(on)set.add(name);else set.delete(name);this.className=[...set].join(' ');return on;}};
    }
    get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    set textContent(value){this._text=String(value);this.children=[];}
    get innerHTML(){return this.textContent;}
    set innerHTML(value){this._text=String(value);this.children=[];}
    get hidden(){return this._hidden;}
    set hidden(value){if(this._hidden!==Boolean(value)){this._hidden=Boolean(value);notify(this);}}
    get open(){return this._open;}
    set open(value){if(this._open!==Boolean(value)){this._open=Boolean(value);notify(this);}}
    get value(){if(this.tagName==='select'&&!this._value)return this.children.find(n=>n.tagName==='option')?.value||'';return this._value;}
    set value(value){this._value=String(value);}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){this._text='';this.children=[];this.append(...nodes);}
    contains(node){return this===node||this.children.some(n=>n.contains(node));}
    setAttribute(key,value){this.attributes[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);if(key==='value')this.value=value;if(key==='hidden')this.hidden=true;}
    getAttribute(key){return this.attributes[key];}
    addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);}
    removeEventListener(key,fn){this.listeners[key]=(this.listeners[key]||[]).filter(x=>x!==fn);}
    async emit(key,event={}){for(const fn of this.listeners[key]||[])await fn({target:this,currentTarget:this,preventDefault(){},...event});}
    click(){if(!this.disabled)return this.emit('click');}
    focus(){document.activeElement=this;}
    select(){this.setSelectionRange(0,this.value.length);this.focus();}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}
    dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}
    querySelectorAll(selector){const all=this.children.flatMap(n=>[n,...n.querySelectorAll('*')]);return all.filter(n=>selector==='*'||selector==='[data-focus]'&&n.dataset.focus||selector.startsWith('#')&&n.id===selector.slice(1)||selector.startsWith('.')&&n.className.split(' ').includes(selector.slice(1))||selector==='th button'&&n.tagName==='button'||n.tagName===selector);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    showModal(){this.open=true;}
    close(){if(this.open){this.open=false;queueMicrotask(()=>this.emit('close'));}}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);}
    getBoundingClientRect(){return {top:42,left:0,right:this.className==='tool-rail'?64:900,height:700,width:64};}
    setPointerCapture(){}
  }
  const tree=new Element('document'), stack=[tree];
  for(const match of fs.readFileSync(path.join(root,'public/index.html'),'utf8').matchAll(/<\/?[^>]+>|[^<]+/g)) {
    const token=match[0];
    if(token.startsWith('<!'))continue;
    if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
    if(token.startsWith('<')){
      const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;
      const node=new Element(tag);
      for(const attribute of token.matchAll(/([\w-]+)="([^"]*)"/g))node.setAttribute(attribute[1],attribute[2]);
      if(/\shidden(?:\s|>|\/)/.test(token))node.hidden=true;
      if(/\schecked(?:\s|>|\/)/.test(token))node.checked=true;
      stack.at(-1).append(node);
      if(!['meta','link','input','br','hr','use'].includes(tag)&&!token.endsWith('/>'))stack.push(node);
    } else stack.at(-1)._text+=token;
  }
  document={body:tree.querySelector('body'),activeElement:null,visibilityState:'visible',querySelector:selector=>tree.querySelector(selector),querySelectorAll:selector=>tree.querySelectorAll(selector),createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag),listeners:{},addEventListener:Element.prototype.addEventListener,emit:Element.prototype.emit};
  const requests=[],copies=[];
  let handler=null;
  const safeConnections=connections.map(({id,name,type,mcpReadOnly})=>({id,name,type,mcpReadOnly}));
  const window={WorkbenchCore:require('../public/workbench-core'),GridBaseSession:{user:{id:'1001',login:'alice'},capabilities:{auditAdmin:false}},location:{href:'https://gridbase.example/'},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},matchMedia:()=>({matches:false,addEventListener(){}}),setTimeout(){},clearTimeout(){},listeners:{},addEventListener:Element.prototype.addEventListener,emit:Element.prototype.emit,confirm:()=>true,navigator:{clipboard:{writeText:async value=>{copies.push(value);}}}};
  const context=vm.createContext({document,window,navigator:window.navigator,MutationObserver:class{constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}observe(target){this.targets.push(target);}},fetch:async(url,options={})=>{
    requests.push({url,options});
    if(url.startsWith('/api/mcp/')){
      if(handler){const result=await handler(url,options);if(result)return result;}
      return {ok:true,json:async()=>({tokens,connections:safeConnections,endpoint:'https://gridbase.example/mcp'})};
    }
    const id=url.split('/').at(-1);
    const data=url==='/api/connections'?{connections,defaultConnectionId:null}:url.startsWith('/api/connections/')?{...connections.find(n=>n.id===id),username:'fixture',password:'fixture',host:'fixture',port:'5432',database:'app'}:url.startsWith('/api/activity')?{events:[],nextCursor:null}:{};
    return {ok:true,json:async()=>data};
  },Event:class{constructor(type){this.type=type;}},URL,URLSearchParams,Blob,console});
  if(fs.existsSync(path.join(root,'public/mcp.js')))vm.runInContext(fs.readFileSync(path.join(root,'public/mcp.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'public/activity.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'public/app.js'),'utf8'),context);
  document.querySelector('#app').hidden=false;
  return {context,document,window,storage,requests,copies,get:id=>document.querySelector('#'+id),read:code=>vm.runInContext(code,context),setHandler:fn=>{handler=fn;}};
}
const checkboxes = app => app.get('mcp-connections').querySelectorAll('input');
const response = data => ({ok:true,json:async()=>data});
const token = {id:'token-1',name:'Assistant',prefix:'gbmcp_safe',scope:'read_only',grants:[{connectionId:'ro',generation:'fixture-generation',readOnly:true}],createdAt:1794690000000,expiresAt:1890000000000,revokedAt:null};
async function open(app){const control=app.get('account-settings');assert.ok(control,'account MCP settings control is present');await control.click();await flush();}

test('rail exposes DB, History and Logs while retaining existing panel navigation and resize geometry',async()=>{
  const app=setup();await flush();
  for(const [id,label] of [['database-tool','DB'],['history-tool','History'],['activity-tool','Logs']])assert.equal(app.get(id).querySelector('span')?.textContent,label);
  await app.get('history-tool').click();assert.equal(app.get('history-view').hidden,false);assert.equal(app.get('history-tool').getAttribute('aria-expanded'),'true');
  await app.get('activity-tool').click();await flush();assert.equal(app.get('activity-panel').hidden,false);assert.equal(app.get('sidebar-heading').textContent,'Logs');
  await app.get('database-tool').click();assert.equal(app.document.querySelector('.workbench').hidden,false);assert.equal(app.get('database-view').hidden,false);
  const resizer=app.get('sidebar-resizer');await resizer.emit('pointerdown',{pointerId:1});await resizer.emit('pointermove',{clientX:324});assert.equal(app.get('app').style.values['--sidebar-width'],'260px');
});
test('connection read-only declaration defaults false and round-trips detail, cache, and explicit payload',async()=>{
  const app=setup();await flush();
  assert.equal(app.read("state.connectionProfiles.find(p=>p.id==='ro').mcpReadOnly"),true);
  await app.context.openConnectionManager(app.read("state.connections.get('ro')"));assert.equal(app.get('connection-mcp-read-only')?.checked,true);
  assert.equal(app.read('connectionPayload().mcpReadOnly'),true);
  app.context.resetConnectionForm();assert.equal(app.get('connection-mcp-read-only').checked,false);assert.equal(app.read('connectionPayload().mcpReadOnly'),false);
  await app.context.openConnectionManager(app.read("state.connections.get('rw')"));assert.equal(app.get('connection-mcp-read-only').checked,false);
  assert.equal(JSON.parse(app.storage.get('gridbase:connections:v1:github:1001')).find(p=>p.id==='ro').mcpReadOnly,true);
});
test('settings default to read_only, 30 days and no implicit grants; scope changes never upgrade profile ceilings',async()=>{
  const app=setup();await flush();await open(app);
  assert.equal(app.get('mcp-dialog').open,true);assert.equal(app.get('mcp-scope').value,'read_only');assert.equal(app.get('mcp-expiry').value,'30');
  assert.deepEqual(checkboxes(app).map(n=>[n.value,n.checked,n.disabled]),[['ro',false,false],['rw',false,true]]);
  app.get('mcp-name').value='Assistant';await app.get('mcp-form').emit('submit');assert.equal(app.requests.some(r=>r.options.method==='POST'),false);assert.match(app.get('mcp-status').textContent,/select/i);
  app.get('mcp-scope').value='full_access';await app.get('mcp-scope').emit('change');assert.equal(checkboxes(app)[1].disabled,false);checkboxes(app)[1].checked=true;
  app.get('mcp-scope').value='read_only';await app.get('mcp-scope').emit('change');assert.equal(checkboxes(app)[1].checked,false);assert.equal(checkboxes(app)[1].disabled,true);
  assert.match(app.get('mcp-dialog').textContent,/externally provisioned/i);assert.match(app.get('mcp-dialog').textContent,/disconnect.*not.*revok/i);
});
test('a legacy server profile cannot inherit a read-only declaration from stale browser cache',async()=>{
  const storage=new Map([['gridbase:connections:v1:github:1001',JSON.stringify([{id:'legacy',name:'Legacy',type:'postgresql',serverSaved:true,mcpReadOnly:true}])]]);
  const app=setup({storage,connections:[{id:'legacy',name:'Legacy',type:'postgresql',connected:false}]});await flush();
  assert.equal(app.read("state.connectionProfiles.find(p=>p.id==='legacy').mcpReadOnly"),false);
  assert.equal(app.read("state.connections.get('legacy').mcpReadOnly"),false);
});
test('editing profile settings requires explicit read-only reconfirmation without changing ordinary connect semantics',async()=>{
  const app=setup();await flush();await app.context.openConnectionManager(app.read("state.connections.get('ro')"));
  assert.equal(app.get('connection-mcp-read-only').checked,true);
  for(const id of ['connection-name','connection-host','connection-port','connection-database','connection-jdbc-url','connection-username','connection-password','connection-ssl']){
    app.get('connection-mcp-read-only').checked=true;await app.get(id).emit('input');assert.equal(app.get('connection-mcp-read-only').checked,false,id+' invalidates the assertion');
  }
  app.get('connection-mcp-read-only').checked=true;app.get('database-type').value='mysql';await app.get('database-type').emit('change');assert.equal(app.get('connection-mcp-read-only').checked,false);
  app.get('connection-mcp-read-only').checked=true;assert.equal(app.read('connectionPayload().mcpReadOnly'),true);
});
test('create sends explicit selected profiles and expiry, shows safe grant names, and copies the secret only on request',async()=>{
  const app=setup();await flush();await open(app);
  app.setHandler((url,options)=>options.method==='POST'?response({token,secret:'one-time-fixture-secret'}):response({tokens:[token],connections:[{id:'ro',name:'Read replica',type:'postgresql',mcpReadOnly:true}],endpoint:'https://gridbase.example/mcp'}));
  app.get('mcp-name').value='Assistant';app.get('mcp-expiry').value='90';checkboxes(app)[0].checked=true;
  await app.get('mcp-form').emit('submit');await flush();
  const request=app.requests.find(r=>r.options.method==='POST');assert.deepEqual(JSON.parse(request.options.body),{name:'Assistant',scope:'read_only',expiresInDays:90,connectionIds:['ro']});
  assert.equal(app.get('mcp-secret').textContent,'one-time-fixture-secret');assert.equal(app.copies.length,0);
  assert.match(app.get('mcp-token-list').textContent,/Assistant/);assert.match(app.get('mcp-token-list').textContent,/gbmcp_safe/);assert.match(app.get('mcp-token-list').textContent,/Read replica/);
  await app.get('mcp-copy-secret').click();assert.deepEqual(app.copies,['one-time-fixture-secret']);
  for(const value of app.storage.values())assert.doesNotMatch(value,/one-time-fixture-secret/);
  assert.doesNotMatch(app.get('mcp-client-values').textContent,/one-time-fixture-secret/);assert.match(app.get('mcp-client-values').textContent,/\$\{GRIDBASE_MCP_TOKEN\}/);
  await app.get('mcp-discard-secret').click();assert.equal(app.get('mcp-secret').textContent,'');assert.equal(app.get('mcp-secret-result').hidden,true);
});
test('full_access is explicit and still presents read-only grants as a ceiling',async()=>{
  const app=setup({tokens:[{...token,scope:'full_access'}]});await flush();await open(app);
  app.get('mcp-scope').value='full_access';await app.get('mcp-scope').emit('change');checkboxes(app)[0].checked=true;checkboxes(app)[1].checked=true;app.get('mcp-name').value='Write assistant';app.get('mcp-expiry').value='365';
  app.setHandler((url,options)=>options.method==='POST'?response({token:{...token,scope:'full_access'},secret:'fixture-full'}):null);
  await app.get('mcp-form').emit('submit');assert.deepEqual(JSON.parse(app.requests.find(r=>r.options.method==='POST').options.body),{name:'Write assistant',scope:'full_access',expiresInDays:365,connectionIds:['ro','rw']});
  assert.match(app.get('mcp-token-list').textContent,/read.only.*ceiling/i);
});
test('revoke targets only its token and refreshes safe list state without revealing a secret',async()=>{
  const app=setup({tokens:[token]});await flush();await open(app);let revoked=false;
  app.setHandler((url,options)=>{if(options.method==='DELETE'){assert.equal(url,'/api/mcp/tokens/token-1');revoked=true;return response({ok:true});}return response({tokens:[{...token,revokedAt:revoked?1794700000000:null}],connections:[{id:'ro',name:'Read replica',type:'postgresql',mcpReadOnly:true}],endpoint:'https://gridbase.example/mcp'});});
  await app.get('mcp-token-list').querySelector('button').click();await flush();assert.ok(revoked);assert.match(app.get('mcp-token-list').textContent,/Revoked/);assert.equal(app.get('mcp-secret').textContent,'');
});
test('server strings render as inert text and expired/revoked tokens have no active revoke action',async()=>{
  const attack='<img src=x onerror=alert(1)>';
  const app=setup({tokens:[{...token,name:attack,revokedAt:1},{...token,id:'old',expiresAt:1}],connections:[{id:'ro',name:attack,type:'postgresql',mcpReadOnly:true}]});await flush();await open(app);
  assert.ok(app.get('mcp-token-list').textContent.includes(attack));assert.equal(app.get('mcp-token-list').querySelectorAll('img').length,0);assert.equal(app.get('mcp-token-list').querySelectorAll('button').filter(n=>!n.disabled).length,0);assert.match(app.get('mcp-token-list').textContent,/Expired/);
});
for(const dismissal of ['close','cancel','native-close','visibility','pagehide','logout','conceal','account'])test('one-time secret is cleared on '+dismissal,async()=>{
  const app=setup();await flush();await open(app);app.setHandler((url,options)=>options.method==='POST'?response({token,secret:'ephemeral-fixture'}):null);
  app.get('mcp-name').value='Assistant';checkboxes(app)[0].checked=true;await app.get('mcp-form').emit('submit');assert.equal(app.get('mcp-secret').textContent,'ephemeral-fixture');
  if(dismissal==='close')await app.get('mcp-close').click();
  if(dismissal==='cancel')await app.get('mcp-dialog').emit('cancel');
  if(dismissal==='native-close')app.get('mcp-dialog').close();
  if(dismissal==='visibility'){app.document.visibilityState='hidden';await app.document.emit('visibilitychange');}
  if(dismissal==='pagehide')await app.window.emit('pagehide');
  if(dismissal==='logout')await app.get('logout').click();
  if(dismissal==='conceal')app.get('app').hidden=true;
  if(dismissal==='account'){app.window.GridBaseSession={user:{id:'2002'}};app.get('app').hidden=true;}
  await flush();assert.equal(app.get('mcp-secret').textContent,'');assert.equal(app.get('mcp-secret-result').hidden,true);
});
for(const phase of ['list','create','revoke'])test('late '+phase+' responses cannot repopulate closed or reopened settings',async()=>{
  const app=setup({tokens:[token]});await flush();if(phase!=='list')await open(app);
  const wait=deferred();app.setHandler((url,options)=>((phase==='create'&&options.method==='POST')||(phase==='revoke'&&options.method==='DELETE')||(phase==='list'&&!options.method))?wait.promise:null);
  let pending;
  if(phase==='list')pending=app.get('account-settings').click();
  if(phase==='create'){app.get('mcp-name').value='Assistant';checkboxes(app)[0].checked=true;pending=app.get('mcp-form').emit('submit');}
  if(phase==='revoke')pending=app.get('mcp-token-list').querySelector('button').click();
  await app.get('mcp-close').click();app.setHandler(()=>response({tokens:[],connections:[],endpoint:'https://gridbase.example/mcp'}));await open(app);
  wait.resolve(response({tokens:[{...token,name:'stale-token'}],connections:[],endpoint:'https://stale.example/mcp',token,secret:'late-secret'}));await pending;await flush();
  assert.equal(app.get('mcp-secret').textContent,'');assert.doesNotMatch(app.get('mcp-token-list').textContent,/stale-token|Assistant/);assert.doesNotMatch(app.get('mcp-endpoint').textContent,/stale/);
});
test('account switch discards a pending create even if the old dialog was not closed yet',async()=>{
  const app=setup();await flush();await open(app);const wait=deferred();app.setHandler((url,options)=>options.method==='POST'?wait.promise:null);
  app.get('mcp-name').value='Assistant';checkboxes(app)[0].checked=true;const pending=app.get('mcp-form').emit('submit');app.window.GridBaseSession={user:{id:'2002'}};
  wait.resolve(response({token,secret:'wrong-account-secret'}));await pending;assert.equal(app.get('mcp-secret').textContent,'');assert.equal(app.get('mcp-dialog').open,false);
});
test('duplicate creates are blocked, errors stay safe, and retry does not require reopening',async()=>{
  const app=setup();await flush();await open(app);const wait=deferred();app.setHandler((url,options)=>options.method==='POST'?wait.promise:null);
  app.get('mcp-name').value='Assistant';checkboxes(app)[0].checked=true;const pending=app.get('mcp-form').emit('submit');await app.get('mcp-form').emit('submit');assert.equal(app.requests.filter(r=>r.options.method==='POST').length,1);
  wait.resolve({ok:false,json:async()=>({error:'<b>fixture failure</b>'})});await pending;assert.match(app.get('mcp-status').textContent,/fixture failure/);assert.equal(app.get('mcp-status').children.length,0);assert.equal(app.get('mcp-create').disabled,false);
});
test('discard invalidates pending responses and releases controls without redisplaying the one-time token',async()=>{
  const app=setup();await flush();await open(app);const wait=deferred();let pendingList=false;
  app.setHandler((url,options)=>options.method==='POST'?response({token,secret:'discard-fixture'}):pendingList?wait.promise:null);
  app.get('mcp-name').value='Assistant';checkboxes(app)[0].checked=true;pendingList=true;
  const pending=app.get('mcp-form').emit('submit');await flush();assert.equal(app.get('mcp-secret').textContent,'discard-fixture');
  await app.get('mcp-discard-secret').click();assert.equal(app.get('mcp-secret').textContent,'');assert.equal(app.get('mcp-create').disabled,false);
  wait.resolve(response({tokens:[{...token,name:'discarded-response'}],connections:[],endpoint:'https://old.example/mcp'}));await pending;
  assert.doesNotMatch(app.get('mcp-token-list').textContent,/discarded-response/);assert.equal(app.get('mcp-secret').textContent,'');
});
