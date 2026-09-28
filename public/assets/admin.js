const $ = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>[...root.querySelectorAll(s)];
const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
const api = async (url, options={}) => {
  options.headers = {'Content-Type':'application/json','X-CSRF-Token':csrf,...(options.headers||{})};
  const res = await fetch(url, options);
  const out = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(out.error || 'Request failed');
  return out;
};
const toast = (msg, bad=false) => {
  const el = document.createElement('div'); el.className = 'admin-toast'+(bad?' bad':''); el.textContent=msg; document.body.appendChild(el);
  setTimeout(()=>el.classList.add('show'),10); setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.remove(),250)},2400);
};
const formObject = form => {
  const data = Object.fromEntries(new FormData(form).entries());
  $$('input[type=checkbox]', form).forEach(i=>data[i.name]=i.checked?1:0);
  ['price','compare_at_price'].forEach(k=>{ if(k in data) data[k]=data[k] === '' ? null : Math.round(Number(data[k])*100); });
  ['stock','size_ml','sort_order'].forEach(k=>{ if(k in data) data[k]=data[k] === '' ? null : Number(data[k]); });
  return data;
};

async function fileToDataUrl(file) {
  return await new Promise((resolve,reject)=>{const r=new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file);});
}

function initProductForm() {
  const form = $('[data-product-form]'); if (!form) return;
  const id = form.dataset.productId;
  form.addEventListener('submit', async e=>{
    e.preventDefault(); const btn=$('button[type=submit]',form); btn.disabled=true;
    try {
      const data=formObject(form);
      const out = await api(id ? `/api/admin/products/${id}` : '/api/admin/products', {method:id?'PUT':'POST',body:JSON.stringify(data)});
      toast('Product saved');
      if(!id) location.href=`/admin/products/${out.id}/edit`; else setTimeout(()=>location.reload(),450);
    } catch(err){toast(err.message,true)} finally{btn.disabled=false}
  });
  const uploader = $('[data-image-upload]');
  uploader?.addEventListener('change', async()=>{
    if(!id){toast('Save the product first, then upload images.', true); return;}
    const files=[...uploader.files]; if(!files.length)return;
    uploader.disabled=true;
    for(const file of files){
      try{ const dataUrl=await fileToDataUrl(file); await api(`/api/admin/products/${id}/images`,{method:'POST',body:JSON.stringify({filename:file.name,dataUrl,alt:$('[name=name]',form)?.value||''})}); }
      catch(err){toast(err.message,true)}
    }
    toast('Images uploaded'); setTimeout(()=>location.reload(),500);
  });
  $$('[data-delete-image]').forEach(btn=>btn.onclick=async()=>{if(!confirm('Delete this image?'))return; try{await api(`/api/admin/images/${btn.dataset.deleteImage}`,{method:'DELETE'});location.reload()}catch(e){toast(e.message,true)}});
  $$('[data-primary-image]').forEach(btn=>btn.onclick=async()=>{try{await api(`/api/admin/images/${btn.dataset.primaryImage}/primary`,{method:'POST',body:'{}'});location.reload()}catch(e){toast(e.message,true)}});
}

function initDeleteProducts(){
  $$('[data-delete-product]').forEach(btn=>btn.onclick=async()=>{if(!confirm('Delete this product and its images?'))return;try{await api(`/api/admin/products/${btn.dataset.deleteProduct}`,{method:'DELETE'});btn.closest('tr').remove();toast('Product deleted')}catch(e){toast(e.message,true)}});
}
function initOrder(){
  const form=$('[data-order-form]'); if(!form)return; form.onsubmit=async e=>{e.preventDefault();try{await api(`/api/admin/orders/${form.dataset.orderId}`,{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});toast('Order updated')}catch(err){toast(err.message,true)}};
}
function initSettings(){
  const form=$('[data-settings-form]'); if(!form)return; form.onsubmit=async e=>{e.preventDefault();const btn=$('button[type=submit]',form);btn.disabled=true;try{await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});toast('Settings saved')}catch(err){toast(err.message,true)}finally{btn.disabled=false}};
}
function initSlug(){
  const name=$('[name=name]'), slug=$('[name=slug]'); if(!name||!slug||slug.value)return;
  name.addEventListener('input',()=>{slug.value=name.value.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')});
}
document.addEventListener('DOMContentLoaded',()=>{initProductForm();initDeleteProducts();initOrder();initSettings();initSlug();});
