/* I2 identity and no-reparse matrix. All generated objects are disposable.
 * Symlink creation requires a runner already permitted to create symlinks;
 * this program does not enable privileges/developer mode. Native prerequisite
 * failure is nonzero, never silently skips assertions.
 * usage: identity-fixture.exe FRESH_ROOT [PREPROVISIONED_MOUNT PREPROVISIONED_OTHER_REPARSE]
 * Optional preprovisioned paths must be children of this fixture-owned root,
 * must exist before the command and are inspected READ ONLY and unchanged. */
#include "fixture-common.h"
#include <winioctl.h>
static int private_file(gb_policy *p,const wchar_t *path) {
 SECURITY_DESCRIPTOR sd;unsigned char acl[256];SECURITY_ATTRIBUTES sa;
 if(gb_descriptor(p,0,&sd,acl,&sa)!=GB_OK)return 0;
 HANDLE h=gb_open(path,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,CREATE_NEW,&sa);
 if(h==INVALID_HANDLE_VALUE)return 0;
 DWORD wrote=0;int ok=WriteFile(h,"synthetic",9,&wrote,NULL)&&wrote==9;CloseHandle(h);return ok;
}
static int refused_directory(gb_policy *p,const wchar_t *path) {
 gb_chain c;int status=gb_open_chain(p,path,1,0,&c);if(status==GB_OK)gb_chain_close(&c);return status==GB_UNSAFE;
}
/* Documented mount-point data layout; no NtCreateFile/private flag claims. */
typedef struct { DWORD tag;WORD data_length,reserved,substitute_offset,substitute_length,print_offset,print_length;wchar_t path[GB_PATH*2+8]; } junction_buffer;
static int junction(const wchar_t *path,const wchar_t *target) {
 if(!CreateDirectoryW(path,NULL))return 0;
 HANDLE h=fx_open(path,GENERIC_WRITE,0,OPEN_EXISTING);if(h==INVALID_HANDLE_VALUE)return 0;
 junction_buffer *b=calloc(1,sizeof *b);if(!b){CloseHandle(h);return 0;}
 b->tag=IO_REPARSE_TAG_MOUNT_POINT;wcscpy(b->path,L"\\??\\");wcscat(b->path,target);
 size_t substitute=wcslen(b->path),print=wcslen(target);wcscpy(b->path+substitute+1,target);
 b->substitute_length=(WORD)(substitute*sizeof(wchar_t));b->print_offset=(WORD)((substitute+1)*sizeof(wchar_t));b->print_length=(WORD)(print*sizeof(wchar_t));
 b->data_length=(WORD)(8+(substitute+print+2)*sizeof(wchar_t));DWORD returned=0;
 int ok=DeviceIoControl(h,FSCTL_SET_REPARSE_POINT,b,(DWORD)b->data_length+8,NULL,0,&returned,NULL);free(b);CloseHandle(h);return ok;
}
static int inspect_preprovisioned(gb_policy *p,const wchar_t *root,const wchar_t *path,int mount) {
 size_t n=wcslen(root);FX_REQUIRE(wcslen(path)>n+1&&!wcsncmp(root,path,n)&&path[n]==L'\\'&&gb_path_valid(path,0));
 wchar_t parent[GB_PATH];wcscpy(parent,path);wchar_t *leaf=wcsrchr(parent,L'\\');FX_REQUIRE(leaf);*leaf=0;
 gb_chain ancestors;FX_REQUIRE(gb_open_chain(p,parent,1,0,&ancestors)==GB_OK);
 HANDLE h=fx_open(path,READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING);FX_REQUIRE(h!=INVALID_HANDLE_VALUE);
 FILE_ATTRIBUTE_TAG_INFO before,after;FX_REQUIRE(GetFileInformationByHandleEx(h,FileAttributeTagInfo,&before,sizeof before));
 FX_REQUIRE(before.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);
 FX_REQUIRE(mount?before.ReparseTag==IO_REPARSE_TAG_MOUNT_POINT:(before.ReparseTag!=IO_REPARSE_TAG_MOUNT_POINT&&before.ReparseTag!=IO_REPARSE_TAG_SYMLINK));
 if(mount){wchar_t mounted[GB_PATH+1],volume[MAX_PATH];wcscpy(mounted,path);wcscat(mounted,L"\\");FX_REQUIRE(GetVolumeNameForVolumeMountPointW(mounted,volume,MAX_PATH)&&!wcsncmp(volume,L"\\\\?\\Volume{",11));}
 unsigned char reparse_before[MAXIMUM_REPARSE_DATA_BUFFER_SIZE],reparse_after[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];DWORD bn=0,an=0;
 FX_REQUIRE(DeviceIoControl(h,FSCTL_GET_REPARSE_POINT,NULL,0,reparse_before,sizeof reparse_before,&bn,NULL));
 DWORD sd_length=0;unsigned char *sd=fx_descriptor(h,&sd_length);FX_REQUIRE(sd);
 gb_identity id;FX_REQUIRE(gb_validate(p,h,path,1,!!(before.FileAttributes&FILE_ATTRIBUTE_DIRECTORY),&id)==GB_UNSAFE);
 if(before.FileAttributes&FILE_ATTRIBUTE_DIRECTORY){wchar_t child[GB_PATH];FX_REQUIRE(!gb_join(child,path,L"must-not-create"));DWORD old_attributes=GetFileAttributesW(child),old_error=GetLastError();gb_chain rejected;int status=gb_open_chain(p,child,1,1,&rejected);if(status==GB_OK)gb_chain_close(&rejected);FX_REQUIRE(status==GB_UNSAFE);DWORD new_attributes=GetFileAttributesW(child),new_error=GetLastError();FX_REQUIRE(old_attributes==new_attributes&&(old_attributes!=INVALID_FILE_ATTRIBUTES||old_error==new_error));}
 FX_REQUIRE(GetFileInformationByHandleEx(h,FileAttributeTagInfo,&after,sizeof after)&&!memcmp(&before,&after,sizeof before));
 FX_REQUIRE(DeviceIoControl(h,FSCTL_GET_REPARSE_POINT,NULL,0,reparse_after,sizeof reparse_after,&an,NULL)&&an==bn&&!memcmp(reparse_before,reparse_after,bn));
 FX_REQUIRE(fx_unchanged(h,sd,sd_length));free(sd);CloseHandle(h);gb_chain_close(&ancestors);return 0;
}
int wmain(int argc,wchar_t **argv) {
 FX_REQUIRE((argc==2||argc==4)&&gb_path_valid(argv[1],0));gb_policy p;FX_REQUIRE(gb_policy_init(&p)==GB_OK);
 gb_chain root;FX_REQUIRE(gb_open_chain(&p,argv[1],1,1,&root)==GB_OK);
 wchar_t pinned[GB_PATH],renamed[GB_PATH];FX_REQUIRE(fx_directory(&p,argv[1],L"pinned-ancestor",pinned));FX_REQUIRE(!gb_join(renamed,argv[1],L"must-not-rename"));
 gb_chain pin;FX_REQUIRE(gb_open_chain(&p,pinned,1,0,&pin)==GB_OK);gb_identity pinned_id;FX_REQUIRE(gb_validate(&p,pin.handles[pin.count-1],pinned,1,1,&pinned_id)==GB_OK);
 FX_REQUIRE(!MoveFileExW(pinned,renamed,0)&&GetLastError()==ERROR_SHARING_VIOLATION);FX_REQUIRE(gb_stable(&p,pin.handles[pin.count-1],pinned,1,&pinned_id)==GB_OK);
 gb_chain_close(&pin);FX_REQUIRE(RemoveDirectoryW(pinned));
 wchar_t file[GB_PATH],moved[GB_PATH],alias[GB_PATH],target[GB_PATH],symlink_dir[GB_PATH],symlink_file[GB_PATH],junction_dir[GB_PATH],inside[GB_PATH];
 FX_REQUIRE(!gb_join(file,argv[1],L"IdentityCase.bin")&&!gb_join(moved,argv[1],L"identity-moved.bin")&&!gb_join(alias,argv[1],L"identitycase.bin"));
 FX_REQUIRE(private_file(&p,file));HANDLE old=fx_open(file,GENERIC_READ|READ_CONTROL|DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);FX_REQUIRE(old!=INVALID_HANDLE_VALUE);
 gb_identity before,now;FX_REQUIRE(gb_validate(&p,old,file,1,0,&before)==GB_OK);
 HANDLE mixed=fx_open(alias,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);FX_REQUIRE(mixed!=INVALID_HANDLE_VALUE);
 FX_REQUIRE(gb_validate(&p,mixed,alias,1,0,&now)==GB_UNSAFE);CloseHandle(mixed);
 FX_REQUIRE(MoveFileExW(file,moved,0)&&private_file(&p,file));
 HANDLE replacement=fx_open(file,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);FX_REQUIRE(replacement!=INVALID_HANDLE_VALUE);
 FX_REQUIRE(gb_validate(&p,replacement,file,1,0,&now)==GB_OK&&(now.volume!=before.volume||now.index!=before.index));FX_REQUIRE(gb_stable(&p,replacement,file,1,&before)==GB_UNSAFE);
 BY_HANDLE_FILE_INFORMATION old_info;FX_REQUIRE(GetFileInformationByHandle(old,&old_info));FX_REQUIRE((((uint64_t)old_info.nFileIndexHigh<<32)|old_info.nFileIndexLow)==before.index);
 FILE_DISPOSITION_INFO deletion={TRUE};FX_REQUIRE(SetFileInformationByHandle(old,FileDispositionInfo,&deletion,sizeof deletion));
 FX_REQUIRE(gb_validate(&p,old,moved,1,0,&now)==GB_UNSAFE);CloseHandle(old);
 FX_REQUIRE(GetFileAttributesW(file)!=INVALID_FILE_ATTRIBUTES);CloseHandle(replacement);FX_REQUIRE(DeleteFileW(file));
 FX_REQUIRE(fx_directory(&p,argv[1],L"target",target));FX_REQUIRE(!gb_join(inside,target,L"inside"));FX_REQUIRE(private_file(&p,inside));
 FX_REQUIRE(!gb_join(symlink_dir,argv[1],L"symlink-dir")&&!gb_join(symlink_file,argv[1],L"symlink-file")&&!gb_join(junction_dir,argv[1],L"junction"));
 FX_REQUIRE(CreateSymbolicLinkW(symlink_dir,target,SYMBOLIC_LINK_FLAG_DIRECTORY|SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE));
 FX_REQUIRE(CreateSymbolicLinkW(symlink_file,inside,SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE));
 FX_REQUIRE(junction(junction_dir,target));
 const wchar_t *dirs[]={symlink_dir,junction_dir};
 for(unsigned i=0;i<2;i++) {
  FX_REQUIRE(refused_directory(&p,dirs[i]));wchar_t descendant[GB_PATH];FX_REQUIRE(!gb_join(descendant,dirs[i],L"new-child"));gb_chain c;int status=gb_open_chain(&p,descendant,1,1,&c);if(status==GB_OK)gb_chain_close(&c);FX_REQUIRE(status==GB_UNSAFE);
  wchar_t absent[GB_PATH];FX_REQUIRE(!gb_join(absent,target,L"new-child"));FX_REQUIRE(GetFileAttributesW(absent)==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND);
 }
 HANDLE link=fx_open(symlink_file,READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,OPEN_EXISTING);FX_REQUIRE(link!=INVALID_HANDLE_VALUE&&gb_validate(&p,link,symlink_file,1,0,&now)==GB_UNSAFE);CloseHandle(link);
 if(argc==4){FX_REQUIRE(inspect_preprovisioned(&p,argv[1],argv[2],1)==0);FX_REQUIRE(inspect_preprovisioned(&p,argv[1],argv[3],0)==0);}
 FX_REQUIRE(DeleteFileW(symlink_file)&&RemoveDirectoryW(symlink_dir)&&RemoveDirectoryW(junction_dir)&&DeleteFileW(inside)&&RemoveDirectoryW(target));
 gb_chain_close(&root);gb_policy_free(&p);puts("NATIVE_IDENTITY_MATRIX_OK");return 0;
}
