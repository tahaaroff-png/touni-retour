// TEMP — variants / img upload (avec variant_ids). À supprimer après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET='touni-sync-2026';
module.exports=async(req,res)=>{
 const q=req.query||{}; if(q.secret!==SECRET) return res.status(401).json({error:'unauthorized'});
 const base=`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
 try{ const h=await shopifyAdminHeaders();
  if(q.action==='variants'){ const r=await fetch(`${base}/products/${q.id}.json?fields=id,title,variants,options`,{headers:h}); const d=await r.json(); const p=d.product; return res.status(200).json({title:p.title, options:p.options.map(o=>({name:o.name,values:o.values})), variants:p.variants.map(v=>({id:v.id,title:v.title,option1:v.option1,option2:v.option2}))}); }
  if(q.action==='img'&&req.method==='POST'){ let b=req.body; if(typeof b==='string')b=JSON.parse(b); const out=[];
    for(const it of b.images){ const payload={image:{attachment:it.b64, position:it.position||1}}; if(it.alt)payload.image.alt=it.alt; if(it.variant_ids)payload.image.variant_ids=it.variant_ids;
      const r=await fetch(`${base}/products/${it.product_id}/images.json`,{method:'POST',headers:h,body:JSON.stringify(payload)}); const d=await r.json();
      out.push({product_id:it.product_id, ok:r.ok, image_id:d.image&&d.image.id, variants:d.image&&d.image.variant_ids, error:r.ok?undefined:JSON.stringify(d).slice(0,150)}); }
    return res.status(200).json({uploaded:out}); }
  return res.status(400).json({error:'bad action'});
 }catch(e){return res.status(500).json({error:String(e)});}
};
