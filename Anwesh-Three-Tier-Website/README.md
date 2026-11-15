# Anwesh Misra Portfolio — Three-Tier Website

This repository contains the **website application only**. It does not provision AWS resources. The website is intended to run directly on EC2 instances: Nginx serves the frontend, a Node.js API runs as a `systemd` service on the private app tier, and Amazon RDS for MySQL stores contact submissions.

## 1. Architecture

```text
Visitor's browser
       |
       v
Public Application Load Balancer (existing AWS infrastructure)
       |
       v
WEB TIER — Nginx on the web EC2 instance
  - Serves frontend/index.html
  - Proxies /api/* to the private app tier
       |
       v
APP TIER — Node.js / Express on private EC2 instance(s)
  - Validates contact form fields
  - Accepts PDF files only (up to 5 files, 5 MB each)
  - Saves contact records using parameterized SQL
  - Optionally emails you when a new message arrives
  - Uploads PDFs to a private S3 bucket in production
       |
       v
DATA TIER — Amazon RDS for MySQL
  - contact_submissions
  - contact_attachments (metadata and private object keys)

PDF binaries -> private S3 bucket (object storage, not another compute tier)
```

Expected network path:

- Public ALB -> web-tier Nginx EC2, TCP `80`.
- Web-tier EC2 -> app-tier EC2, TCP `3000`, using a private IP/DNS name or an internal load balancer.
- App-tier EC2 -> RDS MySQL, TCP `3306`.
- App-tier EC2 -> private S3 bucket using its EC2 instance role.

The browser calls `/api/contact` on the same host. It never connects directly to RDS or S3.

## 2. Folder structure

```text
Anwesh-Three-Tier-Website/
├── frontend/
│   └── index.html                  # Complete portfolio UI and contact form
├── backend/
│   ├── routes/contact.js           # Contact API, validation, DB persistence
│   ├── lib/storage.js               # Local development / private S3 PDF storage
│   ├── lib/mailer.js                # Optional SMTP notification
│   ├── uploads/.gitkeep             # Local development uploads only
│   ├── db.js                        # MySQL connection pool
│   ├── schema.sql                   # RDS/MySQL tables
│   ├── server.js                    # Express API + health endpoints
│   ├── package.json
│   ├── .env.example                 # Local development configuration
│   └── .env.production.example      # Production app-tier configuration template
├── deploy/
│   ├── nginx/anwesh-portfolio.conf  # Nginx web-tier server block
│   └── systemd/anwesh-portfolio-api.service
├── .nvmrc                           # Node.js major version
├── .gitignore
└── README.md
```

## 3. Runtime requirement

Use **Node.js 26 LTS** on the app EC2 instance. The package declares `node >=26`. As of 14 November 2026, Node.js 26 is the Active LTS release line. Check the currently supported release before future upgrades: https://nodejs.org/en/about/previous-releases

## 4. Local development

You need Node.js 26 and a local MySQL 8-compatible server. The website app uses MySQL, so a local MySQL service must be running for contact form tests.

### A. Create a local database and user

Open MySQL Workbench or a MySQL client as an administrative user and run:

```sql
CREATE DATABASE anwesh_portfolio
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'portfolio_app'@'localhost'
  IDENTIFIED BY 'REPLACE_WITH_A_LONG_LOCAL_PASSWORD';

GRANT SELECT, INSERT ON anwesh_portfolio.* TO 'portfolio_app'@'localhost';
FLUSH PRIVILEGES;
```

Then create the tables:

```bash
mysql -u portfolio_app -p anwesh_portfolio < backend/schema.sql
```

### B. Install and run the API

From the project folder:

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and set `DB_PASSWORD` to the local password you created. Keep `DB_SSL=false` and leave `S3_BUCKET` blank for local development. The API will save development PDFs under `backend/uploads/`.

Install dependencies and start the API:

```bash
npm install
npm run dev
```

Check the API in another terminal:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/health
```

`/health` tests the API process. `/api/health` also tests the MySQL connection.

### C. Serve the frontend locally

The contact form uses the same-origin path `/api/contact`, so local browser testing requires a web server that serves `frontend/` and proxies `/api/` to `127.0.0.1:3000`. You can use the included Nginx configuration on an Ubuntu/WSL development environment; set its `root` to the local `frontend` directory and set the API proxy target to `http://127.0.0.1:3000/api/`.

Opening `frontend/index.html` directly as a `file://` URL will display the portfolio, but the contact form cannot submit to the API from that file URL.

## 5. Deploy to the existing AWS three-tier environment

This section connects the website application to AWS resources you provision separately. It does not create or change the VPC, subnets, security groups, ALB, EC2, RDS, S3 bucket, or IAM roles.

### A. Data tier — Amazon RDS for MySQL

1. Use your RDS MySQL endpoint, database, and a dedicated application database user. Do not use the RDS master user in the website application.
2. Allow inbound TCP `3306` on the RDS security group only from the app-tier EC2 security group.
3. Create the database and app user (skip if they already exist). Run as a database administrator:

```sql
CREATE DATABASE anwesh_portfolio
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER 'anwesh_portfolio_app'@'%'
  IDENTIFIED BY 'REPLACE_WITH_A_STRONG_UNIQUE_PASSWORD';

GRANT SELECT, INSERT ON anwesh_portfolio.* TO 'anwesh_portfolio_app'@'%';
FLUSH PRIVILEGES;
```

4. Run the schema once against the portfolio database:

```bash
mysql -h YOUR_RDS_ENDPOINT -P 3306 -u YOUR_SCHEMA_ADMIN -p anwesh_portfolio < backend/schema.sql
```

The application user only needs access to the portfolio database. Do not grant it administrative privileges.

### B. App tier — install Node.js and the API directly on private EC2

The following commands assume an Ubuntu EC2 instance and an account with `sudo` access.

1. Install base packages and Node.js 26 from NodeSource's 26.x package repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version
```

Confirm that `node --version` reports `v26.x`.

2. Download the current Amazon RDS global CA bundle on the app EC2 instance:

```bash
sudo curl -fsSLo /etc/ssl/certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sudo chmod 644 /etc/ssl/certs/rds-global-bundle.pem
```

AWS publishes the regional and global RDS certificate bundles in its RDS TLS documentation: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html

3. Create a dedicated Linux service account and application directory:

```bash
sudo useradd --system --home-dir /opt/anwesh-portfolio-api \
  --create-home --shell /usr/sbin/nologin anweshapi
sudo mkdir -p /opt/anwesh-portfolio-api
sudo chown -R root:root /opt/anwesh-portfolio-api
```

4. Transfer the backend folder and the systemd service file to the app EC2 instance using your approved private access path. For a reachable host, the transfer commands look like this (replace the SSH destination with your bastion/SSM-enabled transfer method):

```bash
scp -r backend ubuntu@YOUR_APP_EC2_ROUTE:/tmp/
scp deploy/systemd/anwesh-portfolio-api.service ubuntu@YOUR_APP_EC2_ROUTE:/tmp/
```

Then on the app EC2 instance:

```bash
sudo cp -a /tmp/backend/. /opt/anwesh-portfolio-api/
sudo chown -R root:root /opt/anwesh-portfolio-api
cd /opt/anwesh-portfolio-api
sudo npm install --omit=dev
```

The recursive `backend` transfer includes hidden environment template files such as `.env.production.example`. Do not transfer a completed local `.env` file.

If the app instance has no public SSH route, copy the files using your approved private access method (for example, an SSM session or a bastion host). Do not open SSH to the whole internet just to transfer the application.

5. Create the protected production environment file:

```bash
sudo cp /opt/anwesh-portfolio-api/.env.production.example /etc/anwesh-portfolio-api.env
sudo nano /etc/anwesh-portfolio-api.env
sudo chown root:root /etc/anwesh-portfolio-api.env
sudo chmod 600 /etc/anwesh-portfolio-api.env
```

Fill in the real RDS values and private S3 bucket:

```env
NODE_ENV=production
PORT=3000
TRUST_PROXY_HOPS=2
DB_HOST=YOUR_RDS_ENDPOINT
DB_PORT=3306
DB_NAME=anwesh_portfolio
DB_USER=anwesh_portfolio_app
DB_PASSWORD=YOUR_STRONG_DATABASE_PASSWORD
DB_CONNECTION_LIMIT=10
DB_SSL=true
DB_SSL_CA_PATH=/etc/ssl/certs/rds-global-bundle.pem
AWS_REGION=ap-southeast-2
S3_BUCKET=YOUR_PRIVATE_PDF_BUCKET
OWNER_EMAIL=anweshmisra68@gmail.com
```

Keep SMTP fields blank unless you have configured an SMTP sender. Contact messages are stored in RDS even when email notifications are not configured.

6. Attach an EC2 instance role to the app-tier EC2 instance. Give it only the required S3 permissions for the private bucket's `contact-uploads/*` prefix:

- `s3:PutObject`
- `s3:DeleteObject` (used if the database transaction fails after an upload)

Do not put AWS access keys in `.env` or source code. The AWS SDK uses the instance role automatically.

7. Install the systemd service:

```bash
sudo cp /tmp/anwesh-portfolio-api.service \
  /etc/systemd/system/anwesh-portfolio-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now anwesh-portfolio-api
sudo systemctl status anwesh-portfolio-api
```

View API logs:

```bash
sudo journalctl -u anwesh-portfolio-api -f
```

Test the API locally on the app instance:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/health
```

The app security group should allow inbound TCP `3000` only from the web-tier security group (or the internal load balancer security group if you use one). Do not expose port `3000` publicly.

### C. Web tier — install Nginx and publish the portfolio on public-facing EC2

1. Install Nginx:

```bash
sudo apt-get update
sudo apt-get install -y nginx
```

2. Transfer `frontend/index.html` and `deploy/nginx/anwesh-portfolio.conf` to the web EC2 instance using your approved private access path. For a reachable host, the transfer commands look like this:

```bash
scp frontend/index.html ubuntu@YOUR_WEB_EC2_ROUTE:/tmp/index.html
scp deploy/nginx/anwesh-portfolio.conf ubuntu@YOUR_WEB_EC2_ROUTE:/tmp/anwesh-portfolio.conf
```

Then copy the frontend HTML to the Nginx web root:

```bash
sudo mkdir -p /var/www/anwesh-portfolio
sudo cp /tmp/index.html /var/www/anwesh-portfolio/index.html
sudo chown -R www-data:www-data /var/www/anwesh-portfolio
sudo find /var/www/anwesh-portfolio -type d -exec chmod 755 {} \;
sudo find /var/www/anwesh-portfolio -type f -exec chmod 644 {} \;
```

3. Copy and edit the Nginx site configuration:

```bash
sudo cp /tmp/anwesh-portfolio.conf \
  /etc/nginx/sites-available/anwesh-portfolio
sudo nano /etc/nginx/sites-available/anwesh-portfolio
```

Replace `APP_TIER_PRIVATE_IP` in the `proxy_pass` line with the private IP of your Node API EC2 instance, for example `10.0.12.25`, or with the private DNS name of an internal load balancer that targets the app instances. The app tier must remain private.

4. Enable the Nginx site and validate its configuration:

```bash
sudo ln -s /etc/nginx/sites-available/anwesh-portfolio \
  /etc/nginx/sites-enabled/anwesh-portfolio
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

5. The web-tier security group should allow HTTP from the public ALB security group. The web EC2 instance must be able to reach the app EC2 private address on TCP `3000`.
6. Set the public ALB target group's health-check path to `/health-web` (HTTP `200`). The public ALB target group should target the web-tier Nginx instances on port `80`. Do not expose the app EC2 instances directly to the public ALB or the browser.

### D. Test through the website

1. Open your domain or the ALB endpoint in a browser.
2. Open **LET'S CONNECT**.
3. Submit a test enquiry without an attachment.
4. Confirm that the API returns a success response and the row is present in `contact_submissions`.
5. Submit a small PDF and confirm its metadata is in `contact_attachments` and the PDF object is private in S3.

## 6. Updating the website later

For frontend-only changes, copy the new `frontend/index.html` to `/var/www/anwesh-portfolio/index.html` on each web-tier instance. Nginx normally does not need a restart for static HTML updates.

For backend changes, copy the updated `backend/` contents to `/opt/anwesh-portfolio-api/`, install updated dependencies if `package.json` changed, then restart the service:

```bash
cd /opt/anwesh-portfolio-api
sudo npm install --omit=dev
sudo systemctl restart anwesh-portfolio-api
sudo systemctl status anwesh-portfolio-api
```

For multiple web/app EC2 instances, deploy the same version to every instance or use your existing private load-balancer/instance rollout process.

## 7. API endpoints and limits

- `GET /health` — API process liveness check.
- `GET /api/health` — readiness check that also tests the MySQL connection.
- `POST /api/contact` — accepts `multipart/form-data` fields `name`, `organization`, `website`, `description`, and zero to five `files` (PDF only).

Upload limits: up to 5 files, 5 MB each. The API checks the extension, MIME type, and PDF signature. The contact endpoint is rate-limited to 5 submissions per 15-minute window per client IP.

## 8. Viewing contact submissions

There is intentionally no public admin page. Connect to RDS using an approved database tool or secure private access and run:

```sql
SELECT id, name, organization, website, description, created_at
FROM contact_submissions
ORDER BY created_at DESC;

SELECT submission_id, original_name, object_key, storage_provider, size_bytes, created_at
FROM contact_attachments
ORDER BY created_at DESC;
```

The `object_key` values identify private S3 objects. Do not make the upload bucket public to make files accessible.

## 9. Important notes

- The frontend remains the portfolio design from the latest approved HTML. Its hosted media and fonts require internet access in the visitor's browser.
- The contact form posts to `/api/contact`; serve it through Nginx (or another same-origin web server) that proxies `/api/` to the private API. Opening the file directly with `file://` will not submit to the API.
- Contact records are stored in RDS MySQL. Optional email is a notification, not the primary storage.
- Production PDFs must be stored in private S3, not on the local EC2 disk, because local files can be lost when an instance is replaced or scaled in/out.
- The current file checks do not perform malware scanning. For public production uploads, add malware scanning before files are reviewed or downloaded.
- Keep `.env`, RDS passwords, SMTP credentials, CA private keys (if any), and AWS access keys out of Git. Do not commit `backend/.env` or `/etc/anwesh-portfolio-api.env`.
