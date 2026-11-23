#include "inventory.h"
#include <bcrypt.h>
#include <stdlib.h>
int gb_hash(gb_policy *p,HANDLE h,const wchar_t *path,const gb_identity *id,unsigned char digest[32],ULONGLONG deadline) {
 BCRYPT_ALG_HANDLE alg=NULL;BCRYPT_HASH_HANDLE hash=NULL;unsigned char *object=NULL;DWORD length=0,got=0;int status=GB_IO;
 if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)<0||BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,(PUCHAR)&length,sizeof length,&got,0)<0||length>1048576)goto done;
 object=calloc(1,length);if(!object||BCryptCreateHash(alg,&hash,object,length,NULL,0,0)<0)goto done;
 unsigned char buffer[65536];uint64_t total=0;
 for(;;){if(GetTickCount64()>deadline)goto done;DWORD n=0;if(!ReadFile(h,buffer,sizeof buffer,&n,NULL))goto done;if(!n)break;total+=n;if(total>id->size||BCryptHashData(hash,buffer,n,0)<0)goto done;}
 if(total!=id->size||BCryptFinishHash(hash,digest,32,0)<0)goto done;
 status=gb_stable(p,h,path,2,id);
 done:if(hash)BCryptDestroyHash(hash);if(alg)BCryptCloseAlgorithmProvider(alg,0);free(object);return status;
}
void gb_inventory_close(gb_inventory *s){for(size_t i=0;i<s->count;i++)free(s->entries[i].name);for(size_t i=0;i<s->directory_count;i++)CloseHandle(s->directories[i]);free(s->entries);free(s->directories);memset(s,0,sizeof *s);}
static int compare(const void *a,const void *b){const gb_entry *x=a,*y=b;int c=CompareStringOrdinal(x->name,-1,y->name,-1,TRUE);return c==CSTR_LESS_THAN?-1:c==CSTR_GREATER_THAN?1:0;}
static int walk_directory(gb_policy *p,const wchar_t *root,const wchar_t *relative,gb_inventory *s) {
 if(GetTickCount64()>s->deadline)return GB_UNSAFE;
 wchar_t full[GB_PATH],pattern[GB_PATH],native_relative[GB_PATH];wcscpy(native_relative,relative);
 for(wchar_t *c=native_relative;*c;c++){if(*c==L'/')*c=L'\\';}
 if(gb_join(full,root,native_relative)||gb_join(pattern,full,L"*"))return GB_UNSAFE;
 wchar_t extended[GB_PATH+4];wcscpy(extended,L"\\\\?\\");wcscat(extended,pattern);
 WIN32_FIND_DATAW data;HANDLE find=FindFirstFileW(extended,&data);if(find==INVALID_HANDLE_VALUE)return gb_error(GetLastError());int status=GB_OK;
 do {
  if(!wcscmp(data.cFileName,L".")||!wcscmp(data.cFileName,L".."))continue;
  if(s->count>=40000||GetTickCount64()>s->deadline){status=GB_UNSAFE;break;}
  wchar_t name[GB_PATH];size_t n=wcslen(relative),m=wcslen(data.cFileName);if(n+m+(n?1:0)>=GB_PATH){status=GB_UNSAFE;break;}
  wcscpy(name,relative);if(n)wcscat(name,L"/");wcscat(name,data.cFileName);
  if(!gb_path_valid(name,1)){status=GB_UNSAFE;break;}
  wchar_t child[GB_PATH];wcscpy(child,name);for(wchar_t *c=child;*c;c++)if(*c==L'/')*c=L'\\';if(gb_join(full,root,child)){status=GB_UNSAFE;break;}
  int dir=!!(data.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY);
  HANDLE h=gb_open(full,READ_CONTROL|FILE_READ_ATTRIBUTES|(dir?FILE_LIST_DIRECTORY:GENERIC_READ),FILE_SHARE_READ|(dir?FILE_SHARE_WRITE:0),OPEN_EXISTING,NULL);
  if(h==INVALID_HANDLE_VALUE){status=gb_error(GetLastError());break;}
  gb_entry *entry=&s->entries[s->count];status=gb_validate(p,h,full,2,dir,&entry->identity);
  if(!status&&!dir){if(++s->files>20000)status=GB_UNSAFE;else status=gb_hash(p,h,full,&entry->identity,entry->sha256,s->deadline);}
  if(!status){entry->name=_wcsdup(name);if(!entry->name)status=GB_IO;}
  if(status){CloseHandle(h);break;}
  s->count++;
  if(dir){s->directories[s->directory_count++]=h;}else CloseHandle(h);
  if(status)break;
 }while(FindNextFileW(find,&data));
 if(!status&&GetLastError()!=ERROR_NO_MORE_FILES){status=gb_error(GetLastError());}FindClose(find);return status;
}
int gb_inventory_start(gb_policy *p,gb_chain *root,gb_inventory *s) {
 memset(s,0,sizeof *s);s->entries=calloc(40000,sizeof(gb_entry));s->directories=calloc(40000,sizeof(HANDLE));s->deadline=GetTickCount64()+60000;
 if(!s->entries||!s->directories){gb_inventory_close(s);return GB_IO;}
 int status=walk_directory(p,root->path,L"",s);
 /* Bounded breadth-first inventory avoids stack depth proportional to paths.
  * Every selected directory handle stays open through the final page. */
 size_t directory=0;
 for(size_t i=0;!status&&i<s->count;i++)if(s->entries[i].identity.directory){
  gb_entry *entry=&s->entries[i];wchar_t relative[GB_PATH],full[GB_PATH];wcscpy(relative,entry->name);
  for(wchar_t *c=relative;*c;c++){if(*c==L'/')*c=L'\\';}
  if(gb_join(full,root->path,relative)){status=GB_UNSAFE;break;}
  HANDLE h=s->directories[directory++];status=gb_stable(p,h,full,2,&entry->identity);
  if(!status)status=walk_directory(p,root->path,entry->name,s);
  if(!status)status=gb_stable(p,h,full,2,&entry->identity);
 }
 if(status){gb_inventory_close(s);return status;}
 qsort(s->entries,s->count,sizeof(gb_entry),compare);
 for(size_t i=1;i<s->count;i++)if(compare(&s->entries[i-1],&s->entries[i])==0){gb_inventory_close(s);return GB_UNSAFE;}
 return GB_OK;
}
int gb_inventory_page(gb_inventory *s,uint32_t cursor,uint32_t next,gb_buf *out) {
 if(!s->entries||cursor!=s->cursor||GetTickCount64()>s->deadline)return GB_PROTOCOL;
 size_t count=0,budget=out->n-out->i;
 if(budget<8)return GB_PROTOCOL;
 budget-=8;
 while(s->offset+count<s->count&&count<256){
  size_t bound=wcslen(s->entries[s->offset+count].name)*3+57;
  if(bound>budget)break;
  budget-=bound;count++;
 }
 if(!count&&s->offset<s->count)return GB_PROTOCOL;
 int more=s->offset+count<s->count;
 gb_w32(out,more?next:0);gb_w32(out,(uint32_t)count);
 for(size_t i=0;i<count;i++) {gb_entry *e=&s->entries[s->offset+i];unsigned char kind=e->identity.directory?1:2;gb_write(out,&kind,1);gb_write_string(out,e->name);gb_w32(out,e->identity.volume);gb_w64(out,e->identity.index);gb_w64(out,e->identity.directory?0:e->identity.size);gb_write(out,e->sha256,32);}
 if(out->bad){return GB_PROTOCOL;}s->offset+=count;s->cursor=more?next:0;return GB_OK;
}
