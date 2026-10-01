import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function createStorage({url, key, dataBucket, imageBucket, fetchImpl=fetch}) {
  const headers = extra => ({apikey:key,...(!key.startsWith('sb_secret_')?{Authorization:`Bearer ${key}`} : {}),...extra});
  const objectPath = value => String(value).split('/').map(encodeURIComponent).join('/');
  const request = (path, options={}) => fetchImpl(`${url}/storage/v1${path}`, {...options,headers:headers(options.headers),signal:AbortSignal.timeout(20000)});
  async function missing(response, kind) {
    const body=await response.json().catch(()=>({}));
    return body.code === (kind==='bucket'?'NoSuchBucket':'NoSuchKey') ||
      ([400,404].includes(response.status) && (kind==='bucket' ? body.message==='Bucket not found' : body.message==='Object not found'));
  }
  async function ensureBucket(name, isPublic) {
    const endpoint=`/bucket/${encodeURIComponent(name)}`;
    const check=await request(endpoint);
    if(check.ok) {
      const bucket=await check.json();
      if(bucket.public!==isPublic) throw new Error(`Bucket ${name} must be ${isPublic?'public':'private'}. Change its access setting before starting.`);
      return;
    }
    if(!await missing(check,'bucket')) throw new Error(`Bucket ${name} check failed (${check.status}).`);
    const created=await request('/bucket/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:name,name,public:isPublic})});
    if(!created.ok) throw new Error(`Bucket ${name} creation failed (${created.status}).`);
  }
  async function upload(bucket, name, bytes, contentType) {
    const response=await request(`/object/${encodeURIComponent(bucket)}/${objectPath(name)}`,{method:'POST',headers:{'Content-Type':contentType,'x-upsert':'true'},body:bytes});
    if(!response.ok) throw new Error(`Storage upload failed (${response.status}).`);
  }
  async function remove(bucket, name) {
    const response=await request(`/object/${encodeURIComponent(bucket)}/${objectPath(name)}`,{method:'DELETE'});
    if(!response.ok && !await missing(response,'object')) throw new Error(`Storage delete failed (${response.status}).`);
  }
  async function restore(dbPath, allowInitialize=false) {
    await ensureBucket(dataBucket,false);
    await ensureBucket(imageBucket,true);
    const response=await request(`/object/authenticated/${encodeURIComponent(dataBucket)}/isolde.sqlite`);
    if(!response.ok) {
      if(await missing(response,'object') && allowInitialize) return false;
      throw new Error(`Database restore failed (${response.status}). Refusing to overwrite the remote database. For the first setup only, set SUPABASE_ALLOW_INITIALIZE=true.`);
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length<100 || bytes.subarray(0,16).toString()!=='SQLite format 3\u0000') throw new Error('Invalid database backup. Startup stopped.');
    const temporary=`${dbPath}.restore`;
    fs.writeFileSync(temporary,bytes);
    let candidate;
    try {
      candidate=new DatabaseSync(temporary,{readOnly:true});
      const check=candidate.prepare('PRAGMA integrity_check').all();
      if(check.length!==1 || Object.values(check[0])[0]!=='ok') throw new Error('Database backup failed its integrity check.');
    } finally { candidate?.close(); }
    for(const suffix of ['-wal','-shm']) fs.rmSync(dbPath+suffix,{force:true});
    fs.renameSync(temporary,dbPath);
    return true;
  }
  return {upload,remove,restore,publicUrl:(bucket,name)=>`${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath(name)}`};
}
