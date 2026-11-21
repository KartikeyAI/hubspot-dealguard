import { onboardingStatus } from './onboarding.js';
import { routeForecast } from './routes-forecast.js';
import { dashboardForIdentity } from './dashboard-access.js';
import { routeBreeze } from './breeze-tools.js';
import { aiAdministration,aiAssistance,changeAiLimits } from './ai-assistance.js';
import { AppError } from './errors.js';
import { validateHubSpotRequest } from './signature.js';
import { json,readJson,methodNotAllowed } from './http.js';
import { changeIntelligenceConsent,getIntelligenceConsent,requireIntelligenceAdministrator } from './intelligence-consent.js';
import { buildOutcomeDataset,listOutcomeDatasets } from './outcome-data.js';
import { evaluateStoredOutcomes,listOutcomeEvaluations } from './outcome-evaluation-service.js';
import type { Env } from './types.js';
const ROOT='/api/v1/enterprise/outcome-evaluation';
export async function routeIntelligence(request:Request,env:Env,ctx:{waitUntil(promise:Promise<unknown>):void}):Promise<Response|null>{
  const forecast=await routeForecast(request,env);if(forecast)return forecast;
  const breeze=await routeBreeze(request,env);if(breeze)return breeze;
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/v1/dashboard'||path==='/api/v1/onboarding'){
    if(request.method!=='GET')return methodNotAllowed(['GET']);
    const identity=await validateHubSpotRequest(request,env,4096);
    return json(path.endsWith('/onboarding')?await onboardingStatus(env,identity):await dashboardForIdentity(env,identity,url));
  }
  const AI='/api/v1/enterprise/ai';
  if([AI+'/consent',AI+'/status',AI+'/limits',AI+'/assist'].includes(path)){
    const allowed=path.endsWith('/status')?['GET']:path.endsWith('/consent')?['PUT']:path.endsWith('/limits')?['PUT']:['POST'];
    if(!allowed.includes(request.method))return methodNotAllowed(allowed);
    const identity=await validateHubSpotRequest(request,env,4096);
    if(path.endsWith('/status'))return json(await aiAdministration(env,identity));
    const input=await readJson(request,4096);
    if(path.endsWith('/consent'))return json(await changeIntelligenceConsent(env,identity,'ai',input));
    if(path.endsWith('/limits'))return json(await changeAiLimits(env,identity,input));
    const work=aiAssistance(env,identity,input,request.signal);ctx.waitUntil(work.catch(()=>undefined));return json(await work);
  }
  if(path===ROOT+'/consent'){
    if(!['GET','PUT'].includes(request.method))return methodNotAllowed(['GET','PUT']);
    const identity=await validateHubSpotRequest(request,env,4096);
    if(request.method==='PUT')return json(await changeIntelligenceConsent(env,identity,'outcomes',await readJson(request,4096)));
    await requireIntelligenceAdministrator(env,identity,false);return json(await getIntelligenceConsent(env,identity.portalId,'outcomes'));
  }
  if(path===ROOT+'/datasets'||path===ROOT+'/evaluations'){
    if(!['GET','POST'].includes(request.method))return methodNotAllowed(['GET','POST']);
    const identity=await validateHubSpotRequest(request,env,4096);
    if(request.method==='GET')return json({predictionsEnabled:false,items:await (path.endsWith('/datasets')?listOutcomeDatasets(env,identity):listOutcomeEvaluations(env,identity))});
    const input=await readJson<Record<string,unknown>>(request,4096);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(400,'intelligence_input_invalid','Use a JSON object.');
    return json(path.endsWith('/datasets')?await buildOutcomeDataset(env,identity,input):await evaluateStoredOutcomes(env,identity,input));
  }
  return null;
}
