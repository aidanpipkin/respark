import re,os
def strip(src):
    src=re.sub(r'^import .*\n','',src,flags=re.M)
    src=re.sub(r'^export (const|function|type|async function)',r'\1',src,flags=re.M)
    return src
shared=strip(open('rileyShared.ts').read()); copy=strip(open('rileyCopy.ts').read()); booking=strip(open('rileyBooking.ts').read())
os.makedirs('../riley_dist',exist_ok=True)
for n in ['rileyEnroll','rileySend','rileyReply','rileyAppointmentFlow','rileyPremiumTruckerWebhook']:
    s=open(n+'.ts').read().replace('//__SHARED__//',shared).replace('//__COPY__//',copy).replace('//__BOOKING__//',booking)
    assert '//__' not in s, n
    open(f'../riley_dist/{n}.ts','w').write(s); print(n,len(s))
import shutil; shutil.copy('rileyClosedGuard.ts','../riley_dist/rileyClosedGuard.ts')
