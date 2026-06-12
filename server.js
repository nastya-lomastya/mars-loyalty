require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const TOTAL_CUPS = 8;
const WELCOME_CUPS = 1;
const MAX_CUPS_PER_DAY = 2;

// ─── APPLE WALLET PASS ────────────────────────────────────────────────────────
// GET /api/pass/:id — generate and return .pkpass file
app.get('/api/pass/:id', async (req, res) => {
  const { id } = req.params;

  const { data: customer, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !customer) {
    return res.status(404).json({ error: 'Müşteri bulunamadı' });
  }

    // passkit-generator appends '.pass' to the model path, so name the folder ending in .pass
  const tmpDir = path.join(os.tmpdir(), `mars-${id}-${Date.now()}.pass`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const { PKPass } = require('passkit-generator');

    if (!process.env.PASS_CERT_BASE64) throw new Error('PASS_CERT_BASE64 env variable missing');
    if (!process.env.PASS_KEY_BASE64)  throw new Error('PASS_KEY_BASE64 env variable missing');
    if (!process.env.PASS_WWDR_BASE64) throw new Error('PASS_WWDR_BASE64 env variable missing');

    const cups       = customer.cups;
    const totalSlots = TOTAL_CUPS - 1; // 7
    const filled     = Math.min(cups, totalSlots);
    const stampRow   = Array(totalSlots).fill(null)
      .map((_, i) => (i < filled ? '■' : '□')).join(' ');

    // Write pass.json to tmp folder
    const passJson = {
      formatVersion:      1,
      passTypeIdentifier: process.env.PASS_TYPE_IDENTIFIER,
      serialNumber:       customer.id,
      teamIdentifier:     process.env.APPLE_TEAM_ID,
      organizationName:   'Mars Espresso',
      description:        'Mars Loyalty Card',
      logoText:           'MARS CAFE',
      backgroundColor:    'rgb(26, 26, 26)',
      foregroundColor:    'rgb(200, 169, 110)',
      labelColor:         'rgb(200, 169, 110)',
      barcodes: [{
        message:         customer.id,
        format:          'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1',
      }],
      storeCard: {
        primaryFields: [{
          key:   'stamps',
          label: 'FİNCAN',
          value: `${filled} / ${totalSlots}`,
        }],
        secondaryFields: [{
          key:   'progress',
          label: 'İLERLEME',
          value: stampRow,
        }],
        auxiliaryFields: [
          { key: 'gifts',   label: 'HEDİYE', value: String(customer.gifts) },
          { key: 'card_id', label: 'KART ID', value: customer.id },
        ],
        backFields: [
          {
            key:   'how',
            label: 'Nasıl çalışır?',
            value: '7 fincan satın al, 8. fincanı bedava al. Baristayla QR kodunu paylaş.',
          },
          {
            key:   'terms',
            label: 'Koşullar',
            value: 'Kart kişiye özeldir. Günde en fazla 2 fincan eklenebilir.',
          },
        ],
      },
    };

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));

    // Copy icon/logo images to tmp folder
    const iconSrc = path.join(__dirname, 'public', 'mars_white.png');
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'icon.png'));
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'icon@2x.png'));
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'logo.png'));
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'logo@2x.png'));

    const pass = await PKPass.from({
      model: tmpDir,  // path to folder, not an object
      certificates: {
        wwdr:                Buffer.from(process.env.PASS_WWDR_BASE64, 'base64'),
        signerCert:          Buffer.from(process.env.PASS_CERT_BASE64, 'base64'),
        signerKey:           Buffer.from(process.env.PASS_KEY_BASE64,  'base64'),
        signerKeyPassphrase: process.env.PASS_CERT_PASSWORD,
      },
    });

    const buf = pass.getAsBuffer();

    res.set({
      'Content-Type':        'application/vnd.apple.pkpass',
      'Content-Disposition': `attachment; filename="mars-loyalty-${id}.pkpass"`,
      'Content-Length':       buf.length,
    });
    res.send(buf);

  } catch (err) {
    console.error('PKPass generation error:', err);
    res.status(500).json({ error: 'Pass oluşturulamadı: ' + err.message });
  } finally {
    // Clean up tmp folder
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  }
});

// ─── VERIFY barista PIN ───────────────────────────────────────────────────────
app.post('/api/barista/verify', async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN gerekli' });

  const { data, error } = await supabase
    .from('baristas')
    .select('id, name, active')
    .eq('pin', pin)
    .single();

  if (error || !data) return res.status(401).json({ error: 'Geçersiz PIN' });
  if (!data.active) return res.status(403).json({ error: 'Bu PIN devre dışı' });

  res.json({ id: data.id, name: data.name });
});

// ─── REGISTER new customer ────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const id = uuidv4().replace(/-/g, '').slice(0, 8);

  const { data, error } = await supabase
    .from('customers')
    .insert([{ id, cups: WELCOME_CUPS, gifts: 0 }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id, cups: data.cups, gifts: data.gifts });
});

// ─── GET customer by ID ───────────────────────────────────────────────────────
app.get('/api/customer/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Müşteri bulunamadı' });
  res.json(data);
});

// ─── ADD cup (barista action) ─────────────────────────────────────────────────
app.post('/api/add-cup', async (req, res) => {
  const { customerId, baristaPin } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId gerekli' });
  if (!baristaPin) return res.status(400).json({ error: 'PIN gerekli' });

  const { data: barista, error: baristaErr } = await supabase
    .from('baristas')
    .select('id, name, active')
    .eq('pin', baristaPin)
    .single();

  if (baristaErr || !barista) return res.status(401).json({ error: 'Geçersiz PIN' });
  if (!barista.active) return res.status(403).json({ error: 'Bu PIN devre dışı' });

  const { data: customer, error: fetchErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (fetchErr || !customer) return res.status(404).json({ error: 'Müşteri bulunamadı' });

  // Check daily limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todayLogs } = await supabase
    .from('logs')
    .select('id')
    .eq('customer_id', customerId)
    .eq('action', 'cup_added')
    .gte('created_at', todayStart.toISOString());

  if (todayLogs && todayLogs.length >= MAX_CUPS_PER_DAY) {
    return res.status(429).json({
      error: `Bu müşteri bugün zaten ${MAX_CUPS_PER_DAY} fincan aldı`
    });
  }

  const giftGiven = customer.cups >= TOTAL_CUPS;
  let newCups, newGifts;

  if (giftGiven) {
    newCups = 1;
    newGifts = customer.gifts + 1;
  } else {
    newCups = customer.cups + 1;
    newGifts = customer.gifts;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('customers')
    .update({ cups: newCups, gifts: newGifts, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await supabase.from('logs').insert([{
    customer_id: customerId,
    barista_id:  barista.id,
    action:      giftGiven ? 'gift_given' : 'cup_added',
    cups_after:  newCups
  }]);

  res.json({
    id:          updated.id,
    cups:        updated.cups,
    gifts:       updated.gifts,
    giftGiven,
    giftEarned:  updated.cups >= TOTAL_CUPS,
    baristaName: barista.name
  });
});

// ─── GOOGLE WALLET PASS ───────────────────────────────────────────────────────
app.get('/api/google-pass/:id', async (req, res) => {
  const { id } = req.params;

  const { data: customer, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !customer) {
    return res.status(404).json({ error: 'Müşteri bulunamadı' });
  }

  try {
    const issuerId  = process.env.GOOGLE_ISSUER_ID;
    const classId   = process.env.GOOGLE_CLASS_ID;
    const email     = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const rawKey    = process.env.GOOGLE_PRIVATE_KEY || '';
    const privateKey = rawKey.includes('\\n')
      ? rawKey.replace(/\\n/g, '\n')
      : rawKey;
    const keyId     = process.env.GOOGLE_PRIVATE_KEY_ID;

    const cups       = customer.cups;
    const totalSlots = TOTAL_CUPS - 1; // 7
    const filled     = Math.min(cups, totalSlots);

    const loyaltyObject = {
      id: `${issuerId}.mars_${id}`,
      classId: `${issuerId}.${classId}`,
      state: 'ACTIVE',
      accountId: id,
      accountName: `Kart: ${id}`,
      loyaltyPoints: {
        label: 'Fincan',
        balance: { string: `${filled} / ${totalSlots}` }
      },
      secondaryLoyaltyPoints: {
        label: 'Hediye',
        balance: { string: `${customer.gifts}` }
      },
      barcode: {
        type:          'QR_CODE',
        value:         id,
        alternateText: id,
      },
      heroImage: {
        sourceUri: { uri: 'https://card.marsespresso.com/mars_white.png' }
      },
      textModulesData: [{
        id:     'how_it_works',
        header: 'Nasıl çalışır?',
        body:   '7 fincan satın al, 8. fincanı bedava al. Baristayla QR kodunu paylaş.'
      }],
      infoModuleData: { showLastUpdateTime: true }
    };

    const jwtPayload = {
      iss: email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      payload: { loyaltyObjects: [loyaltyObject] },
      origins: ['https://card.marsespresso.com']
    };

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(jwtPayload, privateKey, {
      algorithm: 'RS256',
      keyid:     keyId,
    });

    res.redirect(`https://pay.google.com/gp/v/save/${token}`);

  } catch (err) {
    console.error('Google Wallet error:', err);
    res.status(500).json({ error: 'Google pass oluşturulamadı: ' + err.message });
  }
});

// ─── DEBUG (удалить после теста) ─────────────────────────────────────────────
app.get('/api/debug-modules', (req, res) => {
  const mods = {};
  ['passkit-generator', 'jsonwebtoken', 'jszip'].forEach(m => {
    try { require(m); mods[m] = 'OK'; } catch(e) { mods[m] = e.message; }
  });
  res.json(mods);
});

// ─── PAGES ────────────────────────────────────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/barista',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'barista.html')));
app.get('/card/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mars Loyalty running on http://localhost:${PORT}`));