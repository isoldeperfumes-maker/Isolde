# Put Isolde behind Cloudflare without changing the store backend

This Worker forwards storefront requests to the existing Render app. It replaces Render's HTML wake-up screen with a simple Isolde-branded page. The Render free service can still take up to about a minute to wake; this setup removes Render branding and avoids changing the SQLite, admin, Supabase, or Stripe implementation during the first cutover.

## Configure the Worker

1. Create a Cloudflare Worker using `cloudflare-worker.mjs` as its entry point (or deploy with Wrangler).
2. Add the Worker custom domain `isolde.ca` in Cloudflare.
3. Set the Worker variable `ORIGIN_URL` to the Render service's `https://<service>.onrender.com` address, not `https://isolde.ca`.
4. Test a product page, admin login, image upload, checkout and the Stripe webhook using a preview host before routing the public domain.

Keep `BASE_URL=https://isolde.ca` in Render so checkout return links and canonical URLs use the store domain.

## Cutover and rollback

Cloudflare's Worker custom domain will manage the `isolde.ca` DNS route. Leave Render running. To roll back, remove the Worker custom domain and restore the previous DNS records. Do not delete the Render service or Supabase data.

## Scope

This is a Cloudflare edge proxy, not a move of the Node.js application runtime. A full runtime move requires replacing the Node HTTP server and local synchronous SQLite calls with Worker request handling and Cloudflare D1 operations. This proxy keeps current application behavior and can be deployed independently first.
