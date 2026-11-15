const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function fixture(run) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gridbase-release-'));
  const root=path.join(directory,'work'),remote=path.join(directory,'origin.git'),stateFile=path.join(directory,'github.json');
  fs.mkdirSync(root);fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'docs/releases'),{recursive:true});
  fs.mkdirSync(path.join(directory,'bin'));
  const git=(...args)=>{
    const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  try {
    git('init','--bare',remote);git('init','-b','master');git('config','user.name','Release Fixture');git('config','user.email','fixture@example.invalid');git('remote','add','origin',remote);
    for(const name of ['version.js','release.js']) {
      const source=path.resolve(__dirname,'../scripts',name);
      if(fs.existsSync(source))fs.copyFileSync(source,path.join(root,'scripts',name));
    }
    fs.writeFileSync(path.join(root,'VERSION'),'1.2.0\n');
    fs.writeFileSync(path.join(root,'package.json'),'{"name":"fixture","version":"1.2.0"}\n');
    fs.writeFileSync(path.join(root,'openapi.yaml'),'openapi: 3.0.3\ninfo:\n  version: 1.2.0\npaths: {}\n');
    const notes='# GridBase V1.2.0\n\nSQL audit and mutation confirmation.\n';
    fs.writeFileSync(path.join(root,'docs/releases/V1.2.0.md'),notes);
    git('add','.');git('commit','-m','feat: fixture release');git('push','origin','master');
    fs.writeFileSync(stateFile,JSON.stringify({releases:{},latest:null,calls:[]}));
    // Only GitHub's remote boundary is replaced; Git tag creation/push uses a real bare repository.
    fs.writeFileSync(path.join(directory,'bin/gh'),`#!/usr/bin/env node
const fs=require('node:fs');
const file=process.env.RELEASE_FIXTURE_STATE,state=JSON.parse(fs.readFileSync(file,'utf8')),args=process.argv.slice(2);
state.calls.push(args);fs.writeFileSync(file,JSON.stringify(state));
function output(data){process.stdout.write(JSON.stringify(data));}
function absent(){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
if(args[0]==='api') {
  if(state.failLookup){process.stderr.write('network unavailable');process.exit(1);}
  const endpoint=args[1];
  if(endpoint.endsWith('/releases/latest')){if(!state.latest)absent();output(state.releases[state.latest]);}
  else {const tag=endpoint.split('/').at(-1);if(!state.releases[tag])absent();output(state.releases[tag]);}
} else if(args[0]==='release'&&args[1]==='create') {
  const tag=args[2],value=key=>args[args.indexOf(key)+1];
  if(!args.includes('--verify-tag')||!args.includes('--repo')||args.includes('--draft')||args.includes('--prerelease'))process.exit(2);
  if(state.releases[tag])process.exit(3);
  state.releases[tag]={tag_name:tag,name:value('--title'),body:fs.readFileSync(value('--notes-file'),'utf8'),draft:false,prerelease:false,html_url:'https://github.com/fixture/repo/releases/tag/'+tag};
  if(args.includes('--latest'))state.latest=tag;
  fs.writeFileSync(file,JSON.stringify(state));output(state.releases[tag]);
} else process.exit(4);
`,{mode:0o755});
    const state=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
    const save=value=>fs.writeFileSync(stateFile,JSON.stringify(value));
    const command=()=>spawnSync(process.execPath,[path.join(root,'scripts/release.js')],{cwd:root,encoding:'utf8',env:{...process.env,GH_REPO:'fixture/repo',PATH:path.join(directory,'bin')+path.delimiter+process.env.PATH,RELEASE_FIXTURE_STATE:stateFile}});
    run({root,remote,git,notes,state,save,command});
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}

test('release publisher creates an annotated tag and published latest release, then reruns without duplication',()=>{
  fixture(({command,git,state,notes})=>{
    const result=command();assert.equal(result.status,0,result.stderr);
    assert.equal(git('cat-file','-t','V1.2.0'),'tag');
    assert.equal(git('ls-remote','origin','refs/tags/V1.2.0^{}').split(/\s/)[0],git('rev-parse','HEAD'));
    assert.equal(state().releases['V1.2.0'].body,notes);assert.equal(state().latest,'V1.2.0');
    assert.match(result.stdout,/https:\/\/github.com\/fixture\/repo\/releases\/tag\/V1.2.0/);
    const tag=git('rev-parse','V1.2.0');assert.equal(command().status,0);assert.equal(git('rev-parse','V1.2.0'),tag);
    assert.equal(state().calls.filter(args=>args[0]==='release'&&args[1]==='create').length,1);
  });
});

test('release publisher fills a missing release for an existing ancestor tag without moving it',()=>{
  fixture(({command,git,root,state})=>{
    git('tag','-a','V1.2.0','-m','existing release');git('push','origin','V1.2.0');const tag=git('rev-parse','V1.2.0');
    fs.writeFileSync(path.join(root,'automation.txt'),'release workflow\n');git('add','.');git('commit','-m','ci: automate releases');
    const result=command();assert.equal(result.status,0,result.stderr);assert.equal(git('rev-parse','V1.2.0'),tag);
    assert.equal(state().releases['V1.2.0'].draft,false);
  });
});

test('release publisher rejects a version-mismatched existing tag without publishing or moving it',()=>{
  fixture(({command,git,root,state})=>{
    fs.writeFileSync(path.join(root,'VERSION'),'1.1.0\n');git('add','.');git('commit','-m','old version');
    git('tag','-a','V1.2.0','-m','wrong target');git('push','origin','V1.2.0');const tag=git('rev-parse','V1.2.0');
    fs.writeFileSync(path.join(root,'VERSION'),'1.2.0\n');git('add','.');git('commit','-m','restore version');
    const result=command();assert.notEqual(result.status,0);assert.match(result.stderr,/tag.*version|version.*tag/i);
    assert.equal(git('rev-parse','V1.2.0'),tag);assert.deepEqual(state().releases,{});
  });
});

for(const failure of ['missing notes','version drift','API unavailable'])test('release publisher fails closed on '+failure,()=>{
  fixture(({command,git,root,state,save})=>{
    if(failure==='missing notes')fs.unlinkSync(path.join(root,'docs/releases/V1.2.0.md'));
    if(failure==='version drift')fs.writeFileSync(path.join(root,'package.json'),'{"version":"1.1.0"}\n');
    if(failure==='API unavailable'){const data=state();data.failLookup=true;save(data);}
    const result=command();assert.notEqual(result.status,0);assert.deepEqual(state().releases,{});
    assert.match(result.stderr,failure==='missing notes'?/ENOENT.*V1\.2\.0\.md/:failure==='version drift'?/tidak sinkron/:/GitHub API lookup failed/);
    assert.equal(git('ls-remote','origin','refs/tags/V1.2.0'),'');
  });
});

test('publishing an older version does not replace a newer latest release',()=>{
  fixture(({command,state,save})=>{
    const data=state();data.latest='V2.0.0';data.releases['V2.0.0']={tag_name:'V2.0.0',draft:false,prerelease:false};save(data);
    const result=command();assert.equal(result.status,0,result.stderr);assert.equal(state().latest,'V2.0.0');
    assert.ok(state().calls.find(args=>args[0]==='release'&&args[1]==='create').includes('--latest=false'));
  });
});
