#include "policy.h"
#include <stdlib.h>
#include <wctype.h>

int gb_error(DWORD e) {
 if(e==ERROR_FILE_NOT_FOUND||e==ERROR_PATH_NOT_FOUND)return GB_MISSING;
 if(e==ERROR_FILE_EXISTS||e==ERROR_ALREADY_EXISTS)return GB_EXISTS;
 if(e==ERROR_SHARING_VIOLATION||e==ERROR_LOCK_VIOLATION)return GB_INITIALIZING;
 if(e==ERROR_ACCESS_DENIED||e==ERROR_CANT_ACCESS_FILE)return GB_UNSAFE;
 return GB_IO;
}
int gb_policy_init(gb_policy *p) {
 memset(p,0,sizeof *p);HANDLE token=NULL;DWORD n=0;
 if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return GB_UNSUPPORTED;
 GetTokenInformation(token,TokenUser,NULL,0,&n);
 if(n<sizeof(TOKEN_USER)||n>65536){CloseHandle(token);return GB_UNSUPPORTED;}
 p->token=calloc(1,n);
 int ok=p->token&&GetTokenInformation(token,TokenUser,p->token,n,&n);CloseHandle(token);
 if(!ok||!IsValidSid(p->token->User.Sid))return GB_UNSUPPORTED;
 if(!ConvertStringSidToSidW(L"S-1-5-18",&p->system)||!ConvertStringSidToSidW(L"S-1-5-32-544",&p->admins)||
 !ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",&p->installer)||!ConvertStringSidToSidW(L"S-1-3-0",&p->creator))return GB_UNSUPPORTED;
 return GB_OK;
}
void gb_policy_free(gb_policy *p) {free(p->token);LocalFree(p->system);LocalFree(p->admins);LocalFree(p->installer);LocalFree(p->creator);memset(p,0,sizeof *p);}
static int trusted(gb_policy *p,PSID sid) {return IsValidSid(sid)&&(EqualSid(sid,p->token->User.Sid)||EqualSid(sid,p->system)||EqualSid(sid,p->admins)||EqualSid(sid,p->installer));}
static int valid_component(const wchar_t *s,size_t n) {
 if(!n||n>255||(n==1&&s[0]==L'.')||(n==2&&s[0]==L'.'&&s[1]==L'.')||s[n-1]==L'.'||s[n-1]==L' ')return 0;
 for(size_t i=0;i<n;i++)if(s[i]<32||s[i]==127||wcschr(L"\\/:*?\"<>|",s[i]))return 0;
 size_t stem=0;while(stem<n&&s[stem]!=L'.')stem++;
 if(stem==3&&(!_wcsnicmp(s,L"con",3)||!_wcsnicmp(s,L"prn",3)||!_wcsnicmp(s,L"aux",3)||!_wcsnicmp(s,L"nul",3)))return 0;
 if((stem==6&&!_wcsnicmp(s,L"conin$",6))||(stem==7&&!_wcsnicmp(s,L"conout$",7)))return 0;
 if(stem==4&&(!_wcsnicmp(s,L"com",3)||!_wcsnicmp(s,L"lpt",3))&&wcschr(L"123456789\u00b9\u00b2\u00b3",s[3]))return 0;
 return 1;
}
int gb_path_valid(const wchar_t *s,int relative) {
 size_t n=wcslen(s);if(!n||n>=GB_PATH)return 0;size_t start=0;
 if(!relative){if(n<3||s[0]<L'A'||s[0]>L'Z'||s[1]!=L':'||s[2]!=L'\\')return 0;start=3;if(n==3)return 1;}
 wchar_t separator=relative?L'/':L'\\';
 for(size_t i=start;i<=n;i++)if(i==n||s[i]==separator){if(!valid_component(s+start,i-start))return 0;start=i+1;}
 return 1;
}
int gb_read_string(gb_buf *b,wchar_t out[GB_PATH],int relative) {
 uint32_t n=gb_u32(b);if(n>16384){b->bad=1;return GB_PROTOCOL;}unsigned char *s=gb_take(b,n);size_t units=0;
 if(!s||!n||!gb_utf8(s,n,&units)||units>=GB_PATH){b->bad=1;return GB_PROTOCOL;}
 int len=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,(const char *)s,(int)n,out,GB_PATH-1);
 if(len<=0){b->bad=1;return GB_PROTOCOL;}out[len]=0;
 if(!gb_path_valid(out,relative)){b->bad=1;return GB_UNSAFE;}return GB_OK;
}
void gb_write_string(gb_buf *b,const wchar_t *s) {
 int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,NULL,0,NULL,NULL);
 if(n<1||n>16385){b->bad=1;return;}gb_w32(b,(uint32_t)n-1);unsigned char *p=gb_take(b,(size_t)n-1);
 /* Convert via bounded stack buffer: terminator is not serialized. */
 char temp[16385];if(!p||!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s,-1,temp,sizeof temp,NULL,NULL)){b->bad=1;return;}memcpy(p,temp,(size_t)n-1);
}
int gb_join(wchar_t out[GB_PATH],const wchar_t *a,const wchar_t *b) {
 size_t n=wcslen(a),m=wcslen(b);int slash=n&&a[n-1]!=L'\\';if(n+m+(size_t)slash>=GB_PATH)return GB_UNSAFE;
 wcscpy(out,a);if(slash)wcscat(out,L"\\");wcscat(out,b);return GB_OK;
}
HANDLE gb_open(const wchar_t *path,DWORD access,DWORD share,DWORD disposition,SECURITY_ATTRIBUTES *sa) {
 wchar_t extended[GB_PATH+4];wcscpy(extended,L"\\\\?\\");wcscat(extended,path);
 return CreateFileW(extended,access,share,sa,disposition,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
}
int gb_descriptor(gb_policy *p,int dir,SECURITY_DESCRIPTOR *sd,unsigned char acl[256],SECURITY_ATTRIBUTES *sa) {
 if(!InitializeSecurityDescriptor(sd,SECURITY_DESCRIPTOR_REVISION)||!InitializeAcl((PACL)acl,256,ACL_REVISION)||
 !AddAccessAllowedAceEx((PACL)acl,ACL_REVISION,dir?OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE:0,FILE_ALL_ACCESS,p->token->User.Sid)||
 !SetSecurityDescriptorOwner(sd,p->token->User.Sid,FALSE)||!SetSecurityDescriptorDacl(sd,TRUE,(PACL)acl,FALSE)||
 !SetSecurityDescriptorControl(sd,SE_DACL_PROTECTED,SE_DACL_PROTECTED))return GB_UNSUPPORTED;
 sa->nLength=sizeof *sa;sa->lpSecurityDescriptor=sd;sa->bInheritHandle=FALSE;return GB_OK;
}
int gb_security(gb_policy *p,HANDLE h,int privacy,int directory,int parent) {
 PSECURITY_DESCRIPTOR sd=NULL;PSID owner=NULL;PACL acl=NULL;int result=GB_UNSAFE;
 DWORD e=GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&acl,NULL,&sd);
 if(e!=ERROR_SUCCESS)return gb_error(e);
 SECURITY_DESCRIPTOR_CONTROL control;DWORD revision;BOOL present=FALSE,def=FALSE;PACL checked=NULL;
 if(!owner||!IsValidSid(owner)||!GetSecurityDescriptorControl(sd,&control,&revision)||!GetSecurityDescriptorDacl(sd,&present,&checked,&def)||!present||!acl||!IsValidAcl(acl))goto done;
 if(privacy==1){if(!EqualSid(owner,p->token->User.Sid)||!(control&SE_DACL_PROTECTED)||acl->AceCount!=1)goto done;}
 else if(!trusted(p,owner))goto done;
 GENERIC_MAPPING mapping={FILE_GENERIC_READ,FILE_GENERIC_WRITE,FILE_GENERIC_EXECUTE,FILE_ALL_ACCESS};
 for(DWORD i=0;i<acl->AceCount;i++) {
  ACE_HEADER *header=NULL;if(!GetAce(acl,i,(void **)&header))goto done;
  if(header->AceType!=ACCESS_ALLOWED_ACE_TYPE&&header->AceType!=ACCESS_DENIED_ACE_TYPE)goto done;
  if(header->AceSize<sizeof(ACCESS_ALLOWED_ACE))goto done;
  ACCESS_ALLOWED_ACE *ace=(ACCESS_ALLOWED_ACE *)header;PSID sid=&ace->SidStart;
  DWORD sid_space=header->AceSize-(DWORD)offsetof(ACCESS_ALLOWED_ACE,SidStart);
  if(sid_space<8||((SID *)sid)->SubAuthorityCount>(sid_space-8)/sizeof(DWORD)||!IsValidSid(sid)||GetLengthSid(sid)>sid_space)goto done;
  DWORD mask=ace->Mask;MapGenericMask(&mask,&mapping);
  if(privacy==1){unsigned flags=directory?OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE:0;if(header->AceType!=ACCESS_ALLOWED_ACE_TYPE||header->AceFlags!=flags||!EqualSid(sid,p->token->User.Sid)||mask!=FILE_ALL_ACCESS)goto done;continue;}
  if(header->AceType==ACCESS_DENIED_ACE_TYPE)continue;
  int safe=trusted(p,sid);
  if(parent&&(header->AceFlags&(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE))&&!safe&&!EqualSid(sid,p->creator))goto done;
  DWORD mutation=WRITE_DAC|WRITE_OWNER|DELETE|FILE_DELETE_CHILD|FILE_ADD_FILE|FILE_WRITE_ATTRIBUTES|FILE_WRITE_EA;
  if(privacy==2)mutation|=FILE_ADD_SUBDIRECTORY;
  if(!(header->AceFlags&INHERIT_ONLY_ACE)&&!safe&&(mask&mutation))goto done;
 }
 result=GB_OK;
 done:LocalFree(sd);return result;
}
int gb_validate(gb_policy *p,HANDLE h,const wchar_t *path,int privacy,int directory,gb_identity *id) {
 if(GetFileType(h)!=FILE_TYPE_DISK)return GB_UNSUPPORTED;
 FILE_ATTRIBUTE_TAG_INFO tag;FILE_STANDARD_INFO standard;BY_HANDLE_FILE_INFORMATION info;
 if(!GetFileInformationByHandleEx(h,FileAttributeTagInfo,&tag,sizeof tag)||!GetFileInformationByHandleEx(h,FileStandardInfo,&standard,sizeof standard)||!GetFileInformationByHandle(h,&info))return GB_UNSUPPORTED;
 if((tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||standard.DeletePending||!!standard.Directory!=!!directory||(!directory&&standard.NumberOfLinks!=1)||standard.EndOfFile.QuadPart<0)return GB_UNSAFE;
 wchar_t final[GB_PATH+4],expected[GB_PATH+4];DWORD n=GetFinalPathNameByHandleW(h,final,GB_PATH+4,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
 wcscpy(expected,L"\\\\?\\");wcscat(expected,path);
 if(!n||n>=GB_PATH+4||CompareStringOrdinal(final,-1,expected,-1,FALSE)!=CSTR_EQUAL)return GB_UNSAFE;
 wchar_t fs[32];DWORD flags=0;
 if(!GetVolumeInformationByHandleW(h,NULL,0,NULL,NULL,&flags,fs,32)||wcscmp(fs,L"NTFS")||!(flags&FILE_PERSISTENT_ACLS)||GetDriveTypeW((wchar_t[]){path[0],L':',L'\\',0})!=DRIVE_FIXED)return GB_UNSUPPORTED;
 int status=gb_security(p,h,privacy,directory,0);if(status)return status;
 id->volume=info.dwVolumeSerialNumber;id->index=((uint64_t)info.nFileIndexHigh<<32)|info.nFileIndexLow;id->size=(uint64_t)standard.EndOfFile.QuadPart;id->directory=directory;return GB_OK;
}
int gb_stable(gb_policy *p,HANDLE h,const wchar_t *path,int privacy,const gb_identity *id) {
 gb_identity after;int s=gb_validate(p,h,path,privacy,id->directory,&after);if(s)return s;
 return id->volume==after.volume&&id->index==after.index&&id->size==after.size?GB_OK:GB_UNSAFE;
}
void gb_chain_close(gb_chain *c) {for(size_t i=0;i<c->count;i++)CloseHandle(c->handles[i]);free(c->handles);memset(c,0,sizeof *c);}
int gb_open_chain(gb_policy *p,const wchar_t *path,int managed,int create,gb_chain *out) {
 memset(out,0,sizeof *out);if(!gb_path_valid(path,0))return GB_UNSAFE;
 out->handles=calloc(GB_CHAIN_MAX,sizeof(HANDLE));if(!out->handles)return GB_IO;
 size_t n=wcslen(path);wchar_t prefix[GB_PATH];int result=GB_OK;
 for(size_t end=3;;) {
  wmemcpy(prefix,path,end);prefix[end]=0;int final=end==n;
  HANDLE h=gb_open(prefix,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING,NULL);
  DWORD open_error=h==INVALID_HANDLE_VALUE?GetLastError():ERROR_SUCCESS;
  if(h==INVALID_HANDLE_VALUE&&(open_error==ERROR_FILE_NOT_FOUND||open_error==ERROR_PATH_NOT_FOUND)&&final&&create&&out->count) {
   result=gb_security(p,out->handles[out->count-1],0,1,1);if(result)goto fail;
   SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;result=gb_descriptor(p,1,&sd,acl,&sa);if(result)goto fail;
   wchar_t extended[GB_PATH+4];wcscpy(extended,L"\\\\?\\");wcscat(extended,prefix);
   if(!CreateDirectoryW(extended,&sa)&&GetLastError()!=ERROR_ALREADY_EXISTS){result=gb_error(GetLastError());goto fail;}
   h=gb_open(prefix,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING,NULL);
  }
  if(h==INVALID_HANDLE_VALUE){result=gb_error(GetLastError());goto fail;}
  gb_identity id;result=gb_validate(p,h,prefix,final?managed:0,1,&id);if(result){CloseHandle(h);goto fail;}
  if(out->count==GB_CHAIN_MAX){CloseHandle(h);result=GB_UNSAFE;goto fail;}out->handles[out->count++]=h;
  if(final)break;
  size_t next=end;if(next<n&&path[next]==L'\\')next++;while(next<n&&path[next]!=L'\\')next++;
  if(next<=end){result=GB_UNSAFE;goto fail;}end=next;
 }
 wcscpy(out->path,path);return GB_OK;
 fail:gb_chain_close(out);return result;
}
