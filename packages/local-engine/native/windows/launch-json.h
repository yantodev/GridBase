#ifndef GB_LAUNCH_JSON_H
#define GB_LAUNCH_JSON_H
/* Small strict parser for the fixed launch schemas, not a general JSON API. */
#include "codec.h"
#include <stdlib.h>
typedef struct { const unsigned char *p;size_t n,i;int bad; } lj;
static inline void lj_ws(lj *j){while(j->i<j->n&&j->p[j->i]&&strchr(" \r\n\t",j->p[j->i]))j->i++;}
static inline int lj_char(lj *j,unsigned c){lj_ws(j);if(j->i>=j->n||j->p[j->i++]!=c){j->bad=1;return 0;}return 1;}
static inline unsigned lj_hex(lj *j){unsigned n=0;for(unsigned i=0;i<4;i++){if(j->i>=j->n){j->bad=1;return 0;}unsigned c=j->p[j->i++],v=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:99;if(v>15){j->bad=1;return 0;}n=n*16+v;}return n;}
static inline int lj_string(lj *j,char *out,size_t capacity){if(!lj_char(j,'"'))return 0;size_t n=0;int closed=0;
 while(j->i<j->n&&!j->bad){unsigned c=j->p[j->i++];if(c=='"'){closed=1;break;}if(c<32){j->bad=1;break;}
  if(c=='\\'){if(j->i>=j->n){j->bad=1;break;}c=j->p[j->i++];if(c=='u'){c=lj_hex(j);if(c>=0xd800&&c<=0xdbff){if(j->i+2>j->n||j->p[j->i++]!='\\'||j->p[j->i++]!='u'){j->bad=1;break;}unsigned low=lj_hex(j);if(low<0xdc00||low>0xdfff){j->bad=1;break;}c=0x10000+((c-0xd800)<<10)+(low-0xdc00);}else if(c>=0xdc00&&c<=0xdfff){j->bad=1;break;}
    unsigned char bytes[4];size_t k=0;if(c<128)bytes[k++]=(unsigned char)c;else if(c<2048){bytes[k++]=(unsigned char)(192|(c>>6));bytes[k++]=(unsigned char)(128|(c&63));}else if(c<65536){bytes[k++]=(unsigned char)(224|(c>>12));bytes[k++]=(unsigned char)(128|((c>>6)&63));bytes[k++]=(unsigned char)(128|(c&63));}else{bytes[k++]=(unsigned char)(240|(c>>18));bytes[k++]=(unsigned char)(128|((c>>12)&63));bytes[k++]=(unsigned char)(128|((c>>6)&63));bytes[k++]=(unsigned char)(128|(c&63));}
    if(n+k>=capacity){j->bad=1;break;}memcpy(out+n,bytes,k);n+=k;continue;
   }else if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';else if(c=='b')c='\b';else if(c=='f')c='\f';else if(c!='"'&&c!='\\'&&c!='/'){j->bad=1;break;}}
  if(n+1>=capacity){j->bad=1;break;}out[n++]=(char)c;
 }
 if(!closed||j->bad||!gb_utf8((unsigned char *)out,n,NULL)){j->bad=1;return 0;}out[n]=0;return 1;
}
static inline uint32_t lj_number(lj *j){lj_ws(j);uint64_t n=0;size_t start=j->i;while(j->i<j->n&&j->p[j->i]>='0'&&j->p[j->i]<='9'){n=n*10+j->p[j->i++]-'0';if(n>UINT32_MAX){j->bad=1;return 0;}}if(j->i==start||(j->i-start>1&&j->p[start]=='0'))j->bad=1;return (uint32_t)n;}
/* Return index of exact decoded key; seen bitmask rejects escaped aliases. */
static inline int lj_key(lj *j,const char **names,size_t count,unsigned *seen){char key[64];if(!lj_string(j,key,sizeof key)||!lj_char(j,':'))return -1;for(size_t i=0;i<count;i++)if(!strcmp(key,names[i])){if(*seen&(1u<<i)){j->bad=1;return -1;}*seen|=1u<<i;return (int)i;}j->bad=1;return -1;}
static inline int lj_more(lj *j){lj_ws(j);if(j->i<j->n&&j->p[j->i]==','){j->i++;return 1;}return 0;}
static inline int lj_end(lj *j){if(!lj_char(j,'}'))return 0;lj_ws(j);return !j->bad&&j->i==j->n;}
static inline int lj_meta(const unsigned char *p,size_t n,const char *event,uint32_t *pid){lj j={p,n,0,0};const char *keys[]={"event","protocol","hostPid"};unsigned seen=0;char text[32];uint32_t protocol=0,value=0;if(!lj_char(&j,'{'))return 0;
 do{int k=lj_key(&j,keys,pid?3:2,&seen);if(k==0){if(!lj_string(&j,text,sizeof text)||strcmp(text,event))return 0;}else if(k==1)protocol=lj_number(&j);else if(k==2)value=lj_number(&j);else return 0;}while(lj_more(&j));
 if(!lj_end(&j)||protocol!=1||seen!=(pid?7u:3u)||(pid&&!value)){return 0;}if(pid){*pid=value;}return 1;
}
#endif
