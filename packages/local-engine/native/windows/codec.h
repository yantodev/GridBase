#ifndef GB_CODEC_H
#define GB_CODEC_H
/* Portable bounded little-endian RPC primitives. No Windows API emulation. */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#define GB_FRAME_MAX (2u*1024u*1024u)
enum gb_status { GB_OK, GB_EXISTS, GB_MISSING, GB_INITIALIZING, GB_UNSAFE, GB_UNSUPPORTED, GB_IO, GB_PROTOCOL };
typedef struct { unsigned char *p; size_t n, i; int bad; } gb_buf;
static inline uint32_t gb_le32(const unsigned char *p) { return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24; }
static inline void gb_put32(unsigned char *p,uint32_t n) { for(unsigned i=0;i<4;i++)p[i]=(unsigned char)(n>>(8*i)); }
static inline void gb_put64(unsigned char *p,uint64_t n) { for(unsigned i=0;i<8;i++)p[i]=(unsigned char)(n>>(8*i)); }
static inline unsigned char *gb_take(gb_buf *b,size_t n) { if(b->bad || n>b->n-b->i){b->bad=1;return NULL;} unsigned char *p=b->p+b->i;b->i+=n;return p; }
static inline uint32_t gb_u32(gb_buf *b) { unsigned char *p=gb_take(b,4);return p?gb_le32(p):0; }
static inline void gb_write(gb_buf *b,const void *p,size_t n) { unsigned char *q=gb_take(b,n);if(q)memcpy(q,p,n); }
static inline void gb_w32(gb_buf *b,uint32_t n) { unsigned char *p=gb_take(b,4);if(p)gb_put32(p,n); }
static inline void gb_w64(gb_buf *b,uint64_t n) { unsigned char *p=gb_take(b,8);if(p)gb_put64(p,n); }
static inline int gb_done(const gb_buf *b) { return !b->bad && b->i==b->n; }
/* Reject overlong sequences, surrogate scalar values, NUL, invalid continuations. */
static inline int gb_utf8(const unsigned char *p,size_t n,size_t *units) {
 size_t u=0;
 for(size_t i=0;i<n;) { uint32_t c=p[i++];unsigned k=0;uint32_t min=0;
  if(c<0x80){if(!c)return 0;}
  else if(c>=0xc2 && c<=0xdf){c&=31;k=1;min=0x80;}
  else if(c>=0xe0 && c<=0xef){c&=15;k=2;min=0x800;}
  else if(c>=0xf0 && c<=0xf4){c&=7;k=3;min=0x10000;} else return 0;
  if(k>n-i)return 0;
  for(unsigned j=0;j<k;j++){unsigned v=p[i++];if((v&0xc0)!=0x80)return 0;c=(c<<6)|(v&63);}
  if((k && c<min)||c>0x10ffff||(c>=0xd800&&c<=0xdfff))return 0;
  u+=c>0xffff?2:1;if(u>4096)return 0;
 }
 if(units){*units=u;}return 1;
}
static inline int gb_header(const unsigned char *p,size_t n,uint16_t *code,uint32_t *id) {
 if(n<12 || gb_le32(p)<8 || gb_le32(p)>GB_FRAME_MAX || gb_le32(p)!=n-4 || p[4]!=1 || p[5] || !gb_le32(p+8))return 0;
 *code=(uint16_t)(p[6]|p[7]<<8);*id=gb_le32(p+8);return 1;
}
#endif
