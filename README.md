# Isolde Fragrance Store — Storefront + Admin

A self-contained luxury e-commerce starter for **Isolde**, with the 9-product launch collection, the supplied product photography, shopping bag, checkout flow and a password-protected admin dashboard.

## What is included

### Storefront

- Redesigned luxury homepage using the supplied Isolde product photography
- 9 Isolde fragrances, all configured as **100 mL**
- Women / Men / Unisex collections
- Scent-family filtering, search and price sorting
- Product detail pages with upgraded marketing copy
- Multiple product images per fragrance + selectable primary image
- Browser shopping bag and checkout
- Responsive mobile / tablet / desktop layout
- Product structured data, sitemap and robots.txt
- Independent-brand / inspired-by disclosure

### Best Sellers

The homepage is ready for a **Best Sellers** section.

- You can manually mark any fragrance as **Show as Best Seller** in Admin → Products.
- After paid orders exist, the store automatically ranks products using paid sales quantity.
- This avoids claiming products are best sellers before you have either selected them yourself or have sales data.

### Admin dashboard

Open `/admin` to manage:

- Product name and URL
- Inspired-by reference
- Marketing description
- Women / Men / Unisex assignment
- Scent family
- Price and compare-at price
- 100 mL size or future sizes
- SKU and stock
- Visibility / draft status
- Featured homepage products
- Best Seller flag
- Product order
- Multiple product photos
- Orders and payment status
- Brand text, contact information and homepage copy
- Shipping mode, shipping fee, free-shipping threshold and countries

## Current launch prices

All products are 100 mL and currently configured in CAD:

- Blue Elixir — $55
- Summer Creed — $60
- Charismatic Woods — $45
- Fruity Gardenia & Brown Sugar — $45
- Floral Lavender Nectar — $50
- Golden Orchid — $50
- Rich Saffron — $50
- Tobacco Vanille — $45
- Jasmine Flowers & Vanilla Bourbon — $50

## Requirements

- Node.js 22.5+
- No npm packages are required; the project uses Node's built-in `node:sqlite` module.

## Run locally

```bash
cd isolde_store
cp .env.example .env
npm start
```

Open:

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin

If no `.env` is present, local demo credentials are:

- Email: `admin@isolde.local`
- Password: `Isolde123!`

**Do not publish the store with the demo credentials.**

## Card payments with Stripe

The checkout is prepared for Stripe Checkout. Add your secret key to `.env`:

```env
STRIPE_SECRET_KEY=sk_live_...
BASE_URL=https://your-real-domain.com
```

For automatic card checkout, also open **Admin → Settings → Shipping** and choose either:

- **Flat rate** — enter the shipping charge and, optionally, a free-shipping threshold; or
- **Free shipping**.

If shipping is left on **Quote after order**, the site saves the order for manual follow-up instead of charging the customer before the shipping amount is known.

The server recalculates product prices and shipping itself. It does not trust prices stored in the customer's browser cart.

Configure a Stripe webhook for every live store, including low-volume stores:

1. In Stripe, add an event destination at `https://isolde.ca/api/stripe/webhook` (use your own `BASE_URL` if different).
2. Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Copy the destination signing secret into the server environment as `STRIPE_WEBHOOK_SECRET`.
4. Test with Stripe test-mode keys and its test card before switching to matching live-mode keys and a live-mode webhook secret.

The handler verifies the raw-body signature and timestamp, matches the stored session, order number, currency and total, and saves payment confirmation to Supabase. Repeated deliveries are safe. The success page also checks payment but is not required for confirmation. Card checkout failures preserve the bag and allow retry instead of silently changing the order to manual payment. Stripe transaction fees still apply.

## Shipping configuration

Admin → Settings includes:

- Shipping mode: Quote after order / Flat rate / Free shipping
- Flat shipping fee
- Optional free-shipping threshold
- Shipping countries
- Customer-facing shipping message

No shipping fee has been invented for the store. Choose your actual rate before going live.

## Images

Initial product images are in:

`public/uploads/products/`

From the admin panel you can upload more JPG, PNG or WebP photos to each fragrance and choose the primary image.

## Inspired-by notice

The site states that Isolde is independent and that designer fragrance names are used as comparative references to describe scent inspiration. Before a commercial launch, review the final product naming, packaging, advertising language and legal pages for the markets in which you sell.

## Before going live

1. Create `.env` and change the admin email, password and `SESSION_SECRET`.
2. Add the real domain to `BASE_URL` and use HTTPS.
3. Decide shipping prices and countries in Admin → Settings.
4. Add Stripe if you want card payments.
5. Add your real customer-service email / phone / Instagram.
6. Replace starter Shipping, Returns, Privacy and Terms copy with your final policies.
7. Add additional product photos from Admin → Products.
8. Back up `data/isolde.sqlite` and `public/uploads/`.

## Deployment note

### Supabase persistence on Render

The server can use Supabase Storage for product images and a private SQLite snapshot. This is designed for a small store on **one running Node server instance**; do not scale replicas or run another deployment against the same data bucket. Use different buckets/projects for staging. A larger store should move its database to shared Postgres. Render and Supabase free plans have usage limits and availability restrictions; check their current plans. No paid npm dependency is needed.

Set these variables in Render → your Web Service → Environment:

```env
NODE_ENV=production
BASE_URL=https://isolde.ca
ADMIN_EMAIL=your-email@example.com
ADMIN_PASSWORD=your-unique-password
SESSION_SECRET=your-random-secret-at-least-32-characters
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-secret-key
SUPABASE_DATA_BUCKET=isolde-private
SUPABASE_IMAGE_BUCKET=isolde-images
SUPABASE_SINGLE_INSTANCE=true
SUPABASE_ALLOW_INITIALIZE=true
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-webhook-signing-secret
GOOGLE_SITE_VERIFICATION=your-optional-google-verification-token
```

Keep all secret keys in the hosting environment, never GitHub or browser code. `SUPABASE_SECRET_KEY` accepts a server `sb_secret_...` key or the legacy `service_role` JWT. Do not use an anon/publishable key. Generate `SESSION_SECRET`, for example, with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

On the first setup, the server creates a **private** `isolde-private` bucket and a **public** `isolde-images` bucket. Existing buckets must have those access settings. If the current server has products or uploaded photos you want to keep, copy its `data/isolde.sqlite` and `public/uploads/products/` first; initialize from that copy. This code cannot recover files already erased by an earlier deployment. Available local product images are automatically migrated to Supabase.

**After the first successful deployment, set `SUPABASE_ALLOW_INITIALIZE=false`.** Then a missing, inaccessible, corrupt or failed database download stops startup instead of replacing your data with an empty catalogue. Startup validates the SQLite snapshot before using it. A cloud save failure is shown as an error and retried while the server is running; do not restart it until storage recovers. Image cleanup jobs are saved before deletion and retried after failures/restarts.

To connect Google, verify the domain in Google Search Console (DNS verification, or put its HTML tag token in `GOOGLE_SITE_VERIFICATION`), then submit `https://isolde.ca/sitemap.xml`. Titles, descriptions, canonical URLs, social previews and product structured data are generated by the server. Search ranking and indexing time are not guaranteed.

### Verification

Run `node --test tests/persistence-payments.test.mjs`. Tests use mock services and temporary databases to check image persistence after restart, backup failure responses, cleanup retries, failed restore protection, checkout retry safety, and signed payment confirmation. They do not connect to live Supabase or charge a card.
