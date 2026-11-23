/* I2 real TokenUser/ACL matrix. --other-process is a preprovisioned synthetic
 * ordinary user's live process, whose token ACL permits QUERY/DUPLICATE and
 * impersonation by this disposable harness. No credentials/LogonUser/elevation.
 * Caller must already be allowed to impersonate; refusal is a failed prerequisite.
 * Usage: security-fixture.exe FRESH_PRIVATE_ROOT OTHER_PROCESS_PID */
#include "fixture-common.h"
typedef struct {HANDLE token,armed;const wchar_t *parent,*child;} first_probe;
static DWORD WINAPI first_probe_thread(void *argument) {
 first_probe *probe=argument;if(!ImpersonateLoggedOnUser(probe->token))return 1;
 HANDLE parent=CreateFileW(probe->parent,FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OVERLAPPED,NULL);
 if(parent==INVALID_HANDLE_VALUE){RevertToSelf();SetEvent(probe->armed);return 2;}
 OVERLAPPED pending;memset(&pending,0,sizeof pending);pending.hEvent=CreateEventW(NULL,TRUE,FALSE,NULL);unsigned char events[4096];DWORD n=0;
 BOOL started=pending.hEvent&&ReadDirectoryChangesW(parent,events,sizeof events,FALSE,FILE_NOTIFY_CHANGE_DIR_NAME,&n,&pending,NULL);
 DWORD error=GetLastError();SetEvent(probe->armed);
 if(!started&&error!=ERROR_IO_PENDING){CloseHandle(parent);if(pending.hEvent)CloseHandle(pending.hEvent);RevertToSelf();return 3;}
 DWORD status=0;
 if(WaitForSingleObject(pending.hEvent,10000)!=WAIT_OBJECT_0||!GetOverlappedResult(parent,&pending,&n,FALSE)||!n)status=4;
 if(!status){HANDLE access=CreateFileW(probe->child,FILE_LIST_DIRECTORY|FILE_ADD_FILE|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);error=GetLastError();if(access!=INVALID_HANDLE_VALUE){CloseHandle(access);status=5;}else if(error!=ERROR_ACCESS_DENIED)status=6;}
 if(status){CancelIoEx(parent,&pending);GetOverlappedResult(parent,&pending,&n,TRUE);}
 CloseHandle(pending.hEvent);CloseHandle(parent);if(!RevertToSelf())ExitProcess(98);return status;
}
static int denied(HANDLE token,const wchar_t *path,DWORD rights,int directory) {
 if(!ImpersonateLoggedOnUser(token))return 0;
 HANDLE h=CreateFileW(path,rights,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,
  FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),NULL);
 DWORD error=GetLastError();int ok=h==INVALID_HANDLE_VALUE&&error==ERROR_ACCESS_DENIED;
 if(h!=INVALID_HANDLE_VALUE)CloseHandle(h);
 if(!RevertToSelf())ExitProcess(98);
 return ok;
}
static int parent_variants(gb_policy *p,const wchar_t *root,PSID other) {
 LPWSTR owner=NULL,peer=NULL;FX_REQUIRE(ConvertSidToStringSidW(p->token->User.Sid,&owner));FX_REQUIRE(ConvertSidToStringSidW(other,&peer));
 const wchar_t *principals[]={L"WD",L"BU",L"AU",peer};const wchar_t *inheritance[]={L"OI",L"CI",L"OICI"};
 for(unsigned i=0;i<4;i++)for(unsigned j=0;j<3;j++) {
  wchar_t name[64],parent[GB_PATH],child[GB_PATH],sddl[1024];swprintf(name,64,L"broad-%u-%u",i,j);
  FX_REQUIRE(fx_directory(p,root,name,parent));FX_REQUIRE(!gb_join(child,parent,L"must-not-create"));
  swprintf(sddl,1024,L"D:P(A;OICI;FA;;;%ls)(A;%ls;GR;;;%ls)",owner,inheritance[j],principals[i]);FX_REQUIRE(fx_acl(parent,sddl));
  HANDLE h=fx_open(parent,READ_CONTROL|FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING);FX_REQUIRE(h!=INVALID_HANDLE_VALUE);
  DWORD n=0;unsigned char *before=fx_descriptor(h,&n);FX_REQUIRE(before);
  gb_chain chain;int status=gb_open_chain(p,child,1,1,&chain);
  if(status==GB_OK)gb_chain_close(&chain);
  FX_REQUIRE(status==GB_UNSAFE);FX_REQUIRE(GetFileAttributesW(child)==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND);
  FX_REQUIRE(fx_unchanged(h,before,n));free(before);CloseHandle(h);FX_REQUIRE(RemoveDirectoryW(parent));
 }
 LocalFree(owner);LocalFree(peer);return 0;
}
static int first_observable(gb_policy *p,const wchar_t *root,HANDLE other) {
 wchar_t parent[GB_PATH],child[GB_PATH],file[GB_PATH],existing[GB_PATH],sddl[1024];LPWSTR owner=NULL;
 FX_REQUIRE(fx_directory(p,root,L"first-observation",parent));FX_REQUIRE(ConvertSidToStringSidW(p->token->User.Sid,&owner));
 /* Selected fixture parent grants read/traverse only, no broad inheritance or
  * mutation. This permits a real alternate-token probe to reach the child. */
 swprintf(sddl,1024,L"D:P(A;OICI;FA;;;%ls)(A;;GRGX;;;WD)",owner);LocalFree(owner);FX_REQUIRE(fx_acl(root,sddl)&&fx_acl(parent,sddl));
 FX_REQUIRE(!gb_join(child,parent,L"created-protected"));FX_REQUIRE(!gb_join(existing,parent,L"preexisting-open"));
 FX_REQUIRE(!gb_join(file,child,L"synthetic-envelope"));
 FX_REQUIRE(ImpersonateLoggedOnUser(other));
 HANDLE preexisting=CreateFileW(parent,FILE_LIST_DIRECTORY|FILE_TRAVERSE,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
 DWORD error=GetLastError();FX_REQUIRE(RevertToSelf());SetLastError(error);FX_REQUIRE(preexisting!=INVALID_HANDLE_VALUE);
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;FX_REQUIRE(gb_descriptor(p,1,&sd,acl,&sa)==GB_OK);
 first_probe probe={other,CreateEventW(NULL,TRUE,FALSE,NULL),parent,child};FX_REQUIRE(probe.armed);HANDLE observer=CreateThread(NULL,0,first_probe_thread,&probe,0,NULL);FX_REQUIRE(observer&&WaitForSingleObject(probe.armed,10000)==WAIT_OBJECT_0);
 /* No post-create mutation/repair precedes this alternate-token observation. */
 gb_chain created;FX_REQUIRE(gb_open_chain(p,child,1,1,&created)==GB_OK);
 DWORD observer_code=99;FX_REQUIRE(WaitForSingleObject(observer,15000)==WAIT_OBJECT_0&&GetExitCodeThread(observer,&observer_code)&&observer_code==0);CloseHandle(observer);CloseHandle(probe.armed);
 const DWORD rights[]={FILE_LIST_DIRECTORY,FILE_ADD_FILE,DELETE,WRITE_DAC,FILE_WRITE_ATTRIBUTES};
 for(unsigned i=0;i<sizeof rights/sizeof rights[0];i++)FX_REQUIRE(denied(other,child,rights[i],1));
 /* Actual rename/remove/reparse-open attempts, not just an ACL-mask claim. */
 wchar_t renamed[GB_PATH];FX_REQUIRE(!gb_join(renamed,parent,L"renamed"));FX_REQUIRE(ImpersonateLoggedOnUser(other));
 BOOL mutation=MoveFileExW(child,renamed,0);error=GetLastError();FX_REQUIRE(RevertToSelf());FX_REQUIRE(!mutation&&error==ERROR_ACCESS_DENIED);
 FX_REQUIRE(ImpersonateLoggedOnUser(other));mutation=RemoveDirectoryW(child);error=GetLastError();FX_REQUIRE(RevertToSelf());FX_REQUIRE(!mutation&&error==ERROR_ACCESS_DENIED);
 FX_REQUIRE(denied(other,child,GENERIC_WRITE,1));
 HANDLE h=fx_open(child,READ_CONTROL|FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING);gb_identity id;FX_REQUIRE(h!=INVALID_HANDLE_VALUE&&gb_validate(p,h,child,1,1,&id)==GB_OK);CloseHandle(h);
 FX_REQUIRE(gb_descriptor(p,0,&sd,acl,&sa)==GB_OK);
 h=gb_open(file,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,CREATE_NEW,&sa);FX_REQUIRE(h!=INVALID_HANDLE_VALUE);
 /* First access probe occurs before a single envelope byte is written. */
 for(unsigned i=0;i<sizeof rights/sizeof rights[0];i++)FX_REQUIRE(denied(other,file,rights[i],0));
 const unsigned char envelope[]="SYNTHETIC-NONSECRET-ENVELOPE";DWORD wrote=0;FX_REQUIRE(WriteFile(h,envelope,sizeof envelope,&wrote,NULL)&&wrote==sizeof envelope);CloseHandle(h);
 FX_REQUIRE(denied(other,file,GENERIC_READ,0));FX_REQUIRE(denied(other,file,GENERIC_WRITE,0));
 /* A preexisting read-only parent handle cannot grant mutation to a child. */
 FX_REQUIRE(ImpersonateLoggedOnUser(other));HANDLE bad=CreateFileW(existing,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);error=GetLastError();FX_REQUIRE(RevertToSelf());FX_REQUIRE(bad==INVALID_HANDLE_VALUE&&error==ERROR_ACCESS_DENIED);
 CloseHandle(preexisting);FX_REQUIRE(DeleteFileW(file));gb_chain_close(&created);FX_REQUIRE(RemoveDirectoryW(child));FX_REQUIRE(RemoveDirectoryW(parent));
 /* Deliberately unsafe preexisting object with an ordinary user's live open
  * handle: private validation must refuse unchanged, never repair/write. */
 FX_REQUIRE(CreateDirectoryW(parent,NULL));FX_REQUIRE(fx_acl(parent,sddl));
 HANDLE unsafe=fx_open(existing,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,CREATE_NEW);FX_REQUIRE(unsafe!=INVALID_HANDLE_VALUE);CloseHandle(unsafe);FX_REQUIRE(fx_acl(existing,sddl));
 FX_REQUIRE(ImpersonateLoggedOnUser(other));HANDLE held=fx_open(existing,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);error=GetLastError();FX_REQUIRE(RevertToSelf());SetLastError(error);FX_REQUIRE(held!=INVALID_HANDLE_VALUE);
 unsafe=fx_open(existing,READ_CONTROL|GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);FX_REQUIRE(unsafe!=INVALID_HANDLE_VALUE);DWORD dn=0;unsigned char *before=fx_descriptor(unsafe,&dn);FX_REQUIRE(before);
 FX_REQUIRE(gb_validate(p,unsafe,existing,1,0,&id)==GB_UNSAFE&&fx_unchanged(unsafe,before,dn));LARGE_INTEGER length;FX_REQUIRE(GetFileSizeEx(unsafe,&length)&&length.QuadPart==0);free(before);CloseHandle(unsafe);CloseHandle(held);FX_REQUIRE(DeleteFileW(existing)&&RemoveDirectoryW(parent));
 FX_REQUIRE(gb_descriptor(p,1,&sd,acl,&sa)==GB_OK);HANDLE own=fx_open(root,WRITE_DAC|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING);FX_REQUIRE(own!=INVALID_HANDLE_VALUE);
 FX_REQUIRE(SetSecurityInfo(own,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,(PACL)acl,NULL)==ERROR_SUCCESS);CloseHandle(own);return 0;
}
int wmain(int argc,wchar_t **argv) {
 FX_REQUIRE(argc==3&&gb_path_valid(argv[1],0));wchar_t *end=NULL;unsigned long pid=wcstoul(argv[2],&end,10);FX_REQUIRE(pid&&end&&!*end);
 gb_policy p;FX_REQUIRE(gb_policy_init(&p)==GB_OK);gb_chain root;FX_REQUIRE(gb_open_chain(&p,argv[1],1,1,&root)==GB_OK);
 BOOL current_admin=FALSE;FX_REQUIRE(CheckTokenMembership(NULL,p.admins,&current_admin)&&!current_admin);
 HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,(DWORD)pid);FX_REQUIRE(process&&WaitForSingleObject(process,0)==WAIT_TIMEOUT);
 HANDLE token=NULL;FX_REQUIRE(OpenProcessToken(process,TOKEN_QUERY|TOKEN_DUPLICATE,&token));HANDLE peer=NULL;FX_REQUIRE(DuplicateTokenEx(token,TOKEN_QUERY|TOKEN_IMPERSONATE,NULL,SecurityImpersonation,TokenImpersonation,&peer));
 DWORD size=0;GetTokenInformation(peer,TokenUser,NULL,0,&size);FX_REQUIRE(size&&size<=65536);TOKEN_USER *user=malloc(size);FX_REQUIRE(user&&GetTokenInformation(peer,TokenUser,user,size,&size));
 FX_REQUIRE(!EqualSid(user->User.Sid,p.token->User.Sid)&&!EqualSid(user->User.Sid,p.system));BOOL admin=FALSE;FX_REQUIRE(CheckTokenMembership(peer,p.admins,&admin)&&!admin);
 FX_REQUIRE(first_observable(&p,argv[1],peer)==0);FX_REQUIRE(parent_variants(&p,argv[1],user->User.Sid)==0);
 free(user);CloseHandle(peer);CloseHandle(token);CloseHandle(process);gb_chain_close(&root);gb_policy_free(&p);puts("NATIVE_SECURITY_MATRIX_OK");return 0;
}
