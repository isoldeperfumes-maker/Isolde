# Deploy Isolde on Namecheap Shared Hosting (cPanel)

## 1) Upload
Upload the contents of this package to a folder outside `public_html`, for example:

`/home/YOUR_CPANEL_USERNAME/isolde_store`

Make sure `package.json`, `app.js`, `server.mjs`, `data/`, and `public/` are directly inside that folder.

## 2) Create the Node.js app
In cPanel, open **Setup Node.js App** and create an application with:

- Node.js version: **22.x**
- Application mode: **Production**
- Application root: **isolde_store**
- Application URL: your domain (for example `https://yourdomain.com`)
- Application startup file: **app.js**

## 3) Environment variables
Add these in the Node.js App screen:

- `BASE_URL` = `https://yourdomain.com`
- `ADMIN_EMAIL` = your private admin email
- `ADMIN_PASSWORD` = a strong unique password
- `SESSION_SECRET` = a long random secret (at least 32 random characters)
- `STORE_CURRENCY` = `CAD`
- `STRIPE_SECRET_KEY` = leave blank until Stripe is connected

Do **not** set `PORT` manually in cPanel; the hosting environment should provide it.

## 4) Start
No third-party npm packages are required. If cPanel shows a Run NPM Install button, it is safe to run, but there is nothing external to install.

Start or restart the application, then open your domain.
Admin login: `https://yourdomain.com/admin`

## 5) Writable data
The app must be able to write to:

- `data/isolde.sqlite`
- `public/uploads/products/`

Keep backups of both locations.

## 6) Before selling
Configure shipping in Admin → Settings, add your final policies/contact details, and connect Stripe if you want card payments.
