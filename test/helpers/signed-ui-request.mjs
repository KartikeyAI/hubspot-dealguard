import { createHmac } from 'node:crypto';

/** Synthetic signed HubSpot UI request; includes the real URL/body binding. */
export function signedUiRequest(secret,actor,path,method='GET',value) {
  const url=new URL(path,'https://example.test');
  for(const key of ['portalId','userId','userEmail','appId'])if(actor[key]!=null)url.searchParams.set(key,String(actor[key]));
  const body=value===undefined?'':JSON.stringify(value),timestamp=String(Date.now());
  const decoded=url.toString().replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi,value=>decodeURIComponent(value));
  const signature=createHmac('sha256',secret).update(method+decoded+body+timestamp).digest('base64');
  return new Request(url,{method,headers:{'x-hubspot-signature-v3':signature,'x-hubspot-request-timestamp':timestamp,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{})});
}
