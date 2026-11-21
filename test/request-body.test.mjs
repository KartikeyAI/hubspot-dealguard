import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{readBoundedText}from'../dist/request-body.js';import{readJson}from'../dist/http.js';import{validateHubSpotSignature}from'../dist/signature.js';
const req=(body,headers={})=>new Request('https://example.test',{method:'POST',body,duplex:'half',headers});
test('bounded reader measures UTF-8 bytes, not character count',async()=>{
 assert.equal(await readBoundedText(req('🙂'),4),'🙂');await assert.rejects(readBoundedText(req('🙂'),3),{code:'payload_too_large'});
 assert.deepEqual(await readJson(req('{"ok":true}'),11),{ok:true});await assert.rejects(readJson(req('{'),8),{code:'invalid_json'});
});
test('unknown-length chunked input is stopped as soon as the byte budget is exceeded',async()=>{
 let reads=0;const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(1000));}});
 await assert.rejects(readBoundedText(req(stream),100),{code:'payload_too_large'});assert(reads<=3);
});
test('declared invalid or excessive lengths and invalid UTF-8 fail closed',async()=>{
 await assert.rejects(readBoundedText(req('hi',{'content-length':'300'}),10),{code:'payload_too_large'});
 await assert.rejects(readBoundedText(req('hi',{'content-length':'invalid'}),10),{code:'invalid_content_length'});
 await assert.rejects(readBoundedText(req(new Uint8Array([0xff])),10),{code:'invalid_body_encoding'});
});
test('slow bodies and abandoned clone peers cannot hang request validation',async()=>{
 const stream=new ReadableStream({start(){}});await assert.rejects(readBoundedText(req(stream),100,10),{code:'request_body_timeout'});
 const body=req(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1000));}}));await assert.rejects(readBoundedText(body.clone(),10,50),{code:'payload_too_large'});
 void body.body.cancel().catch(()=>undefined);
});
test('signature validation reads exact bounded UTF-8 before authenticating',async()=>{
 const secret='fixture',body='{"text":"Hello 🙂"}',url='https://example.test';const signature=createHash('sha256').update(secret+'POST'+url+'/'+body).digest('hex');
 const request=new Request(url,{method:'POST',body,headers:{'x-hubspot-signature-version':'v2','x-hubspot-signature':signature}});
 await validateHubSpotSignature(request,{HUBSPOT_CLIENT_SECRET:secret},true,100);
 await assert.rejects(validateHubSpotSignature(request,{HUBSPOT_CLIENT_SECRET:secret},true,10),{code:'payload_too_large'});
 assert.equal(await request.text(),body);
});
