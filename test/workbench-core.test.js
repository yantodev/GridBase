const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/workbench-core');
test('row detail formats JSON objects and arrays without changing their values', () => {
  for (const [value,want] of [
    ['{"user":{"name":"Ayu","active":true},"tags":["sql","json"],"extra":null}', '{\n  "user": {\n    "name": "Ayu",\n    "active": true\n  },\n  "tags": [\n    "sql",\n    "json"\n  ],\n  "extra": null\n}'],
    [' [ {"id":1}, [], {} ] ', '[\n  {\n    "id": 1\n  },\n  [],\n  {}\n]'],
    ['{"id":9007199254740993,"price":1.2300e+40,"id":2,"2":0,"1":1}', '{\n  "id": 9007199254740993,\n  "price": 1.2300e+40,\n  "id": 2,\n  "2": 0,\n  "1": 1\n}'],
    [String.raw`{"text":"a, b: [x] {y} \"quote\" \\path\nnext","html":"<script>alert(1)</script>"}`, String.raw`{
  "text": "a, b: [x] {y} \"quote\" \\path\nnext",
  "html": "<script>alert(1)</script>"
}`],
    ['{}','{}'], ['[]','[]']
  ]) assert.equal(C.formatDetailValue(value),want);
});
test('row detail leaves invalid JSON, plain text, scalar values and SQL NULL unchanged', () => {
  for (const value of ['{"broken":}', '[1,]', '{"x":1} trailing', '  ordinary text  ', '"quoted text"', '9007199254740993', 'true', 'null', '']) {
    assert.equal(C.formatDetailValue(value),value);
  }
  assert.equal(C.formatDetailValue(null),'NULL');
  assert.equal(C.formatDetailValue(undefined),'NULL');
  assert.equal(C.formatDetailValue(42),'42');
  assert.equal(C.formatDetailValue(false),'false');
});
test('row detail does not normalize invalid JSON whitespace such as NBSP or BOM', () => {
  for (const value of ['\u00a0{"x":1}', '\ufeff[1,2]', '{"x":1}\u00a0', '[1,2]\ufeff']) {
    assert.equal(C.formatDetailValue(value),value);
  }
  assert.equal(C.formatDetailValue('\t\r\n {"x":1}\t\n'),'{\n  "x": 1\n}');
});
test('runs only selected SQL or the statement at the caret, respecting quoted delimiters', () => {
  const sql = "-- read; safely\nSELECT 'it''s; ok', `a;b`;\nUPDATE x SET y='x'; -- tail";
  assert.match(C.executionSql(sql, 25, 25), /^-- read; safely\nSELECT/);
  assert.equal(C.executionSql(sql, sql.indexOf('UPDATE') + 2, sql.indexOf('UPDATE') + 2), "UPDATE x SET y='x';");
  assert.equal(C.executionSql(sql, sql.indexOf('UPDATE'), sql.indexOf('; --')), "UPDATE x SET y='x'");
  assert.equal(C.executionSql('SELECT 1;\n', 10, 10), 'SELECT 1;');
  assert.equal(C.executionSql('-- only a comment', 2, 2), '');
  assert.equal(C.statementRanges("SELECT /* ; */ 'a\\\';b'; SELECT 2;").length, 2);
});
test('mutation detection handles comments, CTEs and multiple selected statements', () => {
  for(const [sql,want] of [
    ['update fixture set id=2',['UPDATE']],
    ['-- DELETE is a comment\n/* UPDATE */ DeLeTe FROM fixture',['DELETE']],
    ["SELECT 'DELETE', 'UPDATE', `update`, \"delete\" FROM fixture",[]],
    ['SELECT * FROM fixture FOR UPDATE',[]],
    ['SELECT * FROM fixture FOR NO KEY UPDATE',[]],
    ['WITH chosen AS (SELECT 1) UPDATE fixture SET id=2',['UPDATE']],
    ['WITH RECURSIVE chosen(id) AS (SELECT 1) DELETE FROM fixture',['DELETE']],
    ['WITH changed AS (UPDATE fixture SET id=2 RETURNING *) SELECT * FROM changed',['UPDATE']],
    ['WITH changed AS NOT MATERIALIZED (DELETE FROM fixture RETURNING *) SELECT * FROM changed',['DELETE']],
    ['WITH a AS (SELECT 1), b AS (WITH c AS (DELETE FROM fixture RETURNING *) SELECT * FROM c) UPDATE fixture SET id=2',['DELETE','UPDATE']],
    ["WITH a AS (SELECT 'UPDATE') SELECT * FROM a FOR UPDATE",[]],
    ['SELECT 1; UPDATE fixture SET id=2; DELETE FROM fixture; UPDATE fixture SET id=3;',['UPDATE','DELETE']],
    ['EXPLAIN UPDATE fixture SET id=2',[]],
    ['EXPLAIN ANALYZE DELETE FROM fixture',['DELETE']],
    ['EXPLAIN (ANALYZE false) DELETE FROM fixture',[]],
    ['EXPLAIN (ANALYZE true, BUFFERS) UPDATE fixture SET id=2',['UPDATE']]
  ]) assert.deepEqual(C.mutationOperations(sql),want,sql);
});

test('dollar-quoted literals cannot hide a following mutation or split a statement', () => {
  const sql='WITH c AS (SELECT $$($$) DELETE FROM fixture;';
  assert.deepEqual(C.mutationOperations(sql),['DELETE']);
  assert.deepEqual(C.mutationOperations('WITH c AS (SELECT $tag$(; UPDATE$tag$) UPDATE fixture SET id=2;'),['UPDATE']);
  assert.deepEqual(C.mutationOperations('SELECT $$DELETE FROM fixture; UPDATE fixture SET id=2$$;'),[]);
  assert.equal(C.executionSql('SELECT $tag$a;b$tag$; DELETE FROM fixture;',10,10),'SELECT $tag$a;b$tag$;');
});

test('recursive CTE SEARCH and CYCLE clauses cannot hide main or later CTE mutations', () => {
  for(const [sql,want] of [
    ['WITH RECURSIVE c(id) AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ordering DELETE FROM fixture WHERE id IN (SELECT id FROM c);',['DELETE']],
    ['WITH RECURSIVE c(id) AS (SELECT 1) CYCLE id SET is_cycle USING path UPDATE fixture SET id=2;',['UPDATE']],
    ["WITH RECURSIVE c(id) AS (SELECT 1) SEARCH BREADTH FIRST BY id SET ordering CYCLE id SET is_cycle TO 'Y' DEFAULT 'N' USING path, d AS (DELETE FROM fixture RETURNING *) SELECT * FROM d;",['DELETE']],
    ['WITH RECURSIVE c(id) AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ordering CYCLE id SET is_cycle USING path SELECT * FROM c FOR UPDATE;',[]]
  ]) assert.deepEqual(C.mutationOperations(sql),want,sql);
});

test('EXPLAIN ANALYSE confirms executing mutations but not disabled analysis', () => {
  assert.deepEqual(C.mutationOperations('EXPLAIN ANALYSE DELETE FROM fixture;'),['DELETE']);
  assert.deepEqual(C.mutationOperations('EXPLAIN (ANALYSE, BUFFERS) UPDATE fixture SET id=2;'),['UPDATE']);
  assert.deepEqual(C.mutationOperations('EXPLAIN (ANALYSE false) DELETE FROM fixture;'),[]);
});

test('formatting and highlighting preserve literals, comments, and untrusted values', () => {
  const sql = "select 'from  x; <script>', `select` from x where a = 'it''s ok' -- select  x\nlimit 10;";
  const formatted = C.formatSql(sql);
  assert.ok(formatted.includes("'from  x; <script>'"));
  assert.ok(formatted.includes("'it''s ok'"));
  assert.ok(formatted.includes('-- select  x\n'));
  assert.ok(formatted.includes('FROM x'));
  const highlighted = C.highlightSql(sql);
  assert.ok(highlighted.includes('&lt;script&gt;'));
  assert.ok(!highlighted.includes('<script>'));
  assert.equal(C.tableSql('a`b','t'), 'SELECT * FROM `s3tables`.`a``b`.`t` LIMIT 50;');
});
test('draft restoration rejects corrupt storage and never restores results', () => {
  assert.equal(C.restoreDrafts('broken').tabs.length, 1);
  const restored = C.restoreDrafts(JSON.stringify({activeId:'a',tabs:[{id:'a',name:'Console',sql:'SELECT 2',result:{rows:['secret']}}]}));
  assert.equal(restored.tabs[0].sql,'SELECT 2');
  assert.equal(restored.tabs[0].result, undefined);
  assert.ok(!C.serializeDrafts(restored).includes('secret'));
  assert.equal(C.restoreDrafts(JSON.stringify({tabs:[{id:'a',sql:'x'},{id:'a',sql:'y'}]})).tabs.length,1);
  assert.notEqual(C.restoreDrafts(JSON.stringify({tabs:[{id:'invalid:selector',sql:'x'}]})).tabs[0].id,'invalid:selector');
});
test('local filter and stable sort preserve source rows, CSV escapes commas and newlines', () => {
  const rows=[{id:'10',name:'A, B'},{id:'2',name:null},{id:'2',name:'line\nbreak'}];
  assert.deepEqual(C.viewRows({rows,columns:['id','name']},'',{column:'id',direction:1}).map(x=>x.index),[1,2,0]);
  assert.equal(C.viewRows({rows,columns:['id','name']},'null',null).length,1);
  assert.deepEqual(rows.map(x=>x.id),['10','2','2']);
  assert.equal(C.toCsv(['id','name'],rows), 'id,name\r\n10,"A, B"\r\n2,\r\n2,"line\nbreak"');
});

test('numeric grid sorting handles negative decimals and large integer identifiers exactly', () => {
  const values=['9007199254740993','1.2','-2','1.12','-10','9007199254740992'];
  const result={columns:['id'],rows:values.map(id=>({id}))};
  assert.deepEqual(C.viewRows(result,'',{column:'id',direction:1}).map(x=>x.row.id),['-10','-2','1.12','1.2','9007199254740992','9007199254740993']);
});
