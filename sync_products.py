#!/usr/bin/env python3
"""
Sync Shopify products → products.json
Usage: python3 sync_products.py
Env vars needed: SHOPIFY_DOMAIN, SHOPIFY_ACCESS_TOKEN
"""
import os, json, urllib.request, urllib.parse

DOMAIN = os.environ.get('SHOPIFY_DOMAIN', 'tounikora.myshopify.com')
TOKEN  = os.environ.get('SHOPIFY_ACCESS_TOKEN', '')

SIZE_MAP = {
    's': 'S', 's (168-173 cm)': 'S', 's (168-173cm)': 'S',
    'm': 'M', 'm (173-178 cm)': 'M', 'm (173-178cm)': 'M',
    'l': 'L', 'l (178-183 cm)': 'L', 'l (178-183cm)': 'L',
    'xl': 'XL', 'xl (183-188 cm)': 'XL', 'xl (183-188cm)': 'XL',
    'xxl': '2XL', 'xxl (188-193 cm)': '2XL', 'xxl (188-193cm)': '2XL',
    '2xl': '2XL', '3xl': '3XL', '4xl': '4XL', 'xs': 'XS',
}
SIZE_COLORS = {
    'black','blanc','rouge','beige','gray','noir','yellow','halo ivory',
    'gris-clair','gris-fonces','with','without','light brown',
}
SIZE_ORDER = ['XS','S','M','L','XL','2XL','3XL','4XL']

def normalize_size(s):
    if not s: return None
    k = s.strip().lower()
    if k in SIZE_COLORS: return None
    return SIZE_MAP.get(k, s.strip())

def sort_sizes(sizes):
    def key(s):
        if s in SIZE_ORDER: return (0, SIZE_ORDER.index(s))
        return (1, s)
    return sorted(set(sizes), key=key)

def fetch_all_products():
    products = []
    url = f'https://{DOMAIN}/admin/api/2024-01/products.json?limit=250&status=active&fields=title,variants,images'
    while url:
        req = urllib.request.Request(url, headers={'X-Shopify-Access-Token': TOKEN})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            products.extend(data['products'])
            link = resp.headers.get('Link', '')
            import re
            m = re.search(r'<([^>]+)>;\s*rel="next"', link)
            url = m.group(1) if m else None
    return products

def convert(p):
    raw = [v.get('option1') for v in p.get('variants', [])]
    sizes = sort_sizes([normalize_size(s) for s in raw if normalize_size(s)])
    raw_colors = [v.get('option2') for v in p.get('variants', [])] + [v.get('option3') for v in p.get('variants', [])]
    colors = list(dict.fromkeys([c for c in raw_colors if c and c.strip().lower() not in SIZE_MAP and c.strip().lower() not in SIZE_COLORS]))
    image = p['images'][0]['src'] if p.get('images') else ''
    return {'title': p['title'], 'sizes': sizes, 'colors': colors, 'image': image}

if __name__ == '__main__':
    if not TOKEN:
        print('ERROR: Set SHOPIFY_ACCESS_TOKEN env var')
        exit(1)
    print(f'Fetching products from {DOMAIN}...')
    products = fetch_all_products()
    entries = [convert(p) for p in products]
    with open('products.json', 'w', encoding='utf-8') as f:
        json.dump(entries, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Done. {len(entries)} products written to products.json')
