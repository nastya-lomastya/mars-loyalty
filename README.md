# Mars Cafe — Loyalty System

Anonymous UUID-based loyalty card system. No personal data collected (no names, emails, or phone numbers) — fully KVKK compliant.

## How it works

1. Customer opens `marsespresso.com/loyalty` and gets a card with a QR code
2. On registration, the card starts with **1 welcome cup**
3. Barista scans the QR code and adds a cup after each purchase
4. On the **8th cup** — any coffee is free 🎁
5. Gift counter increments, cup counter resets to 0

## Pages

| URL | Description |
|-----|-------------|
| `/` | Customer registration page |
| `/card/:id` | Customer loyalty card with QR code |
| `/barista` | Barista panel — scan QR, add cups, register new customers |

## Setup

### Step 1 — Supabase (database)

1. Go to [supabase.com](https://supabase.com) → create a new project
2. Open **SQL Editor** and run this to create the tables:

```sql
-- Customers table
create table customers (
  id text primary key,
  cups integer default 1,
  gifts integer default 0,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Action log (for fraud detection)
create table logs (
  id uuid primary key default gen_random_uuid(),
  customer_id text references customers(id),
  barista_id text,
  action text,        -- 'cup_added' or 'gift_given'
  cups_after integer,
  created_at timestamp default now()
);
```

3. Go to **Settings → API** and copy:
   - Project URL → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`

### Step 2 — Local setup

```bash
# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Open .env and paste your Supabase credentials

# Start the server
npm run dev
# Open http://localhost:3000
```

### Step 3 — Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → select the repo
3. Add environment variables (same as your `.env` file)
4. Click Deploy — done! ✓

## Fraud protection

- Maximum **1 cup per UUID per day**
- Every action is logged: `customer_id`, `barista_id`, timestamp
- Barista PIN system — coming soon
- Owner dashboard with anomaly detection — coming soon

## Tech stack

| Tool | Purpose | Cost |
|------|---------|------|
| Supabase | Database | Free tier |
| Vercel | Hosting | Free tier |
| Node.js + Express | Server | — |
| Apple/Google Wallet | Card delivery | $99/year (Apple Developer) |
