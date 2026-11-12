const test = require('node:test');
const assert = require('node:assert/strict');
const { metadataSql, quoteIdentifier, extractTables, extractColumns } = require('../src/metadata');
test('metadata quotes each qualified identifier and rejects invalid input', () => {
  assert.equal(metadataSql('my`schema', 'test; DROP TABLE x'), 'DESCRIBE `s3tables`.`my``schema`.`test; DROP TABLE x`');
  assert.equal(metadataSql('analytics'), 'SHOW TABLES IN `s3tables`.`analytics`');
  for (const value of [undefined, '', ' ', 'a'.repeat(257), 'a\n!quit']) assert.throws(() => quoteIdentifier(value));
});
test('metadata retains more than ten tables and deduplicates DESCRIBE partition rows', () => {
  assert.equal(extractTables({ columns: ['namespace', 'tableName'], rows: Array.from({length:25}, (_,i) => ({namespace:'a',tableName:'t'+i})) }).length, 25);
  assert.deepEqual(extractColumns({ columns: ['col_name','data_type','comment'], rows: [
    {col_name:'id',data_type:'bigint'}, {col_name:'# Partition Information'},
    {col_name:'# col_name',data_type:'data_type'}, {col_name:'#id',data_type:'bigint'},
    {col_name:'',data_type:''}, {col_name:'id',data_type:'bigint'}, {col_name:'note',data_type:'string',comment:'hello'}
  ] }), [{name:'id',type:'bigint',comment:''},{name:'#id',type:'bigint',comment:''},{name:'note',type:'string',comment:'hello'}]);
});

test('metadata HTTP handler preserves the contract and rejects invalid identifiers before execution', async () => {
  const { handleMetadata } = require('../server');
  const response = () => ({ writeHead(status){this.status=status;},end(body){this.data=JSON.parse(body);} });
  let calls=0;
  const execute=async sql=>{calls++;assert.equal(sql,'SHOW TABLES IN `s3tables`.`a``b`');return {stdout:'namespace,tableName,isTemporary\na`b,users,false\na`b,events,false\n'};};
  const success=response();await handleMetadata(success,new URL('http://local/api/tables?namespace=a%60b'),execute);
  assert.equal(success.status,200);assert.deepEqual(success.data,{tables:['users','events']});
  const invalid=response();await handleMetadata(invalid,new URL('http://local/api/columns?namespace=analytics'),execute);
  assert.equal(invalid.status,422);assert.equal(calls,1);
  const failure=response();await handleMetadata(failure,new URL('http://local/api/tables?namespace=analytics'),async()=>{throw Object.assign(new Error('fixture'),{code:'TIMEOUT'});});
  assert.equal(failure.status,504);assert.equal(typeof failure.data.error,'string');
});
