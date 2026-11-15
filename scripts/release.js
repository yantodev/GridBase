'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

function command(program,args) {
  const result=spawnSync(program,args,{cwd:root,encoding:'utf8'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${program} ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function github(endpoint) {
  const result=spawnSync('gh',['api',endpoint],{cwd:root,encoding:'utf8'});
  if(result.error)throw result.error;
  if(result.status===0)return JSON.parse(result.stdout);
  if(/\(HTTP 404\)/.test(result.stderr))return null;
  throw new Error('GitHub API lookup failed: '+result.stderr.trim());
}
function semver(tag) {
  const match=/^V(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if(!match)throw new Error('Latest release must use a stable VMAJOR.MINOR.PATCH tag.');
  return match.slice(1).map(BigInt);
}
function main() {
  command(process.execPath,[path.join(root,'scripts/version.js'),'--check']);
  const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim(),tag='V'+version;
  const repo=process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if(!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo))throw new Error('GH_REPO must identify owner/repository.');
  const notesFile='docs/releases/'+tag+'.md',notes=fs.readFileSync(path.join(root,notesFile),'utf8');
  if(!notes.trim())throw new Error('Release notes must not be empty.');
  const existing=github(`repos/${repo}/releases/tags/${tag}`);
  const latest=github(`repos/${repo}/releases/latest`);
  const currentParts=semver(tag),latestParts=latest?semver(latest.tag_name):null;
  const difference=latestParts?currentParts.findIndex((part,i)=>part!==latestParts[i]):-1;
  const makeLatest=!latestParts || difference>=0 && currentParts[difference]>latestParts[difference];
  const ref='refs/tags/'+tag;
  const remote=command('git',['ls-remote','--tags','origin',ref]);
  if(remote) {
    command('git',['fetch','origin',ref+':'+ref]);
    command('git',['merge-base','--is-ancestor',tag+'^{commit}','HEAD']);
    if(command('git',['show',tag+':VERSION'])!==version)throw new Error('Existing tag version does not match VERSION.');
    if(command('git',['show',tag+':'+notesFile])!==notes.trim())throw new Error('Existing tag release notes differ; publish a new version instead.');
  } else {
    if(existing)throw new Error('Existing release has no remote tag; refusing to recreate it.');
    const local=command('git',['tag','--list',tag]);
    if(local)throw new Error('Local-only release tag exists; inspect it before retrying.');
    command('git',['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','tag','-a',tag,'-m','GridBase '+tag]);
    command('git',['push','origin',ref]);
  }
  if(!existing) {
    command('gh',['release','create',tag,'--repo',repo,'--verify-tag','--title','GridBase '+tag,'--notes-file',notesFile,makeLatest?'--latest':'--latest=false']);
  }
  const published=github(`repos/${repo}/releases/tags/${tag}`);
  if(!published || published.tag_name!==tag || published.draft!==false || published.prerelease!==false || !published.html_url)throw new Error('Release publication could not be verified.');
  if(makeLatest && github(`repos/${repo}/releases/latest`)?.tag_name!==tag)throw new Error('Latest release could not be verified.');
  console.log('Published release: '+published.html_url);
}
try {main();}catch(error){console.error(error.message);process.exitCode=1;}
