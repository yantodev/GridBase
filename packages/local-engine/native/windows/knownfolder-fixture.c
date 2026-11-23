/* Native-only test TU compiles the UNMODIFIED filesystem production source.
 * The fixed KnownFolder path is exercised only in a PREPROVISIONED DISPOSABLE
 * user profile; caller must explicitly attest this at the test runner. This
 * does not redirect KnownFolder with environment variables or production hooks.
 * optional argv1: preprovisioned fixture-owned SYSTEM/Admin-owned directory,
 * read-only checked for ancestor acceptance and managed-root refusal. */
#define wmain gb_private_fixture_entry
#include "private-files.c"
#undef wmain
#include "fixture-common.h"
int wmain(int argc,wchar_t **argv) {
 FX_REQUIRE(argc==1||argc==2);session *s=calloc(1,sizeof *s);FX_REQUIRE(s&&gb_policy_init(&s->policy)==GB_OK);
 PWSTR local=NULL;FX_REQUIRE(SUCCEEDED(SHGetKnownFolderPath(&FOLDERID_LocalAppData,0,NULL,&local)));
 wchar_t expected[GB_PATH];FX_REQUIRE(!gb_join(expected,local,L"GridBaseDesktop"));CoTaskMemFree(local);
 unsigned char first[65536],second[65536];gb_buf a={first,sizeof first,0,0},b={second,sizeof second,0,0};
 FX_REQUIRE(desktop(s,&a)==GB_OK&&!a.bad);gb_chain root;FX_REQUIRE(gb_open_chain(&s->policy,expected,1,0,&root)==GB_OK);
 const wchar_t *children[]={L"engine-data",L"engine-temp",L"chromium"};gb_buf in={first,a.i,0,0};
 for(unsigned i=0;i<3;i++) {wchar_t path[GB_PATH],result[GB_PATH];FX_REQUIRE(!gb_join(path,expected,children[i]));FX_REQUIRE(gb_read_string(&in,result,0)==GB_OK&&!wcscmp(result,path));gb_chain c;FX_REQUIRE(gb_open_chain(&s->policy,path,1,0,&c)==GB_OK);gb_chain_close(&c);}
 FX_REQUIRE(gb_done(&in));DWORD n=0;unsigned char *before=fx_descriptor(root.handles[root.count-1],&n);FX_REQUIRE(before);
 FX_REQUIRE(desktop(s,&b)==GB_OK&&a.i==b.i&&!memcmp(first,second,a.i)&&fx_unchanged(root.handles[root.count-1],before,n));free(before);
 wchar_t ancestor[GB_PATH],sddl[1024];FX_REQUIRE(fx_directory(&s->policy,expected,L"fixture-trusted-ancestor",ancestor));LPWSTR user=NULL;FX_REQUIRE(ConvertSidToStringSidW(s->policy.token->User.Sid,&user));
 swprintf(sddl,1024,L"D:P(A;OICI;FA;;;%ls)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;GRGX;;;WD)",user);LocalFree(user);FX_REQUIRE(fx_acl(ancestor,sddl));
 HANDLE h=fx_open(ancestor,FILE_LIST_DIRECTORY|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,OPEN_EXISTING);FX_REQUIRE(h!=INVALID_HANDLE_VALUE);
 FX_REQUIRE(gb_security(&s->policy,h,0,1,0)==GB_OK);FX_REQUIRE(gb_security(&s->policy,h,0,1,1)==GB_OK);FX_REQUIRE(gb_security(&s->policy,h,1,1,0)==GB_UNSAFE);
 DWORD length=0;unsigned char *sd=fx_descriptor(h,&length);FX_REQUIRE(sd&&fx_unchanged(h,sd,length));free(sd);CloseHandle(h);FX_REQUIRE(RemoveDirectoryW(ancestor));
 if(argc==2){gb_chain trusted;FX_REQUIRE(gb_open_chain(&s->policy,argv[1],0,0,&trusted)==GB_OK);HANDLE th=trusted.handles[trusted.count-1];PSECURITY_DESCRIPTOR tsd=NULL;PSID owner=NULL;PACL acl=NULL;
  FX_REQUIRE(GetSecurityInfo(th,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,NULL,&acl,NULL,&tsd)==ERROR_SUCCESS);
  FX_REQUIRE(EqualSid(owner,s->policy.system)||EqualSid(owner,s->policy.admins)||EqualSid(owner,s->policy.installer));LocalFree(tsd);length=0;sd=fx_descriptor(th,&length);FX_REQUIRE(sd);
  FX_REQUIRE(gb_security(&s->policy,th,1,1,0)==GB_UNSAFE&&fx_unchanged(th,sd,length));free(sd);gb_chain_close(&trusted);
 }
 gb_chain_close(&root);gb_policy_free(&s->policy);free(s);puts("NATIVE_KNOWNFOLDER_MATRIX_OK");return 0;
}
