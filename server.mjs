import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStorage } from './storage.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(PUBLIC, 'uploads', 'products');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const k = trimmed.slice(0, i).trim();
    let v = trimmed.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@isolde.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Isolde123!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-development-secret-change-me';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ORDER_NOTIFICATION_EMAIL = process.env.ORDER_NOTIFICATION_EMAIL || ADMIN_EMAIL;
const ORDER_NOTIFICATION_FROM = process.env.ORDER_NOTIFICATION_FROM || 'Isolde Orders <orders@isolde.ca>';
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const SUPABASE_DATA_BUCKET = process.env.SUPABASE_DATA_BUCKET || 'isolde-private';
const SUPABASE_IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'isolde-images';
const SUPABASE_ENABLED = !!SUPABASE_URL && !!SUPABASE_SECRET_KEY;
const DEFAULT_CURRENCY = (process.env.STORE_CURRENCY || 'CAD').toUpperCase();
const USING_DEFAULT_ADMIN = !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET;
const DB_PATH = path.join(DATA, 'isolde.sqlite');

const PRODUCTION = process.env.NODE_ENV==='production' || !!process.env.RENDER || BASE_URL.startsWith('https://');
if (!!SUPABASE_URL !== !!SUPABASE_SECRET_KEY) throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY.');
if(PRODUCTION && USING_DEFAULT_ADMIN) throw new Error('Set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET before publishing.');
if(PRODUCTION && (['Isolde123!','ChangeMeNow123!'].includes(ADMIN_PASSWORD) || SESSION_SECRET.length<32 || SESSION_SECRET==='replace-with-a-long-random-secret')) throw new Error('Use a unique admin password and a random SESSION_SECRET of at least 32 characters.');
if(PRODUCTION && (!BASE_URL.startsWith('https://') || new URL(BASE_URL).hostname==='localhost')) throw new Error('BASE_URL must be your public HTTPS domain.');
if(PRODUCTION && !SUPABASE_ENABLED) throw new Error('Configure Supabase before publishing so products and images survive restarts.');
if(SUPABASE_ENABLED && SUPABASE_DATA_BUCKET===SUPABASE_IMAGE_BUCKET) throw new Error('Use separate private data and public image buckets.');
if(SUPABASE_ENABLED && process.env.SUPABASE_SINGLE_INSTANCE!=='true') throw new Error('Set SUPABASE_SINGLE_INSTANCE=true and run only one server instance.');
if(PRODUCTION && STRIPE_SECRET_KEY && !STRIPE_WEBHOOK_SECRET) throw new Error('Set STRIPE_WEBHOOK_SECRET to enable reliable card payments.');
const storage=SUPABASE_ENABLED ? createStorage({url:SUPABASE_URL,key:SUPABASE_SECRET_KEY,dataBucket:SUPABASE_DATA_BUCKET,imageBucket:SUPABASE_IMAGE_BUCKET}) : null;

async function uploadStorageObject(bucket, name, bytes, type) {
  return storage.upload(bucket,name,bytes,type);
}
function publicStorageUrl(bucket,name) { return storage.publicUrl(bucket,name); }
function imageObjectFromUrl(value='') {
  if(!SUPABASE_ENABLED) return null;
  const prefix=`${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_IMAGE_BUCKET)}/`;
  if(!String(value).startsWith(prefix)) return null;
  return String(value).slice(prefix.length).split('/').map(x=>decodeURIComponent(x)).join('/');
}
if(SUPABASE_ENABLED) await storage.restore(DB_PATH,process.env.SUPABASE_ALLOW_INITIALIZE==='true');

const DATABASE_NEW=!fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
let persistChain=Promise.resolve();
let backupDirty=false;
function persistDatabase() {
  if(!SUPABASE_ENABLED) return Promise.resolve();
  backupDirty=true;
  const operation=persistChain.catch(()=>{}).then(async()=>{
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint.busy) throw new Error('Database checkpoint is busy.');
    const bytes=fs.readFileSync(DB_PATH);
    await uploadStorageObject(SUPABASE_DATA_BUCKET,'isolde.sqlite',bytes,'application/vnd.sqlite3');
    backupDirty=false;
  });
  persistChain=operation;
  return operation.catch(err=>{
    console.error('Database backup failed:',err.message);
    const failure=new Error('Cloud save failed. Changes are kept locally and will be retried. Refresh to check before retrying.');
    failure.statusCode=503;
    throw failure;
  });
}
async function uploadProductImage(name, bytes, contentType) {
  const objectName=`products/${name}`;
  await uploadStorageObject(SUPABASE_IMAGE_BUCKET,objectName,bytes,contentType);
  return publicStorageUrl(SUPABASE_IMAGE_BUCKET,objectName);
}
async function deleteStoredImage(imagePath) {
  const remote=imageObjectFromUrl(imagePath);
  if(remote) {
    await storage.remove(SUPABASE_IMAGE_BUCKET,remote);
    return;
  }
  if(String(imagePath).startsWith('/uploads/products/')) {
    const file=path.join(PUBLIC,imagePath);
    if(fs.existsSync(file)) fs.unlinkSync(file);
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS pending_image_deletions (path TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  inspired_by TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Signature',
  audience TEXT NOT NULL DEFAULT 'Unisex',
  price_cents INTEGER NOT NULL DEFAULT 0,
  compare_at_cents INTEGER,
  size_ml INTEGER,
  sku TEXT NOT NULL DEFAULT '',
  stock INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  featured INTEGER NOT NULL DEFAULT 0,
  bestseller INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address1 TEXT NOT NULL,
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Canada',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT NOT NULL DEFAULT 'manual',
  stripe_session_id TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('products', 'audience', "TEXT NOT NULL DEFAULT 'Unisex'");
ensureColumn('products', 'bestseller', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders','currency',"TEXT NOT NULL DEFAULT 'CAD'");
ensureColumn('orders','checkout_key','TEXT');
ensureColumn('orders','notification_sent','INTEGER NOT NULL DEFAULT 0');
ensureColumn('order_items','image',"TEXT NOT NULL DEFAULT ''");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_checkout_key ON orders(checkout_key) WHERE checkout_key IS NOT NULL');

function queueImageDeletion(imagePath) {
  db.prepare('INSERT OR IGNORE INTO pending_image_deletions(path) VALUES(?)').run(imagePath);
}
async function cleanupImages() {
  let changed=false;
  for(const row of db.prepare('SELECT path FROM pending_image_deletions').all()) {
    if(db.prepare('SELECT id FROM product_images WHERE path=?').get(row.path)) continue;
    try {
      await deleteStoredImage(row.path);
      db.prepare('DELETE FROM pending_image_deletions WHERE path=?').run(row.path);
      changed=true;
    } catch(err) { console.error('Image cleanup will retry:',err.message); }
  }
  if(changed) await persistDatabase();
}
async function migrateLocalImages() {
  if(!SUPABASE_ENABLED) return;
  for(const image of db.prepare("SELECT id,path FROM product_images WHERE path LIKE '/uploads/products/%'").all()) {
    const name=path.basename(image.path);
    const local=path.join(UPLOADS,name);
    if(!fs.existsSync(local)) { console.warn(`Old image is missing and must be reuploaded: ${name}`); continue; }
    const type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(name).toLowerCase()];
    if(!type) continue;
    const remote=await uploadProductImage(name,fs.readFileSync(local),type);
    db.prepare('UPDATE product_images SET path=? WHERE id=?').run(remote,image.id);
  }
}


const settingDefaults = {
  brand_name: 'Isolde',
  tagline: 'Modern fragrance, reimagined.',
  announcement: 'Discover the Isolde signature collection — 9 distinctive scents.',
  hero_eyebrow: 'The Isolde Collection',
  hero_title: 'Scent, distilled to its character.',
  hero_subtitle: 'A refined collection of fragrance interpretations designed around the profiles people already love — presented with Isolde’s own visual language.',
  currency: DEFAULT_CURRENCY,
  contact_email: 'hello@isoldefragrance.com',
  contact_phone: '',
  instagram: '',
  shipping_note: 'Free shipping on all orders.',
  footer_note: 'Independent fragrance house. Designer references are used only to describe scent inspiration.',
  shipping_mode: 'free',
  shipping_flat_fee: '',
  free_shipping_threshold: '',
  shipping_countries: 'Canada',
  catalogue_v2_migrated: '0'
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(settingDefaults)) insertSetting.run(k, String(v));

// Apply the store owner's free-shipping policy once, preserving later admin edits.
if (!db.prepare("SELECT value FROM settings WHERE key='free_shipping_launch_v1'").get()) {
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE settings SET value='free' WHERE key='shipping_mode'").run();
    db.prepare("UPDATE settings SET value='Free shipping on all orders.' WHERE key='shipping_note'").run();
    insertSetting.run('free_shipping_launch_v1', '1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const seedProducts = [
  {
    slug: 'fruity-gardenia-brown-sugar', name: 'Fruity Gardenia & Brown Sugar',
    inspired_by: 'Flora Gorgeous Gardenia Eau de Parfum with Pear and Brown Sugar',
    description: 'A luminous floral-fruity profile with creamy gardenia, pear-like brightness and a warm brown-sugar finish. Soft, polished and easy to wear.',
    category: 'Floral · Fruity', audience: 'Women', price_cents: 4500, featured: 1, bestseller: 0, sort_order: 1, image: '/uploads/products/fruity-gardenia-brown-sugar.webp'
  },
  {
    slug: 'floral-lavender-nectar', name: 'Floral Lavender Nectar', inspired_by: 'YSL Libre Intense',
    description: 'An aromatic floral interpretation built around lavender freshness and a smooth, warm sweetness. Confident, elegant and full-bodied.',
    category: 'Floral · Aromatic', audience: 'Women', price_cents: 5000, featured: 1, bestseller: 0, sort_order: 2, image: '/uploads/products/floral-lavender-nectar.webp'
  },
  {
    slug: 'jasmine-flowers-vanilla-bourbon', name: 'Jasmine Flowers & Vanilla Bourbon', inspired_by: 'Valentino Donna Born in Roma',
    description: 'Radiant jasmine and white-floral character wrapped in creamy vanilla warmth. A polished scent with a soft, modern trail.',
    category: 'Floral · Vanilla', audience: 'Women', price_cents: 5000, featured: 0, bestseller: 0, sort_order: 3, image: '/uploads/products/jasmine-flowers-vanilla-bourbon.webp'
  },
  {
    slug: 'charismatic-woods', name: 'Charismatic Woods', inspired_by: 'Tom Ford Grey Vetiver',
    description: 'Clean, tailored woods with a crisp vetiver-like character and understated freshness. Refined, structured and effortlessly versatile.',
    category: 'Woody · Fresh', audience: 'Men', price_cents: 4500, featured: 1, bestseller: 0, sort_order: 4, image: '/uploads/products/charismatic-woods.webp'
  },
  {
    slug: 'tobacco-vanille', name: 'Tobacco Vanille', inspired_by: 'Tom Ford Tobacco Vanille',
    description: 'A rich tobacco-and-vanilla profile with warm sweetness and an enveloping, evening-ready feel. Deep, smooth and unmistakably bold.',
    category: 'Warm · Gourmand', audience: 'Unisex', price_cents: 4500, featured: 1, bestseller: 0, sort_order: 5, image: '/uploads/products/tobacco-vanille.webp'
  },
  {
    slug: 'golden-orchid', name: 'Golden Orchid', inspired_by: 'Tom Ford Black Orchid',
    description: 'A dark floral interpretation with orchid richness, warm woods and a luxurious, velvety depth. Dramatic without losing polish.',
    category: 'Floral · Dark', audience: 'Unisex', price_cents: 5000, featured: 0, bestseller: 0, sort_order: 6, image: '/uploads/products/golden-orchid.webp'
  },
  {
    slug: 'blue-elixir', name: 'Blue Elixir', inspired_by: 'Dior Sauvage Elixir',
    description: 'A bold aromatic profile combining spicy freshness with a darker woody backbone. Concentrated, clean and designed to leave a strong impression.',
    category: 'Aromatic · Woody', audience: 'Men', price_cents: 5500, featured: 1, bestseller: 0, sort_order: 7, image: '/uploads/products/blue-elixir.webp'
  },
  {
    slug: 'rich-saffron', name: 'Rich Saffron', inspired_by: 'Althaïr by Parfums de Marly',
    description: 'A plush warm-spice profile with saffron-inspired richness, creamy sweetness and smooth woods. Comforting, luxurious and expressive.',
    category: 'Warm · Spiced', audience: 'Men', price_cents: 5000, featured: 0, bestseller: 0, sort_order: 8, image: '/uploads/products/rich-saffron.webp'
  },
  {
    slug: 'summer-creed', name: 'Summer Creed', inspired_by: 'Aventus Cologne by Creed',
    description: 'Bright citrus and juicy fruit move into polished woods for a clean, energetic fragrance with a relaxed summer character.',
    category: 'Fresh · Citrus', audience: 'Men', price_cents: 6000, featured: 1, bestseller: 0, sort_order: 9, image: '/uploads/products/summer-creed.webp'
  }
];
if (DATABASE_NEW) {
  const insP = db.prepare(`INSERT INTO products(slug,name,inspired_by,description,category,audience,price_cents,size_ml,sku,stock,status,featured,bestseller,sort_order)
    VALUES(?,?,?,?,?,?,?,?,'',NULL,'active',?,?,?)`);
  const insI = db.prepare('INSERT INTO product_images(product_id,path,alt,sort_order,is_primary) VALUES(?,?,?,?,1)');
  for (const p of seedProducts) {
    const r = insP.run(p.slug, p.name, p.inspired_by, p.description, p.category, p.audience || 'Unisex', Number(p.price_cents || 0), 100, p.featured, p.bestseller || 0, p.sort_order);
    insI.run(Number(r.lastInsertRowid), p.image, `${p.name} by Isolde`, 0);
  }
}

// One-time migration for the launch catalogue. After this runs, admin edits are preserved.
const catalogueMigrated = db.prepare("SELECT value FROM settings WHERE key='catalogue_v2_migrated'").get()?.value === '1';
if (!catalogueMigrated) {
  const launchAudience = {
    'fruity-gardenia-brown-sugar':'Women',
    'floral-lavender-nectar':'Women',
    'jasmine-flowers-vanilla-bourbon':'Women',
    'charismatic-woods':'Men',
    'tobacco-vanille':'Unisex',
    'golden-orchid':'Unisex',
    'blue-elixir':'Men',
    'rich-saffron':'Men',
    'summer-creed':'Men'
  };
  const launchDescriptions = {
    'fruity-gardenia-brown-sugar': 'Bright, feminine and polished. Fruity Gardenia & Brown Sugar pairs a sparkling fruit impression with creamy white florals and a soft caramelized sweetness for an easy signature scent that feels playful without losing elegance.',
    'floral-lavender-nectar': 'Confident and magnetic. Floral Lavender Nectar balances aromatic lavender character with a warm floral sweetness, creating a smooth, dressed-up fragrance that moves easily from daytime to evening.',
    'jasmine-flowers-vanilla-bourbon': 'Radiant jasmine meets a creamy vanilla warmth in a modern floral profile. Jasmine Flowers & Vanilla Bourbon feels soft, expressive and refined, with a lingering sweetness designed for everyday glamour.',
    'charismatic-woods': 'Crisp, tailored and quietly sophisticated. Charismatic Woods brings fresh woody character and a clean vetiver-style edge together for a versatile scent that feels sharp, modern and composed.',
    'tobacco-vanille': 'Rich, warm and enveloping. Tobacco Vanille blends a deep tobacco-style character with smooth vanilla sweetness for a bold evening fragrance with a luxurious, comforting trail.',
    'golden-orchid': 'Dark florals, warm woods and a velvety sense of depth define Golden Orchid. The result is dramatic and elegant, made for moments when you want your fragrance to feel distinctive and memorable.',
    'blue-elixir': 'Powerful, fresh and concentrated in character. Blue Elixir combines aromatic spice, clean freshness and a darker woody backbone for a confident scent with strong presence.',
    'rich-saffron': 'Warm spice and creamy sweetness come together in Rich Saffron. Smooth woods add depth, giving the fragrance a plush, polished feel that works especially well in cooler weather and evening settings.',
    'summer-creed': 'Fresh, energetic and effortless. Summer Creed opens with a bright citrus-fruit impression before settling into clean woods, creating a polished warm-weather scent with an easy everyday character.'
  };
  const setAudience = db.prepare('UPDATE products SET audience=? WHERE slug=?');
  const setDescription = db.prepare('UPDATE products SET description=? WHERE slug=?');
  for (const [slug, audience] of Object.entries(launchAudience)) setAudience.run(audience, slug);
  for (const [slug, description] of Object.entries(launchDescriptions)) setDescription.run(description, slug);
  db.prepare("UPDATE settings SET value='1' WHERE key='catalogue_v2_migrated'").run();
}
await migrateLocalImages();
await persistDatabase();
await cleanupImages();

function settings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
}
function shippingConfig() {
  const s=settings();
  const toCents=v => String(v ?? '').trim()==='' ? 0 : Math.max(0, Math.round(Number(v) * 100) || 0);
  return {
    mode: ['quote','flat','free'].includes(s.shipping_mode) ? s.shipping_mode : 'quote',
    flatFeeCents: toCents(s.shipping_flat_fee),
    freeThresholdCents: toCents(s.free_shipping_threshold),
    countries: String(s.shipping_countries || 'Canada').split(',').map(x=>x.trim()).filter(Boolean)
  };
}
function calculateShipping(subtotalCents) {
  const c=shippingConfig();
  if(c.mode==='quote') return null;
  if(c.mode==='free') return 0;
  if(c.freeThresholdCents > 0 && subtotalCents >= c.freeThresholdCents) return 0;
  return c.flatFeeCents;
}
function e(v='') { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function absoluteAssetUrl(value='') {
  const v=String(value || '');
  if(/^https?:\/\//i.test(v)) return v;
  return `${BASE_URL}${v.startsWith('/')?v:'/'+v}`;
}
function money(cents, currency = settings().currency || 'CAD') {
  if (!Number(cents)) return '';
  try { return new Intl.NumberFormat('en-CA', {style:'currency',currency}).format(cents / 100); }
  catch { return `$${(cents/100).toFixed(2)}`; }
}
function slugify(s='') { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,90); }
function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('='); if (i < 0) continue;
    out[pair.slice(0,i).trim()] = decodeURIComponent(pair.slice(i+1).trim());
  }
  return out;
}
function safeEqual(a,b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah,bh);
}
function newSession() {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + 1000*60*60*12;
  db.prepare('INSERT INTO sessions(id,csrf,expires_at) VALUES(?,?,?)').run(id,csrf,expires);
  return {id,csrf,expires};
}
function adminSession(req) {
  const sid = parseCookies(req).isolde_admin;
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare('DELETE FROM sessions WHERE id=?').run(sid); return null; }
  return row;
}
function requireAdmin(req,res,{api=false}={}) {
  const session = adminSession(req);
  if (session) return session;
  if (api) json(res,401,{error:'Please sign in again.'}); else redirect(res,'/admin/login');
  return null;
}
function verifyCsrf(req, session) { return !!session && safeEqual(req.headers['x-csrf-token'] || '', session.csrf); }
function redirect(res, loc, code=302) { res.writeHead(code,{Location:loc}); res.end(); }
function json(res, code, obj) { const body=JSON.stringify(obj); res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)}); res.end(body); }
function html(res, body, code=200, headers={}) { res.writeHead(code, {'Content-Type':'text/html; charset=utf-8',...headers}); res.end(body); }
function text(res, body, type='text/plain; charset=utf-8', code=200) { res.writeHead(code, {'Content-Type':type}); res.end(body); }
async function readBody(req, limit=22*1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req) { const b=await readBody(req); return JSON.parse(b.toString('utf8') || '{}'); }
async function readForm(req) { const b=await readBody(req,1024*1024); return Object.fromEntries(new URLSearchParams(b.toString('utf8'))); }

function getProducts({activeOnly=true, featured=false}={}) {
  let sql = `SELECT p.*, (SELECT path FROM product_images i WHERE i.product_id=p.id ORDER BY is_primary DESC, sort_order, id LIMIT 1) image
             FROM products p`;
  const where=[];
  if (activeOnly) where.push(`p.status='active'`);
  if (featured) where.push(`p.featured=1`);
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.sort_order, p.id';
  return db.prepare(sql).all();
}
function getBestSellers(limit=4) {
  const sold = db.prepare(`SELECT p.*, (SELECT path FROM product_images i WHERE i.product_id=p.id ORDER BY is_primary DESC, sort_order, id LIMIT 1) image,
      COALESCE(SUM(CASE WHEN o.payment_status='paid' AND o.status!='cancelled' THEN oi.qty ELSE 0 END),0) sales_qty
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id=p.id
    LEFT JOIN orders o ON o.id=oi.order_id
    WHERE p.status='active'
    GROUP BY p.id
    HAVING sales_qty > 0
    ORDER BY sales_qty DESC, p.sort_order, p.id
    LIMIT ?`).all(limit);
  if (sold.length) return sold;
  return db.prepare(`SELECT p.*, (SELECT path FROM product_images i WHERE i.product_id=p.id ORDER BY is_primary DESC, sort_order, id LIMIT 1) image, 0 sales_qty
    FROM products p WHERE p.status='active' AND p.bestseller=1 ORDER BY p.sort_order,p.id LIMIT ?`).all(limit);
}
function getProductBySlug(slug) {
  const p = db.prepare('SELECT * FROM products WHERE slug=? AND status=\'active\'').get(slug);
  if (!p) return null;
  p.images = db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY is_primary DESC, sort_order, id').all(p.id);
  return p;
}
function getAdminProduct(id) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return null;
  p.images = db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY is_primary DESC, sort_order, id').all(id);
  return p;
}

function baseHead(title, description='', options={}) {
  const s=settings();
  const isHome=!title || title===s.brand_name;
  const pageTitle=String(options.pageTitle || (isHome
    ? `${s.brand_name} Perfumes Canada | Women, Men & Unisex Fragrances`
    : `${title} | ${s.brand_name} Perfumes Canada`)).trim();
  const rawDescription=String(description || s.hero_subtitle || 'Discover Isolde fragrances, an independent perfume collection in Canada.').replace(/\s+/g,' ').trim();
  const metaDescription=rawDescription.length>165 ? rawDescription.slice(0,162).replace(/\s+\S*$/,'')+'…' : rawDescription;
  const canonicalPath=String(options.canonicalPath || '/');
  const canonical=`${BASE_URL}${canonicalPath.startsWith('/')?canonicalPath:'/'+canonicalPath}`;
  const ogImage=absoluteAssetUrl(options.image || '/assets/isolde-logo.png');
  const robots=options.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
  const organization={
    "@type":"Organization",
    "@id":`${BASE_URL}/#organization`,
    name:s.brand_name,
    url:BASE_URL,
    logo:{"@type":"ImageObject",url:absoluteAssetUrl('/assets/isolde-logo.png')},
    description:'Independent fragrance house in Canada offering Isolde perfumes for women, men and unisex wear.'
  };
  if(s.contact_email) organization.email=s.contact_email;
  if(/^https?:\/\//i.test(String(s.instagram||''))) organization.sameAs=[s.instagram];
  const website={
    "@type":"WebSite",
    "@id":`${BASE_URL}/#website`,
    url:BASE_URL,
    name:s.brand_name,
    publisher:{"@id":`${BASE_URL}/#organization`},
    inLanguage:'en-CA'
  };
  const structured={"@context":"https://schema.org","@graph":[organization,website]};
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(pageTitle)}</title><meta name="description" content="${e(metaDescription)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${e(canonical)}"><link rel="icon" type="image/png" href="/assets/isolde-logo.png"><meta name="theme-color" content="#171512"><meta property="og:locale" content="en_CA"><meta property="og:site_name" content="${e(s.brand_name)}"><meta property="og:type" content="${e(options.type || 'website')}"><meta property="og:title" content="${e(pageTitle)}"><meta property="og:description" content="${e(metaDescription)}"><meta property="og:url" content="${e(canonical)}"><meta property="og:image" content="${e(ogImage)}"><meta property="og:image:alt" content="${e(options.imageAlt || pageTitle)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(pageTitle)}"><meta name="twitter:description" content="${e(metaDescription)}"><meta name="twitter:image" content="${e(ogImage)}">${GOOGLE_SITE_VERIFICATION?`<meta name="google-site-verification" content="${e(GOOGLE_SITE_VERIFICATION)}">`:''}<script type="application/ld+json">${JSON.stringify(structured).replace(/</g,'\\u003c')}</script><link rel="stylesheet" href="/assets/styles.css"><script>window.ISOLDE_CURRENCY=${JSON.stringify(s.currency || 'CAD')};window.ISOLDE_SHIPPING=${JSON.stringify(shippingConfig())}</script><script src="/assets/store.js" defer></script></head><body>`;
}
function publicHeader(active='', seo={}) {
  const s=settings();
  return `${baseHead(active ? active : s.brand_name, seo.description || '', seo)}
  <div class="announcement">${e(s.announcement)}</div>
  <header class="site-header"><div class="container nav">
    <nav class="nav-links"><a href="/shop">Shop</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a></nav>
    <button class="menu-button" data-menu-toggle aria-label="Menu">☰</button>
    <a class="brand brand-logo" href="/" aria-label="${e(s.brand_name)} home"><img src="/assets/isolde-logo.png" alt="${e(s.brand_name)} perfume logo"></a>
    <div class="nav-actions"><a href="/about">Our Story</a><a class="bag-pill" href="/cart">Bag <span data-cart-count>0</span></a></div>
  </div><div class="mobile-menu" data-mobile-menu><a href="/shop">Shop all</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a><a href="/about">Our Story</a><a href="/contact">Contact</a></div></header>`;
}
function publicFooter() {
  const s=settings();
  return `<footer class="site-footer"><div class="container"><div class="footer-grid">
    <div><a class="footer-brand footer-logo" href="/" aria-label="${e(s.brand_name)} home"><img src="/assets/isolde-logo.png" alt="${e(s.brand_name)}"></a><p style="max-width:440px;color:#bdb3a5">${e(s.tagline)} ${e(s.footer_note)}</p></div>
    <div><h4>Collections</h4><a href="/shop">Shop all</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a></div>
    <div><h4>Customer care</h4><a href="/about">Our story</a><a href="/contact">Contact</a><a href="/shipping">Shipping</a><a href="/returns">Returns</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
  </div><div class="footer-bottom"><span>© ${new Date().getFullYear()} ${e(s.brand_name)}.</span><span>Designer brand names are referenced only to identify scent inspiration; Isolde is not affiliated with or endorsed by those brands.</span></div></div></footer></body></html>`;
}
function productCard(p) {
  const addPayload = JSON.stringify({id:p.id,slug:p.slug,name:p.name,inspiredBy:p.inspired_by,image:p.image,priceCents:p.price_cents}).replace(/'/g,'&#39;');
  const badge = Number(p.sales_qty||0)>0 || p.bestseller ? '<span class="tag">Best Seller</span>' : (p.featured?'<span class="tag">Featured</span>':'');
  return `<article class="product-card" data-product-card data-search="${e((p.name+' '+p.inspired_by+' '+p.category+' '+p.audience).toLowerCase())}" data-category="${e(p.category)}" data-audience="${e(p.audience||'Unisex')}" data-price="${p.price_cents||0}" data-name="${e(p.name)}" data-order="${p.sort_order}">
    <a class="product-media" href="/product/${e(p.slug)}"><img src="${e(p.image || '/assets/placeholder.svg')}" alt="${e(p.name)}" loading="lazy">${badge}</a>
    <div class="product-info"><div class="product-kicker">${e(p.audience||'Unisex')} · ${e(p.size_ml?`${p.size_ml} mL`:'Isolde')}</div><a class="product-name" href="/product/${e(p.slug)}">${e(p.name)}</a><div class="product-sub">Inspired by ${e(p.inspired_by)}</div>
    <div class="product-bottom">${p.price_cents>0?`<span class="price">${e(money(p.price_cents))}</span><button class="quick-add" aria-label="Add ${e(p.name)} to bag" data-add-to-cart data-product='${addPayload}'>+</button>`:`<span class="coming">Price coming soon</span><a class="quick-add" href="/product/${e(p.slug)}" aria-label="View product">→</a>`}</div>${shippingConfig().mode==='free'?'<p class="free-shipping">Free shipping</p>':''}</div>
  </article>`;
}
function homePage() {
  const s=settings();
  const featured=getProducts({featured:true}).slice(0,6);
  const best=getBestSellers(4);
  const all=getProducts();
  const heroMain=all.find(x=>x.slug==='tobacco-vanille') || all[0];
  const heroSide=all.find(x=>x.slug==='fruity-gardenia-brown-sugar') || all[1];
  const collectionCards=[
    {audience:'Women',title:'For Her',copy:'Floral, luminous and expressive profiles.',product:all.find(x=>x.slug==='floral-lavender-nectar')},
    {audience:'Men',title:'For Him',copy:'Fresh woods, aromatic depth and confident character.',product:all.find(x=>x.slug==='blue-elixir')},
    {audience:'Unisex',title:'Unisex',copy:'Warm, distinctive scents designed beyond labels.',product:all.find(x=>x.slug==='golden-orchid')}
  ].filter(x=>x.product);
  return `${publicHeader('',{canonicalPath:'/',description:'Shop Isolde perfumes in Canada. Discover independent fragrances for women, men and unisex wear, with clear scent inspiration and 100 mL bottles.'})}<main>
  <section class="lux-hero"><div class="container lux-hero-grid"><div class="lux-hero-copy"><div class="eyebrow">${e(s.hero_eyebrow)}</div><h1>${e(s.hero_title)}</h1><p class="lead">${e(s.hero_subtitle)}</p>${shippingConfig().mode==='free'?'<p class="shipping-banner">Free shipping on all orders</p>':''}<div class="hero-actions"><a class="btn" href="/shop">Shop all fragrances</a><a class="text-link" href="/about">Discover the house →</a></div><div class="hero-facts"><span>100 mL</span><span>9 signature scents</span><span>Independent fragrance house</span></div></div>
  <div class="lux-hero-media"><a class="hero-main-photo" href="/product/${e(heroMain.slug)}"><img src="${e(heroMain.image)}" alt="${e(heroMain.name)}"><div class="image-caption"><span>${e(heroMain.name)}</span><strong>${e(money(heroMain.price_cents))}</strong></div></a><a class="hero-float-photo" href="/product/${e(heroSide.slug)}"><img src="${e(heroSide.image)}" alt="${e(heroSide.name)}"></a></div></div></section>

  <div class="feature-strip"><div class="container"><div class="feature"><strong>100 mL collection</strong><span>Full-size bottles across the entire launch range.</span></div><div class="feature"><strong>Transparent inspiration</strong><span>Every product clearly identifies the fragrance direction that inspired it.</span></div><div class="feature"><strong>Independent identity</strong><span>Original Isolde naming, imagery and brand presentation.</span></div></div></div>

  <section class="collection-section"><div class="container"><div class="section-head"><div><div class="eyebrow">Shop by collection</div><h2 class="section-title">Choose your direction.</h2></div><p class="muted">Browse the Isolde range by the style you are shopping for, then refine further by scent family.</p></div><div class="collection-grid">${collectionCards.map(c=>`<a class="collection-card" href="/shop?audience=${encodeURIComponent(c.audience)}"><img src="${e(c.product.image)}" alt="${e(c.title)}"><div class="collection-overlay"><div class="eyebrow">${e(c.audience)}</div><h3>${e(c.title)}</h3><p>${e(c.copy)}</p><span>Explore collection →</span></div></a>`).join('')}</div></div></section>

  ${best.length?`<section class="best-section"><div class="container"><div class="section-head"><div><div class="eyebrow">Best sellers</div><h2 class="section-title">The fragrances customers choose most.</h2></div><p class="muted">This section can be curated from the admin panel and automatically reflects paid sales once orders begin.</p></div><div class="product-grid">${best.map(productCard).join('')}</div></div></section>`:''}

  <section><div class="container"><div class="section-head"><div><div class="eyebrow">The collection</div><h2 class="section-title">Nine scents. One visual language.</h2></div><p class="muted">A focused fragrance wardrobe spanning fresh, floral, woody, gourmand and aromatic directions.</p></div><div class="product-grid">${featured.map(productCard).join('')}</div><div style="text-align:center;margin-top:42px"><a class="btn btn-outline" href="/shop">View the full collection</a></div></div></section>

  <section class="editorial-section"><div class="container story-panel"><div class="story-copy"><div class="eyebrow" style="color:#c7a980">The Isolde point of view</div><h2 class="section-title">Recognizable inspiration, presented with restraint.</h2><p>Isolde is built for customers who know the fragrance styles they enjoy and want an elevated way to explore them. The inspiration stays transparent; the identity, photography and shopping experience belong to Isolde.</p><a class="btn btn-light" href="/about">Read our story</a></div><div class="story-photo"><img src="/uploads/products/golden-orchid.webp" alt="Golden Orchid by Isolde" loading="lazy"></div></div></section>
  <section style="padding-top:18px"><div class="container disclaimer"><strong>Brand-reference notice:</strong> Designer fragrance names shown on this website are used only to communicate scent inspiration. Isolde is an independent brand and is not affiliated with, sponsored by, or endorsed by those trademark owners.</div></section>
  </main>${publicFooter()}`;
}
function shopPage() {
  const products=getProducts();
  const cats=[...new Set(products.map(p=>p.category))];
  const description='Shop Isolde perfumes in Canada. Browse 100 mL fragrances for women, men and unisex wear by scent family, inspiration and price, with free shipping.';
  const collectionLd={
    "@context":"https://schema.org",
    "@type":"CollectionPage",
    "@id":`${BASE_URL}/shop#collection`,
    url:`${BASE_URL}/shop`,
    name:'Shop Isolde Perfumes in Canada',
    description,
    isPartOf:{"@id":`${BASE_URL}/#website`},
    mainEntity:{
      "@type":"ItemList",
      numberOfItems:products.length,
      itemListElement:products.map((p,index)=>({
        "@type":"ListItem",
        position:index+1,
        url:`${BASE_URL}/product/${encodeURIComponent(p.slug)}`,
        name:p.name,
        image:absoluteAssetUrl(p.image || '/assets/isolde-logo.png')
      }))
    }
  };
  const head=baseHead('Shop',description,{canonicalPath:'/shop',pageTitle:'Shop Perfumes in Canada | Women, Men & Unisex | Isolde'});
  return `${head.replace('</head>',`<script type="application/ld+json">${JSON.stringify(collectionLd).replace(/</g,'\\u003c')}</script></head>`)}<div class="announcement">${e(settings().announcement)}</div><header class="site-header"><div class="container nav">
    <nav class="nav-links"><a href="/shop">Shop</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a></nav>
    <button class="menu-button" data-menu-toggle aria-label="Menu">☰</button>
    <a class="brand brand-logo" href="/" aria-label="${e(settings().brand_name)} home"><img src="/assets/isolde-logo.png" alt="${e(settings().brand_name)} perfume logo"></a>
    <div class="nav-actions"><a href="/about">Our Story</a><a class="bag-pill" href="/cart">Bag <span data-cart-count>0</span></a></div>
  </div><div class="mobile-menu" data-mobile-menu><a href="/shop">Shop all</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a><a href="/about">Our Story</a><a href="/contact">Contact</a></div></header><main><section class="page-hero shop-hero"><div class="container"><div class="eyebrow">The Isolde Collection</div><h1>Find your signature.</h1><p class="lead">Explore all ${products.length} fragrances by audience, scent family, inspiration or price.</p></div></section>
  <section style="padding-top:20px"><div class="container"><div class="shop-toolbar shop-toolbar-4"><input class="field" data-shop-search placeholder="Search fragrances or inspirations…"><select class="select" data-shop-audience><option value="">Women, Men & Unisex</option><option>Women</option><option>Men</option><option>Unisex</option></select><select class="select" data-shop-category><option value="">All scent families</option>${cats.map(c=>`<option>${e(c)}</option>`).join('')}</select><select class="select" data-shop-sort><option value="default">Curated order</option><option value="name">Name A–Z</option><option value="price-asc">Price low to high</option><option value="price-desc">Price high to low</option></select></div><div class="shop-result-line"><span><strong data-shop-count>${products.length}</strong> fragrances</span><a href="/shop">Clear filters</a></div><div class="product-grid" data-shop-grid>${products.map(productCard).join('')}</div></div></section></main>${publicFooter()}`;
}
function productPage(p) {
  const s=settings();
  const ship=shippingConfig();
  const image=(p.images[0]?.path || '');
  const payload=JSON.stringify({id:p.id,slug:p.slug,name:p.name,inspiredBy:p.inspired_by,image,priceCents:p.price_cents}).replace(/'/g,'&#39;');
  const canonicalPath=`/product/${encodeURIComponent(p.slug)}`;
  const sizeLabel=p.size_ml ? `${p.size_ml} mL` : 'fragrance';
  const shippingCopy=ship.mode==='free' ? ' Free shipping in Canada.' : '';
  const metaDescription=`Shop ${p.name}, a ${sizeLabel} ${String(p.audience||'unisex').toLowerCase()} fragrance by Isolde inspired by ${p.inspired_by}.${shippingCopy}`;
  const productLd={
    "@type":"Product",
    "@id":`${BASE_URL}${canonicalPath}#product`,
    name:p.name,
    brand:{"@type":"Brand",name:s.brand_name},
    description:p.description,
    image:p.images.map(i=>absoluteAssetUrl(i.path)),
    url:`${BASE_URL}${canonicalPath}`,
    category:p.category,
    audience:{"@type":"PeopleAudience",suggestedGender:p.audience||'Unisex'},
    size:p.size_ml ? `${p.size_ml} mL` : undefined,
    sku:p.sku||undefined
  };
  if(p.price_cents>0) {
    const offer={
      "@type":"Offer",
      priceCurrency:s.currency||'CAD',
      price:(p.price_cents/100).toFixed(2),
      availability:p.stock===0?"https://schema.org/OutOfStock":"https://schema.org/InStock",
      itemCondition:"https://schema.org/NewCondition",
      url:`${BASE_URL}${canonicalPath}`,
      seller:{"@id":`${BASE_URL}/#organization`}
    };
    if(ship.mode==='free' && ship.countries.some(country=>country.toLowerCase()==='canada')) {
      offer.shippingDetails={
        "@type":"OfferShippingDetails",
        shippingRate:{"@type":"MonetaryAmount",value:"0.00",currency:s.currency||'CAD'},
        shippingDestination:{"@type":"DefinedRegion",addressCountry:"CA"}
      };
    }
    productLd.offers=offer;
  }
  const jsonLd={
    "@context":"https://schema.org",
    "@graph":[
      productLd,
      {
        "@type":"BreadcrumbList",
        "@id":`${BASE_URL}${canonicalPath}#breadcrumb`,
        itemListElement:[
          {"@type":"ListItem",position:1,name:"Home",item:BASE_URL},
          {"@type":"ListItem",position:2,name:"Shop",item:`${BASE_URL}/shop`},
          {"@type":"ListItem",position:3,name:p.name,item:`${BASE_URL}${canonicalPath}`}
        ]
      }
    ]
  };
  const head=baseHead(p.name,metaDescription,{canonicalPath,image,imageAlt:`${p.name} by Isolde`,type:'product',pageTitle:`${p.name} ${sizeLabel} Perfume | Isolde Canada`});
  return `${head.replace('</head>',`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,'\\u003c')}</script></head>`)}
  <div class="announcement">${e(s.announcement)}</div><header class="site-header"><div class="container nav"><nav class="nav-links"><a href="/shop">Shop</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a></nav><button class="menu-button" data-menu-toggle aria-label="Menu">☰</button><a class="brand brand-logo" href="/" aria-label="${e(s.brand_name)} home"><img src="/assets/isolde-logo.png" alt="${e(s.brand_name)} perfume logo"></a><div class="nav-actions"><a href="/about">Our Story</a><a class="bag-pill" href="/cart">Bag <span data-cart-count>0</span></a></div></div><div class="mobile-menu" data-mobile-menu><a href="/shop">Shop all</a><a href="/shop?audience=Women">Women</a><a href="/shop?audience=Men">Men</a><a href="/shop?audience=Unisex">Unisex</a><a href="/about">Our Story</a><a href="/contact">Contact</a></div></header>
  <main><div class="container product-page"><div><div class="gallery-main"><img src="${e(image)}" alt="${e(p.name)} by Isolde"></div>${p.images.length>1?`<div class="thumbs">${p.images.map(i=>`<button class="thumb" type="button" data-gallery-thumb data-image="${e(i.path)}"><img src="${e(i.path)}" alt="${e(i.alt || p.name)}"></button>`).join('')}</div>`:''}</div>
  <div class="product-detail"><div class="product-detail-topline"><span>${e(p.audience||'Unisex')}</span><span>${e(p.category)}</span></div><h1>${e(p.name)}</h1><div class="inspired-line">Inspired by <strong>${e(p.inspired_by)}</strong></div>${p.price_cents>0?`<div class="detail-price">${e(money(p.price_cents))}</div>`:'<div class="coming" style="margin-top:22px">Price coming soon.</div>'}${ship.mode==='free'?'<p class="free-shipping">Free shipping</p>':''}<p class="product-description">${e(p.description)}</p>
  ${p.price_cents>0?`<div data-product-buy><div class="buy-row"><input class="field qty-input" type="number" min="1" value="1" name="qty"><button class="btn" data-add-to-cart data-product='${payload}'>Add to bag</button></div></div>`:`<a class="btn btn-outline" href="/contact">Ask about this fragrance</a>`}
  <div class="product-assurance"><div><strong>100 mL bottle</strong><span>Full-size Isolde fragrance</span></div><div><strong>Independent fragrance</strong><span>Transparent inspired-by reference</span></div></div>
  <div class="product-meta">${p.size_ml?`<div class="meta-row"><span>Size</span><strong>${p.size_ml} mL</strong></div>`:''}<div class="meta-row"><span>For</span><strong>${e(p.audience||'Unisex')}</strong></div><div class="meta-row"><span>Scent family</span><strong>${e(p.category)}</strong></div>${p.sku?`<div class="meta-row"><span>SKU</span><strong>${e(p.sku)}</strong></div>`:''}</div><p class="small muted" style="margin-top:18px">Independent fragrance interpretation. Not affiliated with or endorsed by the referenced designer brand.</p></div></div></main>${publicFooter()}`;
}
function cartPage() {
  return `${publicHeader('Bag',{canonicalPath:'/cart',noindex:true})}<main><section class="page-hero"><div class="container"><div class="eyebrow">Your bag</div><h1>Your Isolde selection.</h1></div></section><section style="padding-top:10px"><div class="container cart-layout"><div><div data-cart-page></div><div data-cart-empty hidden><p class="lead">Your bag is empty.</p><a class="btn" href="/shop">Explore fragrances</a></div></div><aside class="summary-card" data-cart-summary hidden><h3 style="font-size:1.7rem;margin-top:0">Order summary</h3><div class="summary-row"><span>Items</span><span data-cart-items>0</span></div><div class="summary-row"><span>Subtotal</span><strong data-cart-subtotal>—</strong></div><p class="small muted">${shippingConfig().mode==='free'?'Free shipping on all orders. Applicable tax is confirmed during checkout.':'Shipping and applicable tax are confirmed during checkout.'}</p><a class="btn" href="/checkout">Continue to checkout</a></aside></div></section></main>${publicFooter()}`;
}
function checkoutPage() {
  const s=settings();
  const ship=shippingConfig();
  const stripeReady=!!STRIPE_SECRET_KEY && ship.mode!=='quote';
  const payCopy = stripeReady ? 'Continue to secure payment' : 'Place order request';
  const helper = stripeReady ? 'Payment is completed securely through Stripe. Shipping is calculated from your store settings.' : (STRIPE_SECRET_KEY && ship.mode==='quote' ? 'Stripe is connected, but shipping is still set to “Quote after order.” Set a flat or free shipping method in Admin → Settings to charge cards automatically.' : 'The order will be saved in your Isolde admin dashboard for payment and shipping follow-up.');
  return `${publicHeader('Checkout',{canonicalPath:'/checkout',noindex:true})}<main><section class="page-hero"><div class="container"><div class="eyebrow">Checkout</div><h1>Complete your order.</h1></div></section><section style="padding-top:8px"><div class="container checkout-grid"><form data-checkout-form><div class="form-grid"><div class="form-group"><label>First & last name</label><input name="customer_name" required></div><div class="form-group"><label>Email</label><input type="email" name="email" required></div><div class="form-group"><label>Phone</label><input type="tel" name="phone"></div><div class="form-group"><label>Country</label><input name="country" value="${e(ship.countries[0]||'Canada')}" required></div><div class="form-group span-2"><label>Address</label><input name="address1" required></div><div class="form-group span-2"><label>Apartment / suite (optional)</label><input name="address2"></div><div class="form-group"><label>City</label><input name="city" required></div><div class="form-group"><label>Province / state</label><input name="province" required></div><div class="form-group"><label>Postal / ZIP code</label><input name="postal_code" required></div><div class="form-group span-2"><label>Order note (optional)</label><textarea name="notes" rows="3"></textarea></div></div><button class="btn" type="submit" style="margin-top:22px">${payCopy}</button><p class="small muted">${e(helper)}</p></form><aside class="summary-card"><h3 style="font-size:1.7rem;margin-top:0">Order summary</h3><div data-checkout-items class="checkout-lines"></div><div class="summary-row" style="margin-top:12px"><span>Subtotal</span><strong data-checkout-subtotal>—</strong></div><div class="summary-row"><span>Shipping</span><strong data-checkout-shipping>—</strong></div><div class="summary-row checkout-total"><span>Total</span><strong data-checkout-total>—</strong></div><p class="small muted">${e(s.shipping_note)}</p></aside></div></section></main>${publicFooter()}`;
}
function successPage(orderNo, paid=false) {
  return `${publicHeader('Order received',{canonicalPath:'/order/success',noindex:true})}<main ${paid?'data-payment-confirmed':''}><section class="page-hero"><div class="container info-page"><div class="eyebrow">${paid?'Payment confirmed':'Order received'}</div><h1>Thank you.</h1><p class="lead">Your Isolde order <strong>${e(orderNo || '')}</strong> has been received${paid?' and payment has been confirmed':''}.</p><p>We’ll use the contact details on the order to provide the next update.</p><a class="btn" href="/shop">Continue shopping</a></div></section></main>${publicFooter()}`;
}
function infoPage(kind) {
  const s=settings();
  const content={
    about:["Our Story",`Isolde is an independent fragrance label built around a simple idea: make familiar scent directions easy to discover through a clear, elevated brand experience.`, `The collection currently includes nine fragrances. Each product page identifies the original fragrance that inspired its scent direction, while the bottle, naming, imagery and customer experience are presented under the Isolde brand.`, `Isolde is not affiliated with or endorsed by the designer brands referenced on this site.`],
    contact:["Contact",`Questions about a fragrance, an order or wholesale interest? Reach the Isolde team using the details below.`, `${s.contact_email ? 'Email: '+s.contact_email : ''}${s.contact_phone ? '\nPhone: '+s.contact_phone : ''}`, `You can also update these contact details from the admin dashboard.`],
    shipping:["Shipping",`Shipping methods, rates and delivery estimates can be configured as the store launches.`, s.shipping_note, `For international orders, duties and import charges may apply depending on destination.`],
    returns:["Returns",`Before launch, set a return policy that matches your actual fulfillment process, hygiene rules and local consumer-protection requirements.`, `This starter site intentionally avoids inventing a return window or refund promise that you have not approved.`, `You can replace this copy once your final policy is confirmed.`],
    privacy:["Privacy",`This starter store collects the information required to process orders, including customer name, contact details and shipping address.`, `If Stripe is enabled, payment card information is handled by Stripe rather than stored in the Isolde database.`, `Before public launch, update this page to reflect your actual analytics, email-marketing and cookie tools.`],
    terms:["Terms",`Product images and descriptions are provided for shopping and product-identification purposes.`, `Designer fragrance names are used only as comparative references to describe scent inspiration. Isolde is an independent brand and is not affiliated with or endorsed by those trademark owners.`, `Before public launch, have your final terms reviewed for your jurisdiction and business model.`]
  }[kind];
  return `${publicHeader(content[0],{canonicalPath:`/${kind}`,description:content[1]})}<main><section class="page-hero"><div class="container info-page"><div class="eyebrow">Isolde</div><h1>${e(content[0])}</h1>${content.slice(1).map((p,i)=>`<p class="${i===0?'lead':''}" style="white-space:pre-line">${e(p)}</p>`).join('')}</div></section></main>${publicFooter()}`;
}

function adminHead(title, csrf='') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · Isolde Admin</title><meta name="robots" content="noindex,nofollow"><meta name="csrf-token" content="${e(csrf)}"><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/admin.js" defer></script></head><body class="admin-body">`;
}
function adminLayout(title, body, session, active='') {
  return `${adminHead(title,session.csrf)}<div class="admin-shell"><aside class="admin-side"><a class="brand" href="/admin">Isolde</a>${[['Dashboard','/admin','dashboard'],['Products','/admin/products','products'],['Orders','/admin/orders','orders'],['Settings','/admin/settings','settings']].map(([n,h,k])=>`<a class="${active===k?'active':''}" href="${h}">${n}</a>`).join('')}<a href="/" target="_blank">View store ↗</a><form method="post" action="/admin/logout" style="margin-top:18px"><button style="background:transparent;border:0;color:#cfc6b9;padding:10px 12px">Sign out</button></form></aside><main class="admin-main">${USING_DEFAULT_ADMIN?'<div class="error-box" style="margin-bottom:18px">Default local admin credentials are active. Set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET in a .env file before publishing this site.</div>':''}${body}</main></div></body></html>`;
}
function adminLogin(error='') {
  return `${adminHead('Sign in')}<div class="login-wrap"><div class="login-card"><div class="brand">Isolde</div><p class="muted">Store administration</p>${error?`<div class="error-box">${e(error)}</div>`:''}<form method="post" action="/admin/login"><div class="form-group"><label>Email</label><input type="email" name="email" required autofocus></div><div class="form-group"><label>Password</label><input type="password" name="password" required></div><button class="btn" type="submit">Sign in</button></form>${USING_DEFAULT_ADMIN?`<p class="admin-login-note">Local demo: ${e(ADMIN_EMAIL)} / ${e(ADMIN_PASSWORD)}</p>`:''}</div></div></body></html>`;
}
function adminDashboard(session) {
  const stats={products:db.prepare('SELECT COUNT(*) n FROM products').get().n, active:db.prepare("SELECT COUNT(*) n FROM products WHERE status='active'").get().n, orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n, pending:db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('new','processing')").get().n};
  const orders=db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();
  const body=`<div class="admin-top"><div><div class="eyebrow">Overview</div><h1>Dashboard</h1></div><a class="btn small-btn" href="/admin/products/new">+ Add fragrance</a></div><div class="stat-grid"><div class="admin-card stat"><strong>${stats.products}</strong><span>Total products</span></div><div class="admin-card stat"><strong>${stats.active}</strong><span>Live products</span></div><div class="admin-card stat"><strong>${stats.orders}</strong><span>Total orders</span></div><div class="admin-card stat"><strong>${stats.pending}</strong><span>Orders to review</span></div></div><div class="admin-card" style="margin-top:20px"><div class="section-head" style="margin-bottom:12px"><h2 style="font-size:1.8rem;margin:0">Recent orders</h2><a href="/admin/orders" class="small">View all</a></div>${orders.length?orderTable(orders):'<p class="muted">No orders yet. Once customers check out, they will appear here.</p>'}</div>`;
  return adminLayout('Dashboard',body,session,'dashboard');
}
function orderTable(rows) {
  return `<div style="overflow:auto"><table class="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th>Payment</th><th>Date</th></tr></thead><tbody>${rows.map(o=>`<tr><td><a href="/admin/orders/${o.id}"><strong>${e(o.order_number)}</strong></a></td><td>${e(o.customer_name)}<div class="muted small">${e(o.email)}</div></td><td>${e(money(o.total_cents))}</td><td><span class="status ${e(o.status)}">${e(o.status)}</span></td><td><span class="status ${e(o.payment_status)}">${e(o.payment_status)}</span></td><td>${e(new Date(o.created_at+'Z').toLocaleDateString('en-CA'))}</td></tr>`).join('')}</tbody></table></div>`;
}
function adminProducts(session) {
  const ps=getProducts({activeOnly:false});
  const body=`<div class="admin-top"><div><div class="eyebrow">Catalogue</div><h1>Products</h1></div><a class="btn small-btn" href="/admin/products/new">+ Add fragrance</a></div><div class="admin-card"><div style="overflow:auto"><table class="admin-table"><thead><tr><th>Product</th><th>Price</th><th>For</th><th>Family</th><th>Status</th><th>Homepage</th><th></th></tr></thead><tbody>${ps.map(p=>`<tr><td><a class="admin-product" href="/admin/products/${p.id}/edit"><img src="${e(p.image||'')}" alt=""><span><strong>${e(p.name)}</strong><div class="muted small">Inspired by ${e(p.inspired_by)}</div></span></a></td><td>${p.price_cents?e(money(p.price_cents)):'—'}</td><td>${e(p.audience||'Unisex')}</td><td>${e(p.category)}</td><td><span class="status ${e(p.status)}">${e(p.status)}</span></td><td>${p.bestseller?'Best Seller':(p.featured?'Featured':'—')}</td><td style="white-space:nowrap"><a class="small" href="/admin/products/${p.id}/edit">Edit</a> · <button class="link-button" data-delete-product="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table></div></div>`;
  return adminLayout('Products',body,session,'products');
}
function productForm(session,p=null) {
  const id=p?.id || '';
  const title=p?'Edit product':'New product';
  const fields=p || {name:'',slug:'',inspired_by:'',description:'',category:'Signature',audience:'Unisex',price_cents:0,compare_at_cents:null,size_ml:100,sku:'',stock:null,status:'draft',featured:0,bestseller:0,sort_order:50,images:[]};
  const body=`<div class="admin-top"><div><div class="eyebrow">Catalogue</div><h1>${title}</h1></div><div><a class="btn btn-outline small-btn" href="/admin/products">Back</a></div></div><form data-product-form data-product-id="${id}"><div class="admin-form-grid"><div class="admin-card"><div class="admin-fields"><div><label>Product name</label><input name="name" value="${e(fields.name)}" required></div><div><label>URL slug</label><input name="slug" value="${e(fields.slug)}" required></div><div class="full"><label>Inspired by</label><input name="inspired_by" value="${e(fields.inspired_by)}"></div><div class="full"><label>Marketing description</label><textarea name="description">${e(fields.description)}</textarea></div><div><label>Scent family</label><input name="category" value="${e(fields.category)}"></div><div><label>Collection / audience</label><select class="select" name="audience">${['Women','Men','Unisex'].map(x=>`<option value="${x}" ${fields.audience===x?'selected':''}>${x}</option>`).join('')}</select></div><div><label>SKU</label><input name="sku" value="${e(fields.sku)}"></div><div><label>Price (CAD)</label><input type="number" min="0" step="0.01" name="price" value="${fields.price_cents?(fields.price_cents/100).toFixed(2):''}" placeholder="e.g. 59.00"></div><div><label>Compare-at price</label><input type="number" min="0" step="0.01" name="compare_at_price" value="${fields.compare_at_cents?(fields.compare_at_cents/100).toFixed(2):''}"></div><div><label>Size (mL)</label><input type="number" min="0" name="size_ml" value="${e(fields.size_ml ?? '')}"></div><div><label>Stock (blank = not tracked)</label><input type="number" min="0" name="stock" value="${e(fields.stock ?? '')}"></div><div><label>Sort order</label><input type="number" name="sort_order" value="${e(fields.sort_order ?? 50)}"></div><div><label>Status</label><select class="select" name="status"><option value="active" ${fields.status==='active'?'selected':''}>Active</option><option value="draft" ${fields.status==='draft'?'selected':''}>Draft</option></select></div><div class="full check-row"><label><input type="checkbox" name="featured" ${fields.featured?'checked':''}> Featured on homepage</label><label><input type="checkbox" name="bestseller" ${fields.bestseller?'checked':''}> Show as Best Seller</label></div></div><button class="btn" type="submit" style="margin-top:20px">Save product</button><p class="small muted">Best Seller can be curated manually. Once paid orders exist, the storefront also ranks actual paid sales automatically.</p></div><aside class="admin-card"><h3 style="margin-top:0">Product images</h3>${p?`<div class="image-list">${fields.images.map(i=>`<div class="image-tile"><img src="${e(i.path)}" alt="${e(i.alt)}"><div class="image-actions">${i.is_primary?'<span class="status active">Primary</span>':`<button type="button" data-primary-image="${i.id}">Make primary</button>`}<button type="button" data-delete-image="${i.id}">Delete</button></div></div>`).join('')}</div><label class="upload-box">Upload more images<br><span class="small muted">PNG, JPG or WebP</span><input type="file" accept="image/png,image/jpeg,image/webp" multiple data-image-upload style="display:none"></label>`:'<p class="muted">Save this product first, then you can upload multiple photos and choose the primary image.</p>'}</aside></div></form>`;
  return adminLayout(title,body,session,'products');
}
function adminOrders(session) {
  const rows=db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  return adminLayout('Orders',`<div class="admin-top"><div><div class="eyebrow">Sales</div><h1>Orders</h1></div></div><div class="admin-card">${rows.length?orderTable(rows):'<p class="muted">No orders yet.</p>'}</div>`,session,'orders');
}
function adminOrder(session,id) {
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id); if(!o) return null;
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id);
  const body=`<div class="admin-top"><div><div class="eyebrow">Order</div><h1>${e(o.order_number)}</h1></div><a class="btn btn-outline small-btn" href="/admin/orders">Back</a></div><div class="admin-form-grid"><div><div class="admin-card"><h3>Items</h3><div class="checkout-lines">${items.map(i=>`<div class="checkout-line"><span>${e(i.name)} × ${i.qty}</span><strong>${e(money(i.unit_price_cents*i.qty))}</strong></div>`).join('')}</div><div class="summary-row"><span>Subtotal</span><strong>${e(money(o.subtotal_cents))}</strong></div><div class="summary-row"><span>Shipping</span><strong>${o.shipping_cents?e(money(o.shipping_cents)):(o.payment_method==='manual'?'To confirm':e(money(0)))}</strong></div><div class="summary-row"><span>Total</span><strong>${e(money(o.total_cents))}</strong></div></div><div class="admin-card" style="margin-top:18px"><h3>Customer</h3><p><strong>${e(o.customer_name)}</strong><br>${e(o.email)}<br>${e(o.phone)}</p><p>${e(o.address1)}${o.address2?'<br>'+e(o.address2):''}<br>${e(o.city)}, ${e(o.province)} ${e(o.postal_code)}<br>${e(o.country)}</p>${o.notes?`<p><strong>Note:</strong> ${e(o.notes)}</p>`:''}</div></div><aside class="admin-card"><h3 style="margin-top:0">Order status</h3><form data-order-form data-order-id="${o.id}"><label>Fulfillment status</label><select class="select" name="status">${['new','processing','fulfilled','cancelled'].map(x=>`<option ${o.status===x?'selected':''}>${x}</option>`).join('')}</select><label style="margin-top:14px">Payment status</label><select class="select" name="payment_status">${['pending','paid','refunded','cancelled'].map(x=>`<option ${o.payment_status===x?'selected':''}>${x}</option>`).join('')}</select><button class="btn" type="submit" style="margin-top:18px;width:100%">Update order</button></form><hr style="border:0;border-top:1px solid var(--line);margin:20px 0"><p class="small muted">Payment method: ${e(o.payment_method)}${o.stripe_session_id?'<br>Stripe session: '+e(o.stripe_session_id):''}</p></aside></div>`;
  return adminLayout('Order '+o.order_number,body,session,'orders');
}
function adminSettings(session) {
  const s=settings();
  const body=`<div class="admin-top"><div><div class="eyebrow">Store</div><h1>Settings</h1></div></div><form class="admin-card" data-settings-form style="max-width:920px"><div class="admin-fields">
    <div><label>Brand name</label><input name="brand_name" value="${e(s.brand_name)}"></div><div><label>Tagline</label><input name="tagline" value="${e(s.tagline)}"></div>
    <div class="full"><label>Announcement bar</label><input name="announcement" value="${e(s.announcement)}"></div>
    <div><label>Hero eyebrow</label><input name="hero_eyebrow" value="${e(s.hero_eyebrow)}"></div><div><label>Hero headline</label><input name="hero_title" value="${e(s.hero_title)}"></div>
    <div class="full"><label>Hero paragraph</label><textarea name="hero_subtitle">${e(s.hero_subtitle)}</textarea></div>
    <div><label>Contact email</label><input name="contact_email" value="${e(s.contact_email)}"></div><div><label>Contact phone</label><input name="contact_phone" value="${e(s.contact_phone)}"></div>
    <div><label>Instagram URL</label><input name="instagram" value="${e(s.instagram)}"></div><div><label>Currency</label><input name="currency" value="${e(s.currency)}"></div>
    <div class="full settings-divider"><h3>Shipping</h3><p class="small muted">Keep “Quote after order” until you decide your shipping price. Stripe card checkout only turns on automatically when shipping is set to Flat rate or Free shipping.</p></div>
    <div><label>Shipping mode</label><select class="select" name="shipping_mode"><option value="quote" ${s.shipping_mode==='quote'?'selected':''}>Quote after order</option><option value="flat" ${s.shipping_mode==='flat'?'selected':''}>Flat rate</option><option value="free" ${s.shipping_mode==='free'?'selected':''}>Free shipping</option></select></div>
    <div><label>Flat shipping fee (${e(s.currency||'CAD')})</label><input type="number" min="0" step="0.01" name="shipping_flat_fee" value="${e(s.shipping_flat_fee)}" placeholder="e.g. 12.00"></div>
    <div><label>Free shipping threshold (${e(s.currency||'CAD')})</label><input type="number" min="0" step="0.01" name="free_shipping_threshold" value="${e(s.free_shipping_threshold)}" placeholder="optional"></div>
    <div><label>Shipping countries</label><input name="shipping_countries" value="${e(s.shipping_countries)}" placeholder="Canada, United States"></div>
    <div class="full"><label>Shipping message</label><textarea name="shipping_note">${e(s.shipping_note)}</textarea></div>
    <div class="full"><label>Footer note</label><textarea name="footer_note">${e(s.footer_note)}</textarea></div>
  </div><button class="btn" type="submit" style="margin-top:20px">Save settings</button><div class="admin-payment-status"><strong>Card payments:</strong> ${STRIPE_SECRET_KEY?'Stripe key detected.':'Not connected yet.'} ${STRIPE_SECRET_KEY && s.shipping_mode!=='quote'?'Secure Stripe checkout is ready to use.':STRIPE_SECRET_KEY?'Choose Flat rate or Free shipping to activate automatic card checkout.':'Add STRIPE_SECRET_KEY to .env when you are ready to accept cards.'}</div></form>`;
  return adminLayout('Settings',body,session,'settings');
}
function serveStatic(req,res,pathname) {
  const rel=decodeURIComponent(pathname.replace(/^\//,''));
  const file=path.normalize(path.join(PUBLIC,rel));
  if(!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext=path.extname(file).toLowerCase();
  const mime={'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'}[ext]||'application/octet-stream';
  const stat=fs.statSync(file);
  res.writeHead(200,{'Content-Type':mime,'Content-Length':stat.size,'Cache-Control':ext==='.css'||ext==='.js'?'public, max-age=300':'public, max-age=86400'});
  fs.createReadStream(file).pipe(res); return true;
}

function orderNumber() {
  const d=new Date();
  const y=String(d.getFullYear()).slice(-2), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `IS-${y}${m}${day}-${crypto.randomBytes(6).toString('hex')}`;
}
async function createStripeSession(order, items) {
  const params=new URLSearchParams();
  params.set('mode','payment');
  params.set('locale','auto');
  params.set('billing_address_collection','auto');
  params.set('payment_method_types[0]','card');
  params.set('client_reference_id',order.order_number);
  params.set('success_url',`${BASE_URL}/order/success?order=${encodeURIComponent(order.order_number)}&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url',`${BASE_URL}/checkout`);
  params.set('customer_email',order.email);
  params.set('metadata[order_id]',String(order.id));
  params.set('metadata[order_number]',order.order_number);
  params.set('payment_intent_data[metadata][order_id]',String(order.id));
  params.set('payment_intent_data[metadata][order_number]',order.order_number);
  items.forEach((item,i)=>{
    params.set(`line_items[${i}][quantity]`,String(item.qty));
    params.set(`line_items[${i}][price_data][currency]`,order.currency.toLowerCase());
    params.set(`line_items[${i}][price_data][unit_amount]`,String(item.unit_price_cents));
    params.set(`line_items[${i}][price_data][product_data][name]`,item.name);
    if(item.image) params.set(`line_items[${i}][price_data][product_data][images][0]`,absoluteAssetUrl(item.image));
  });
  if (Number(order.shipping_cents||0) > 0) {
    const i=items.length;
    params.set(`line_items[${i}][quantity]`,'1');
    params.set(`line_items[${i}][price_data][currency]`,order.currency.toLowerCase());
    params.set(`line_items[${i}][price_data][unit_amount]`,String(order.shipping_cents));
    params.set(`line_items[${i}][price_data][product_data][name]`,'Shipping');
  }
  const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`isolde-checkout-${order.order_number}`},body:params,signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error?.message || 'Stripe checkout could not be created');
  return data;
}
function applyStripePayment(data, expectedOrder='') {
  if(data.payment_status!=='paid') return 0;
  const order=db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').get(data.id);
  if(!order || (expectedOrder && order.order_number!==expectedOrder) ||
     String(order.id)!==String(data.metadata?.order_id) || order.order_number!==data.metadata?.order_number ||
     order.order_number!==data.client_reference_id || data.mode!=='payment' ||
     Number(data.amount_total)!==order.total_cents || String(data.currency).toUpperCase()!==order.currency) {
    throw new Error('Stripe payment does not match a saved order.');
  }
  const updated=db.prepare("UPDATE orders SET payment_status='paid', status=CASE WHEN status='new' THEN 'processing' ELSE status END WHERE id=? AND payment_status='pending'").run(order.id);
  return Number(updated.changes||0)>0 ? Number(order.id) : 0;
}
async function sendPaidOrderNotification(orderId) {
  if(!RESEND_API_KEY || !ORDER_NOTIFICATION_EMAIL || !ORDER_NOTIFICATION_FROM) return false;
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!order || order.payment_status!=='paid' || Number(order.notification_sent||0)===1) return false;
  const items=db.prepare('SELECT name,qty,unit_price_cents FROM order_items WHERE order_id=? ORDER BY id').all(order.id);
  const money=cents=>new Intl.NumberFormat('en-CA',{style:'currency',currency:order.currency||'CAD'}).format(Number(cents||0)/100);
  const lines=[
    `New paid order: ${order.order_number}`,
    '',
    `Customer: ${order.customer_name}`,
    `Email: ${order.email}`,
    `Phone: ${order.phone||'-'}`,
    '',
    'Ship to:',
    order.address1,
    order.address2||'',
    `${order.city}, ${order.province} ${order.postal_code}`,
    order.country,
    '',
    'Items:',
    ...items.map(item=>`- ${item.name} x${item.qty} — ${money(item.unit_price_cents*item.qty)}`),
    '',
    `Subtotal: ${money(order.subtotal_cents)}`,
    `Shipping: ${money(order.shipping_cents)}`,
    `Total: ${money(order.total_cents)}`,
    '',
    `Admin: ${BASE_URL}/admin/orders/${order.id}`
  ].filter((line,index,arr)=>line!=='' || arr[index-1]!=='').join('\n');
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      from:ORDER_NOTIFICATION_FROM,
      to:[ORDER_NOTIFICATION_EMAIL],
      subject:`New Isolde order ${order.order_number} — ${money(order.total_cents)}`,
      text:lines
    }),
    signal:AbortSignal.timeout(20000)
  });
  if(!response.ok) {
    const detail=await response.text().catch(()=> '');
    throw new Error(`Order email failed (${response.status}): ${detail.slice(0,300)}`);
  }
  db.prepare('UPDATE orders SET notification_sent=1 WHERE id=?').run(order.id);
  await persistDatabase();
  return true;
}
async function notifyPaidOrderSafely(orderId) {
  if(!orderId) return;
  try { await sendPaidOrderNotification(orderId); }
  catch(err) { console.error('Paid order email notification failed:',err.message); }
}
async function verifyStripeSuccess(sessionId,orderNo) {
  if(!STRIPE_SECRET_KEY || !sessionId || !orderNo) return false;
  const response=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,{headers:{Authorization:`Bearer ${STRIPE_SECRET_KEY}`},signal:AbortSignal.timeout(20000)});
  if(!response.ok) return false;
  const paidOrderId=applyStripePayment(await response.json(),orderNo);
  if(paidOrderId) {
    await persistDatabase();
    await notifyPaidOrderSafely(paidOrderId);
  }
  return !!paidOrderId;
}
function verifiedStripeEvent(raw,header='') {
  const values=String(header).split(',').map(part=>part.split('='));
  const timestamp=values.find(([key])=>key==='t')?.[1];
  if(!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300) throw new Error('Invalid webhook timestamp.');
  const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(timestamp+'.').update(raw).digest('hex');
  if(!values.some(([key,value])=>key==='v1' && /^[a-f0-9]{64}$/i.test(value||'') && safeEqual(expected,value))) throw new Error('Invalid webhook signature.');
  return JSON.parse(raw.toString('utf8'));
}

async function handleRequest(req,res) {
  try {
    const url=new URL(req.url,BASE_URL);
    const pathname=url.pathname;
    if ((pathname.startsWith('/assets/') || pathname.startsWith('/uploads/')) && serveStatic(req,res,pathname)) return;
    if(req.method==='GET' && pathname==='/'){html(res,homePage());return;}
    if(req.method==='GET' && pathname==='/shop'){html(res,shopPage());return;}
    if(req.method==='GET' && pathname.startsWith('/product/')){const p=getProductBySlug(decodeURIComponent(pathname.slice(9))); if(!p){html(res,baseHead('Not found','',{canonicalPath:pathname,noindex:true})+'<h1>Product not found</h1></body></html>',404);return;} html(res,productPage(p));return;}
    if(req.method==='GET' && pathname==='/cart'){html(res,cartPage());return;}
    if(req.method==='GET' && pathname==='/checkout'){html(res,checkoutPage());return;}
    if(req.method==='GET' && pathname==='/about'){html(res,infoPage('about'));return;}
    if(req.method==='GET' && pathname==='/contact'){html(res,infoPage('contact'));return;}
    if(req.method==='GET' && pathname==='/shipping'){html(res,infoPage('shipping'));return;}
    if(req.method==='GET' && pathname==='/returns'){html(res,infoPage('returns'));return;}
    if(req.method==='GET' && pathname==='/privacy'){html(res,infoPage('privacy'));return;}
    if(req.method==='GET' && pathname==='/terms'){html(res,infoPage('terms'));return;}
    if(req.method==='GET' && pathname==='/api/products'){json(res,200,getProducts());return;}
    if(req.method==='GET' && pathname==='/robots.txt'){text(res,`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /cart\nDisallow: /checkout\nDisallow: /order/\nSitemap: ${BASE_URL}/sitemap.xml\n`);return;}
    if(req.method==='GET' && pathname==='/sitemap.xml'){
      const staticUrls=['/','/shop','/about','/contact','/shipping','/returns','/privacy','/terms'].map(path=>({path}));
      const productUrls=getProducts().map(p=>({path:'/product/'+encodeURIComponent(p.slug),lastmod:String(p.updated_at||'').slice(0,10)}));
      const urls=[...staticUrls,...productUrls];
      text(res,`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(row=>`<url><loc>${e(BASE_URL+row.path)}</loc>${row.lastmod?`<lastmod>${e(row.lastmod)}</lastmod>`:''}</url>`).join('')}</urlset>`,'application/xml; charset=utf-8');return;
    }
    if(req.method==='POST' && pathname==='/api/stripe/webhook') {
      if(!STRIPE_WEBHOOK_SECRET) { json(res,503,{error:'Webhook is not configured.'}); return; }
      let event;
      try { event=verifiedStripeEvent(await readBody(req,1024*1024),req.headers['stripe-signature']); }
      catch { json(res,400,{error:'Invalid webhook.'}); return; }
      if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
        const paidOrderId=applyStripePayment(event.data.object);
        if(paidOrderId) {
          await persistDatabase();
          await notifyPaidOrderSafely(paidOrderId);
        }
      }
      json(res,200,{received:true}); return;
    }
    if(req.method==='POST' && pathname==='/api/orders'){
      const data=await readJson(req);
      const required=['customer_name','email','address1','city','province','postal_code','country'];
      for(const k of required) if(!String(data[k]||'').trim()){json(res,400,{error:`${k.replaceAll('_',' ')} is required.`});return;}
      if(!Array.isArray(data.items)||!data.items.length){json(res,400,{error:'Your bag is empty.'});return;}
      const checkoutKey=String(data.checkout_key||'');
      if(!/^[a-f0-9-]{36}$/i.test(checkoutKey)) {json(res,400,{error:'Refresh checkout and try again.'});return;}
      if(!shippingConfig().countries.some(country=>country.toLowerCase()===String(data.country).trim().toLowerCase())) {json(res,400,{error:'Shipping is not available to this country.'});return;}
      let order=db.prepare('SELECT * FROM orders WHERE checkout_key=?').get(checkoutKey);
      const resolved=[]; let subtotal=0;
      if(order) {
        if(order.email!==String(data.email).trim()) {json(res,400,{error:'Start a new checkout.'});return;}
        if(order.payment_status==='paid') {await persistDatabase();json(res,200,{orderNumber:order.order_number});return;}
        resolved.push(...db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id));
        subtotal=order.subtotal_cents;
      } else {
        const quantities=new Map();
        for(const raw of data.items) {
          const id=Number(raw.id),qty=Number(raw.qty);
          if(!Number.isSafeInteger(id)||!Number.isSafeInteger(qty)||qty<1||qty>20) {json(res,400,{error:'Product quantities must be whole numbers from 1 to 20.'});return;}
          quantities.set(id,(quantities.get(id)||0)+qty);
        }
        for(const [id,qty] of quantities) {
          const p=db.prepare("SELECT * FROM products WHERE id=? AND status='active'").get(id);
          if(!p || p.price_cents<=0 || qty>20 || (p.stock!==null && qty>p.stock)) {json(res,400,{error:'One or more products are unavailable in the requested quantity.'});return;}
          const image=db.prepare('SELECT path FROM product_images WHERE product_id=? ORDER BY is_primary DESC,sort_order,id LIMIT 1').get(p.id)?.path||'';
          resolved.push({product_id:p.id,name:p.name,qty,unit_price_cents:p.price_cents,image});
          subtotal+=p.price_cents*qty;
        }
      }
      if(!order) {
        const shipping=calculateShipping(subtotal);
        const stripeReady=!!STRIPE_SECRET_KEY && shipping!==null;
        db.exec('BEGIN');
        try {
          const r=db.prepare(`INSERT INTO orders(order_number,customer_name,email,phone,address1,address2,city,province,postal_code,country,subtotal_cents,shipping_cents,total_cents,status,payment_status,payment_method,notes,currency,checkout_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'new','pending',?,?,?,?)`).run(orderNumber(),String(data.customer_name).trim(),String(data.email).trim(),String(data.phone||'').trim(),String(data.address1).trim(),String(data.address2||'').trim(),String(data.city).trim(),String(data.province).trim(),String(data.postal_code).trim(),String(data.country).trim(),subtotal,shipping??0,subtotal+(shipping??0),stripeReady?'stripe':'manual',String(data.notes||'').trim(),settings().currency||'CAD',checkoutKey);
          const orderId=Number(r.lastInsertRowid);
          const ins=db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,unit_price_cents,image) VALUES(?,?,?,?,?,?)');
          resolved.forEach(i=>ins.run(orderId,i.product_id,i.name,i.qty,i.unit_price_cents,i.image||''));
          db.exec('COMMIT');
          order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
        } catch(err) { db.exec('ROLLBACK'); throw err; }
      }
      // Persist the order before sending the customer to payment.
      await persistDatabase();
      if(order.payment_method==='stripe') {
        let session;
        try { session=await createStripeSession(order,resolved); }
        catch(err) { console.error('Stripe checkout failed:',err.message);json(res,502,{error:'Payment checkout is temporarily unavailable. Your bag is saved; please retry.'});return; }
        db.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?').run(session.id,order.id);
        await persistDatabase();
        json(res,200,{orderNumber:order.order_number,checkoutUrl:session.url,shippingCents:order.shipping_cents,totalCents:order.total_cents});
      } else json(res,200,{orderNumber:order.order_number});
      return;
    }
    if(req.method==='GET' && pathname==='/order/success'){
      const orderNo=url.searchParams.get('order')||''; const sid=url.searchParams.get('session_id')||''; let paid=false;
      if(sid) paid=await verifyStripeSuccess(sid,orderNo);
      html(res,successPage(orderNo,paid));return;
    }

    // Admin authentication
    if(req.method==='GET' && pathname==='/admin/login'){ if(adminSession(req)){redirect(res,'/admin');return;} html(res,adminLogin());return; }
    if(req.method==='POST' && pathname==='/admin/login'){
      const f=await readForm(req); if(safeEqual(f.email||'',ADMIN_EMAIL) && safeEqual(f.password||'',ADMIN_PASSWORD)){const s=newSession(); await persistDatabase(); res.writeHead(302,{Location:'/admin','Set-Cookie':`isolde_admin=${s.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${BASE_URL.startsWith('https://')?'; Secure':''}`});res.end();} else html(res,adminLogin('Incorrect email or password.'),401); return;
    }
    if(req.method==='POST' && pathname==='/admin/logout'){const s=adminSession(req);if(s){db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);await persistDatabase();}res.writeHead(302,{Location:'/admin/login','Set-Cookie':'isolde_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});res.end();return;}

    if(pathname==='/admin'&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;html(res,adminDashboard(s));return;}
    if(pathname==='/admin/products'&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;html(res,adminProducts(s));return;}
    if(pathname==='/admin/products/new'&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;html(res,productForm(s));return;}
    let m=pathname.match(/^\/admin\/products\/(\d+)\/edit$/); if(m&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;const p=getAdminProduct(Number(m[1]));if(!p){html(res,'Not found',404);return;}html(res,productForm(s,p));return;}
    if(pathname==='/admin/orders'&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;html(res,adminOrders(s));return;}
    m=pathname.match(/^\/admin\/orders\/(\d+)$/); if(m&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;const page=adminOrder(s,Number(m[1]));if(!page){html(res,'Not found',404);return;}html(res,page);return;}
    if(pathname==='/admin/settings'&&req.method==='GET'){const s=requireAdmin(req,res);if(!s)return;html(res,adminSettings(s));return;}

    // Admin APIs
    if(pathname==='/api/admin/products'&&req.method==='POST'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired. Refresh and try again.'});return;}const d=await readJson(req);const name=String(d.name||'').trim(), slug=slugify(d.slug||name);if(!name||!slug){json(res,400,{error:'Name and slug are required.'});return;}
      try{const audience=['Women','Men','Unisex'].includes(d.audience)?d.audience:'Unisex';const r=db.prepare(`INSERT INTO products(slug,name,inspired_by,description,category,audience,price_cents,compare_at_cents,size_ml,sku,stock,status,featured,bestseller,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(slug,name,String(d.inspired_by||''),String(d.description||''),String(d.category||'Signature'),audience,Number(d.price||0),d.compare_at_price==null?null:Number(d.compare_at_price),d.size_ml==null?null:Number(d.size_ml),String(d.sku||''),d.stock==null?null:Number(d.stock),d.status==='active'?'active':'draft',d.featured?1:0,d.bestseller?1:0,Number(d.sort_order||50));await persistDatabase();json(res,200,{id:Number(r.lastInsertRowid)});}catch(err){json(res,err.statusCode||400,{error:String(err.message).includes('UNIQUE')?'That URL slug already exists.':err.message});}return;
    }
    m=pathname.match(/^\/api\/admin\/products\/(\d+)$/); if(m&&req.method==='PUT'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const id=Number(m[1]),d=await readJson(req);const name=String(d.name||'').trim(),slug=slugify(d.slug||name);if(!name||!slug){json(res,400,{error:'Name and slug are required.'});return;}
      try{const audience=['Women','Men','Unisex'].includes(d.audience)?d.audience:'Unisex';db.prepare(`UPDATE products SET slug=?,name=?,inspired_by=?,description=?,category=?,audience=?,price_cents=?,compare_at_cents=?,size_ml=?,sku=?,stock=?,status=?,featured=?,bestseller=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(slug,name,String(d.inspired_by||''),String(d.description||''),String(d.category||'Signature'),audience,Number(d.price||0),d.compare_at_price==null?null:Number(d.compare_at_price),d.size_ml==null?null:Number(d.size_ml),String(d.sku||''),d.stock==null?null:Number(d.stock),d.status==='active'?'active':'draft',d.featured?1:0,d.bestseller?1:0,Number(d.sort_order||50),id);await persistDatabase();json(res,200,{ok:true});}catch(err){json(res,err.statusCode||400,{error:String(err.message).includes('UNIQUE')?'That URL slug already exists.':err.message});}return;
    }
    if(m&&req.method==='DELETE'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const id=Number(m[1]);const imgs=db.prepare('SELECT path FROM product_images WHERE product_id=?').all(id);db.prepare('DELETE FROM products WHERE id=?').run(id);for(const img of imgs) queueImageDeletion(img.path);await persistDatabase();await cleanupImages();json(res,200,{ok:true});return;
    }
    m=pathname.match(/^\/api\/admin\/products\/(\d+)\/images$/); if(m&&req.method==='POST'){
      const session=requireAdmin(req,res,{api:true});if(!session)return;
      if(!verifyCsrf(req,session)){json(res,403,{error:'Security token expired.'});return;}
      const productId=Number(m[1]);
      if(!db.prepare('SELECT id FROM products WHERE id=?').get(productId)){json(res,404,{error:'Product not found'});return;}
      const data=await readJson(req);
      const match=String(data.dataUrl||'').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if(!match){json(res,400,{error:'Please upload a PNG, JPG or WebP image.'});return;}
      const bytes=Buffer.from(match[2],'base64');
      if(bytes.length>10*1024*1024){json(res,400,{error:'Image must be under 10 MB.'});return;}
      const type=match[1];
      const valid=type==='image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        type==='image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255])) :
        bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP';
      if(!valid){json(res,400,{error:'The file is not a valid PNG, JPG or WebP image.'});return;}
      const ext=type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg';
      const name=`p${productId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const imagePath=SUPABASE_ENABLED ? await uploadProductImage(name,bytes,type) : `/uploads/products/${name}`;
      if(!SUPABASE_ENABLED) fs.writeFileSync(path.join(UPLOADS,name),bytes);
      let result;
      try {
        const count=db.prepare('SELECT COUNT(*) n FROM product_images WHERE product_id=?').get(productId).n;
        result=db.prepare('INSERT INTO product_images(product_id,path,alt,sort_order,is_primary) VALUES(?,?,?,?,?)').run(productId,imagePath,String(data.alt||''),count,count===0?1:0);
      } catch(err) {
        queueImageDeletion(imagePath);
        await persistDatabase();
        await cleanupImages();
        throw err;
      }
      await persistDatabase();
      json(res,200,{id:Number(result.lastInsertRowid),path:imagePath});return;
    }
    m=pathname.match(/^\/api\/admin\/images\/(\d+)$/); if(m&&req.method==='DELETE'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const id=Number(m[1]);const img=db.prepare('SELECT * FROM product_images WHERE id=?').get(id);if(!img){json(res,404,{error:'Image not found'});return;}db.prepare('DELETE FROM product_images WHERE id=?').run(id);queueImageDeletion(img.path);const any=db.prepare('SELECT id FROM product_images WHERE product_id=? ORDER BY sort_order,id LIMIT 1').get(img.product_id);if(any)db.prepare('UPDATE product_images SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE product_id=?').run(any.id,img.product_id);await persistDatabase();await cleanupImages();json(res,200,{ok:true});return;
    }
    m=pathname.match(/^\/api\/admin\/images\/(\d+)\/primary$/); if(m&&req.method==='POST'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const id=Number(m[1]);const img=db.prepare('SELECT * FROM product_images WHERE id=?').get(id);if(!img){json(res,404,{error:'Image not found'});return;}db.prepare('UPDATE product_images SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE product_id=?').run(id,img.product_id);await persistDatabase();json(res,200,{ok:true});return;
    }
    m=pathname.match(/^\/api\/admin\/orders\/(\d+)$/); if(m&&req.method==='PUT'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const d=await readJson(req);const allowedStatus=['new','processing','fulfilled','cancelled'],allowedPay=['pending','paid','refunded','cancelled'];if(!allowedStatus.includes(d.status)||!allowedPay.includes(d.payment_status)){json(res,400,{error:'Invalid order status.'});return;}db.prepare('UPDATE orders SET status=?,payment_status=? WHERE id=?').run(d.status,d.payment_status,Number(m[1]));await persistDatabase();json(res,200,{ok:true});return;
    }
    if(pathname==='/api/admin/settings'&&req.method==='PUT'){
      const s=requireAdmin(req,res,{api:true});if(!s)return;if(!verifyCsrf(req,s)){json(res,403,{error:'Security token expired.'});return;}const d=await readJson(req);const allowed=Object.keys(settingDefaults);const up=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');for(const k of allowed)if(k in d)up.run(k,String(d[k]??''));await persistDatabase();json(res,200,{ok:true});return;
    }

    html(res,`${publicHeader('Not found',{canonicalPath:pathname,noindex:true})}<main><section class="page-hero"><div class="container"><h1>Page not found.</h1><a class="btn" href="/">Back home</a></div></section></main>${publicFooter()}`,404);
  } catch(err) {
    console.error(err);
    if(!res.headersSent) json(res,err.statusCode||500,{error:err.statusCode?err.message:'Something went wrong. Please try again.'}); else res.end();
  }
}
// One writer prevents overlapping product/image/order mutations in this instance.
let requestChain=Promise.resolve();
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,BASE_URL).pathname;
  const mutates=req.method!=='GET' || pathname==='/order/success';
  if(mutates) requestChain=requestChain.catch(()=>{}).then(()=>handleRequest(req,res));
  else handleRequest(req,res);
});
if(SUPABASE_ENABLED) setInterval(()=>{
  requestChain=requestChain.catch(()=>{}).then(async()=>{
    if(backupDirty) await persistDatabase();
    await cleanupImages();
  }).catch(err=>console.error('Storage retry:',err.message));
},30000).unref();

server.listen(PORT,()=>{
  console.log(`\nIsolde store is running at ${BASE_URL}`);
  console.log(`Admin: ${BASE_URL}/admin`);
  if(USING_DEFAULT_ADMIN) console.log(`Local demo login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log('');
});
