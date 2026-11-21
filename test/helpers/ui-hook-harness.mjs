import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Small hook host for deterministic async boundary tests without a DOM or network.
 * React state, ref identity, dependency changes and effect cleanup are modeled;
 * rendering SDK components is outside this helper's scope.
 */
export function hookHarness(filename, exportName, initialArgument, fetch, modules={}) {
  const slots=[],pending=[];let cursor=0,argument=initialArgument,current,scheduled=false,disposed=false;
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]));
  const schedule=()=>{if(!scheduled&&!disposed){scheduled=true;queueMicrotask(()=>{scheduled=false;if(!disposed)render();});}};
  const react={__esModule:true,default:{createElement:(type,props,...children)=>({type,props:{...props,children}})},
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],value=>{const next=typeof value==='function'?value(slots[index]):value;if(!Object.is(slots[index],next)){slots[index]=next;schedule();}}];},
    useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useCallback(callback,deps){const index=cursor++;if(!equal(slots[index]?.deps,deps))slots[index]={value:callback,deps};return slots[index].value;},
    useEffect(callback,deps){const index=cursor++,previous=slots[index];if(!equal(previous?.deps,deps)){
      slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[index].cleanup?.();slots[index].cleanup=callback();});}},
  };
  const code=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
  const module={exports:{}};
  const sdk=new Proxy({hubspot:{fetch}},{get:(target,name)=>name in target?target[name]:name});
  new Function('require','module','exports',code)(name=>name==='react'?react:name==='@hubspot/ui-extensions'?sdk:name in modules?modules[name]:(()=>{throw new Error(`Unsupported hook dependency ${name}`);})(),module,module.exports);
  const hook=module.exports[exportName];
  function render(){cursor=0;current=hook(argument);for(const effect of pending.splice(0))effect();return current;}
  render();
  return {get current(){return current;},render(value){argument=value;return render();},
    async flush(){await new Promise(resolve=>setImmediate(resolve));return current;},
    dispose(){disposed=true;for(const slot of slots)if(slot&&typeof slot.cleanup==='function')slot.cleanup();}};
}

export function deferredFetch() {
  const calls=[];
  return {calls,fetch:(url,options)=>new Promise(resolve=>{calls.push({url,options,resolve:(data,status=200)=>resolve({ok:status>=200&&status<300,status,json:async()=>data})});})};
}
