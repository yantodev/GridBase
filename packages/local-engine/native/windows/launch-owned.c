/* Nonprivileged Windows owned launcher. Sole unnamed job handle stays here;
 * Java inherits job ASSOCIATION, never the job/host/control HANDLEs. */
#include "policy.h"
#include "launch-json.h"
#include <stdio.h>
#define START_MS 30000
#define GRACE_MS 5000
#define LINE_MAXIMUM 65536
#define COMMAND_MAX 32767
#define CP_MAX 1024
typedef struct { wchar_t java[GB_PATH],resources[GB_PATH],data[GB_PATH],temp[GB_PATH];wchar_t **classpath;size_t count; } configuration;
typedef struct { HANDLE job,host,stop,input_event,input_consumed,input_thread,eof_event,java_process;CRITICAL_SECTION lock;unsigned char *line;DWORD line_size;int eof,bad,queued;volatile LONG input_phase,ready,forced;ULONGLONG deadline;HANDLE java_input,java_output,java_error;DWORD java_pid; } lifetime;
static lifetime state;
static int write_all(HANDLE h,const void *bytes,DWORD n){const unsigned char *b=bytes;DWORD total=0;while(total<n){DWORD got=0;if(!WriteFile(h,b+total,n-total,&got,NULL)||!got)return 0;total+=got;}return 1;}
static void fatal(void){TerminateJobObject(state.job,7);ExitProcess(7);}
static DWORD WINAPI input_reader(void *unused){(void)unused;unsigned char *line=calloc(1,LINE_MAXIMUM);if(!line)fatal();DWORD count=0;unsigned stage=0;
 for(;;){unsigned char c;DWORD n=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),&c,1,&n,NULL)||!n){EnterCriticalSection(&state.lock);state.eof=1;if(count)state.bad=1;LeaveCriticalSection(&state.lock);if(count)fatal();SetEvent(state.eof_event);SetEvent(state.input_event);break;}
  DWORD max=stage==1?65536:stage==3?8192:256;
  if(stage>=4||count>=max){SecureZeroMemory(line,LINE_MAXIMUM);free(line);fatal();}line[count++]=c;
  if(c==10){EnterCriticalSection(&state.lock);if(state.queued){LeaveCriticalSection(&state.lock);SecureZeroMemory(line,LINE_MAXIMUM);free(line);fatal();}state.line=line;state.line_size=count;state.queued=1;ResetEvent(state.input_consumed);LeaveCriticalSection(&state.lock);SetEvent(state.input_event);
   if(WaitForSingleObject(state.input_consumed,INFINITE)!=WAIT_OBJECT_0)fatal();
   line=calloc(1,LINE_MAXIMUM);if(!line)fatal();count=0;stage++;
  }
 }
 SecureZeroMemory(line,LINE_MAXIMUM);free(line);return 0;
}
static int take_line(unsigned char **out,DWORD *size){
 for(;;){EnterCriticalSection(&state.lock);if(state.bad){LeaveCriticalSection(&state.lock);return 0;}if(state.queued){*out=state.line;*size=state.line_size;state.line=NULL;state.queued=0;if(!state.eof)ResetEvent(state.input_event);LeaveCriticalSection(&state.lock);return 1;}int eof=state.eof;ResetEvent(state.input_event);LeaveCriticalSection(&state.lock);if(eof)return 0;
  ULONGLONG now=GetTickCount64();if(now>=state.deadline)return 0;HANDLE handles[2]={state.input_event,state.host};DWORD n=state.host?2:1;DWORD wait=WaitForMultipleObjects(n,handles,FALSE,(DWORD)(state.deadline-now));if(wait!=WAIT_OBJECT_0)return 0;
 }
}
static DWORD WINAPI host_watchdog(void *unused){(void)unused;HANDLE handles[3]={state.host,state.stop,state.eof_event};
 for(;;){DWORD timeout=INFINITE;if(!InterlockedCompareExchange(&state.ready,0,0)){ULONGLONG now=GetTickCount64();if(now>=state.deadline)fatal();timeout=(DWORD)(state.deadline-now);}
  DWORD wait=WaitForMultipleObjects(3,handles,FALSE,timeout);if(wait==WAIT_OBJECT_0+1)return 0;
  if(wait==WAIT_OBJECT_0+2){
   /* Grace/termination remains live even while the main thread is blocked in
    * a Java pipe write. The hProcess is retained until this watchdog joins. */
   if(InterlockedCompareExchange(&state.input_phase,0,0)<4||!state.java_process)fatal();
   HANDLE closing[3]={state.host,state.stop,state.java_process};DWORD end=WaitForMultipleObjects(3,closing,FALSE,GRACE_MS);
   if(end==WAIT_OBJECT_0){fatal();}if(end==WAIT_OBJECT_0+1)return 0;
   if(end==WAIT_OBJECT_0+2){if(WaitForMultipleObjects(2,handles,FALSE,INFINITE)!=WAIT_OBJECT_0+1){fatal();}return 0;}
   if(end!=WAIT_TIMEOUT){fatal();}InterlockedExchange(&state.forced,1);
   if(!TerminateProcess(state.java_process,7)&&WaitForSingleObject(state.java_process,0)!=WAIT_OBJECT_0)fatal();
   HANDLE final[2]={state.host,state.java_process};end=WaitForMultipleObjects(2,final,FALSE,INFINITE);if(end!=WAIT_OBJECT_0+1)fatal();
   if(WaitForMultipleObjects(2,handles,FALSE,INFINITE)!=WAIT_OBJECT_0+1){fatal();}return 0;
  }
  if(wait==WAIT_TIMEOUT&&InterlockedCompareExchange(&state.ready,0,0)){continue;}fatal();
 }
}
static int host_alive(void){return state.host&&WaitForSingleObject(state.host,0)==WAIT_TIMEOUT;}
static int wide(const char *s,wchar_t out[GB_PATH]){int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,out,GB_PATH);return n>0&&gb_path_valid(out,0);}
static int parse_configuration(const unsigned char *bytes,DWORD size,configuration *c){
 lj j={bytes,size,0,0};const char *keys[]={"event","protocol","java","resources","classpath","dataDir","tempDir"};unsigned seen=0;char text[16385];uint32_t protocol=0;
 if(!lj_char(&j,'{'))return 0;
 do{int k=lj_key(&j,keys,7,&seen);if(k<0)return 0;
  if(k==1){protocol=lj_number(&j);continue;}
  if(k==4){if(!lj_char(&j,'['))return 0;do{if(c->count==CP_MAX||!lj_string(&j,text,sizeof text))return 0;wchar_t path[GB_PATH];if(!wide(text,path)||wcschr(path,L';'))return 0;c->classpath[c->count]=_wcsdup(path);if(!c->classpath[c->count++])return 0;}while(lj_more(&j));if(!lj_char(&j,']'))return 0;continue;}
  if(!lj_string(&j,text,sizeof text))return 0;
  if(k==0){if(strcmp(text,"LaunchOwned"))return 0;}
  else if(!wide(text,k==2?c->java:k==3?c->resources:k==5?c->data:c->temp))return 0;
 }while(lj_more(&j));
 if(!lj_end(&j)||seen!=127||protocol!=1||!c->count)return 0;
 if(!_wcsicmp(c->data,c->temp)||!_wcsicmp(c->java,c->data)||!_wcsicmp(c->java,c->temp))return 0;
 return 1;
}
static int token32(const char *s){if(strlen(s)!=43)return 0;for(unsigned i=0;i<43;i++)if(!strchr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",s[i]))return 0;return strchr("AEIMQUYcgkosw048",s[42])!=NULL;}
static int bootstrap_valid(const unsigned char *bytes,DWORD size){lj j={bytes,size,0,0};const char *keys[]={"protocol","capability","credentialKey","clientKind"};unsigned seen=0;char text[128];uint32_t protocol=0;if(!lj_char(&j,'{'))return 0;
 do{int k=lj_key(&j,keys,4,&seen);if(k<0)return 0;if(k==0){protocol=lj_number(&j);continue;}if(!lj_string(&j,text,sizeof text))return 0;if(k==3){if(strcmp(text,"desktop")&&strcmp(text,"vscode"))return 0;}else if(!token32(text))return 0;SecureZeroMemory(text,sizeof text);}while(lj_more(&j));return lj_end(&j)&&seen==15&&protocol==1;
}
/* Microsoft CRT argv quoting, including backslashes before quotes/end. */
static int append(wchar_t *out,size_t *used,const wchar_t *s,size_t n){if(n>COMMAND_MAX-1-*used)return 0;wmemcpy(out+*used,s,n);*used+=n;out[*used]=0;return 1;}
static int quote(wchar_t *out,size_t *used,const wchar_t *arg){if(*used&&!append(out,used,L" ",1))return 0;if(!append(out,used,L"\"",1))return 0;
 const wchar_t *p=arg;for(;;){size_t slashes=0;while(*p==L'\\'){slashes++;p++;}size_t times=(*p==L'"'||!*p)?slashes*2:slashes;for(size_t i=0;i<times;i++)if(!append(out,used,L"\\",1))return 0;if(!*p)break;if(*p==L'"'&&!append(out,used,L"\\",1))return 0;if(!append(out,used,p++,1))return 0;}return append(out,used,L"\"",1);
}
static wchar_t *command_line(const configuration *c){wchar_t *cmd=calloc(COMMAND_MAX,sizeof(wchar_t)),*classpath=calloc(COMMAND_MAX,sizeof(wchar_t));if(!cmd||!classpath){free(cmd);free(classpath);return NULL;}size_t cp=0,used=0;
 for(size_t i=0;i<c->count;i++){if((i&&!append(classpath,&cp,L";",1))||!append(classpath,&cp,c->classpath[i],wcslen(c->classpath[i])))goto fail;}
 wchar_t temp[GB_PATH+64],sqlite[GB_PATH+64];wcscpy(temp,L"-Djava.io.tmpdir=");wcscat(temp,c->temp);wcscpy(sqlite,L"-Dorg.sqlite.tmpdir=");wcscat(sqlite,c->temp);
 const wchar_t *args[]={c->java,L"--add-modules",L"jdk.httpserver",temp,sqlite,L"-cp",classpath,L"com.peentar.thriftquery.LocalEngineMain",L"--resources",c->resources,L"--data-dir",c->data,L"--temp-dir",c->temp};
 for(size_t i=0;i<sizeof args/sizeof args[0];i++){if(!quote(cmd,&used,args[i]))goto fail;}free(classpath);return cmd;
 fail:free(cmd);free(classpath);return NULL;
}
static wchar_t *environment(const configuration *c){wchar_t *env=calloc(32768,sizeof(wchar_t));if(!env)return NULL;size_t used=0;const wchar_t *names[]={L"APPDATA",L"LOCALAPPDATA",L"SystemRoot",L"TEMP",L"TMP",L"USERPROFILE",L"WINDIR"};
 for(unsigned i=0;i<7;i++){wchar_t value[GB_PATH];if(i==3||i==4)wcscpy(value,c->temp);else {DWORD n=GetEnvironmentVariableW(names[i],value,GB_PATH);if(!n)continue;if(n>=GB_PATH){free(env);return NULL;}}
  size_t n=wcslen(names[i]),m=wcslen(value);if(used+n+m+3>32768){free(env);return NULL;}wmemcpy(env+used,names[i],n);used+=n;env[used++]=L'=';wmemcpy(env+used,value,m);used+=m;env[used++]=0;
 }
 env[used]=0;return env;
}
static int pipes(HANDLE *parent,HANDLE *child,int input){SECURITY_ATTRIBUTES sa={sizeof sa,NULL,TRUE};HANDLE read=NULL,write=NULL;if(!CreatePipe(&read,&write,&sa,0))return 0;*parent=input?write:read;*child=input?read:write;if(!SetHandleInformation(*parent,HANDLE_FLAG_INHERIT,0)){CloseHandle(read);CloseHandle(write);return 0;}return 1;}
static DWORD WINAPI ready_reader(void *unused){(void)unused;unsigned char bytes[1024];DWORD total=0;int newline=0;
 for(;;){DWORD n=0;if(!ReadFile(state.java_output,bytes,sizeof bytes,&n,NULL)||!n)break;if(newline||total+n>8192)fatal();for(DWORD i=0;i<n;i++)if(bytes[i]==10){if(i!=n-1)fatal();newline=1;}total+=n;if(!write_all(GetStdHandle(STD_OUTPUT_HANDLE),bytes,n))fatal();if(newline)InterlockedExchange(&state.ready,1);}
 SecureZeroMemory(bytes,sizeof bytes);return 0;
}
static DWORD WINAPI discard_error(void *unused){(void)unused;unsigned char bytes[4096];for(;;){DWORD n;if(!ReadFile(state.java_error,bytes,sizeof bytes,&n,NULL)||!n)break;SecureZeroMemory(bytes,sizeof bytes);}return 0;}
static int launch(configuration *c,PROCESS_INFORMATION *pi){
 HANDLE child_in=NULL,child_out=NULL,child_error=NULL;STARTUPINFOEXW si;memset(&si,0,sizeof si);si.StartupInfo.cb=sizeof si;si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;SIZE_T size=0;int ok=0,attributes_ready=0;
 wchar_t *cmd=command_line(c),*env=environment(c);if(!cmd||!env)goto done;
 if(!pipes(&state.java_input,&child_in,1)||!pipes(&state.java_output,&child_out,0)||!pipes(&state.java_error,&child_error,0))goto done;
 si.StartupInfo.hStdInput=child_in;si.StartupInfo.hStdOutput=child_out;si.StartupInfo.hStdError=child_error;
 InitializeProcThreadAttributeList(NULL,1,0,&size);si.lpAttributeList=malloc(size);if(!si.lpAttributeList||!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&size))goto done;attributes_ready=1;
 HANDLE list[]={child_in,child_out,child_error};if(!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,list,sizeof list,NULL,NULL))goto done;
 if(!host_alive())goto done;
 ok=CreateProcessW(c->java,cmd,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,env,c->data,&si.StartupInfo,pi);
 done:if(child_in)CloseHandle(child_in);if(child_out)CloseHandle(child_out);if(child_error)CloseHandle(child_error);if(si.lpAttributeList){if(attributes_ready)DeleteProcThreadAttributeList(si.lpAttributeList);free(si.lpAttributeList);}free(cmd);free(env);return ok;
}
int wmain(int argc,wchar_t **argv){(void)argv;if(argc!=1)return 7;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);if(!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32))return 5;
 memset(&state,0,sizeof state);state.deadline=GetTickCount64()+START_MS;InitializeCriticalSection(&state.lock);
 state.job=CreateJobObjectW(NULL,NULL);if(!state.job)return 5;JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;memset(&limits,0,sizeof limits);limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
 if(!SetInformationJobObject(state.job,JobObjectExtendedLimitInformation,&limits,sizeof limits)||!AssignProcessToJobObject(state.job,GetCurrentProcess())){CloseHandle(state.job);return 5;}
 /* From this point ANY exit closes our sole job handle, covering all descendants. */
 state.stop=CreateEventW(NULL,TRUE,FALSE,NULL);state.input_event=CreateEventW(NULL,TRUE,FALSE,NULL);state.input_consumed=CreateEventW(NULL,TRUE,FALSE,NULL);state.eof_event=CreateEventW(NULL,TRUE,FALSE,NULL);if(!state.stop||!state.input_event||!state.input_consumed||!state.eof_event)fatal();
 state.input_thread=CreateThread(NULL,0,input_reader,NULL,0,NULL);if(!state.input_thread)fatal();
 unsigned char *line=NULL;DWORD size=0;uint32_t host_pid=0;if(!take_line(&line,&size)||size>256||!lj_meta(line,size,"BindHost",&host_pid)){fatal();}SecureZeroMemory(line,LINE_MAXIMUM);free(line);line=NULL;
 state.host=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,host_pid);if(!state.host||!host_alive())fatal();
 HANDLE watchdog=CreateThread(NULL,0,host_watchdog,NULL,0,NULL);if(!watchdog)fatal();
 /* No prequeued bytes may serve as live acknowledgement. Production host waits
  * for HostBound; reject coalesced BindHost+LaunchOwned before issuing it. */
 DWORD queued=0;if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),NULL,0,NULL,&queued,NULL)||queued)fatal();
 InterlockedExchange(&state.input_phase,1);char metadata[256];int n=snprintf(metadata,sizeof metadata,"{\"event\":\"HostBound\",\"protocol\":1,\"hostPid\":%lu}\n",(unsigned long)host_pid);if(n<=0||!write_all(GetStdHandle(STD_OUTPUT_HANDLE),metadata,(DWORD)n))fatal();SetEvent(state.input_consumed);
 /* Live acknowledgement on the same private pipe is LaunchOwned itself. */
 configuration c;memset(&c,0,sizeof c);c.classpath=calloc(CP_MAX,sizeof(wchar_t *));if(!c.classpath||!take_line(&line,&size)||!host_alive()||!parse_configuration(line,size,&c))fatal();SecureZeroMemory(line,LINE_MAXIMUM);free(line);line=NULL;
 gb_policy policy;if(gb_policy_init(&policy))fatal();gb_chain data,temp;if(gb_open_chain(&policy,c.data,1,0,&data)||gb_open_chain(&policy,c.temp,1,0,&temp))fatal();
 PROCESS_INFORMATION pi;memset(&pi,0,sizeof pi);if(!launch(&c,&pi))fatal();BOOL member=FALSE;
 if(!IsProcessInJob(pi.hProcess,state.job,&member)||!member||!pi.dwProcessId||GetProcessId(pi.hProcess)!=pi.dwProcessId||!host_alive()){TerminateProcess(pi.hProcess,7);WaitForSingleObject(pi.hProcess,INFINITE);fatal();}
 state.java_pid=pi.dwProcessId;state.java_process=pi.hProcess;InterlockedExchange(&state.input_phase,2);n=snprintf(metadata,sizeof metadata,"{\"event\":\"Owned\",\"protocol\":1,\"javaPid\":%lu}\n",(unsigned long)pi.dwProcessId);if(n<=0||!write_all(GetStdHandle(STD_OUTPUT_HANDLE),metadata,(DWORD)n))fatal();SetEvent(state.input_consumed);
 if(!take_line(&line,&size)||size>256||!lj_meta(line,size,"Commit",NULL)||!host_alive()){fatal();}SecureZeroMemory(line,LINE_MAXIMUM);free(line);line=NULL;
 InterlockedExchange(&state.input_phase,3);SetEvent(state.input_consumed);if(!host_alive()||ResumeThread(pi.hThread)==(DWORD)-1)fatal();CloseHandle(pi.hThread);pi.hThread=NULL;
 HANDLE output_thread=CreateThread(NULL,0,ready_reader,NULL,0,NULL),error_thread=CreateThread(NULL,0,discard_error,NULL,0,NULL);if(!output_thread||!error_thread)fatal();
 if(!take_line(&line,&size)||size>8192||!host_alive()||!bootstrap_valid(line,size)){fatal();}InterlockedExchange(&state.input_phase,4);SetEvent(state.input_consumed);if(!write_all(state.java_input,line,size))fatal();SecureZeroMemory(line,LINE_MAXIMUM);free(line);line=NULL;
 /* Only EOF may now arrive. Input-reader event is waitable; anonymous pipes
  * themselves are never used as process wait objects. Host watchdog remains
  * independent even if a Java pipe WriteFile or JDBC blocks. */
 HANDLE waiters[]={pi.hProcess,state.input_event};DWORD wait=WaitForMultipleObjects(2,waiters,FALSE,INFINITE);int forced=0;
 if(wait==WAIT_OBJECT_0+1){EnterCriticalSection(&state.lock);int bad=state.bad||state.queued||!state.eof;LeaveCriticalSection(&state.lock);if(bad)fatal();CloseHandle(state.java_input);state.java_input=NULL;
  wait=WaitForSingleObject(pi.hProcess,GRACE_MS);if(wait==WAIT_TIMEOUT){forced=1;if(!TerminateProcess(pi.hProcess,7)&&WaitForSingleObject(pi.hProcess,0)!=WAIT_OBJECT_0)fatal();if(WaitForSingleObject(pi.hProcess,INFINITE)!=WAIT_OBJECT_0)fatal();}else if(wait!=WAIT_OBJECT_0)fatal();
 }else if(wait!=WAIT_OBJECT_0)fatal();
 DWORD code;if(WaitForSingleObject(pi.hProcess,0)!=WAIT_OBJECT_0||!GetExitCodeProcess(pi.hProcess,&code))fatal();
 n=snprintf(metadata,sizeof metadata,"{\"event\":\"JavaExited\",\"protocol\":1,\"javaPid\":%lu,\"code\":%lu,\"forced\":%s}\n",(unsigned long)pi.dwProcessId,(unsigned long)code,(forced||InterlockedCompareExchange(&state.forced,0,0))?"true":"false");if(n>0)write_all(GetStdHandle(STD_ERROR_HANDLE),metadata,(DWORD)n);
 SetEvent(state.stop);WaitForSingleObject(watchdog,INFINITE);CloseHandle(watchdog);CloseHandle(pi.hProcess);gb_chain_close(&data);gb_chain_close(&temp);gb_policy_free(&policy);for(size_t i=0;i<c.count;i++)free(c.classpath[i]);free(c.classpath);
 /* Do not close HANDLEs while workers can wait/read them. Exiting closes the
  * job and all remaining pipe/thread handles; no completion inferred from BOOL. */
 ExitProcess(0);return 0;
}
