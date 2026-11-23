/* Synthetic native process, NOT Java/JDBC. Exercises real Windows job/handle
 * lifetime with the production launch-owned.exe and its unchanged fixed argv. */
#include <windows.h>
#include <stdio.h>
int wmain(int argc,wchar_t **argv){
 if(argc==3&&!wcscmp(argv[1],L"--observe")){
  wchar_t *end=NULL;unsigned long pid=wcstoul(argv[2],&end,10);if(!pid||*end)return 2;
  HANDLE process=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,(DWORD)pid);if(!process)return 3;
  puts("OBSERVING");fflush(stdout);DWORD wait=WaitForSingleObject(process,45000);CloseHandle(process);return wait==WAIT_OBJECT_0?0:4;
 }
 /* Modes are selected only by disposable fixture data in private cwd; no
  * production launcher environment/argv override is added. */
 HANDLE marker=CreateFileW(L"fixture-started",GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);if(marker==INVALID_HANDLE_VALUE)return 7;CloseHandle(marker);
 char mode[64]={0};HANDLE mode_file=CreateFileW(L"fixture-mode",GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
 if(mode_file!=INVALID_HANDLE_VALUE){DWORD got=0;if(!ReadFile(mode_file,mode,sizeof mode-1,&got,NULL)){CloseHandle(mode_file);return 8;}CloseHandle(mode_file);}
 unsigned char bootstrap[8192];DWORD used=0;
 while(used<sizeof bootstrap){DWORD n=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),bootstrap+used,1,&n,NULL)||!n)return 5;if(bootstrap[used++]==10)break;}
 if(used==sizeof bootstrap&&bootstrap[used-1]!=10){return 6;}
 if(!strcmp(mode,"reflect")){DWORD wrote=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),bootstrap,used,&wrote,NULL)||wrote!=used)return 9;}
 else if(!strcmp(mode,"oversize")){unsigned char data[8193];memset(data,'X',sizeof data);DWORD wrote=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),data,sizeof data,&wrote,NULL))return 9;}
 else {
  char ready[256];int length=snprintf(ready,sizeof ready,"{\"event\":\"ready\",\"protocol\":1,\"version\":\"1.4.0\",\"pid\":%lu,\"port\":1234}\n",(unsigned long)GetCurrentProcessId()+(!strcmp(mode,"wrong-pid")?1:0));
  if(length<1)return 9;
  if(!strcmp(mode,"split")){DWORD wrote=0;if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),ready,7,&wrote,NULL))return 9;Sleep(20);if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),ready+7,(DWORD)length-7,&wrote,NULL))return 9;}
  else {fputs(ready,stdout);fflush(stdout);}
  if(!strcmp(mode,"extra")){puts("unexpected");fflush(stdout);}
 }
 SecureZeroMemory(bootstrap,sizeof bootstrap);
 /* Deliberately nonresponsive to EOF: real JVM/JDBC acceptance is separate. */
 Sleep(INFINITE);return 0;
}
