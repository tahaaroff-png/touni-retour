// TEMP — addcols / prodcols. À supprimer après usage.
const { SHOPIFY_DOMAIN, SHOPIFY_API_VERSION, shopifyAdminHeaders } = require('./_shopify-helpers');
const SECRET='touni-sync-2026';
async function gql(h,q,v){const r=await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,{method:'POST',headers:h,body:JSON.stringify({query:q,variables:v})});return r.json();}
const gP=id=>`gid://shopify/Product/${id}`, gC=id=>`gid://shopify/Collection/${id}`;
module.exports=async(req,res)=>{
 const q=req.query||{}; if(q.secret!==SECRET) return res.status(401).json({error:'unauthorized'});
 try{ const h=await shopifyAdminHeaders();
  if(q.action==='addcols'&&req.method==='POST'){ let b=req.body; if(typeof b==='string')b=JSON.parse(b);
    const d=await gql(h,`mutation($id:ID!,$pids:[ID!]!){ collectionAddProducts(id:$id, productIds:$pids){ collection{ id title } userErrors{ message } } }`,{id:gC(b.collection_id),pids:b.product_ids.map(gP)});
    const r=d.data&&d.data.collectionAddProducts; return res.status(200).json({ok:!!(r&&r.collection),collection:r&&r.collection,errors:(r&&r.userErrors)||d.errors});
  }
  if(q.action==='prodcols'){ const d=await gql(h,`query($id:ID!){ product(id:$id){ title collections(first:60){ nodes{ id title } } } }`,{id:gP(q.id)}); const p=d.data&&d.data.product; if(!p)return res.status(404).json({error:'nf'}); return res.status(200).json({product:p.title,collections:p.collections.nodes.map(c=>({id:c.id.split('/').pop(),title:c.title}))}); }
  return res.status(400).json({error:'bad action'});
 }catch(e){return res.status(500).json({error:String(e)});}
};
