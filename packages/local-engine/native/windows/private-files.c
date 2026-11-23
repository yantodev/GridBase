/* Native Windows filesystem candidate. stdin/stdout only binary RPC; no raw
 * bootstrap, commands, environment paths, diagnostics, ACL repair or DPAPI. */
#include "inventory.h"
#include <shlobj.h>
#include <knownfolders.h>
#include <stdlib.h>
#define GB_OBJECTS 128
static const wchar_t KEY[]=L"credential-key.v1",CLAIM[]=L".credential-key.init",CONSENT[]=L"key-consent.v1.json";
typedef struct { uint32_t id,root; int kind,read; gb_chain chain; HANDLE claim; gb_identity identity; gb_inventory inventory; } object;
typedef struct { gb_policy policy; object objects[GB_OBJECTS]; uint32_t next,cursor; ULONGLONG deadline; } session;
static HANDLE session_stop;
static DWORD WINAPI session_deadline(void *unused){(void)unused;if(WaitForSingleObject(session_stop,120000)!=WAIT_OBJECT_0)ExitProcess(6);return 0;}
static object *lookup(session *s,uint32_t id,int kind){for(unsigned i=0;i<GB_OBJECTS;i++)if(s->objects[i].id==id&&s->objects[i].kind==kind)return &s->objects[i];return NULL;}
static object *allocate(session *s,int kind){if(!s->next||s->next==UINT32_MAX)return NULL;for(unsigned i=0;i<GB_OBJECTS;i++)if(!s->objects[i].id){object *o=&s->objects[i];memset(o,0,sizeof *o);o->kind=kind;o->id=s->next++;return o;}return NULL;}
static void close_object(object *o){if(o->claim&&o->claim!=INVALID_HANDLE_VALUE)CloseHandle(o->claim);gb_chain_close(&o->chain);gb_inventory_close(&o->inventory);memset(o,0,sizeof *o);}
static int root_check(session *s,object *root){gb_identity id;return gb_validate(&s->policy,root->chain.handles[root->chain.count-1],root->chain.path,1,1,&id);}
static int snapshot(session *s,object *root,unsigned char flags[5]) {
 int status=root_check(s,root);if(status)return status;memset(flags,0,5);
 wchar_t pattern[GB_PATH];if(gb_join(pattern,root->chain.path,L"*"))return GB_UNSAFE;
 wchar_t extended[GB_PATH+4];wcscpy(extended,L"\\\\?\\");wcscat(extended,pattern);WIN32_FIND_DATAW data;
 HANDLE find=FindFirstFileW(extended,&data);if(find==INVALID_HANDLE_VALUE)return gb_error(GetLastError());unsigned count=0;
 do {if(!wcscmp(data.cFileName,L".")||!wcscmp(data.cFileName,L".."))continue;if(++count>40000){status=GB_UNSAFE;break;}
  const wchar_t *names[]={KEY,CLAIM,CONSENT};int selected=-1;
  for(int i=0;i<3;i++)if(!_wcsicmp(data.cFileName,names[i])){selected=i;if(wcscmp(data.cFileName,names[i]))flags[4]=1;break;}
  if(data.cAlternateFileName[0]){for(int i=0;i<3;i++)if(!_wcsicmp(data.cAlternateFileName,names[i]))flags[4]=1;}
  if(selected<0)flags[3]=1;else flags[selected]=1;
  if(data.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT){status=GB_UNSAFE;break;}
  if(selected>=0){
   wchar_t entry_path[GB_PATH];if(gb_join(entry_path,root->chain.path,data.cFileName)){status=GB_UNSAFE;break;}
   /* Snapshot is nonsecret metadata. Share existing claim owner's WRITE/DELETE
    * access only for this short read-control probe; never use it to read a key
    * or pin a path. The retained root chain is the namespace authority. */
   HANDLE check=gb_open(entry_path,READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING,NULL);
   if(check==INVALID_HANDLE_VALUE){status=gb_error(GetLastError());break;}
   gb_identity identity;status=gb_validate(&s->policy,check,entry_path,1,0,&identity);CloseHandle(check);
   if(status)break;
  }
 }while(FindNextFileW(find,&data));
 if(!status&&GetLastError()!=ERROR_NO_MORE_FILES){status=gb_error(GetLastError());}
 FindClose(find);if(flags[4])return GB_UNSAFE;return status?status:root_check(s,root);
}
static int key_read(session *s,object *root,gb_buf *out,int mark) {
 wchar_t path[GB_PATH];if(gb_join(path,root->chain.path,KEY))return GB_UNSAFE;int status=root_check(s,root);if(status)return status;
 HANDLE h=gb_open(path,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,OPEN_EXISTING,NULL);if(h==INVALID_HANDLE_VALUE)return gb_error(GetLastError());
 gb_identity id;status=gb_validate(&s->policy,h,path,1,0,&id);
 unsigned char bytes[65537];DWORD n=0,total=0;
 if(!status&&id.size>65536)status=GB_UNSAFE;
 while(!status&&total<sizeof bytes){if(!ReadFile(h,bytes+total,(DWORD)sizeof bytes-total,&n,NULL)){status=GB_IO;break;}if(!n)break;total+=n;}
 if(!status&&total!=id.size)status=GB_UNSAFE;
 if(!status){status=gb_stable(&s->policy,h,path,1,&id);}CloseHandle(h);
 if(!status)status=root_check(s,root);
 if(!status){if(out){gb_w32(out,total);gb_write(out,bytes,total);}if(mark)for(unsigned i=0;i<GB_OBJECTS;i++)if(s->objects[i].kind==3&&s->objects[i].root==root->id)s->objects[i].read=1;}
 SecureZeroMemory(bytes,sizeof bytes);return status;
}
static int begin_claim(session *s,object *root,gb_buf *out) {
 int status=root_check(s,root);if(status)return status;wchar_t path[GB_PATH];if(gb_join(path,root->chain.path,CLAIM))return GB_UNSAFE;
 object *claim=allocate(s,3);if(!claim)return GB_PROTOCOL;
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;status=gb_descriptor(&s->policy,0,&sd,acl,&sa);if(status){close_object(claim);return status;}
 claim->claim=gb_open(path,GENERIC_READ|GENERIC_WRITE|READ_CONTROL|DELETE,FILE_SHARE_READ,CREATE_NEW,&sa);
 if(claim->claim==INVALID_HANDLE_VALUE){status=gb_error(GetLastError());if(status==GB_EXISTS)status=GB_INITIALIZING;close_object(claim);return status;}
 claim->root=root->id;status=gb_validate(&s->policy,claim->claim,path,1,0,&claim->identity);
 unsigned char flags[5];if(!status)status=snapshot(s,root,flags);
 /* Post-exclusive snapshot is mandatory. A late winner's existing key is
  * reopened by the host; no create can overwrite it. Failed claims stay. */
 if(!status&&(!flags[1]||(!flags[0]&&(flags[2]||flags[3]))))status=GB_UNSAFE;
 if(!status)gb_w32(out,claim->id);else close_object(claim);return status;
}
static int create_key(session *s,object *root,object *claim,gb_buf *in) {
 uint32_t length=gb_u32(in);unsigned char *bytes=gb_take(in,length);if(length>65536||!bytes||!gb_done(in))return GB_PROTOCOL;
 int status=root_check(s,root);wchar_t path[GB_PATH],held[GB_PATH];if(status)return status;
 if(gb_join(path,root->chain.path,KEY)||gb_join(held,root->chain.path,CLAIM))return GB_UNSAFE;
 status=gb_stable(&s->policy,claim->claim,held,1,&claim->identity);if(status)return status;
 unsigned char flags[5];status=snapshot(s,root,flags);if(status)return status;if(flags[0])return GB_EXISTS;if(flags[2]||flags[3]||!flags[1])return GB_UNSAFE;
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;status=gb_descriptor(&s->policy,0,&sd,acl,&sa);if(status)return status;
 HANDLE h=gb_open(path,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,0,CREATE_NEW,&sa);if(h==INVALID_HANDLE_VALUE)return gb_error(GetLastError());
 gb_identity id;status=gb_validate(&s->policy,h,path,1,0,&id);DWORD total=0;
 while(!status&&total<length){DWORD n=0;if(!WriteFile(h,bytes+total,length-total,&n,NULL)||!n){status=GB_IO;break;}total+=n;}
 if(!status&&!FlushFileBuffers(h))status=GB_IO;
 if(!status){LARGE_INTEGER zero;zero.QuadPart=0;unsigned char check[65537];DWORD got=0;
  if(!SetFilePointerEx(h,zero,NULL,FILE_BEGIN)||!ReadFile(h,check,length+1,&got,NULL)||got!=length||memcmp(check,bytes,length))status=GB_IO;
  SecureZeroMemory(check,sizeof check);
 }
 if(!status){gb_identity after;status=gb_validate(&s->policy,h,path,1,0,&after);if(!status&&(after.volume!=id.volume||after.index!=id.index||after.size!=length))status=GB_UNSAFE;}
 CloseHandle(h);claim->read=0;return status?status:root_check(s,root);
}
static int finish_claim(session *s,object *root,object *claim) {
 if(!claim->read){return GB_PROTOCOL;}int status=key_read(s,root,NULL,0);wchar_t path[GB_PATH];if(status)return status;
 if(gb_join(path,root->chain.path,CLAIM)){return GB_UNSAFE;}status=gb_stable(&s->policy,claim->claim,path,1,&claim->identity);if(status)return status;
 FILE_DISPOSITION_INFO info={TRUE};if(!SetFileInformationByHandle(claim->claim,FileDispositionInfo,&info,sizeof info))return gb_error(GetLastError());close_object(claim);return GB_OK;
}
static int open_root(session *s,const wchar_t *path,int kind,gb_buf *out) {
 object *o=allocate(s,kind);if(!o)return GB_PROTOCOL;int status=gb_open_chain(&s->policy,path,kind==1?1:2,kind==1,&o->chain);
 if(status){close_object(o);return status;}gb_w32(out,o->id);return GB_OK;
}
static int desktop(session *s,gb_buf *out) {
 PWSTR local=NULL;if(FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData,0,NULL,&local)))return GB_UNSUPPORTED;
 wchar_t base[GB_PATH];int status=gb_join(base,local,L"GridBaseDesktop");CoTaskMemFree(local);if(status)return status;
 gb_chain chain;status=gb_open_chain(&s->policy,base,1,1,&chain);if(status)return status;
 const wchar_t *names[]={L"engine-data",L"engine-temp",L"chromium"};
 for(unsigned i=0;i<3&&!status;i++){wchar_t path[GB_PATH];status=gb_join(path,base,names[i]);gb_chain child;if(!status){status=gb_open_chain(&s->policy,path,1,1,&child);if(!status){gb_write_string(out,path);gb_chain_close(&child);}}}
 gb_chain_close(&chain);return status;
}
static int bundle_read(session *s,object *bundle,gb_buf *in,gb_buf *out) {
 wchar_t relative[GB_PATH],path[GB_PATH];int status=gb_read_string(in,relative,1);uint32_t max=gb_u32(in);if(!gb_done(in)||!max||max>1048576)return GB_PROTOCOL;if(status)return status;
 for(wchar_t *c=relative;*c;c++){if(*c==L'/')*c=L'\\';}
 if(gb_join(path,bundle->chain.path,relative))return GB_UNSAFE;
 wchar_t parent[GB_PATH];wcscpy(parent,path);wchar_t *end=wcsrchr(parent,L'\\');if(!end)return GB_UNSAFE;*end=0;
 gb_chain chain;status=gb_open_chain(&s->policy,parent,2,0,&chain);if(status)return status;
 HANDLE h=gb_open(path,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,OPEN_EXISTING,NULL);if(h==INVALID_HANDLE_VALUE){gb_chain_close(&chain);return gb_error(GetLastError());}
 gb_identity id;status=gb_validate(&s->policy,h,path,2,0,&id);if(!status&&id.size>max)status=GB_UNSAFE;
 unsigned char *bytes=NULL;DWORD total=0;if(!status){bytes=malloc((size_t)id.size+1);if(!bytes)status=GB_IO;}
 while(!status&&total<=id.size){DWORD n=0;if(!ReadFile(h,bytes+total,(DWORD)id.size+1-total,&n,NULL)){status=GB_IO;break;}if(!n)break;total+=n;}
 if(!status&&total!=id.size){status=GB_UNSAFE;}if(!status)status=gb_stable(&s->policy,h,path,2,&id);
 if(!status){gb_w32(out,total);gb_write(out,bytes,total);}free(bytes);CloseHandle(h);gb_chain_close(&chain);return status;
}
static int dispatch(session *s,uint16_t op,gb_buf *in,gb_buf *out) {
 if(GetTickCount64()>s->deadline)return GB_IO;
 if(op==1){if(!gb_done(in))return GB_PROTOCOL;return desktop(s,out);}
 if(op==2||op==8){wchar_t path[GB_PATH];int status=gb_read_string(in,path,0);if(!gb_done(in))return GB_PROTOCOL;return status?status:open_root(s,path,op==2?1:2,out);}
 if(op==13)return gb_done(in)?GB_OK:GB_PROTOCOL;
 uint32_t id=gb_u32(in);object *o=lookup(s,id,(op==9||op==10||op==12)?2:1);if(!o)return GB_PROTOCOL;
 if(op==6||op==7){uint32_t claim_id=gb_u32(in);object *claim=lookup(s,claim_id,3);if(!claim||claim->root!=id)return GB_PROTOCOL;if(op==6)return create_key(s,o,claim,in);if(!gb_done(in))return GB_PROTOCOL;return finish_claim(s,o,claim);}
 if(op==9)return bundle_read(s,o,in,out);
 if(op==10){uint32_t cursor=gb_u32(in);if(!gb_done(in))return GB_PROTOCOL;if(!cursor){if(o->inventory.entries)return GB_PROTOCOL;int status=gb_inventory_start(&s->policy,&o->chain,&o->inventory);if(status)return status;}if(!s->cursor||s->cursor==UINT32_MAX)return GB_PROTOCOL;return gb_inventory_page(&o->inventory,cursor,s->cursor++,out);}
 if(!gb_done(in))return GB_PROTOCOL;
 if(op==3){unsigned char flags[5];int status=snapshot(s,o,flags);if(!status)gb_write(out,flags,5);return status;}
 if(op==4)return begin_claim(s,o,out);
 if(op==5)return key_read(s,o,out,1);
 if(op==11||op==12){for(unsigned i=0;i<GB_OBJECTS;i++)if(s->objects[i].root==id)close_object(&s->objects[i]);close_object(o);return GB_OK;}
 return GB_PROTOCOL;
}
static int read_exact(HANDLE h,unsigned char *b,DWORD n){DWORD total=0;while(total<n){DWORD got=0;if(!ReadFile(h,b+total,n-total,&got,NULL)||!got)return 0;total+=got;}return 1;}
static int write_exact(HANDLE h,const unsigned char *b,DWORD n){DWORD total=0;while(total<n){DWORD got=0;if(!WriteFile(h,b+total,n-total,&got,NULL)||!got)return 0;total+=got;}return 1;}
int wmain(int argc,wchar_t **argv) {
 (void)argv;if(argc!=1)return 7;SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);if(!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32))return 5;
 session *s=calloc(1,sizeof *s);if(!s)return 6;int init=gb_policy_init(&s->policy);if(init){gb_policy_free(&s->policy);free(s);return init;}
 s->next=1;s->cursor=1;s->deadline=GetTickCount64()+120000;
 session_stop=CreateEventW(NULL,TRUE,FALSE,NULL);HANDLE watchdog=session_stop?CreateThread(NULL,0,session_deadline,NULL,0,NULL):NULL;
 if(!watchdog){gb_policy_free(&s->policy);free(s);if(session_stop)CloseHandle(session_stop);return 6;}
 HANDLE input=GetStdHandle(STD_INPUT_HANDLE),output=GetStdHandle(STD_OUTPUT_HANDLE);uint32_t last=0;
 unsigned char *request=malloc(GB_FRAME_MAX+4),*response=malloc(GB_FRAME_MAX+4);int result=0;
 if(!request||!response){result=6;goto done;}
 for(;;){if(!read_exact(input,request,4))break;uint32_t length=gb_le32(request);if(length<8||length>GB_FRAME_MAX){result=7;break;}if(!read_exact(input,request+4,length)){result=7;break;}
  uint16_t op;uint32_t id;if(!gb_header(request,length+4,&op,&id)||id<=last||op<1||op>13){result=7;break;}last=id;
  gb_buf in={request+12,length-8,0,0},out={response+12,GB_FRAME_MAX-8,0,0};int status=dispatch(s,op,&in,&out);if(out.bad)status=GB_PROTOCOL;if(status)out.i=0;
  gb_put32(response,(uint32_t)out.i+8);response[4]=1;response[5]=0;response[6]=(unsigned char)status;response[7]=0;gb_put32(response+8,id);
  SecureZeroMemory(request,length+4);if(!write_exact(output,response,(DWORD)out.i+12)){result=6;break;}SecureZeroMemory(response,out.i+12);if(op==13||status==GB_PROTOCOL)break;
 }
 done:for(unsigned i=0;i<GB_OBJECTS;i++)close_object(&s->objects[i]);gb_policy_free(&s->policy);free(s);if(request){SecureZeroMemory(request,GB_FRAME_MAX+4);free(request);}if(response){SecureZeroMemory(response,GB_FRAME_MAX+4);free(response);}SetEvent(session_stop);WaitForSingleObject(watchdog,INFINITE);CloseHandle(watchdog);CloseHandle(session_stop);return result;
}
