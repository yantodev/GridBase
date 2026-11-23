'use strict';
// Synthetic JDBC for real Java host tests and the genuine Electron workflow.
// No network sockets/database services, production data or driver override.
const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {realBundle}=require('../../packages/local-engine/test/java-fixture.cjs');const {writeManifest}=require('../../packages/local-engine/test/fixture.cjs');
async function makeWorkflowBundle(t){
  const f=await realBundle(t);const source=path.join(f.root,'Driver.java');
  await fs.writeFile(source,`package org.postgresql;
import java.sql.*;import java.lang.reflect.*;import java.util.*;
public final class Driver implements java.sql.Driver {
 static {try {DriverManager.registerDriver(new Driver());}catch(Exception e){throw new ExceptionInInitializerError(e);}}
 static Object proxy(Class<?> type,InvocationHandler h){return Proxy.newProxyInstance(Driver.class.getClassLoader(),new Class[]{type},h);}
 static Object empty(Class<?> type){if(!type.isPrimitive())return null;if(type==boolean.class)return false;if(type==int.class)return 0;if(type==long.class)return 0L;return null;}
 static ResultSet rows(String[] columns,String[][] values){int[] i={-1};return (ResultSet)proxy(ResultSet.class,(p,m,a)->switch(m.getName()){
  case "next" -> ++i[0]<values.length;
  case "getString" -> {int c=a[0] instanceof Integer?(Integer)a[0]-1:Arrays.asList(columns).indexOf((String)a[0]);yield c<0?null:values[i[0]][c];}
  case "getMetaData" -> proxy(ResultSetMetaData.class,(x,n,b)->switch(n.getName()){case "getColumnCount"->columns.length;case "getColumnLabel","getColumnName"->columns[(Integer)b[0]-1];default->empty(n.getReturnType());});
  default -> empty(m.getReturnType());});}
 public Connection connect(String u,Properties properties){if(!acceptsURL(u))return null;return (Connection)proxy(Connection.class,(p,m,a)->switch(m.getName()){
  case "isValid" -> true;case "getCatalog"->"fixture";
  case "getMetaData"->proxy(DatabaseMetaData.class,(x,n,b)->switch(n.getName()){
   case "getSearchStringEscape"->"\\\\";
   case "getSchemas"->rows(new String[]{"TABLE_SCHEM"},new String[][]{{"fixture"}});
   case "getTables"->rows(new String[]{"TABLE_NAME"},new String[][]{{"items"}});
   case "getColumns"->rows(new String[]{"COLUMN_NAME","TYPE_NAME","REMARKS"},new String[][]{{"payload","json","<b>inert</b>"}});
   default->empty(n.getReturnType());});
  case "createStatement"->proxy(Statement.class,new InvocationHandler(){ResultSet result;public Object invoke(Object s,Method n,Object[] b)throws Throwable{return switch(n.getName()){
   case "execute"->{String sql=(String)b[0];var dir=java.nio.file.Path.of(System.getenv("HOME"));java.nio.file.Files.writeString(dir.resolve("jdbc-writes"),sql+"\\n",java.nio.file.StandardOpenOption.CREATE,java.nio.file.StandardOpenOption.APPEND);
    boolean select=sql.stripLeading().toUpperCase().startsWith("SELECT");result=rows(new String[]{"payload"},new String[][]{{"{\\"id\\":9007199254740993,\\"html\\":\\"<img src=x onerror=window.injected=true>\\"}"}});yield select;}
   case "getResultSet"->result;case "getUpdateCount"->1;default->empty(n.getReturnType());};}});
  default->empty(m.getReturnType());});}
 public boolean acceptsURL(String u){return u.startsWith("jdbc:postgresql:");}public DriverPropertyInfo[] getPropertyInfo(String u,Properties p){return new DriverPropertyInfo[0];}
 public int getMajorVersion(){return 1;}public int getMinorVersion(){return 0;}public boolean jdbcCompliant(){return false;}public java.util.logging.Logger getParentLogger(){return java.util.logging.Logger.getGlobal();}
}`);
  const java=path.join(process.env.JAVA_HOME||'/usr/lib/jvm/java-17-openjdk-amd64','bin/javac');
  const compiled=spawnSync(java,['--release','17','-d',path.join(f.bundleDir,'classes'),source],{env:{LANG:'C.UTF-8'},encoding:'utf8',timeout:15000});
  if(compiled.status!==0)throw new Error('Synthetic JDBC compilation failed: '+compiled.stderr);
  await writeManifest(f.bundleDir,'jre/bin/java',['classes','lib/gson.jar','lib/jsqlparser.jar','lib/sqlite-jdbc.jar','lib/slf4j.jar']);return f;
}
module.exports={makeWorkflowBundle};
