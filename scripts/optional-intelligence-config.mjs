// Pure, non-secret configuration validation shared by deployment preflight tests.
const TOOLS = new Set(['evidence','risk','next-action','handover','remediation-preview']);
export function optionalIntelligenceConfiguration(env, now = Date.now()) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({id,ok:Boolean(ok),detail,category:'environment'});
  const flag = name => {
    const raw=env[name]??'';check(`env.${name}`,['','false','true'].includes(raw),'Use an explicit true or false flag; unset means disabled.');
    return raw==='true';
  };
  const ai=flag('DEALGUARD_AI_ENABLED'),breeze=flag('DEALGUARD_BREEZE_ENABLED'),forecast=flag('DEALGUARD_FORECAST_ENABLED');
  const vars={DEALGUARD_AI_ENABLED:String(ai),DEALGUARD_BREEZE_ENABLED:String(breeze),DEALGUARD_FORECAST_ENABLED:String(forecast),DEALGUARD_AI_MODEL:'',
    DEALGUARD_AI_PRICING_VERIFIED_AT:'',DEALGUARD_AI_INPUT_USD_PER_MILLION:'',DEALGUARD_AI_OUTPUT_USD_PER_MILLION:'',DEALGUARD_BREEZE_ACTION_IDS:''};
  if(ai){
    check('env.DEALGUARD_AI_MODEL',/^[a-zA-Z0-9_.:-]{1,100}$/.test(env.DEALGUARD_AI_MODEL??''),'An approved exact model ID is required.');
    check('env.DEALGUARD_AI_API_KEY',typeof env.DEALGUARD_AI_API_KEY==='string'&&env.DEALGUARD_AI_API_KEY.length>=16&&!/^(replace|placeholder|changeme)/i.test(env.DEALGUARD_AI_API_KEY),'The optional AI credential must be configured as a protected Worker secret.');
    const stamp=env.DEALGUARD_AI_PRICING_VERIFIED_AT??'',time=Date.parse(stamp);
    check('env.DEALGUARD_AI_PRICING_VERIFIED_AT',/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(stamp)&&Number.isFinite(time)&&new Date(time).toISOString().replace('.000Z','Z')===stamp.replace('.000Z','Z')&&time<=now&&now-time<=30*86400000,'Pricing requires a valid UTC verification timestamp within the previous thirty days.');
    for(const key of ['DEALGUARD_AI_INPUT_USD_PER_MILLION','DEALGUARD_AI_OUTPUT_USD_PER_MILLION'])
      check(`env.${key}`,typeof env[key]==='string'&&env[key].trim()!==''&&Number.isFinite(Number(env[key]))&&Number(env[key])>0&&Number(env[key])<=1000,'An explicitly verified positive USD-per-million-token rate is required.');
    for(const key of ['DEALGUARD_AI_MODEL','DEALGUARD_AI_PRICING_VERIFIED_AT','DEALGUARD_AI_INPUT_USD_PER_MILLION','DEALGUARD_AI_OUTPUT_USD_PER_MILLION'])vars[key]=String(env[key]??'');
  }
  if(breeze){
    let parsed=null;try{parsed=JSON.parse(env.DEALGUARD_BREEZE_ACTION_IDS??'');}catch{/* Checked without echoing input. */}
    const valid=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).length>0&&Object.entries(parsed).every(([key,value])=>TOOLS.has(key)
      &&(typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value))&&/^[1-9]\d{0,29}$/.test(String(value)))
      &&new Set(Object.values(parsed).map(String)).size===Object.keys(parsed).length;
    check('env.DEALGUARD_BREEZE_ACTION_IDS',valid,'Only unique real action-definition IDs for approved tool names are accepted. This check does not grant HubSpot approval.');
    if(valid)vars.DEALGUARD_BREEZE_ACTION_IDS=JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([key,value])=>[key,String(value)])));
  }
  return {checks,vars,enabled:{ai,breeze,forecast},secretsRendered:false,liveProviderVerified:false};
}
export function renderOptionalIntelligenceVariables(source,target,env){
  if(!['staging','production'].includes(target))throw new Error('Invalid release target.');
  const config=optionalIntelligenceConfiguration(env);
  if(config.checks.some(c=>!c.ok))throw new Error('Optional intelligence configuration failed validation.');
  const header=`[env.${target}.vars]`,lines=source.split('\n'),output=[];let selected=false,found=false;
  for(const line of lines){
    if(line.trim().startsWith('['))selected=line.trim()===header;
    if(line.trim()===header){found=true;output.push(line,...Object.entries(config.vars).map(([key,value])=>`${key} = ${JSON.stringify(value)}`));continue;}
    if(selected&&Object.keys(config.vars).some(key=>new RegExp(`^\\s*${key}\\s*=`).test(line)))continue;
    output.push(line);
  }
  if(!found)throw new Error('Selected Worker environment vars section was not found.');
  return output.join('\n');
}
