/* ============================================================
   ilm Toy — প্রি-রেন্ডার
   প্রতিটা পণ্যের জন্য /p/<slug>/index.html বানায়।
   ওই ফাইলে শুধু OG ট্যাগ ও structured data থাকে, তারপর
   গ্রাহককে /#p=<id> এ পাঠিয়ে দেয়।

   ফেসবুক আর গুগলের ক্রলার জাভাস্ক্রিপ্ট চালায় না, তাই
   হ্যাশ-লিংকে ওরা কোন পণ্য বুঝতেই পারে না। এই ফাইলগুলো
   সেই ফাঁকটা পূরণ করে।

   চালানো:  node scripts/prerender.mjs
   ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT   = process.cwd();
const SITE   = 'https://ilmtoy.com';
const OUTDIR = join(ROOT, 'p');

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* ---------- ১) index.html থেকেই Supabase-এর তথ্য ----------
   আলাদা করে সিক্রেট রাখার দরকার নেই — anon key এমনিতেই
   index.html-এ প্রকাশ্য, আর এভাবে নিলে কখনো পুরনো হবে না। */
const grabConst = (name) => {
  const m = html.match(new RegExp(`const\\s+${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`));
  if (!m) throw new Error(`index.html-এ ${name} পাওয়া গেল না`);
  return m[1];
};
const SB_URL = grabConst('SB_URL');
const SB_KEY = grabConst('SB_KEY');

/* ---------- ২) slug বানানোর ফাংশন index.html থেকেই ----------
   হাতে কপি করলে ভবিষ্যতে একটায় বদল হলে অন্যটা পিছিয়ে
   পড়ত, আর লিংক দুই রকম হয়ে যেত। */
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`index.html-এ ${name}() পাওয়া গেল না`);
  let i = html.indexOf('{', start), depth = 0, j = i;
  for (;; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) break;
  }
  return html.slice(start, j + 1);
}
const slugScope = {};
new Function('scope', extractFn('bnToLatin') + extractFn('slugify')
  + ';scope.slugify=slugify;')(slugScope);
const slugify = slugScope.slugify;

/* ---------- ৩) ডেটা আনা ---------- */
async function sb(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const products = await sb('products?select=id,name,description,price,old_price,image_url,category,status,stock&order=sort_order');
const setRows  = await sb('settings?select=key,value');

const S = {};
setRows.forEach(r => { if (r.key) S[r.key.trim()] = (r.value || '').trim(); });

const STORE = S.store_name || 'ilm Toy';
const live  = products.filter(p => p.name && p.status !== 'hidden');

/* ---------- ৪) সহায়ক ---------- */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// image_url ঘরে একাধিক লিংক থাকতে পারে ( | বা নতুন লাইন দিয়ে )
const firstImage = (p) => String(p.image_url || '')
  .split(/\s*[|\n]\s*/).map(s => s.trim()).filter(Boolean)[0] || '';

const plain = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip  = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const productSlug = (p) => slugify(p.name) || ('product-' + p.id);

/* ---------- ৫) একটা পণ্যের পাতা ---------- */
function pageFor(p) {
  const slug  = productSlug(p);
  const url   = `${SITE}/p/${slug}/`;
  const img   = firstImage(p);
  const title = `${plain(p.name)} — ${STORE}`;
  const price = Number(p.price) || 0;
  const desc  = clip(plain(p.description) || `${plain(p.name)} — ৳${price}। ${STORE} থেকে অর্ডার করুন।`, 160);

  // স্টক শেষ হলে গুগলকে সেটাই বলা — ভুল বললে গুগল পরে
  // যাচাই করে অসঙ্গতি পেলে রিচ রেজাল্ট বন্ধ করে দেয়
  const soldOut = ['soldout','sold out','out of stock','stockout','no stock']
                    .includes(String(p.status||'').toLowerCase())
                  || (p.stock !== null && p.stock !== undefined && Number(p.stock) <= 0);

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: plain(p.name),
    description: plain(p.description) || plain(p.name),
    image: img ? [img] : [],
    sku: String(p.id),
    brand: { '@type': 'Brand', name: STORE },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'BDT',
      price: String(price),
      availability: soldOut ? 'https://schema.org/OutOfStock'
                             : 'https://schema.org/InStock'
    }
  };

  return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">

<meta property="og:type" content="product">
<meta property="og:site_name" content="${esc(STORE)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${img ? `<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="1200">` : ''}
<meta property="product:price:amount" content="${price}">
<meta property="product:price:currency" content="BDT">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${img ? `<meta name="twitter:image" content="${esc(img)}">` : ''}

<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g,'\\u003c')}<\/script>

<!-- ক্রলার উপরের ট্যাগগুলো পড়ে নেওয়ার পর গ্রাহককে আসল সাইটে পাঠানো -->
<meta http-equiv="refresh" content="0; url=/#p=${p.id}">
<script>location.replace('/#p=${p.id}');<\/script>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;color:#555}</style>
</head>
<body>
<h1 style="font-size:19px">${esc(plain(p.name))}</h1>
<p>এক মুহূর্ত… <a href="/#p=${p.id}">এখানে ক্লিক করুন</a></p>
</body>
</html>
`;
}

/* ---------- ৬) লেখা ---------- */
// পুরনো পাতা মুছে নতুন করে — নাম বদলানো বা মুছে ফেলা পণ্যের
// পাতা রয়ে গেলে গুগলে মৃত লিংক জমতে থাকত
if (existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

const seen = new Map();
let written = 0;

for (const p of live) {
  let slug = productSlug(p);
  // দুটো পণ্যের নাম হুবহু এক হলে slug-ও এক হবে
  if (seen.has(slug)) slug = `${slug}-${p.id}`;
  seen.set(slug, p.id);

  const dir = join(OUTDIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), pageFor({ ...p, __slug: slug }), 'utf8');
  written++;
}

/* ---------- ৭) sitemap ও robots ---------- */
const today = new Date().toISOString().slice(0, 10);
const urls = [
  `  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>`,
  ...[...seen.keys()].map(s =>
    `  <url><loc>${SITE}/p/${s}/</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`)
];
writeFileSync(join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
  'utf8');

writeFileSync(join(ROOT, 'robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /admin.html\n\nSitemap: ${SITE}/sitemap.xml\n`, 'utf8');

/* ---------- ৮) 404 — নিরাপত্তা জাল ----------
   নতুন পণ্য যোগ করার পর পরের বিল্ড চলা পর্যন্ত তার পাতা
   থাকে না। ইতিমধ্যে কেউ লিংক শেয়ার করলে GitHub-এর সাদা
   404 দেখত। এই ফাইল ঠিকানা থেকে slug বুঝে নিয়ে সাইটেই
   পাঠিয়ে দেবে — শুধু OG প্রিভিউটা পাওয়া যাবে না। */
writeFileSync(join(ROOT, '404.html'), `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(STORE)}</title>
<meta name="robots" content="noindex">
<script>
(function(){
  var m = location.pathname.match(/^\\/p\\/([^/]+)\\/?$/);
  location.replace(m ? '/#p=' + m[1] : '/');
})();
<\/script>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;color:#555}</style>
</head>
<body><p>এক মুহূর্ত… <a href="/">হোমপেজে যান</a></p></body>
</html>
`, 'utf8');

console.log(`✓ ${written} product pages, sitemap with ${urls.length} URLs`);
