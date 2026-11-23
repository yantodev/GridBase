/* I3 native helper-level drivers. All processes/jobs created here are owned
 * synthetic children; never enumerate or terminate global/outer host processes.
 * --outer LAUNCHER REPORT [ui]: fixture-owned enclosing job + sibling.
 * --barrier PREFIX: create fixture events/mapping, wait hit, report exact child
 *   PID + opaque launcher handle values, accept one 'R' byte to release barrier.
 * --inspect LAUNCHER_PID JOB HOST STDIN STDOUT STDERR JAVA_PID: duplicate only captured
 *   handles; examine exact known Java process for forbidden object inheritance.
 * --idle: independently surviving sibling. */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#define REQUIRE(c) do{if(!(c)){fprintf(stderr,"JOB_FIXTURE_FAIL line=%u win32=%lu\n",(unsigned)__LINE__,(unsigned long)GetLastError());return 1;}}while(0)
static HANDLE numeric(const wchar_t *s){wchar_t *end=NULL;unsigned long long n=wcstoull(s,&end,10);return end&&!*end?(HANDLE)(uintptr_t)n:NULL;}
static int child(const wchar_t *exe,const wchar_t *argument,HANDLE job,int inherit,PROCESS_INFORMATION *pi){
 wchar_t cmd[32767];if(wcschr(exe,L'"')||wcslen(exe)+wcslen(argument)+5>=32767)return 0;swprintf(cmd,32767,L"\"%ls\" %ls",exe,argument);
 STARTUPINFOEXW si;memset(&si,0,sizeof si);si.StartupInfo.cb=inherit?sizeof si:sizeof(STARTUPINFOW);SIZE_T n=0;int initialized=0,ok=0;
 if(inherit){si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;si.StartupInfo.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.StartupInfo.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.StartupInfo.hStdError=GetStdHandle(STD_ERROR_HANDLE);
  HANDLE list[]={si.StartupInfo.hStdInput,si.StartupInfo.hStdOutput,si.StartupInfo.hStdError};for(unsigned i=0;i<3;i++)if(!SetHandleInformation(list[i],HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT))goto done;
  InitializeProcThreadAttributeList(NULL,1,0,&n);si.lpAttributeList=malloc(n);if(!si.lpAttributeList||!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&n))goto done;initialized=1;
  if(!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,list,sizeof list,NULL,NULL))goto done;
 }
 ok=CreateProcessW(exe,cmd,NULL,NULL,inherit,CREATE_SUSPENDED|CREATE_NO_WINDOW|(inherit?EXTENDED_STARTUPINFO_PRESENT:0),NULL,NULL,&si.StartupInfo,pi);
 if(ok&&job&&!AssignProcessToJobObject(job,pi->hProcess)){TerminateProcess(pi->hProcess,90);WaitForSingleObject(pi->hProcess,INFINITE);CloseHandle(pi->hThread);CloseHandle(pi->hProcess);ok=0;}
 done:if(initialized)DeleteProcThreadAttributeList(si.lpAttributeList);free(si.lpAttributeList);return ok;
}
static int outer(int argc,wchar_t **argv){
 REQUIRE(argc==4||argc==5);wchar_t self[32767];REQUIRE(GetModuleFileNameW(NULL,self,32767));HANDLE job=CreateJobObjectW(NULL,NULL);REQUIRE(job);
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;memset(&limits,0,sizeof limits);limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;REQUIRE(SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof limits));
 if(argc==5){REQUIRE(!wcscmp(argv[4],L"ui"));JOBOBJECT_BASIC_UI_RESTRICTIONS ui={JOB_OBJECT_UILIMIT_HANDLES};REQUIRE(SetInformationJobObject(job,JobObjectBasicUIRestrictions,&ui,sizeof ui));}
 PROCESS_INFORMATION sibling,launcher;memset(&sibling,0,sizeof sibling);memset(&launcher,0,sizeof launcher);
 REQUIRE(child(self,L"--idle",job,0,&sibling));REQUIRE(ResumeThread(sibling.hThread)!=(DWORD)-1);CloseHandle(sibling.hThread);
 REQUIRE(child(argv[2],L"",job,1,&launcher));BOOL in_outer=FALSE;REQUIRE(IsProcessInJob(launcher.hProcess,job,&in_outer)&&in_outer);REQUIRE(ResumeThread(launcher.hThread)!=(DWORD)-1);CloseHandle(launcher.hThread);
 REQUIRE(WaitForSingleObject(launcher.hProcess,45000)==WAIT_OBJECT_0);DWORD code=0;REQUIRE(GetExitCodeProcess(launcher.hProcess,&code));
 REQUIRE(WaitForSingleObject(sibling.hProcess,0)==WAIT_TIMEOUT);JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;ULONGLONG deadline=GetTickCount64()+10000;
 /* Job termination is asynchronous. Await this exact fixture job's member
  * accounting, never infer descendant death from launcher termination alone. */
 do {REQUIRE(QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&accounting,sizeof accounting,NULL));if(accounting.ActiveProcesses==1)break;REQUIRE(GetTickCount64()<deadline);Sleep(10);}while(1);
 BOOL member=FALSE;REQUIRE(IsProcessInJob(sibling.hProcess,job,&member)&&member&&WaitForSingleObject(sibling.hProcess,0)==WAIT_TIMEOUT);
 char report[256];int n=snprintf(report,sizeof report,"{\"launcherCode\":%lu,\"siblingSurvived\":true,\"activeProcesses\":%lu}\n",(unsigned long)code,(unsigned long)accounting.ActiveProcesses);
 HANDLE file=CreateFileW(argv[3],GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);REQUIRE(file!=INVALID_HANDLE_VALUE);DWORD wrote=0;REQUIRE(n>0&&WriteFile(file,report,(DWORD)n,&wrote,NULL)&&wrote==(DWORD)n);CloseHandle(file);
 REQUIRE(TerminateProcess(sibling.hProcess,0));REQUIRE(WaitForSingleObject(sibling.hProcess,10000)==WAIT_OBJECT_0);CloseHandle(sibling.hProcess);CloseHandle(launcher.hProcess);CloseHandle(job);return 0;
}
static int barrier(const wchar_t *prefix){
 REQUIRE(wcslen(prefix)<256);wchar_t name[512];swprintf(name,512,L"%ls-reached",prefix);HANDLE hit=CreateEventW(NULL,TRUE,FALSE,name);REQUIRE(hit&&GetLastError()!=ERROR_ALREADY_EXISTS);
 swprintf(name,512,L"%ls-release",prefix);HANDLE release=CreateEventW(NULL,TRUE,FALSE,name);REQUIRE(release&&GetLastError()!=ERROR_ALREADY_EXISTS);
 swprintf(name,512,L"%ls-metadata",prefix);HANDLE mapping=CreateFileMappingW(INVALID_HANDLE_VALUE,NULL,PAGE_READWRITE,0,6*sizeof(uintptr_t),name);REQUIRE(mapping&&GetLastError()!=ERROR_ALREADY_EXISTS);
 uintptr_t *values=MapViewOfFile(mapping,FILE_MAP_READ,0,0,6*sizeof(uintptr_t));REQUIRE(values);puts("BARRIER_READY");fflush(stdout);
 REQUIRE(WaitForSingleObject(hit,30000)==WAIT_OBJECT_0);printf("{\"pid\":%llu,\"job\":%llu,\"host\":%llu,\"control\":%llu,\"output\":%llu,\"error\":%llu}\n",(unsigned long long)values[0],(unsigned long long)values[1],(unsigned long long)values[2],(unsigned long long)values[3],(unsigned long long)values[4],(unsigned long long)values[5]);fflush(stdout);
 unsigned char command=0;DWORD n=0;REQUIRE(ReadFile(GetStdHandle(STD_INPUT_HANDLE),&command,1,&n,NULL)&&n==1&&command=='R');REQUIRE(SetEvent(release));
 UnmapViewOfFile(values);CloseHandle(mapping);CloseHandle(release);CloseHandle(hit);return 0;
}
static int inspect(int argc,wchar_t **argv){
 REQUIRE(argc==9);DWORD launcher_id=(DWORD)(uintptr_t)numeric(argv[2]),java_id=(DWORD)(uintptr_t)numeric(argv[8]);REQUIRE(launcher_id&&java_id);
 HANDLE launcher=OpenProcess(PROCESS_DUP_HANDLE|SYNCHRONIZE,FALSE,launcher_id),java=OpenProcess(PROCESS_DUP_HANDLE|PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,java_id);REQUIRE(launcher&&java);
 HANDLE forbidden[5]={NULL,NULL,NULL,NULL,NULL};for(unsigned i=0;i<5;i++)REQUIRE(DuplicateHandle(launcher,numeric(argv[3+i]),GetCurrentProcess(),&forbidden[i],0,FALSE,DUPLICATE_SAME_ACCESS));
 /* Official API lives in KernelBase.dll; installed MinGW has the declaration
  * but no import library. Resolve that documented OS export, fail if absent. */
 typedef BOOL (WINAPI *compare_fn)(HANDLE,HANDLE);union { FARPROC raw;compare_fn compare; } api;
 HMODULE kernelbase=GetModuleHandleW(L"KernelBase.dll");REQUIRE(kernelbase);api.raw=GetProcAddress(kernelbase,"CompareObjectHandles");REQUIRE(api.raw);
 REQUIRE(api.compare(forbidden[0],forbidden[0]));
 /* Microsoft documents inherited handles retain the same numeric value and
  * object identity (Processes/Inheritance). Probe exactly the captured slots,
  * not an undocumented handle-table layout or a global process enumeration.
  * A reused child slot is allowed only if it is a different kernel object. */
 for(unsigned i=0;i<5;i++){
  HANDLE duplicate=NULL;SetLastError(ERROR_SUCCESS);
  if(DuplicateHandle(java,numeric(argv[3+i]),GetCurrentProcess(),&duplicate,0,FALSE,DUPLICATE_SAME_ACCESS)){
   REQUIRE(!api.compare(duplicate,forbidden[i]));CloseHandle(duplicate);
  }else REQUIRE(GetLastError()==ERROR_INVALID_HANDLE);
 }
 BOOL member=FALSE;REQUIRE(IsProcessInJob(java,forbidden[0],&member)&&member);
 /* Positive controls: prove the selected handles really are a job, live host
  * process and control pipe before treating their absence as meaningful. */
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;REQUIRE(QueryInformationJobObject(forbidden[0],JobObjectExtendedLimitInformation,&info,sizeof info,NULL));REQUIRE(info.BasicLimitInformation.LimitFlags&JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
 REQUIRE(GetProcessId(forbidden[1])!=0&&GetFileType(forbidden[2])==FILE_TYPE_PIPE&&GetFileType(forbidden[3])==FILE_TYPE_PIPE&&GetFileType(forbidden[4])==FILE_TYPE_PIPE);
 for(unsigned i=0;i<5;i++){CloseHandle(forbidden[i]);}CloseHandle(java);CloseHandle(launcher);puts("NATIVE_HANDLE_EXCLUSION_OK");return 0;
}
int wmain(int argc,wchar_t **argv){
 if(argc==2&&!wcscmp(argv[1],L"--idle")){Sleep(INFINITE);return 0;}
 if(argc>=2&&!wcscmp(argv[1],L"--outer"))return outer(argc,argv);
 if(argc==3&&!wcscmp(argv[1],L"--barrier"))return barrier(argv[2]);
 if(argc>=2&&!wcscmp(argv[1],L"--inspect"))return inspect(argc,argv);
 return 2;
}
