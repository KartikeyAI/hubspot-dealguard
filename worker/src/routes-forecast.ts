import { AppError } from './errors.js';
import { changeForecastControls,dealForecast,forecastStatus,registerForecastModel,reviewForecastModel } from './forecast-service.js';
import { json,methodNotAllowed,readJson } from './http.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';
const ROOT='/api/v1/enterprise/forecast';
export async function routeForecast(request:Request,env:Env):Promise<Response|null>{
 const url=new URL(request.url),part=url.pathname.slice(ROOT.length);
 if(!url.pathname.startsWith(ROOT+'/')||!['/status','/deal','/controls','/models','/review'].includes(part))return null;
 const allowed=part==='/status'||part==='/deal'?['GET']:part==='/controls'?['PUT']:['POST'];
 if(!allowed.includes(request.method))return methodNotAllowed(allowed);
 const identity=await validateHubSpotRequest(request,env,4096);
 if(part==='/status')return json(await forecastStatus(env,identity));
 if(part==='/deal'){
  if(url.searchParams.getAll('dealId').length!==1)throw new AppError(400,'forecast_record_required','Provide exactly one deal ID.');
  return json(await dealForecast(env,identity,url.searchParams.get('dealId')!));
 }
 const body=await readJson(request,4096);
 return json(part==='/controls'?await changeForecastControls(env,identity,body):part==='/models'?await registerForecastModel(env,identity,body):await reviewForecastModel(env,identity,body));
}
