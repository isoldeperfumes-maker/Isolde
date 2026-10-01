import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStorage} from '../storage.mjs';

test('storage authentication, bucket privacy and restore fail closed',async()=>{
  let options;
  const storage=createStorage({url:'https://example.invalid',key:'sb_secret_example',dataBucket:'private',imageBucket:'images',fetchImpl:async(url,opts)=>{options=opts;return new Response(JSON.stringify({public:true}),{status:200});}});
  await assert.rejects(storage.restore('/unused'),/must be private/);
  assert.equal(options.headers.apikey,'sb_secret_example');
  assert.equal(options.headers.Authorization,undefined);
  const unauthorized=createStorage({url:'https://example.invalid',key:'legacy-jwt',dataBucket:'private',imageBucket:'images',fetchImpl:async()=>new Response(JSON.stringify({message:'Invalid JWT'}),{status:400})});
  await assert.rejects(unauthorized.restore('/unused',true),/check failed/);
});

test('images and orders survive restart; backup failures surface; signed Stripe webhook confirms only matching orders',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'isolde-test-'));
  for(const file of ['server.mjs','storage.mjs']) fs.copyFileSync(new URL('../'+file,import.meta.url),path.join(directory,file));
  const objects=new Map(),buckets=new Map(),sessions=new Map();
  let failBackup=false,failRestore=false,failDelete=false,child,logs='';
  const service=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname.startsWith('/v1/checkout/sessions')) {
      if(req.method==='GET') {reply(200,sessions.get(pathname.split('/').at(-1)));return;}
      const params=new URLSearchParams(body.toString());
      const key=req.headers['idempotency-key'];
      let session=[...sessions.values()].find(s=>s.key===key);
      if(session && session.request!==body.toString()) {reply(400,{error:{message:'Idempotency parameters changed'}});return;}
      if(!session) {
        let total=0;for(let i=0;params.has(`line_items[${i}][quantity]`);i++)total+=Number(params.get(`line_items[${i}][quantity]`))*Number(params.get(`line_items[${i}][price_data][unit_amount]`));
        session={id:'cs_test_'+sessions.size,key,url:'https://checkout.stripe.com/test',mode:'payment',payment_status:'unpaid',currency:params.get('line_items[0][price_data][currency]'),amount_total:total,metadata:{order_id:params.get('metadata[order_id]'),order_number:params.get('metadata[order_number]')},client_reference_id:params.get('client_reference_id')};
        session.request=body.toString();sessions.set(session.id,session);
      }
      reply(200,session);return;
    }
    if(pathname==='/storage/v1/bucket/') {const b=JSON.parse(body);buckets.set(b.name,b);reply(200,b);return;}
    if(pathname.startsWith('/storage/v1/bucket/')) {const b=buckets.get(pathname.split('/').at(-1));reply(b?200:400,b||{message:'Bucket not found'});return;}
    if(pathname.startsWith('/storage/v1/object/')) {
      const name=pathname.replace('/storage/v1/object/','').replace(/^authenticated\//,'');
      if(req.method==='GET') {
        if(failRestore){reply(500,{message:'Unavailable'});return;}
        if(!objects.has(name)){reply(400,{message:'Object not found'});return;}
        res.writeHead(200);res.end(objects.get(name));return;
      }
      if(req.method==='DELETE') {if(failDelete){reply(500,{});return;}objects.delete(name);reply(200,{});return;}
      if(failBackup&&name.endsWith('isolde.sqlite')){reply(500,{});return;}
      objects.set(name,body);reply(200,{});return;
    }
    reply(404,{});
  });
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
  const mockUrl=`http://127.0.0.1:${service.address().port}`;
  t.after(async()=>{child?.kill();await new Promise(resolve=>service.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  async function start(initialize=false) {
    const sock=http.createServer();await new Promise(resolve=>sock.listen(0,'127.0.0.1',resolve));const port=sock.address().port;await new Promise(resolve=>sock.close(resolve));
    logs='';child=spawn(process.execPath,['--import',new URL('./mock-stripe.mjs',import.meta.url).pathname,path.join(directory,'server.mjs')],{env:{...process.env,PORT:String(port),BASE_URL:`http://127.0.0.1:${port}`,NODE_ENV:'test',RENDER:'',SUPABASE_URL:mockUrl,SUPABASE_SECRET_KEY:'legacy-test',SUPABASE_SINGLE_INSTANCE:'true',SUPABASE_ALLOW_INITIALIZE:String(initialize),ADMIN_EMAIL:'test@example.com',ADMIN_PASSWORD:'test-password',SESSION_SECRET:'test-session-secret',STRIPE_SECRET_KEY:'sk_test_mock',STRIPE_WEBHOOK_SECRET:'whsec_mock',MOCK_STRIPE_URL:mockUrl}});
    child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(logs)),5000);const check=setInterval(()=>{if(logs.includes('store is running')){clearTimeout(timeout);clearInterval(check);resolve();}else if(child.exitCode!==null){clearTimeout(timeout);clearInterval(check);reject(new Error(logs));}},20);});
    return `http://127.0.0.1:${port}`;
  }
  const stop=async()=>{const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;};
  let base=await start(true),cookie,csrf;
  async function login() {
    const response=await fetch(base+'/admin/login',{method:'POST',redirect:'manual',body:new URLSearchParams({email:'test@example.com',password:'test-password'})});
    assert.equal(response.status,302);cookie=response.headers.get('set-cookie').split(';')[0];
    csrf=(await (await fetch(base+'/admin',{headers:{cookie}})).text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  }
  const api=(url,method='GET',data)=>fetch(base+url,{method,headers:{cookie,'x-csrf-token':csrf,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  await login();
  assert.equal((await api('/api/admin/settings','PUT',{shipping_mode:'free'})).status,200);
  const image=await (await api('/api/admin/products/1/images','POST',{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII='})).json();
  assert.ok(image.path.includes('/object/public/isolde-images/'));
  const cloudDb=()=>{const file=path.join(directory,'inspect.sqlite');fs.writeFileSync(file,objects.get('isolde-private/isolde.sqlite'));return new DatabaseSync(file,{readOnly:true});};
  await stop();fs.rmSync(path.join(directory,'data'),{recursive:true});base=await start();await login();
  assert.ok((await (await api('/api/products')).json())[0].image);
  const inspected=cloudDb();assert.equal(inspected.prepare('SELECT path FROM product_images WHERE id=?').get(image.id).path,image.path);inspected.close();
  failBackup=true;
  assert.equal((await api('/api/admin/settings','PUT',{contact_phone:'123'})).status,503);
  failBackup=false;assert.equal((await api('/api/admin/settings','PUT',{contact_phone:'123'})).status,200);
  const order={customer_name:'Test Buyer',email:'buyer@example.com',address1:'1 Test St',city:'Brantford',province:'ON',postal_code:'N3T 1A1',country:'Canada',items:[{id:1,qty:1}],checkout_key:crypto.randomUUID()};
  const first=await (await api('/api/orders','POST',order)).json();assert.ok(first.checkoutUrl);
  const second=await (await api('/api/orders','POST',order)).json();assert.equal(first.orderNumber,second.orderNumber);assert.equal(sessions.size,1);
  const session=[...sessions.values()][0];session.payment_status='paid';
  async function webhook(data,signatureValid=true) {
    const raw=JSON.stringify({type:'checkout.session.completed',data:{object:data}});const timestamp=Math.floor(Date.now()/1000);
    const signature=crypto.createHmac('sha256','whsec_mock').update(timestamp+'.'+raw).digest('hex');
    return fetch(base+'/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signatureValid?signature:'0'.repeat(64)}`},body:raw});
  }
  assert.equal((await webhook(session,false)).status,400);
  assert.equal((await webhook({...session,amount_total:1})).status,500);
  assert.equal((await webhook(session)).status,200);
  assert.equal((await webhook(session)).status,200);
  const paidDb=cloudDb();assert.equal(paidDb.prepare('SELECT payment_status FROM orders WHERE order_number=?').get(first.orderNumber).payment_status,'paid');assert.equal(paidDb.prepare('SELECT COUNT(*) n FROM orders').get().n,1);paidDb.close();
  failDelete=true;assert.equal((await api(`/api/admin/images/${image.id}`,'DELETE')).status,200);
  const queuedDb=cloudDb();assert.equal(queuedDb.prepare('SELECT COUNT(*) n FROM pending_image_deletions').get().n,1);queuedDb.close();
  failDelete=false;await stop();base=await start();
  const cleanedDb=cloudDb();assert.equal(cleanedDb.prepare('SELECT COUNT(*) n FROM pending_image_deletions').get().n,0);cleanedDb.close();
  await stop();const original=objects.get('isolde-private/isolde.sqlite');failRestore=true;
  await assert.rejects(start(),/restore failed/);assert.deepEqual(objects.get('isolde-private/isolde.sqlite'),original);
});
