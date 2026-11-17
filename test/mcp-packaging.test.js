'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Docker prioritizes pinned MCP JSON dependencies over Sparks bundled Gson', () => {
  const docker = fs.readFileSync('Dockerfile','utf8');
  const entry = JSON.parse(docker.split('\n').find(line=>line.startsWith('ENTRYPOINT ')).slice('ENTRYPOINT '.length));
  const classpath = entry[entry.indexOf('-cp')+1].split(':');
  assert.ok(classpath.indexOf('/opt/gridbase/drivers/*') < classpath.indexOf('/opt/spark/jars/*'), 'Pinned Gson must resolve before the older Spark-bundled Gson');
});
