(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbenchCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEYWORDS = new Set(('SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS AND OR NOT NULL IS IN LIKE BETWEEN DISTINCT WITH UNION ALL CASE WHEN THEN ELSE END ASC DESC CREATE TABLE VIEW IF EXISTS INSERT INTO VALUES UPDATE SET DELETE MERGE USING MATCHED ALTER ADD DROP TRUNCATE SHOW DESCRIBE EXPLAIN TRUE FALSE OVER PARTITION COUNT SUM AVG MIN MAX CURRENT_DATE CURRENT_DATABASE').split(' '));
  function tokens(sql) {
    const out = [];
    for (let i=0; i<sql.length;) {
      const start=i, char=sql[i];
      let kind='symbol';
      if (sql.startsWith('--',i)) { kind='comment'; i=sql.indexOf('\n',i); if(i<0)i=sql.length; }
      else if (sql.startsWith('/*',i)) { kind='comment'; const end=sql.indexOf('*/',i+2); i=end<0?sql.length:end+2; }
      else if (char==='$' && /^\$(?:[a-zA-Z_][\w]*)?\$/.test(sql.slice(i))) {
        kind='string'; const delimiter=sql.slice(i).match(/^\$(?:[a-zA-Z_][\w]*)?\$/)[0];
        const end=sql.indexOf(delimiter,i+delimiter.length);i=end<0?sql.length:end+delimiter.length;
      }
      else if (char === "'" || char === '"' || char === '`') {
        kind=char==='`'?'identifier':'string'; i++;
        while(i<sql.length) {
          if(sql[i]==='\\' && char!=='`') {i=Math.min(sql.length,i+2);continue;}
          if(sql[i]===char) {if(sql[i+1]===char){i+=2;continue;}i++;break;} i++;
        }
      } else if (/\s/.test(char)) {kind='space'; while(i<sql.length && /\s/.test(sql[i]))i++;}
      else if (/[a-zA-Z_]/.test(char)) {kind='word';while(i<sql.length && /[\w$]/.test(sql[i]))i++;}
      else if (/\d/.test(char)) {kind='number';while(i<sql.length && /[\d.]/.test(sql[i]))i++;}
      else i++;
      out.push({kind,text:sql.slice(start,i),start,end:i});
    }
    return out;
  }
  function statementRanges(sql) {
    const out=[];let start=0,hasCode=false;
    for(const token of tokens(sql)) {
      if(token.kind!=='space' && token.kind!=='comment' && token.text!==';')hasCode=true;
      if(token.kind==='symbol' && token.text===';') {
        if(hasCode)out.push({start,end:token.end});start=token.end;hasCode=false;
      }
    }
    if(hasCode)out.push({start,end:sql.length});
    return out;
  }
  function executionSql(sql,start=0,end=start) {
    if(start!==end && sql.slice(start,end).trim())return sql.slice(start,end).trim();
    const ranges=statementRanges(sql);
    const current=ranges.find(r=>start>=r.start && start<r.end) || ranges.find(r=>r.start>=start) || ranges.at(-1);
    return current?sql.slice(current.start,current.end).trim():'';
  }
  function mutationOperations(sql) {
    const code=tokens(sql).filter(t=>t.kind!=='space' && t.kind!=='comment');
    const word=i=>code[i]?.kind==='word'?code[i].text.toUpperCase():'';
    const pairs=new Map(),stack=[],operations=new Set();
    code.forEach((t,i)=>{
      if(t.kind==='symbol' && t.text==='(')stack.push(i);
      else if(t.kind==='symbol' && t.text===')' && stack.length)pairs.set(stack.pop(),i);
    });
    function scan(start,end) {
      const command=word(start);
      if(command==='EXPLAIN') {
        let i=start+1,analyze=false;
        if(pairs.has(i)) {
          const close=pairs.get(i);
          for(let j=i+1;j<close;j++)if(/^(ANALYZE|ANALYSE)$/.test(word(j)))analyze=!/^(FALSE|OFF|0)$/i.test(code[j+1]?.text || '');
          i=close+1;
        } else {
          while(i<end && !/^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)$/.test(word(i))) {
            if(/^(ANALYZE|ANALYSE)$/.test(word(i)))analyze=true;
            i++;
          }
        }
        if(analyze)scan(i,end);
        return;
      }
      if(command==='UPDATE' || command==='DELETE')operations.add(command);
      if(command!=='WITH')return;
      let i=start+1;
      if(word(i)==='RECURSIVE')i++;
      while(i<end) {
        i++; // CTE name (possibly quoted).
        if(pairs.has(i))i=pairs.get(i)+1; // Optional column list.
        if(word(i)!=='AS')return;
        i++;
        if(word(i)==='NOT')i++;
        if(word(i)==='MATERIALIZED')i++;
        if(!pairs.has(i))return;
        const close=pairs.get(i);scan(i+1,close);i=close+1;
        // Recursive CTE decorations precede the next CTE or main command.
        if(word(i)==='SEARCH') {
          while(i<end && word(i)!=='SET')i++;
          i+=2; // SET generated_order_column.
        }
        if(word(i)==='CYCLE') {
          while(i<end && word(i)!=='USING')i++;
          i+=2; // USING generated_path_column.
        }
        if(code[i]?.text!==',')break;
        i++;
      }
      scan(i,end);
    }
    let start=0;
    for(let i=0;i<=code.length;i++)if(i===code.length || code[i].kind==='symbol' && code[i].text===';') {scan(start,i);start=i+1;}
    return [...operations];
  }
  function escapeHtml(value) {return String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function highlightSql(sql) {
    return tokens(sql).map(t=>{
      const kind=t.kind==='word' && KEYWORDS.has(t.text.toUpperCase())?'keyword':t.kind;
      const value=escapeHtml(t.text);
      return ['keyword','string','comment','number','identifier'].includes(kind)?`<span class="sql-${kind}">${value}</span>`:value;
    }).join('');
  }
  function formatSql(sql) {
    let out='',pendingSpace=false;
    const lineWords=new Set(['SELECT','FROM','WHERE','HAVING','LIMIT','UNION','JOIN','LEFT','RIGHT','INNER','OUTER','GROUP','ORDER','VALUES','SET']);
    for(const t of tokens(sql)) {
      if(t.kind==='space'){pendingSpace=true;continue;}
      const word=t.kind==='word'?t.text.toUpperCase():'';
      if(lineWords.has(word) && out.trim())out=out.trimEnd()+'\n';
      else if(pendingSpace && out && !out.endsWith('\n'))out+=' ';
      out+=t.kind==='word' && KEYWORDS.has(word)?word:t.text;
      if(t.kind==='comment' && t.text.startsWith('--'))out+='\n';
      pendingSpace=false;
    }
    return out.trim();
  }
  function quoteIdentifier(value,databaseType='hive'){
    const quote=databaseType==='postgresql'?'"':'`';
    return quote+String(value).replaceAll(quote,quote+quote)+quote;
  }
  function qualifiedTable(namespace,table,databaseType='hive'){
    const parts=databaseType==='hive'?['s3tables',namespace,table]:[namespace,table];
    return parts.map(value=>quoteIdentifier(value,databaseType)).join('.');
  }
  function tableSql(namespace,table,databaseType='hive'){return `SELECT * FROM ${qualifiedTable(namespace,table,databaseType)} LIMIT 50;`;}
  let sequence=0;
  function newTab(name='Console',sql='') {return {id:'sql-'+Date.now().toString(36)+'-'+(++sequence),name,sql};}
  function restoreDrafts(raw) {
    try {
      const data=JSON.parse(raw),seen=new Set();
      const tabs=(Array.isArray(data?.tabs)?data.tabs:[]).filter(t=>{
        if(!t || typeof t.id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(t.id) || seen.has(t.id) || typeof t.sql!=='string' || t.sql.length>20000)return false;
        seen.add(t.id);return true;
      }).slice(0,20).map(t=>({id:t.id,name:typeof t.name==='string'&&t.name.trim()?t.name.slice(0,80):'Console',sql:t.sql,
        ...(typeof t.connectionId==='string' && (t.connectionId==='' || /^[a-zA-Z0-9_-]{1,100}$/.test(t.connectionId))?{connectionId:t.connectionId}:{}),
        ...(t.source && typeof t.source.namespace==='string' && typeof t.source.table==='string'?{source:{namespace:t.source.namespace,table:t.source.table}}:{})}));
      if(tabs.length)return {tabs,activeId:tabs.some(t=>t.id===data.activeId)?data.activeId:tabs[0].id};
    }catch{/* Corrupt or unavailable storage starts a clean console. */}
    const tab=newTab('Console 1', 'SELECT CURRENT_DATE AS today;');
    return {tabs:[tab],activeId:tab.id};
  }
  function serializeDrafts(state){return JSON.stringify({activeId:state.activeId,tabs:state.tabs.map(t=>({id:t.id,name:t.name,sql:t.sql,...(typeof t.connectionId==='string'?{connectionId:t.connectionId}:{}),...(t.source?{source:t.source}:{})}))});}
  function compareValues(a,b) {
    if(a==null)return b==null?0:1;
    if(b==null)return -1;
    const av=String(a),bv=String(b),decimal=/^([+-]?)(\d+)(?:\.(\d*))?$/;
    const am=av.match(decimal),bm=bv.match(decimal);
    if(am && bm) {
      const ai=am[2].replace(/^0+/, '')||'0',bi=bm[2].replace(/^0+/, '')||'0';
      const af=(am[3]||'').replace(/0+$/, ''),bf=(bm[3]||'').replace(/0+$/, '');
      const an=am[1]==='-'&&(ai!=='0'||af!==''),bn=bm[1]==='-'&&(bi!=='0'||bf!=='');
      if(an!==bn)return an?-1:1;
      const width=Math.max(af.length,bf.length);
      const order=ai.length-bi.length || ai.localeCompare(bi) || af.padEnd(width,'0').localeCompare(bf.padEnd(width,'0'));
      return an?-order:order;
    }
    return av.localeCompare(bv,'en',{numeric:true,sensitivity:'base'});
  }
  function viewRows(result,filter='',sort=null) {
    const needle=filter.toLocaleLowerCase();
    const rows=result.rows.map((row,index)=>({row,index})).filter(({row})=>!needle || result.columns.some(c=>String(row[c]??'NULL').toLocaleLowerCase().includes(needle)));
    if(sort)rows.sort((a,b)=>{
      const av=a.row[sort.column],bv=b.row[sort.column];
      const order=compareValues(av,bv);
      return order*sort.direction || a.index-b.index;
    });
    return rows;
  }
  function formatDetailValue(value) {
    const text=value==null?'NULL':String(value),json=text.trim();
    if(!json.startsWith('{') && !json.startsWith('['))return text;
    try { JSON.parse(text); } catch { return text; }
    // Format original tokens: parsing and reserializing would round large numbers
    // and could drop duplicate keys or reorder numeric object keys.
    const parts=json.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g);
    const out=[];let depth=0;
    const newline=()=>out.push('\n','  '.repeat(depth));
    parts.forEach((part,index)=>{
      if(part==='{' || part==='[') {
        out.push(part);depth++;
        if(parts[index+1]!=='}' && parts[index+1]!==']')newline();
      } else if(part==='}' || part===']') {
        depth--;
        if(parts[index-1]!=='{' && parts[index-1]!=='[')newline();
        out.push(part);
      } else if(part===',') {out.push(part);newline();}
      else if(part===':')out.push(': ');
      else out.push(part);
    });
    return out.join('');
  }
  function toCsv(columns,rows) {
    const cell=v=>{const s=v==null?'':String(v);return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
    return [columns,...rows.map(r=>columns.map(c=>r[c]))].map(r=>r.map(cell).join(',')).join('\r\n');
  }
  return {tokens,statementRanges,executionSql,mutationOperations,escapeHtml,highlightSql,formatSql,quoteIdentifier,qualifiedTable,tableSql,newTab,restoreDrafts,serializeDrafts,viewRows,formatDetailValue,toCsv,KEYWORDS};
});
