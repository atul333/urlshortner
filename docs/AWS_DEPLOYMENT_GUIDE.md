# SocialAdLinker — Complete Single AWS EC2 Deployment Document

Deploy **SocialAdLinker** (`https://www.socialadlinker.com/`) on **one AWS EC2 Ubuntu 24.04 instance** — **no Amazon RDS, no Route 53, no ALB, no SES, and no S3 required.**

---

## 1. System Architecture (Single EC2 Instance)

| Component | Runs On | Purpose |
| --- | --- | --- |
| **Nginx + Certbot** | EC2 Ports `80`, `443` | Free Let's Encrypt HTTPS, HTTP→HTTPS redirect, security headers, `/api` & `/api/unlock` rate limiting |
| **PM2 + Node.js 22** | EC2 `127.0.0.1:3000` | Express API, SPA dashboard, Razorpay Checkout & webhook verification, Telegram Bot REST API |
| **PostgreSQL** | EC2 `127.0.0.1:5432` | Production relational database & immutable creator wallet ledger |
| **Daily Backup Cron** | EC2 `/var/backups/socialadlinker` | Automated `03:00` compressed `pg_dump` backups with 14-day retention |
| **UFW Firewall + AWS SG** | Ports `22`, `80`, `443` | Blocks direct external access to ports `3000` and `5432` |

---

## 2. Step-by-Step Deployment Guide

### Step 1: Launch AWS EC2 Instance & Elastic IP

1. Sign in to **AWS Console → EC2 → Instances → Launch instances**.
2. Configure the instance:
   - **Name**: `socialadlinker-prod`
   - **Application and OS Images (AMI)**: **Ubuntu Server 24.04 LTS (HVM)** (64-bit x86)
   - **Instance type**:
     - `t3.small` (2 vCPU, 2 GB RAM) — **Recommended for production**
     - `t3.micro` (2 vCPU, 1 GB RAM) — Works for testing/early launch (add a 2 GB swap file in Step 4)
   - **Key pair (login)**: Create a new `.pem` key pair (for example `socialadlinker-ec2.pem`) and save it safely on Windows (e.g., `C:\Users\<YOUR_USER>\.ssh\socialadlinker-ec2.pem`).
   - **Configure storage**: `20 GB gp3` EBS root volume.
3. **Network settings (Security Group Inbound Rules)**:
   - **SSH (`22`)**: `My IP` *(recommended)* or `0.0.0.0/0` if your ISP IP changes frequently
   - **HTTP (`80`)**: `0.0.0.0/0` *(required for Let's Encrypt validation & HTTPS redirect)*
   - **HTTPS (`443`)**: `0.0.0.0/0`
   - **Important**: Do **NOT** open port `3000` or `5432`. Both stay internal to `127.0.0.1`.
4. Launch the instance, then attach a **Static Public IP (Elastic IP)**:
   - Open **EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address → Allocate**.
   - Select the allocated IP → **Actions → Associate Elastic IP address** → choose `socialadlinker-prod`.
   - Copy this IPv4 address (denoted `<EC2_IP>` below, e.g., `203.0.113.10`).

---

### Step 2: Configure Domain DNS Records

In your domain registrar's DNS control panel (GoDaddy, Namecheap, Hostinger, Cloudflare, etc.), add two `A` records pointing to `<EC2_IP>`:

| Type | Host / Name | Value | TTL |
| --- | --- | --- | --- |
| `A` | `@` (`socialadlinker.com`) | `<EC2_IP>` | 300 / Automatic |
| `A` | `www` (`www.socialadlinker.com`) | `<EC2_IP>` | 300 / Automatic |

> **Cloudflare Users**: Keep the proxy status on **DNS only (grey cloud)** while issuing the SSL certificate in Step 7. Once Certbot finishes and HTTPS works, you may switch to **Proxied (orange cloud)** with Cloudflare SSL/TLS set to **Full (strict)**.

Wait a few minutes and verify DNS propagation from your Windows PowerShell terminal:

```powershell
nslookup www.socialadlinker.com
nslookup socialadlinker.com
```

Both must return `<EC2_IP>` before running Certbot later.

---

### Step 3: Upload Project Code from Windows to EC2

#### 3A. Set Strict Key Permissions on Windows (One-Time)
Windows OpenSSH refuses to use a `.pem` key if other users can read it. Run in PowerShell:

```powershell
$key = "$HOME\.ssh\socialadlinker-ec2.pem"
icacls $key /inheritance:r
icacls $key /grant:r "$($env:USERNAME):(R)"
```

#### 3B. Upload from `e:\URLShortner_paid` to EC2

**Option 1: Direct Upload via `tar` + `scp` (No GitHub Repo Needed)**  
Run in Windows PowerShell from `e:\URLShortner_paid`:

```powershell
cd e:\URLShortner_paid
tar --exclude="node_modules" --exclude="data" --exclude=".git" --exclude=".env" --exclude="logs" -czf "$env:TEMP\socialadlinker.tar.gz" .
scp -i "$HOME\.ssh\socialadlinker-ec2.pem" "$env:TEMP\socialadlinker.tar.gz" ubuntu@<EC2_IP>:/tmp/socialadlinker.tar.gz
```

Then SSH into your EC2 server and extract into `/var/www/socialadlinker`:

```powershell
ssh -i "$HOME\.ssh\socialadlinker-ec2.pem" ubuntu@<EC2_IP>
```

On the EC2 Ubuntu shell:

```bash
sudo mkdir -p /var/www/socialadlinker
sudo chown -R "$USER":"$USER" /var/www/socialadlinker
tar -xzf /tmp/socialadlinker.tar.gz -C /var/www/socialadlinker
rm -f /tmp/socialadlinker.tar.gz
cd /var/www/socialadlinker
```

**Option 2: Clone from a Private Git Repository**

```bash
ssh -i /path/to/socialadlinker-ec2.pem ubuntu@<EC2_IP>
sudo mkdir -p /var/www/socialadlinker
sudo chown -R "$USER":"$USER" /var/www/socialadlinker
git clone <YOUR_GIT_REPO_URL> /var/www/socialadlinker
cd /var/www/socialadlinker
```

---

### Step 4: Provision EC2 Server (`deploy/ec2-setup.sh`)

*(Recommended if using `t3.micro` with 1 GB RAM)* — add a 2 GB swap file so `npm ci` and PostgreSQL never run out of memory:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Run the automated setup script included in the repository:

```bash
cd /var/www/socialadlinker
sed -i 's/\r$//' deploy/ec2-setup.sh
chmod +x deploy/ec2-setup.sh
./deploy/ec2-setup.sh
```

**What this installs and configures on EC2:**
- **System packages**: `nginx`, `certbot`, `python3-certbot-nginx`, `postgresql`, `postgresql-contrib`, `ufw`
- **Runtime**: Node.js 22 LTS + global `pm2`
- **Firewall**: UFW enabled allowing `OpenSSH` and `'Nginx Full'` (`80`, `443`)
- **Database**: PostgreSQL user `socialadlinker` & database `socialadlinker` with a generated random password
- **Daily Backups**: Cron job `/etc/cron.d/socialadlinker-backup` running `pg_dump | gzip` daily at `03:00` into `/var/backups/socialadlinker/` (keeps 14 days)

**Save the `DATABASE_URL=...` printed at the end of the script.**

---

### Step 5: Configure `.env`, Migrate Database & Create Admin User

Install Node dependencies cleanly and create `.env`:

```bash
cd /var/www/socialadlinker
npm ci --omit=dev
cp .env.example .env
```

Generate two random secrets you will paste into `.env`:

```bash
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
echo "RAZORPAY_WEBHOOK_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

Open `.env` with `nano .env` and fill in your production values:

```env
NODE_ENV=production
PORT=3000
APP_URL=https://www.socialadlinker.com
TRUST_PROXY=1

# Paste the DATABASE_URL printed by ./deploy/ec2-setup.sh
DATABASE_URL=postgres://socialadlinker:YOUR_DB_PASSWORD@127.0.0.1:5432/socialadlinker
DATABASE_SSL=false
DATABASE_POOL_MAX=20

# Paste your generated 96-char secret
SESSION_SECRET=PASTE_GENERATED_SESSION_SECRET

# Razorpay Live Keys (Razorpay Dashboard -> Account & Settings -> API Keys)
RAZORPAY_KEY_ID=rzp_live_YOUR_KEY_ID
RAZORPAY_KEY_SECRET=YOUR_RAZORPAY_KEY_SECRET

# Paste the generated webhook secret (you will paste this exact same secret into Razorpay in Step 8)
RAZORPAY_WEBHOOK_SECRET=PASTE_GENERATED_WEBHOOK_SECRET

# Optional SMTP for Forgot-Password emails (Gmail App Password, Zoho Mail, Brevo, etc.)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=SocialAdLinker <no-reply@socialadlinker.com>
```

> **Critical Startup Rule (`src/config.js`)**: In production (`NODE_ENV=production`), the app requires `SESSION_SECRET` (32+ chars), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `APP_URL=https://...`, and a PostgreSQL `DATABASE_URL`. Defining `RAZORPAY_WEBHOOK_SECRET` now ensures PM2 starts cleanly on the first run.

Lock `.env` file permissions, apply database migrations, and create your Super Admin account:

```bash
chmod 600 .env
mkdir -p logs

# Create all PostgreSQL tables and seed default settings
npm run migrate

# Create your production Super Admin login
node scripts/create-admin.js --username admin --email admin@socialadlinker.com --password "ChooseAStrongPassword!2026"
```

---

### Step 6: Start SocialAdLinker with PM2

```bash
cd /var/www/socialadlinker
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
```

> **Important**: `pm2 startup` outputs a `sudo env PATH=...` command. Copy and run that exact printed command so SocialAdLinker starts automatically if EC2 reboots.

Verify Node.js is running and connected to PostgreSQL:

```bash
pm2 status
curl -s http://127.0.0.1:3000/healthz
```

Expected output:

```json
{"ok":true,"service":"socialadlinker"}
```

If `pm2 status` shows `errored`, check logs immediately with `pm2 logs socialadlinker --lines 50`.

---

### Step 7: Configure Nginx + Free HTTPS SSL (Certbot)

First verify from EC2 that your domain already resolves to this server:

```bash
curl -s http://checkip.amazonaws.com
dig +short www.socialadlinker.com
```

Both IPs should match. Then complete the **two-step Nginx SSL setup**:

```bash
# 1. Remove default Nginx welcome site and enable HTTP bootstrap config
sudo rm -f /etc/nginx/sites-enabled/default
sudo cp /var/www/socialadlinker/deploy/nginx-bootstrap.conf /etc/nginx/sites-available/socialadlinker.conf
sudo ln -sf /etc/nginx/sites-available/socialadlinker.conf /etc/nginx/sites-enabled/socialadlinker.conf
sudo nginx -t && sudo systemctl reload nginx

# 2. Issue free Let's Encrypt certificate (keep www.socialadlinker.com FIRST so path matches nginx.conf)
sudo certbot --nginx -d www.socialadlinker.com -d socialadlinker.com

# 3. Switch to hardened production Nginx config (TLSv1.2/1.3, HSTS, apex->www redirect, edge rate limits)
sudo cp /var/www/socialadlinker/deploy/nginx.conf /etc/nginx/sites-available/socialadlinker.conf
sudo nginx -t && sudo systemctl reload nginx
```

Verify certificate auto-renewal:

```bash
sudo certbot renew --dry-run
```

Open `https://www.socialadlinker.com/healthz` in your browser or run:

```bash
curl -s https://www.socialadlinker.com/healthz
```

---

### Step 8: Connect Razorpay Live Webhook & Configure Platform Settings

1. Log in to **Razorpay Dashboard** (switch toggle to **Live Mode**).
2. Go to **Account & Settings → Webhooks → + Add New Webhook**:
   - **Webhook URL**: `https://www.socialadlinker.com/api/webhooks/razorpay`
   - **Secret**: Paste the **exact** `RAZORPAY_WEBHOOK_SECRET` value you put in `/var/www/socialadlinker/.env`
   - **Active Events**:
     - `payment.captured`
     - `order.paid`
     - `refund.processed`
   - Click **Create Webhook**.
3. Open `https://www.socialadlinker.com/login` in your browser and sign in with the Super Admin account from Step 5.
4. Go to **Admin Console → Platform & KYC Settings** and configure:
   - **Withdrawal Commission (%)**: e.g., `0` while onboarding creators, or `5` / `10` when charging commission
   - **Default / Minimum / Maximum Price Per Link (Whole ₹)**: e.g., default `1`, min `1`, max `5000`
   - **Minimum Withdrawal (₹)**: e.g., `100`
   - **Business & KYC Details**: Company Name, Support Email, Support Phone, Business Address, Grievance Officer *(displayed automatically on About, Contact, Terms, Privacy, Refund & Delivery policy pages)*.

---

## 3. Post-Deploy Verification Checklist

| Check | How to Verify | Expected Result |
| --- | --- | --- |
| HTTPS & Redirect | Visit `http://socialadlinker.com` | Redirects cleanly to `https://www.socialadlinker.com/` |
| Health Endpoint | `curl -s https://www.socialadlinker.com/healthz` | `{"ok":true,"service":"socialadlinker"}` |
| Mobile UI | Open `https://www.socialadlinker.com` on a phone | Hamburger menu, dashboard drawer/tab bar, and unlock page fit without horizontal scroll |
| Creator Flow | Register test creator → shorten link (`₹1`) | Short link created cleanly; decimals like `1.5` rejected |
| Pay & Unlock Gate | Open `https://www.socialadlinker.com/<alias>` | Razorpay Checkout opens for exact `₹1`, unlocks destination after payment |
| Anti-Bypass Check | Copy `/go/<token>` into another browser / Incognito | Rejected immediately (`token` is single-use and cookie-bound) |
| Telegram / API Test | Create secret API key in **Dashboard → API & Webhooks** and call `POST /api/v1/links` | Returns JSON with `short_url` and configured price |
| Auto Backup | `sudo ls -lh /var/backups/socialadlinker` (next day or test `sudo -u postgres pg_dump socialadlinker \| gzip > /tmp/test.sql.gz`) | Non-empty `.sql.gz` SQL backup created cleanly |

---

## 4. Alternative Option: Docker Compose on EC2

If you prefer containerized deployment on the same EC2 instance using the included [Dockerfile](../Dockerfile) and [docker-compose.yml](../docker-compose.yml):

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx ufw
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable

cd /var/www/socialadlinker
cp .env.example .env
# Edit .env with SESSION_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, APP_URL=https://www.socialadlinker.com
echo "POSTGRES_PASSWORD=$(openssl rand -hex 20)" >> .env

sudo docker compose up -d --build
sudo docker compose exec web npm run migrate
sudo docker compose exec web node scripts/create-admin.js --username admin --email admin@socialadlinker.com --password "ChooseAStrongPassword!2026"
```

Then run **Step 7** above so Nginx + Let's Encrypt HTTPS proxies to `127.0.0.1:3000`.

---

## 5. Ongoing Operations, Updates & Recovery

### Deploy Code Updates from Windows

```powershell
# On Windows (in e:\URLShortner_paid):
tar --exclude="node_modules" --exclude="data" --exclude=".git" --exclude=".env" --exclude="logs" -czf "$env:TEMP\socialadlinker-update.tar.gz" .
scp -i "$HOME\.ssh\socialadlinker-ec2.pem" "$env:TEMP\socialadlinker-update.tar.gz" ubuntu@<EC2_IP>:/tmp/socialadlinker-update.tar.gz
```

```bash
# On EC2:
cd /var/www/socialadlinker
tar -xzf /tmp/socialadlinker-update.tar.gz -C /var/www/socialadlinker
rm -f /tmp/socialadlinker-update.tar.gz
npm ci --omit=dev
npm run migrate
pm2 reload deploy/ecosystem.config.cjs
```

### Logs, Database Checks & Restore

```bash
# Live application logs
pm2 logs socialadlinker

# Nginx access / error logs
sudo tail -n 50 /var/log/nginx/error.log

# Check PostgreSQL tables & counts
sudo -u postgres psql socialadlinker -c "SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS links FROM links; SELECT COUNT(*) AS paid_unlocks FROM payments WHERE status='paid';"

# Restore from a daily backup file (only if needed)
gunzip -c /var/backups/socialadlinker/socialadlinker_YYYY-MM-DD.sql.gz | sudo -u postgres psql socialadlinker
```

### Troubleshooting Quick Reference

- **PM2 restarts in a loop (`errored`)**: Check `pm2 logs socialadlinker --err --lines 40`. Most often caused by missing `RAZORPAY_WEBHOOK_SECRET` or invalid `DATABASE_URL` in `.env`.
- **`Certbot failed` during Step 7**: Ensure `dig +short www.socialadlinker.com` equals `<EC2_IP>`, AWS Security Group allows port `80`, and Cloudflare proxy (orange cloud) is temporarily off.
- **Nginx shows `502 Bad Gateway`**: Check `curl -s http://127.0.0.1:3000/healthz` and `pm2 status` on EC2.
- **Disaster Recovery**: Enable **AWS EC2 Data Lifecycle Manager** weekly/daily **EBS Volume Snapshots** for your EC2 instance root volume in AWS Console.
