const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/workbench-core');
test('runs only selected SQL or the statement at the caret, respecting quoted delimiters', () => {
  const sql = "-- read; safely\nSELECT 'it''s; ok', `a;b`;\nUPDATE x SET y='x'; -- tail";
  assert.match(C.executionSql(sql, 25, 25), /^-- read; safely\nSELECT/);
  assert.equal(C.executionSql(sql, sql.indexOf('UPDATE') + 2, sql.indexOf('UPDATE') + 2), "UPDATE x SET y='x';");
  assert.equal(C.executionSql(sql, sql.indexOf('UPDATE'), sql.indexOf('; --')), "UPDATE x SET y='x'");
  assert.equal(C.executionSql('SELECT 1;\n', 10, 10), 'SELECT 1;');
  assert.equal(C.executionSql('-- only a comment', 2, 2), '');
  assert.equal(C.statementRanges("SELECT /* ; */ 'a\\\';b'; SELECT 2;").length, 2);
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
