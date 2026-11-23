#ifndef GB_FIXTURE_COMMON_H
#define GB_FIXTURE_COMMON_H
/* Native tests only. Every mutable path is beneath a fresh fixture root.
 * Fail prerequisites explicitly; never enable privileges or provision users. */
#include "policy.h"
#include <stdio.h>
#include <stdlib.h>
#define FX_REQUIRE(condition) do { if (!(condition)) { fprintf(stderr,"FIXTURE_FAIL line=%u win32=%lu\n",(unsigned)__LINE__,(unsigned long)GetLastError()); return 1; } } while(0)
static inline HANDLE fx_handle(const wchar_t *value) {
 wchar_t *end=NULL;unsigned long long n=wcstoull(value,&end,10);
 return n&&end&&!*end?(HANDLE)(uintptr_t)n:NULL;
}
static inline HANDLE fx_open(const wchar_t *path,DWORD access,DWORD share,DWORD disposition) {
 return CreateFileW(path,access,share,NULL,disposition,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
}
static inline int fx_directory(gb_policy *p,const wchar_t *parent,const wchar_t *name,wchar_t out[GB_PATH]) {
 if(gb_join(out,parent,name))return 0;
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;
 return gb_descriptor(p,1,&sd,acl,&sa)==GB_OK&&CreateDirectoryW(out,&sa);
}
static inline int fx_acl(const wchar_t *path,const wchar_t *sddl) {
 PSECURITY_DESCRIPTOR sd=NULL;PACL acl=NULL;BOOL present=FALSE,def=FALSE;
 if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,SDDL_REVISION_1,&sd,NULL))return 0;
 int ok=GetSecurityDescriptorDacl(sd,&present,&acl,&def)&&present&&acl&&
  SetNamedSecurityInfoW((LPWSTR)path,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,acl,NULL)==ERROR_SUCCESS;
 LocalFree(sd);return ok;
}
static inline unsigned char *fx_descriptor(HANDLE h,DWORD *length) {
 PSECURITY_DESCRIPTOR sd=NULL;PSID owner=NULL;PACL acl=NULL;
 if(GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&acl,NULL,&sd)!=ERROR_SUCCESS)return NULL;
 DWORD n=GetSecurityDescriptorLength(sd);unsigned char *copy=malloc(n);
 if(copy){memcpy(copy,sd,n);*length=n;}LocalFree(sd);return copy;
}
static inline int fx_unchanged(HANDLE h,const unsigned char *before,DWORD length) {
 DWORD n=0;unsigned char *after=fx_descriptor(h,&n);int same=after&&n==length&&!memcmp(before,after,n);free(after);return same;
}
static inline int fx_wait_exit(HANDLE process,DWORD expected,DWORD timeout) {
 DWORD code=0;return WaitForSingleObject(process,timeout)==WAIT_OBJECT_0&&GetExitCodeProcess(process,&code)&&code==expected;
}
#endif
