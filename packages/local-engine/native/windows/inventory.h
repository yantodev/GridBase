#ifndef GB_INVENTORY_H
#define GB_INVENTORY_H
#include "policy.h"
typedef struct { wchar_t *name; gb_identity identity; unsigned char sha256[32]; } gb_entry;
typedef struct { gb_entry *entries; size_t count,files,offset; HANDLE *directories; size_t directory_count; DWORD cursor; ULONGLONG deadline; } gb_inventory;
int gb_hash(gb_policy *p,HANDLE h,const wchar_t *path,const gb_identity *id,unsigned char digest[32],ULONGLONG deadline);
int gb_inventory_start(gb_policy *p,gb_chain *root,gb_inventory *scan);
int gb_inventory_page(gb_inventory *scan,uint32_t cursor,uint32_t next,gb_buf *out);
void gb_inventory_close(gb_inventory *scan);
#endif
