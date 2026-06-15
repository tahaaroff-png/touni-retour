// TEMP — orders created_at pour analyse horaire. À supprimer après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET='touni-sync-2026';
module.exports=async(req,res)=>{
 const q=req.query||{}; if(q.secret!==SECRET) return res.status(401).json({error:'unauthorized'});
 const base=`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`;
 try{ const h=await shopifyAdminHeaders();
  if(q.action==='orders'){
    const out=[]; const maxPages=parseInt(q.pages||'5');
    let url=`${base}/orders.json?status=any&limit=250&fields=created_at,financial_status,total_price`;
    let pages=0;
    while(url && pages<maxPages){ const r=await fetch(url,{headers:h}); const d=await r.json();
      for(const o of (d.orders||[])) out.push({c:o.created_at,f:o.financial_status,t:o.total_price});
      const link=r.headers.get('link')||''; const m=link.match(/<([^>]+)>;\s*rel="next"/); url=m?m[1]:null; pages++;
    }
    return res.status(200).json({count:out.length,orders:out});
  }
  return res.status(400).json({error:'bad action'});
 }catch(e){return res.status(500).json({error:String(e)});}
};
