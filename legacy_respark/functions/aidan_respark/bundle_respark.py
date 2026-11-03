import re,sys,os
def strip(src):
    src=re.sub(r'^import .*\n','',src,flags=re.M)
    src=re.sub(r'^export (const|function|type|async function)',r'\1',src,flags=re.M)
    return src
shared=strip(open('resparkShared.ts').read()); copy=strip(open('resparkCopy.ts').read()); booking=strip(open('resparkBooking.ts').read())
os.makedirs('dist',exist_ok=True)
for n in ['resparkEnroll','resparkSend','aidanReply','resparkAppointmentFlow','premiumTruckerWebhook']:
    s=open(n+'.ts').read().replace('//__SHARED__//',shared).replace('//__COPY__//',copy).replace('//__BOOKING__//',booking)
    open(f'dist/{n}.ts','w').write(s); print(n,len(s))
