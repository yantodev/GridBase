#include "codec.h"
#include <stdio.h>
int main(void) {
 unsigned char b[32];size_t n=fread(b,1,sizeof b,stdin);uint16_t code;uint32_t id;
 if(!gb_header(b,n,&code,&id)||code!=3||id!=1)return 1;
 gb_buf r={b+12,n-12,0,0};if(gb_u32(&r)!=0x12345678||!gb_done(&r))return 2;
 unsigned char invalid[][4]={{0xc0,0xaf,0,0},{0xed,0xa0,0x80,0},{0xf4,0x90,0x80,0x80},{0xe2,0x82,0,0}};
 size_t lengths[]={2,3,4,2};for(unsigned i=0;i<4;i++)if(gb_utf8(invalid[i],lengths[i],NULL))return 3;
 const unsigned char valid[]={0xf0,0x9f,0x98,0x80};size_t units=0;if(!gb_utf8(valid,4,&units)||units!=2)return 4;
 unsigned char overflow[]={255,255,255,255};if(gb_le32(overflow)<=GB_FRAME_MAX)return 5;
 if(fwrite(b,1,n,stdout)!=n){return 6;}return 0;
}
