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

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/* ছবির লিংক ঠিক করার ফাংশনও index.html থেকেই — সাইট যে লিংক দিয়ে ছবি খোঁজে,
   ম্যাপের চাবিও হুবহু সেটাই হতে হবে */
const imgScope = {};
new Function('scope', extractFn('driveId') + extractFn('imgURL')
  + ';scope.imgURL=imgURL;')(imgScope);
const imgURL = imgScope.imgURL;

/* ---------- ছবির নিজস্ব কপি: /img/<id>-<200|600|1200>.webp ----------
   সাইটের সব ছবি (পণ্য, ক্যাটাগরি, ব্যানার, পপআপ, লোগো, রিভিউ, ব্লগ) একবার নামিয়ে
   WebP করে repo-তে রাখা হয়। এরপর ভিজিটররা ছবি পায় GitHub-এর CDN থেকে, Supabase
   বা Google Drive-এর উপর কোনো চাপ পড়ে না। একবার বানানো ছবি আর বানানো হয় না;
   সাইটে আর ব্যবহার না হওয়া ছবি মুছে ফেলা হয়। কোনো ছবি নামাতে ব্যর্থ হলে সেটা
   শুধু বাদ পড়ে — সাইট তখন আগের মতো wsrv দিয়ে দেখায়। */
const IMG_DIR = join(ROOT, 'img');
const IMG_WIDTHS = [200, 600, 1200];     // index.html-এর cdnW()-এর তিনটা ধাপ

function collectImageUrls(snap){
  const out = new Set();
  const add = (v, splitter) => {
    if(!v) return;
    String(v).split(splitter || /\s*\n\s*/).forEach(x => {
      x = x.trim();
      if(!/^https?:\/\//i.test(x)) return;
      if(/\.(mp4|webm|ogg)(\?|#|$)/i.test(x) || /youtu\.?be/i.test(x)) return;   // ভিডিও নয়
      out.add(x);
    });
  };
  snap.products.forEach(p => Object.keys(p).forEach(k => {
    if(/^(image_url|image)\d*$/i.test(k)) add(p[k], /[|\n,]+/);   // index.html-এর gatherMedia-র মতো
  }));
  snap.categories.forEach(c => add(c.image_url));
  snap.reviews.forEach(r => add(r.photo));
  snap.blog.forEach(b => add(b.image));
  snap.pages.forEach(pg => add(pg.image));
  snap.settings.forEach(r => {
    const k = (r.key || '').trim();
    if(/^banner\d+$/.test(k)) add(String(r.value || '').split('|')[0]);   // "লিংক | শিরোনাম | …"
    else if(k === 'popup_image' || k === 'logo_url') add(r.value);
  });
  return [...out];
}

async function mirrorImages(snap){
  let sharp;
  try{ sharp = (await import('sharp')).default; }
  catch(e){ console.log('ℹ sharp নেই — ছবির কপি বানানো বাদ'); return {}; }
  mkdirSync(IMG_DIR, { recursive: true });

  const map = {}, keep = new Set();
  const urls = collectImageUrls(snap);
  let made = 0, failed = 0;

  async function one(raw){
    const src = imgURL(raw);                           // সাইট যে লিংক থেকে ছবি নেয়
    const id  = createHash('sha1').update(src).digest('hex').slice(0, 16);
    const files = IMG_WIDTHS.map(w => join(IMG_DIR, `${id}-${w}.webp`));
    if(!files.every(f => existsSync(f))){
      try{
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 25000);
        const r = await fetch(src, { signal: ctl.signal, redirect: 'follow' });
        clearTimeout(timer);
        if(!r.ok) throw new Error('HTTP ' + r.status);
        if(!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('ছবি নয়: ' + r.headers.get('content-type'));
        const buf = Buffer.from(await r.arrayBuffer());
        for(let i = 0; i < IMG_WIDTHS.length; i++){
          await sharp(buf, { failOn: 'none' }).rotate()
            .resize({ width: IMG_WIDTHS[i], withoutEnlargement: true })
            .webp({ quality: 80 }).toFile(files[i]);
        }
        made++;
      }catch(e){
        failed++;
        files.forEach(f => { try{ unlinkSync(f); }catch(_){} });   // অর্ধেক বানানো ফাইল রাখা হয় না
        console.log(`  ✗ ${src.slice(0, 90)} — ${e.message}`);
        return;
      }
    }
    keep.add(id);
    // সাইট কখনো মূল লিংক, কখনো ঠিক করা লিংক দিয়ে খোঁজে — দুটোই রাখা
    map[src] = id; map[raw] = id; map[imgURL(src)] = id;
  }

  // একসাথে ৬টা করে নামানো
  const queue = urls.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while(queue.length) await one(queue.shift());
  }));

  // আর ব্যবহার হয় না এমন পুরোনো ছবি মুছে ফেলা
  let removed = 0;
  for(const f of readdirSync(IMG_DIR)){
    const m = f.match(/^([0-9a-f]{16})-\d+\.webp$/);
    if(m && !keep.has(m[1])){ unlinkSync(join(IMG_DIR, f)); removed++; }
  }
  console.log(`✓ images — ${keep.size} ready (${made} new), ${failed} failed, ${removed} old files removed`);

  // কী ক্রমে ঢুকল তার উপর যেন ফাইল না বদলায় (নইলে অকারণে কমিট হতো)
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a < b ? -1 : 1));
}

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

/* ---------- ৩ক) সাইটের পুরো ডেটার স্ট্যাটিক কপি: /data/site.json ----------
   আগে প্রতিটা ভিজিটর পেজ খুললেই Supabase-এ ৭টা query যেত।
   অ্যাডে একসাথে হাজার মানুষ এলে ফ্রি প্ল্যানের লিমিট পার হয়ে
   সাইট বন্ধ হয়ে যেত। এখন ভিজিটররা এই ফাইলটা পড়ে (GitHub-এর
   CDN থেকে, ফ্রি), আর Supabase-এ যায় শুধু অর্ডার, ট্র্যাকিং
   আর নতুন রিভিউ। query-গুলো index.html-এর sbFetch()-এর হুবহু।
   কোনো একটা fetch ব্যর্থ হলে sb() থ্রো করে, ফলে অর্ধেক ফাইল
   লেখা হয় না — আগের site.json-টাই থেকে যায়। */
{
  const okReview = s => ['approved','approve','show','active','yes','published']
                          .includes(String(s || '').toLowerCase().trim());
  const hiddenPost = s => ['hidden','off','no','draft']
                          .includes(String(s || 'active').toLowerCase().trim());

  const [allProducts, categories, coupons, reviews, pages, blog] = await Promise.all([
    sb('products?select=*&order=sort_order.asc'),
    sb('categories?select=name,slug,image_url,sort_order&order=sort_order.asc,name.asc'),
    // মেয়াদ/সীমার কলাম পড়ার অনুমতি না থাকলে পুরো বিল্ড যেন না ভাঙে — তখন শুধু মূল তথ্য
    sb('coupons?select=code,type,value,min:min_amount,max:max_discount,expires:expires_at,limit:usage_limit,used:used_count&active=eq.true')
      .catch(() => sb('coupons?select=code,type,value,min:min_amount,max:max_discount&active=eq.true')),
    sb('reviews?select=name,profession,product,rating,review,photo,video,status,date:created_at'),
    sb('pages?select=page,title,content,image'),
    sb('blog_posts?select=title,date:post_date,image,content,status')
  ]);

  const snapshot = {
    // generated_at রাখা হয়নি: তাহলে প্রতিবার ফাইল বদলাত আর
    // ডেটা একই থাকলেও প্রতি রানে অকারণে কমিট ও ডিপ্লয় হতো
    settings:   setRows,
    categories,
    coupons,
    // লুকানো পণ্য, পেন্ডিং রিভিউ আর ড্রাফট ব্লগ পাবলিক ফাইলে রাখা হয় না
    products:   allProducts.filter(p => p.name && String(p.status || '').toLowerCase().trim() !== 'hidden'),
    reviews:    reviews.filter(r => (r.name || r.review) && okReview(r.status)),
    pages,
    blog:       blog.filter(b => !hiddenPost(b.status))
  };

  snapshot.img_map = await mirrorImages(snapshot);

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'site.json'), JSON.stringify(snapshot), 'utf8');
  console.log(`✓ data/site.json — ${snapshot.products.length} products, ${snapshot.reviews.length} reviews`);
}

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
