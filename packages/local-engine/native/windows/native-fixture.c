/* Native-only synthetic ACL/identity/claim test. Never executed on Linux.
 * Takes a missing DISPOSABLE final directory beneath a safe existing parent,
 * creates it protected before use, never live app data. */
#include "policy.h"
#include <stdio.h>
static int exists(const wchar_t *p){return GetFileAttributesW(p)!=INVALID_FILE_ATTRIBUTES;}
int wmain(int argc,wchar_t **argv){
 if(argc!=2||!gb_path_valid(argv[1],0)){return 1;}gb_policy p;if(gb_policy_init(&p))return 2;
 gb_chain base;if(gb_open_chain(&p,argv[1],1,1,&base))return 3;
 wchar_t path[GB_PATH],file[GB_PATH],link[GB_PATH];if(gb_join(path,argv[1],L"native-owner-protected"))return 4;
 gb_chain child;if(gb_open_chain(&p,path,1,1,&child))return 5;
 gb_identity directory;if(gb_validate(&p,child.handles[child.count-1],path,1,1,&directory))return 6;
 if(gb_join(file,path,L"exclusive-claim")||gb_join(link,path,L"hardlink"))return 7;
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;if(gb_descriptor(&p,0,&sd,acl,&sa))return 8;
 HANDLE h=gb_open(file,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|DELETE,FILE_SHARE_READ,CREATE_NEW,&sa);if(h==INVALID_HANDLE_VALUE)return 9;
 gb_identity id;if(gb_validate(&p,h,file,1,0,&id))return 10;
 HANDLE second=gb_open(file,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|DELETE,FILE_SHARE_READ,CREATE_NEW,&sa);if(second!=INVALID_HANDLE_VALUE){CloseHandle(second);return 11;}
 FILE_DISPOSITION_INFO disposition={TRUE};if(!SetFileInformationByHandle(h,FileDispositionInfo,&disposition,sizeof disposition))return 12;CloseHandle(h);if(exists(file))return 13;
 h=gb_open(file,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,0,CREATE_NEW,&sa);if(h==INVALID_HANDLE_VALUE)return 14;CloseHandle(h);
 if(!CreateHardLinkW(link,file,NULL)){return 15;}h=gb_open(file,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,OPEN_EXISTING,NULL);if(h==INVALID_HANDLE_VALUE)return 16;
 if(gb_validate(&p,h,file,1,0,&id)!=GB_UNSAFE){return 17;}CloseHandle(h);DeleteFileW(link);DeleteFileW(file);
 /* Broad inheritable immediate parent must remain byte-identical and no child
  * can be created. Change only this fixture's own synthetic parent DACL. */
 gb_chain_close(&child);wchar_t rejected[GB_PATH];if(gb_join(rejected,path,L"must-not-exist"))return 18;
 LPWSTR user_sid=NULL;wchar_t descriptor[512];if(!ConvertSidToStringSidW(p.token->User.Sid,&user_sid))return 19;
 int chars=swprintf(descriptor,512,L"D:P(A;OICI;FA;;;%ls)(A;OICI;GR;;;WD)",user_sid);LocalFree(user_sid);if(chars<1||chars>=512)return 19;
 PSECURITY_DESCRIPTOR broad=NULL;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor,SDDL_REVISION_1,&broad,NULL))return 19;
 PACL dacl=NULL;BOOL present,defaulted;if(!GetSecurityDescriptorDacl(broad,&present,&dacl,&defaulted))return 20;
 if(SetNamedSecurityInfoW(path,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,dacl,NULL)!=ERROR_SUCCESS)return 21;
 HANDLE parent=gb_open(path,READ_CONTROL|FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING,NULL);if(parent==INVALID_HANDLE_VALUE)return 22;
 PSECURITY_DESCRIPTOR before=NULL,after=NULL;PACL ignored=NULL;if(GetSecurityInfo(parent,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,NULL,NULL,&ignored,NULL,&before))return 23;
 gb_chain unsafe;int status=gb_open_chain(&p,rejected,1,1,&unsafe);if(status==GB_OK)gb_chain_close(&unsafe);if(status!=GB_UNSAFE)return 24;if(exists(rejected))return 25;
 if(GetSecurityInfo(parent,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,NULL,NULL,&ignored,NULL,&after))return 26;
 DWORD n=GetSecurityDescriptorLength(before);if(n!=GetSecurityDescriptorLength(after)||memcmp(before,after,n))return 27;
 LocalFree(before);LocalFree(after);LocalFree(broad);CloseHandle(parent);RemoveDirectoryW(path);gb_chain_close(&base);gb_policy_free(&p);puts("NATIVE_PRIVATE_FIXTURE_OK");return 0;
}
