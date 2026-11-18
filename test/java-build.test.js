'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn,spawnSync} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gridbase-java-build-'));
  const source=path.join(root,'java-service/src/com/peentar/thriftquery/ThriftQueryServer.java');
  fs.mkdirSync(path.dirname(source),{recursive:true});
  fs.mkdirSync(path.join(root,'spark/jars'),{recursive:true});
  fs.mkdirSync(path.join(root,'build/deps'),{recursive:true});
  fs.copyFileSync(path.resolve('run-java.sh'),path.join(root,'run-java.sh'));
  for(const name of ['ensure-mcp-deps.sh','ensure-sqlite-driver.sh'])fs.writeFileSync(path.join(root,name),'#!/bin/bash\nprintf "%s\\n" "$(dirname "$0")/build/deps"\n');
  fs.writeFileSync(source,`package com.peentar.thriftquery;
import java.io.*;
public class ThriftQueryServer {
  public static void main(String[] args) throws Exception {
    if (args.length > 0 && args[0].equals("hold")) {
      System.out.println("READY");
      new BufferedReader(new InputStreamReader(System.in)).readLine();
      System.out.println("COLUMN=" + Column.name());
    } else {
      try (var in = new DataInputStream(ThriftQueryServer.class.getResourceAsStream("ThriftQueryServer.class"))) {
        in.readInt(); in.readUnsignedShort();
        System.out.println("MAJOR=" + in.readUnsignedShort());
      }
      System.out.println("BUILD=" + ThriftQueryServer.class.getProtectionDomain().getCodeSource().getLocation().toURI().getPath());
    }
  }
  static class Column { static String name() { return "original"; } }
}
`);
  const env={...process.env,SPARK_HOME:path.join(root,'spark')};
  return {root,source,env,run:()=>spawnSync('bash',[path.join(root,'run-java.sh'),'--check'],{cwd:root,env,encoding:'utf8',timeout:30000}),clean:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('Java test runner establishes its root when invoked outside the repository',()=>{
  const f=fixture();
  try {
    fs.copyFileSync(path.resolve('test-java.sh'),path.join(f.root,'test-java.sh'));
    fs.writeFileSync(path.join(f.root,'spark/jars/hive-jdbc-2.3.9.jar'),'fixture');
    const bin=path.join(f.root,'fake-jdk/bin');fs.mkdirSync(bin,{recursive:true});
    // Only runner scheduling is synthetic here. The actual full Java suite still
    // executes ConnectionStoreKeyRaceTest and its controlled real child JVMs.
    for(const name of ['java','javac']) {
      fs.writeFileSync(path.join(bin,name),'#!/bin/bash\n[[ "$PWD" == "$EXPECTED_TEST_ROOT" ]] || { printf "runner cwd mismatch\\n" >&2; exit 42; }\n',{mode:0o755});
    }
    const outside=path.join(f.root,'outside cwd');fs.mkdirSync(outside);
    const result=spawnSync('bash',[path.join(f.root,'test-java.sh')],{cwd:outside,
      env:{...f.env,JAVA_HOME:path.join(f.root,'fake-jdk'),EXPECTED_TEST_ROOT:f.root},encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
  } finally { f.clean(); }
});

test('native build emits Java 17 bytecode even with a newer default compiler',()=>{
  const f=fixture();
  try {
    const result=f.run();
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/MAJOR=61\b/,'Service classes must load on Java 17');
  } finally { f.clean(); }
});

test('configuration checks never overwrite or populate the deployed class directory',()=>{
  const f=fixture();
  try {
    const deployed=path.join(f.root,'build/java');fs.mkdirSync(deployed,{recursive:true});
    fs.writeFileSync(path.join(deployed,'sentinel.class'),'running-bytecode');
    const result=f.run();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readdirSync(deployed),['sentinel.class']);
    assert.equal(fs.readFileSync(path.join(deployed,'sentinel.class'),'utf8'),'running-bytecode');
    const build=result.stdout.match(/^BUILD=(.+)$/m)[1];
    assert.notEqual(path.resolve(build),deployed);
    assert.equal(fs.existsSync(build),false,'Temporary check builds must be cleaned up');
  } finally { f.clean(); }
});

test('a running service can lazily load its original column class after another build',async()=>{
  const f=fixture();
  const child=spawn('bash',[path.join(f.root,'run-java.sh'),'hold'],{cwd:f.root,env:f.env,stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
  const lines=readline.createInterface({input:child.stdout});
  const done=once(child,'close');
  const ready=Promise.race([
    once(lines,'line',{signal:AbortSignal.timeout(30000)}),
    done.then(()=>{throw new Error('Service exited before readiness: '+errors);})
  ]);
  try {
    const [line]=await ready;assert.equal(line,'READY',errors);
    fs.writeFileSync(f.source,fs.readFileSync(f.source,'utf8').replace('return "original"','return "replacement"'));
    const check=f.run();assert.equal(check.status,0,check.stderr);
    child.stdin.end('\n');
    const [status]=await done;assert.equal(status,0,errors);
    assert.match(output,/COLUMN=original\b/,'A check must not replace classes used by a running service');
  } finally { lines.close();child.kill();f.clean(); }
});
