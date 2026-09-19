import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import { validateHubSpotSignature,validateHubSpotRequest } from '../dist/signature.js';
const env={HUBSPOT_CLIENT_SECRET:'fixture-only-secret',HUBSPOT_APP_ID:'200'};
const base='https://fixture.example/api/v1/deals/3/assessment?portalId=100&appId=200&userId=7&userEmail=owner%40example.test';
const decode=url=>url.replace(/%(3a|2f|3f|40|21|24|27|28|29|2a|2c|3b)/gi,value=>decodeURIComponent(value));
function request(url=base,version='v3',method='GET',body='',extra={}) {
 const timestamp=String(Date.now()); const source=version==='v3'?`${method}${decode(url)}${body}${timestamp}`:version==='v2'?`${env.HUBSPOT_CLIENT_SECRET}${method}${url}${body}`:`${env.HUBSPOT_CLIENT_SECRET}${body}`;
 const signature=version==='v3'?createHmac('sha256',env.HUBSPOT_CLIENT_SECRET).update(source).digest('base64'):createHash('sha256').update(source).digest('hex');
 const headers=version==='v3'?{'x-hubspot-signature-v3':signature,'x-hubspot-request-timestamp':timestamp}:{'x-hubspot-signature':signature,'x-hubspot-signature-version':version};
 return new Request(url,{method,...(method!=='GET'?{body}:{}),headers:{...headers,...extra}});
}
test('v3 authenticates the exact method, URL, body and identity',async()=>{
 const r=request();assert.deepEqual(await validateHubSpotRequest(r,env),{portalId:'100',appId:'200',userId:'7',userEmail:'owner@example.test'});
 for(const suffix of [base.replace('portalId=100','portalId=999'),base.replace('/3/','/4/'),base.replace('userId=7','userId=9')]) await assert.rejects(validateHubSpotRequest(new Request(suffix,{headers:r.headers}),env),{status:401});
 const post=request(base,'v3','POST','{"x":1}');await validateHubSpotRequest(post,env);
 await assert.rejects(validateHubSpotRequest(new Request(base,{method:'POST',headers:post.headers,body:'{"x":2}'}),env),{status:401});
});
test('legacy body-only signatures work only for body-origin webhooks, never URL identity',async()=>{
 const r=request(base,'v1','POST','[]');await validateHubSpotSignature(r,env);
 await assert.rejects(validateHubSpotRequest(r,env),{status:401});
 await assert.rejects(validateHubSpotSignature(r,env,true),{status:401});
});
test('documented v2 compatibility remains URL bound rather than accepting a body-only hash',async()=>{
 const r=request(base,'v2','POST','{}');await validateHubSpotRequest(r,env);
 await assert.rejects(validateHubSpotRequest(new Request(base.replace('portalId=100','portalId=999'),{method:'POST',body:'{}',headers:r.headers}),env),{status:401});
});
test('partial or invalid v3 headers cannot fall back to a legacy signature',async()=>{
 const legacy=request(base,'v2');
 for(const headers of [{'x-hubspot-signature-v3':'invalid'},{'x-hubspot-request-timestamp':String(Date.now())},{'x-hubspot-signature-v3':'A'.repeat(43)+'=','x-hubspot-request-timestamp':String(Date.now())}]) {
  const h=new Headers(legacy.headers);for(const[k,v]of Object.entries(headers))h.set(k,v);
  await assert.rejects(validateHubSpotRequest(new Request(base,{headers:h}),env),{status:401});
 }
});
test('timestamps are bounded canonical integers, not exponent, whitespace or decimal encodings',async()=>{
 for(const timestamp of ['1e12',' 1234567890123','1234567890123.1','not-a-time',String(Date.now()-300001),String(Date.now()+300001)]) {
  const r=request();const h=new Headers(r.headers);h.set('x-hubspot-request-timestamp',timestamp);
  await assert.rejects(validateHubSpotRequest(new Request(base,{headers:h}),env),{status:401});
 }
});
test('signed duplicate identity parameters are rejected rather than selecting the first value',async()=>{
 for(const key of ['portalId','appId','userId','userEmail']) await assert.rejects(validateHubSpotRequest(request(`${base}&${key}=100`),env),{code:'ambiguous_request_identity'});
});
test('configured project identity is mandatory and must match the signer configuration',async()=>{
 for(const value of [base.replace('&appId=200',''),base.replace('appId=200','appId=999')]) await assert.rejects(validateHubSpotRequest(request(value),env),{code:'app_identity_mismatch'});
});
test('malformed signed identities fail validation',async()=>{
 for(const value of [base.replace('portalId=100','portalId=0'),base.replace('userId=7','userId=bad'),base.replace('userEmail=owner%40example.test','userEmail=bad'),base.replace('portalId=100','portalId=%20100')]) await assert.rejects(validateHubSpotRequest(request(value),env),{status:401});
});
test('no configured secret and tampered body cannot authenticate',async()=>{
 await assert.rejects(validateHubSpotRequest(request(),{...env,HUBSPOT_CLIENT_SECRET:''}),{status:401});
});
