#ifndef GB_POLICY_H
#define GB_POLICY_H
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <wchar.h>
#include "codec.h"
#define GB_PATH 4097
#define GB_CHAIN_MAX 2049
/* Ancestors stay open with actual directory access and without DELETE sharing.
 * This is NOT atomic handle-relative traversal: the ACL policy excludes
 * other-user mutation of each already established cumulative prefix. */
typedef struct { HANDLE *handles; size_t count; wchar_t path[GB_PATH]; } gb_chain;
typedef struct { DWORD volume; uint64_t index, size; int directory; } gb_identity;
typedef struct { TOKEN_USER *token; PSID system, admins, installer, creator; } gb_policy;
int gb_policy_init(gb_policy *p);
void gb_policy_free(gb_policy *p);
int gb_path_valid(const wchar_t *path,int relative);
int gb_read_string(gb_buf *b,wchar_t out[GB_PATH],int relative);
void gb_write_string(gb_buf *b,const wchar_t *s);
int gb_security(gb_policy *p,HANDLE h,int private_object,int directory,int parent);
int gb_validate(gb_policy *p,HANDLE h,const wchar_t *path,int private_object,int directory,gb_identity *identity);
int gb_stable(gb_policy *p,HANDLE h,const wchar_t *path,int private_object,const gb_identity *identity);
int gb_open_chain(gb_policy *p,const wchar_t *path,int managed,int create,gb_chain *out);
void gb_chain_close(gb_chain *c);
HANDLE gb_open(const wchar_t *path,DWORD access,DWORD share,DWORD disposition,SECURITY_ATTRIBUTES *sa);
int gb_descriptor(gb_policy *p,int directory,SECURITY_DESCRIPTOR *sd,unsigned char acl[256],SECURITY_ATTRIBUTES *sa);
int gb_join(wchar_t out[GB_PATH],const wchar_t *a,const wchar_t *b);
int gb_error(DWORD error);
#endif
