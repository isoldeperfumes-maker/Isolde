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

For a high-volume public launch, add a Stripe webhook so payment status is updated even if the customer closes the browser before returning to the store.

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

This version stores its SQLite database and uploaded images on disk. Deploy it to a Node server/VPS/container with persistent storage. If you deploy to a serverless platform with ephemeral storage, move the database and image uploads to persistent managed services first.
