#include "launch-json.h"
#include <stdio.h>
int main(void){
 const char *good[]={"{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42}\n"," {\"hostPid\":42,\"protocol\":1,\"event\":\"BindHost\"} "};
 const char *bad[]={"{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":0}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":4294967296}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":01}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42,\"host\\u0050id\":42}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42,\"extra\":0}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42}{}","{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42,}","{\"event\":\"\\ud800\",\"protocol\":1,\"hostPid\":42}","{\"event\":\"BindHost\",\"protocol\":1e0,\"hostPid\":42}"};
 uint32_t pid=0;for(unsigned i=0;i<sizeof good/sizeof good[0];i++)if(!lj_meta((const unsigned char *)good[i],strlen(good[i]),"BindHost",&pid)||pid!=42)return 1;
 for(unsigned i=0;i<sizeof bad/sizeof bad[0];i++)if(lj_meta((const unsigned char *)bad[i],strlen(bad[i]),"BindHost",&pid))return 2;
 const unsigned char nul[]="{\"event\":\"BindHost\",\"protocol\":1,\"hostPid\":42}\0";
 if(lj_meta(nul,sizeof nul-1,"BindHost",&pid))return 3;
 puts("PORTABLE_LAUNCH_JSON_OK");return 0;
}
