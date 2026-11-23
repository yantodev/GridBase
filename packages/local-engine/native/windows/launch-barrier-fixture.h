#ifndef GB_LAUNCH_BARRIER_FIXTURE_H
#define GB_LAUNCH_BARRIER_FIXTURE_H
/* Included ONLY into disposable copies by fixture-build.cjs. Never included by
 * production launch-owned.c. Named events live only in this fixture namespace;
 * they coordinate tests, not production ownership. No release means timeout. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
static void fx_launch_barrier(const wchar_t *stage,DWORD child,HANDLE job,HANDLE host) {
 wchar_t selected[64],prefix[256],name[512];
 if(!GetEnvironmentVariableW(L"GRIDBASE_FIXTURE_STAGE",selected,64)||wcscmp(selected,stage))return;
 if(!GetEnvironmentVariableW(L"GRIDBASE_FIXTURE_PREFIX",prefix,256))ExitProcess(97);
 swprintf(name,512,L"%ls-reached",prefix);HANDLE reached=OpenEventW(EVENT_MODIFY_STATE,FALSE,name);
 swprintf(name,512,L"%ls-release",prefix);HANDLE release=OpenEventW(SYNCHRONIZE,FALSE,name);
 swprintf(name,512,L"%ls-metadata",prefix);HANDLE metadata=OpenFileMappingW(FILE_MAP_WRITE,FALSE,name);
 if(!reached||!release||!metadata)ExitProcess(97);
 uintptr_t *values=MapViewOfFile(metadata,FILE_MAP_WRITE,0,0,6*sizeof(uintptr_t));if(!values)ExitProcess(97);
 values[0]=child;values[1]=(uintptr_t)job;values[2]=(uintptr_t)host;values[3]=(uintptr_t)GetStdHandle(STD_INPUT_HANDLE);values[4]=(uintptr_t)GetStdHandle(STD_OUTPUT_HANDLE);values[5]=(uintptr_t)GetStdHandle(STD_ERROR_HANDLE);
 FlushViewOfFile(values,6*sizeof(uintptr_t));UnmapViewOfFile(values);CloseHandle(metadata);
 if(!SetEvent(reached)||WaitForSingleObject(release,30000)!=WAIT_OBJECT_0)ExitProcess(97);
 CloseHandle(release);CloseHandle(reached);
}
#endif
