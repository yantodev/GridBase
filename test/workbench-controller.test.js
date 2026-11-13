// Controller integration in a small DOM simulation. This is not a rendered-browser test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../public/workbench-core');
function setup({configured=true,offline=false,storage=new Map(),connections}={}) {
  let sources=connections || (configured ? [{id:'default',name:'Spark Thrift / Hive',type:'hive'}] : []);
  let document;
  class Element {
    constructor(tag='div') {
      this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this.dataset={};this.style={setProperty(){}};
      this.className='';this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.scrollTop=0;this.scrollLeft=0;this.selectionStart=0;this.selectionEnd=0;
      this.classList={add:(name)=>this.classList.toggle(name,true),remove:(name)=>this.classList.toggle(name,false),toggle:(name,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));on??=!set.has(name);if(on)set.add(name);else set.delete(name);this.className=[...set].join(' ');return on;}};
    }
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=[...nodes];}
    contains(node){return this===node||this.children.some(n=>n.contains(node));}
    setAttribute(key,value){this.attributes[key]=String(value);if(key==='id')this.id=value;}
    getAttribute(key){return this.attributes[key];}
    addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);}
    removeEventListener(key,fn){this.listeners[key]=(this.listeners[key]||[]).filter(x=>x!==fn);}
    async emit(key,event={}){for(const fn of this.listeners[key]||[])await fn({target:this,preventDefault(){},...event});}
    click(){if(!this.disabled)return this.emit('click');}
    focus(){document.activeElement=this;}
    select(){this.setSelectionRange(0,this.value.length);this.focus();}
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}
    dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}
    querySelectorAll(selector){
      const all=this.children.flatMap(n=>[n,...n.querySelectorAll('*')]);
      return all.filter(n=>selector==='*'||selector==='[data-focus]'&&n.dataset.focus||selector.startsWith('#')&&n.id===selector.slice(1)||selector==='th button'&&n.tagName==='button'||n.tagName===selector);
    }
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    remove(){}
    getBoundingClientRect(){return {top:42,height:700};}
    setPointerCapture(){}
  }
  const nodes=new Map();
  const html=fs.readFileSync('public/index.html','utf8');
  for(const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node=new Element(match[1]);node.id=match[2];const cls=match[0].match(/class="([^"]*)"/);if(cls)node.className=cls[1];nodes.set('#'+node.id,node);
  }
  nodes.get('#run-query').append(new Element('span'));
  const workspace=new Element();nodes.set('.workbench',workspace);
  document={body:new Element('body'),activeElement:null,querySelector(selector){const found=nodes.get(selector)||[...nodes.values()].flatMap(n=>n.querySelectorAll('*')).find(n=>selector==='#'+n.id);assert.ok(found,'Unknown DOM selector: '+selector);return found;},createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag),addEventListener(){}};
  let queryResponse=null, connectResponse=null, metadataResponse=null;
  const requests=[];
  const fixture=(count=23)=>({columns:['id','name'],rows:Array.from({length:count},(_,i)=>({id:String(i+1),name:i===0?null:'row '+(i+1)})),rowCount:count,durationMs:12,truncated:false,updateCount:null});
  const context=vm.createContext({document,window:{WorkbenchCore:C,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},matchMedia:()=>({matches:false,addEventListener(){}}),clearTimeout(){},setTimeout(){},addEventListener(){},confirm:()=>true},fetch:async(url,options)=>{
    requests.push({url,options});if(offline)throw new Error('offline');
    let data;
    if(url==='/api/health')data={configured,target:'fixture.example'};
    else if(url==='/api/connections')data={connections:sources,defaultConnectionId:sources[0]?.id || null};
    else if(url==='/api/connections/connect') {
      if(connectResponse)await connectResponse;
      const payload=JSON.parse(options.body),connection={id:payload.connectionId || 'added-'+sources.length,name:payload.name,type:payload.type};
      sources=sources.filter(item=>item.id!==connection.id).concat(connection);data={ok:true,connection};
    }
    else if(url==='/api/connections/disconnect'){const {connectionId}=JSON.parse(options.body);sources=sources.filter(item=>item.id!==connectionId);data={ok:true};}
    else if(url==='/api/connections/test')data={ok:true};
    else if(url.startsWith('/api/databases'))data=metadataResponse?await metadataResponse(url):{databases:['analytics']};
    else if(url.startsWith('/api/tables'))data={tables:Array.from({length:25},(_,i)=>'table_'+i)};
    else if(url.startsWith('/api/columns'))data={columns:[{name:'id',type:'bigint',comment:''}]};
    else if(url==='/api/query')data=queryResponse?await queryResponse:fixture();
    else throw new Error('Unexpected URL '+url);
    return {ok:true,json:async()=>data};
  },Event:class {constructor(type){this.type=type;}},Blob,URL,URLSearchParams});
  vm.runInContext(fs.readFileSync('public/app.js','utf8'),context);
  return {context,nodes,storage,requests,fixture,setQuery:value=>{queryResponse=value;},setConnect:value=>{connectResponse=value;},setMetadata:value=>{metadataResponse=value;},get:id=>nodes.get('#'+id),read:code=>vm.runInContext(code,context)};
}
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(setImmediate);};
test('explorer metadata, pagination, sorting/filtering, row detail and draft restoration',async()=>{
  const app=setup();await flush();
  assert.equal(app.get('connection-label').textContent,'Connected');
  await app.context.toggleSchema('analytics');
  assert.equal(app.read("state.connections.get('default').schemaEntries.get('analytics').tables.length"),25);
  await app.context.toggleColumns('analytics','table_1');
  assert.equal(app.read("state.connections.get('default').columns.values().next().value.items[0].type"),'bigint');
  app.context.openTable('analytics','table_1');await flush();
  assert.equal(JSON.parse(app.requests.find(r=>r.url==='/api/query').options.body).sql,'SELECT * FROM `s3tables`.`analytics`.`table_1` LIMIT 50;');
  assert.equal(app.get('results-range').textContent,'1–10 of 23 rows');
  const rows=()=>app.get('results-table-wrap').children[0].children[1].children;
  assert.equal(rows().length,10);
  await app.get('results-next').click();assert.equal(app.get('results-range').textContent,'11–20 of 23 rows');
  await app.get('results-next').click();assert.equal(rows().length,3);assert.equal(app.get('results-next').disabled,true);
  await rows()[0].children[0].children[0].click();assert.equal(app.get('row-detail').open,true);
  await app.get('close-row-detail').click();assert.equal(app.get('row-detail').open,false);
  app.get('result-filter').value='NULL';await app.get('result-filter').emit('input');assert.equal(rows().length,1);assert.equal(rows()[0].children[2].textContent,'NULL');
  app.get('result-filter').value='none-match';await app.get('result-filter').emit('input');assert.equal(app.get('results-table-wrap').hidden,true);assert.match(app.get('result-state').children[1].textContent,/No matching/);
  app.get('result-filter').value='';await app.get('result-filter').emit('input');
  const firstSort=app.get('results-table-wrap').children[0].children[0].children[0].children[1].children[0];await firstSort.click();assert.equal(app.read('active().sort.column'),'id');
  app.context.persistDrafts();const draft=app.storage.get('thrift-query-workbench:drafts:v1');assert.ok(draft.includes('table_1'));assert.ok(!draft.includes('rowCount'));
  const reloaded=setup({storage:app.storage});await flush();assert.equal(reloaded.read('active().source.table'),'table_1');assert.equal(reloaded.read('active().result'),undefined);assert.equal(reloaded.get('console-context').textContent,'analytics / table_1');
});
test('in-flight results stay with their originating console and current statement selection works',async()=>{
  const app=setup();await flush();let resolve;
  app.setQuery(new Promise(r=>{resolve=r;}));
  app.get('sql-editor').value='SELECT 1;\nUPDATE fixture SET id=2;';app.get('sql-editor').setSelectionRange(17,17);
  const origin=app.read('active().id');const pending=app.context.runQuery();
  assert.equal(JSON.parse(app.requests.at(-1).options.body).sql,'UPDATE fixture SET id=2;');
  app.context.addConsole('SELECT 3;','Other');const other=app.read('active().id');
  resolve(app.fixture(4));await pending;
  assert.equal(app.read('active().id'),other);assert.equal(app.read('active().result'),undefined);assert.match(app.get('result-state').children[1].textContent,/Ready/);
  app.context.switchTab(origin);assert.equal(app.read('active().result.rows.length'),4);assert.equal(app.get('results-range').textContent,'1–4 of 4 rows');
  app.context.closeTab(origin);assert.equal(app.read('active().id'),other);assert.equal(app.get('sql-editor').value,'SELECT 3;');
});
test('zero and unknown affected counts, offline and missing configuration are distinct',async()=>{
  const app=setup();await flush();
  for(const [count,expected] of [[0,'0 rows affected.'],[null,'The server did not report an affected-row count.']]){
    app.setQuery({...app.fixture(0),columns:[],updateCount:count});await app.context.runQuery('DELETE FROM fixture WHERE id=-1');
    assert.equal(app.get('result-state').children[2].textContent,expected);assert.equal(app.get('results-pagination').hidden,true);
  }
  const offline=setup({offline:true}),missing=setup({configured:false});await flush();
  assert.equal(offline.get('connection-label').textContent,'Offline');assert.equal(offline.get('run-query').disabled,true);
  assert.equal(missing.get('connection-label').textContent,'Not configured');assert.equal(missing.get('connection-notice').hidden,false);
});

test('editor controls format, indent, rename, completion and errors work through their handlers',async()=>{
  const app=setup();await flush();const editor=app.get('sql-editor');
  editor.value="select 'from  literal' from fixture;";editor.setSelectionRange(0,0);await editor.emit('input');await app.get('format-query').click();
  assert.equal(editor.value,"SELECT 'from  literal'\nFROM fixture;");
  editor.value='SELECT 1';editor.setSelectionRange(0,8);await editor.emit('keydown',{key:'Tab',shiftKey:false});assert.equal(editor.value,'  SELECT 1');
  await editor.emit('keydown',{key:'Tab',shiftKey:true});assert.equal(editor.value,'SELECT 1');
  await app.get('rename-console').click();assert.equal(app.get('rename-dialog').open,true);app.get('console-name').value='My SQL';await app.get('rename-form').emit('submit');assert.equal(app.read('active().name'),'My SQL');
  editor.value='sel';editor.setSelectionRange(3,3);await editor.emit('keydown',{key:' ',code:'Space',ctrlKey:true});assert.equal(app.get('completion-panel').hidden,false);
  app.get('completion-select').value='SELECT';await app.get('completion-select').emit('keydown',{key:'Enter'});assert.equal(editor.value,'SELECT');
  app.setQuery(Promise.reject(new Error('synthetic failure')));await app.context.runQuery('SELECT 1');assert.equal(app.get('result-state').className,'result-state is-error');assert.match(app.get('query-output').textContent,/Execution failed/);
});

test('SQL editing has a keyboard exit and cannot create an unrestorable oversized draft',async()=>{
  const app=setup();await flush();const editor=app.get('sql-editor');
  editor.value='x'.repeat(20000);editor.setSelectionRange(20000,20000);await editor.emit('input');
  await editor.emit('keydown',{key:'Tab'});assert.equal(editor.value.length,20000);assert.equal(app.read('active().sql.length'),20000);
  await editor.emit('keydown',{key:'Enter'});assert.equal(editor.value.length,20000);
  app.context.persistDrafts();assert.equal(C.restoreDrafts(app.storage.get('thrift-query-workbench:drafts:v1')).tabs[0].sql.length,20000);
  await editor.emit('keydown',{key:'Escape'});assert.equal(app.get('format-query'),app.context.document.activeElement);
});

test('completion preserves column aliases and replaces full table qualifiers',async()=>{
  const app=setup();await flush();await app.context.toggleSchema('analytics');await app.context.toggleColumns('analytics','table_1');
  const editor=app.get('sql-editor'),select=app.get('completion-select');
  editor.value='SELECT a.i FROM a JOIN b ON a.id=b.id';editor.setSelectionRange(10,10);app.context.showCompletion();
  select.selectedIndex=select.children.findIndex(o=>o.textContent==='id');select.value='`id`';app.context.insertCompletion();
  assert.equal(editor.value,'SELECT a.`id` FROM a JOIN b ON a.id=b.id');
  editor.value='SELECT * FROM analytics.tab';editor.setSelectionRange(editor.value.length,editor.value.length);app.context.showCompletion();
  select.selectedIndex=select.children.findIndex(o=>o.textContent==='analytics.table_1');select.value=select.children[select.selectedIndex].value;app.context.insertCompletion();
  assert.equal(editor.value,'SELECT * FROM `s3tables`.`analytics`.`table_1`');
});

test('20 returned rows remain available across two ten-row result pages',async()=>{
  const app=setup();await flush();app.setQuery(app.fixture(20));
  await app.context.runQuery('SELECT id FROM fixture LIMIT 20');
  assert.equal(app.get('results-range').textContent,'1–10 of 20 rows');
  assert.equal(app.get('results-next').disabled,false);
  await app.get('results-next').click();
  assert.equal(app.get('results-range').textContent,'11–20 of 20 rows');
  assert.equal(app.get('results-next').disabled,true);
  app.setQuery(app.fixture(50));await app.context.runQuery('SELECT id FROM fixture');
  assert.equal(app.get('results-range').textContent,'1–10 of 50 rows');
  assert.equal(app.get('results-page').textContent,'1 / 5');
});

test('two data sources keep consoles, dialect, metadata, query routing and history independent',async()=>{
  const app=setup({connections:[{id:'pg',name:'Orders',type:'postgresql'},{id:'my',name:'Orders',type:'mysql'}]});await flush();
  assert.equal(app.read('state.connections.size'),2);
  await app.context.toggleSchema('analytics','pg');
  await app.context.toggleSchema('analytics','my');
  assert.ok(app.requests.some(r=>r.url.includes('/api/tables?')&&r.url.includes('connectionId=pg')));
  assert.ok(app.requests.some(r=>r.url.includes('/api/tables?')&&r.url.includes('connectionId=my')));
  app.context.openTable('analytics','table_1','pg');await flush();
  const pg=app.read('active().id');
  assert.equal(app.read('active().connectionId'),'pg');
  assert.equal(JSON.parse(app.requests.filter(r=>r.url==='/api/query').at(-1).options.body).sql,'SELECT * FROM "analytics"."table_1" LIMIT 50;');
  app.context.openTable('analytics','table_1','my');await flush();
  const my=app.read('active().id');assert.notEqual(my,pg);assert.equal(app.read('active().connectionId'),'my');
  assert.equal(JSON.parse(app.requests.filter(r=>r.url==='/api/query').at(-1).options.body).connectionId,'my');
  let resolve;app.setQuery(new Promise(r=>{resolve=r;}));
  app.context.switchTab(pg);const pending=app.context.runQuery('UPDATE orders SET id=2');
  app.context.switchTab(my);
  assert.equal(JSON.parse(app.requests.filter(r=>r.url==='/api/query').at(-1).options.body).connectionId,'pg');
  resolve(app.fixture(3));await pending;
  assert.equal(app.read('active().result.rows.length'),23);
  app.context.switchTab(pg);assert.equal(app.read('active().result.rows.length'),3);
  assert.equal(app.read('state.history[0].connectionId'),'pg');
  const restored=setup({storage:app.storage,connections:[{id:'pg',name:'Orders',type:'postgresql'},{id:'my',name:'Orders',type:'mysql'}]});await flush();
  assert.equal(restored.read('active().connectionId'),'pg');
});

test('adding from the left preserves existing consoles and saves no password or JDBC URL',async()=>{
  const app=setup();await flush();
  await app.get('add-connection').click();assert.equal(app.get('connection-dialog').open,true);
  for(const [id,value] of Object.entries({'connection-name':'Other','database-type':'hive','connection-username':'fixture','connection-password':'sensitive-value','connection-jdbc-url':'jdbc:hive2://fixture/db;password=embedded-value'}))app.get(id).value=value;
  await app.context.requestConnection('/api/connections/connect');
  assert.equal(app.read('state.connections.size'),2);
  assert.equal(app.read('state.tabs[0].connectionId'),'default');
  assert.equal(app.read('active().connectionId'),'added-1');
  const saved=app.storage.get('gridbase:connections:v1');
  assert.ok(!saved.includes('sensitive-value'));assert.ok(!saved.includes('embedded-value'));assert.ok(!saved.includes('jdbcUrl'));
  assert.equal(app.get('connection-password').value,'');
  await app.context.disconnectConnection('added-1');
  assert.equal(app.get('run-query').disabled,true);
  assert.equal(app.read("state.connections.get('default').connected"),true);
  app.context.switchTab(app.read('state.tabs[0].id'));assert.equal(app.get('run-query').disabled,false);
});

test('a restored console with a missing connection never falls back to another source',async()=>{
  const tab=C.newTab('Missing','DELETE FROM fixture');tab.connectionId='gone';
  const storage=new Map([['thrift-query-workbench:drafts:v1',C.serializeDrafts({tabs:[tab],activeId:tab.id})]]);
  const app=setup({storage});await flush();
  assert.equal(app.read('active().connectionId'),'gone');assert.equal(app.get('run-query').disabled,true);
  await app.context.runQuery();assert.equal(app.requests.filter(r=>r.url==='/api/query').length,0);
});

test('reconnect locks disconnect and duplicate submissions until completion',async()=>{
  const app=setup({connections:[{id:'pg',name:'Orders',type:'postgresql'}]});await flush();
  app.context.openConnectionManager(app.read("state.connections.get('pg')"));
  app.get('connection-password').value='fixture-secret';app.get('connection-username').value='fixture';app.get('connection-host').value='fixture';
  let finish;app.setConnect(new Promise(resolve=>{finish=resolve;}));
  const pending=app.context.requestConnection('/api/connections/connect');
  assert.equal(app.get('disconnect-connection').disabled,true);
  await app.get('disconnect-connection').click();
  await app.context.requestConnection('/api/connections/connect');
  assert.equal(app.requests.filter(r=>r.url==='/api/connections/connect').length,1);
  assert.equal(app.requests.filter(r=>r.url==='/api/connections/disconnect').length,0);
  finish();await pending;
  assert.equal(app.read('active().connectionId'),'pg');assert.equal(app.read('state.connections.size'),1);
});

test('explicitly unbound consoles remain disabled after checking the server and reloading',async()=>{
  const connections=[{id:'pg',name:'Orders',type:'postgresql'},{id:'my',name:'Orders',type:'mysql'}];
  const app=setup({connections});await flush();
  app.get('sql-editor').value='DELETE FROM orders';await app.get('sql-editor').emit('input');
  app.get('console-connection').value='my';await app.get('console-connection').emit('change');
  app.get('console-connection').value='';await app.get('console-connection').emit('change');
  await app.context.checkConnection();
  assert.equal(app.read('active().connectionId'),'');assert.equal(app.get('run-query').disabled,true);
  const reloaded=setup({connections,storage:app.storage});await flush();
  assert.equal(reloaded.read('active().connectionId'),'');assert.equal(reloaded.get('run-query').disabled,true);
  assert.equal(reloaded.get('sql-editor').value,'DELETE FROM orders');
});

test('out-of-order metadata responses cannot cross connections or replace a newer refresh',async()=>{
  const app=setup({connections:[{id:'pg',name:'Orders',type:'postgresql'},{id:'my',name:'Orders',type:'mysql'}]});await flush();
  let finish;const delayed=new Promise(resolve=>{finish=resolve;});
  app.setMetadata(url=>url.includes('connectionId=pg')?delayed:{databases:['mysql_schema']});
  const pending=app.context.refreshMetadata('pg');await app.context.refreshMetadata('my');
  app.setMetadata(()=>({databases:['new_pg_schema']}));await app.context.refreshMetadata('pg');
  finish({databases:['stale_pg_schema']});await pending;
  assert.equal(app.read("state.connections.get('pg').schemas.join(',')"),'new_pg_schema');
  assert.equal(app.read("state.connections.get('my').schemas.join(',')"),'mysql_schema');
});
