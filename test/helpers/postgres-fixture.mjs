import { randomUUID } from 'node:crypto';
export const databaseUrl=process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if(process.env.GITHUB_WORKFLOW==='CI'&&!databaseUrl) throw new Error('Canonical CI requires isolated PostgreSQL.');
export async function fixture(t,prefix='slice') {
  const {Client}=await import('pg');const {postgresSql}=await import('../../dist/postgres.js');
  const clients=await Promise.all([0,1].map(async()=>{const c=new Client({connectionString:databaseUrl});await c.connect();await c.query('SET search_path TO dealguard,public');await c.query("SET statement_timeout TO '10s'");return c;}));
  const first=clients[0],second=clients[1],portal=`${prefix}-${randomUUID()}`,other=`${prefix}-${randomUUID()}`;
  const portalIds=[portal,other];
  const base=Date.now()-86400000,at=n=>new Date(base+n*1000).toISOString();
  for(const id of [portal,other]) await first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,
    token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at)
    VALUES($1,'fixture','fixture','fixture','fixture','fixture',$2,'{}',$2,$2,$2,'enterprise',$3)`,[id,at(0),new Date(Date.now()+86400000).toISOString()]);
  t.after(async()=>{for(const c of clients) await c.query('ROLLBACK');await first.query('DELETE FROM tenants WHERE portal_id=ANY($1::text[])',[portalIds]);await Promise.all(clients.map(c=>c.end()));});
  const sent=[];
  const envFor=client=>({MAINTENANCE_QUEUE:{async send(message){sent.push(message);}},DB:{prepare(sql){let params=[];
    const execute=()=>client.query(postgresSql.placeholders(postgresSql.qualifyRelations(sql)),params);
    const stmt={bind(...args){params=args;return stmt;},async first(){return (await execute()).rows[0]??null;},async all(){return {results:(await execute()).rows};},async run(){const r=await execute();return {success:true,results:r.rows,meta:{changes:r.rowCount}};}};return stmt;},async batch(statements){await client.query('BEGIN');try{const rows=[];for(const s of statements)rows.push(await s.run());await client.query('COMMIT');return rows;}catch(e){await client.query('ROLLBACK');throw e;}}}});
  return {first,second,portal,other,at,env:envFor(first),envFor,sent,portalIds};
}
