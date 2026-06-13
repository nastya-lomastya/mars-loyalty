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

// ─── APNs PUSH для Apple Wallet ───────────────────────────────────────────────
function getApnProvider() {
  if (!process.env.PASS_CERT_BASE64 || !process.env.PASS_KEY_BASE64) return null;
  try {
    const apn = require('apn');
    return new apn.Provider({
      cert:        Buffer.from(process.env.PASS_CERT_BASE64, 'base64').toString('utf8'),
      key:         Buffer.from(process.env.PASS_KEY_BASE64,  'base64').toString('utf8'),
      production:  true,
    });
  } catch(e) {
    console.error('APNs provider error:', e.message);
    return null;
  }
}

async function sendPassUpdatePush(customerId) {
  try {
    const { data: regs } = await supabase
      .from('pass_registrations')
      .select('push_token')
      .eq('serial_number', customerId);

    if (!regs || regs.length === 0) return;

    const provider = getApnProvider();
    if (!provider) return;

    for (const reg of regs) {
      const note = new (require('apn').Notification)();
      note.topic = process.env.PASS_TYPE_IDENTIFIER;
      await provider.send(note, reg.push_token);
    }
    provider.shutdown();
    console.log(`APNs push sent for ${customerId} to ${regs.length} device(s)`);
  } catch(e) {
    console.error('APNs push error:', e.message);
  }
}

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
    // Write pass.json to tmp folder
    const passJson = {
      formatVersion:      1,
      passTypeIdentifier: process.env.PASS_TYPE_IDENTIFIER,
      serialNumber:       customer.id,
      teamIdentifier:     process.env.APPLE_TEAM_ID,
      organizationName:   'Mars Espresso',
      description:        'Mars Loyalty Card',
      backgroundColor:    'rgb(26, 26, 26)',
      foregroundColor:    'rgb(200, 169, 110)',
      labelColor:         'rgb(200, 169, 110)',
      webServiceURL:       'https://card.marsespresso.com/',
      authenticationToken: process.env.PASS_AUTH_TOKEN,
      barcodes: [{
        message:         customer.id,
        format:          'PKBarcodeFormatQR',
        messageEncoding: 'iso-8859-1',
      }],
      storeCard: {
        auxiliaryFields: [
          { key: 'stamps',  label: 'FİNCAN',  value: `${filled} / ${totalSlots}` },
          { key: 'gifts',   label: 'HEDİYE',  value: String(customer.gifts) },
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

    // Generate strip image — 2 rows: 4 cups top, 3 cups + gift bottom
    const sharp = require('sharp');
    const GOLD = '#C8A96E';
    const GREY = '#3a3a3a';
    const W = 640, H = 260;
    const ROW1 = 4, ROW2 = 3;
    const R = 30; // cup radius
    const colW1 = W / ROW1;
    const colW2 = W / (ROW2 + 1); // +1 for gift slot

    function cupSVG(cx, cy, color) {
      return `
        <path d="M${cx-22},${cy-10} Q${cx-22},${cy+18} ${cx},${cy+22} Q${cx+22},${cy+18} ${cx+22},${cy-10} Z"
              fill="${color}"/>
        <rect x="${cx-22}" y="${cy-18}" width="44" height="14" rx="4" fill="${color}"/>
        <rect x="${cx-14}" y="${cy-16}" width="28" height="10" rx="2" fill="rgb(26,26,26)" opacity="0.4"/>
        <path d="M${cx+22},${cy-12} Q${cx+34},${cy-12} ${cx+34},${cy} Q${cx+34},${cy+12} ${cx+22},${cy+12}"
              fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
      `;
    }

    function giftSVG(cx, cy, color) {
      return `
        <rect x="${cx-20}" y="${cy-8}" width="40" height="28" rx="4" fill="${color}"/>
        <rect x="${cx-20}" y="${cy-18}" width="40" height="12" rx="3" fill="${color}"/>
        <line x1="${cx}" y1="${cy-18}" x2="${cx}" y2="${cy+20}" stroke="rgb(26,26,26)" stroke-width="3"/>
        <line x1="${cx-20}" y1="${cy-12}" x2="${cx+20}" y2="${cy-12}" stroke="rgb(26,26,26)" stroke-width="3"/>
        <path d="M${cx},${cy-18} Q${cx-12},${cy-30} ${cx-16},${cy-22} Q${cx-20},${cy-14} ${cx},${cy-18}"
              fill="${color}"/>
        <path d="M${cx},${cy-18} Q${cx+12},${cy-30} ${cx+16},${cy-22} Q${cx+20},${cy-14} ${cx},${cy-18}"
              fill="${color}"/>
      `;
    }

    let icons = '';
    // Row 1: 4 cups
    for (let i = 0; i < ROW1; i++) {
      const cx = colW1 * i + colW1 / 2;
      const cy = 72;
      const color = i < filled ? GOLD : GREY;
      icons += cupSVG(cx, cy, color);
    }
    // Row 2: 3 cups + gift
    for (let i = 0; i < ROW2; i++) {
      const cx = colW2 * i + colW2 / 2;
      const cy = 190;
      const color = (i + ROW1) < filled ? GOLD : GREY;
      icons += cupSVG(cx, cy, color);
    }
    // Gift slot (8th = free)
    const giftCx = colW2 * ROW2 + colW2 / 2;
    const giftColor = filled >= totalSlots ? GOLD : GREY;
    icons += giftSVG(giftCx, 190, giftColor);

    const svgStrip = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="rgb(26,26,26)"/>
      ${icons}
    </svg>`;

    const stripBuf = await sharp(Buffer.from(svgStrip)).png().toBuffer();
    fs.writeFileSync(path.join(tmpDir, 'strip.png'),    stripBuf);
    fs.writeFileSync(path.join(tmpDir, 'strip@2x.png'), stripBuf);

    // Logo and icons
    const logoSrc = path.join(__dirname, 'public', 'mars_transparent.png');
    const iconSrc = path.join(__dirname, 'public', 'mars_white.png');
    fs.copyFileSync(logoSrc, path.join(tmpDir, 'logo.png'));
    fs.copyFileSync(logoSrc, path.join(tmpDir, 'logo@2x.png'));
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'icon.png'));
    fs.copyFileSync(iconSrc, path.join(tmpDir, 'icon@2x.png'));

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

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="mars-loyalty-${id}.pkpass"`);
    res.end(buf);

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

  // Отправляем push Apple Wallet для обновления карточки
  // Двойной push — первый сразу, второй через 5 сек (Apple иногда игнорирует первый)
  sendPassUpdatePush(customerId).catch(console.error);
  setTimeout(() => sendPassUpdatePush(customerId).catch(console.error), 5000);

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

// ─── APPLE WALLET WEBSERVICE ─────────────────────────────────────────────────
// Apple вызывает эти эндпоинты автоматически

// Регистрация устройства
app.post('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  const { deviceId, serialNumber } = req.params;
  const { pushToken } = req.body;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('ApplePass ', '');

  if (token !== process.env.PASS_AUTH_TOKEN) {
    return res.status(401).send();
  }

  const { error } = await supabase
    .from('pass_registrations')
    .upsert({
      device_id:    deviceId,
      push_token:   pushToken,
      pass_type_id: process.env.PASS_TYPE_IDENTIFIER,
      serial_number: serialNumber,
    }, { onConflict: 'device_id,serial_number' });

  if (error) {
    console.error('Registration error:', error);
    return res.status(500).send();
  }

  res.status(201).send();
});

// Удаление регистрации устройства
app.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
  const { deviceId, serialNumber } = req.params;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('ApplePass ', '');

  if (token !== process.env.PASS_AUTH_TOKEN) {
    return res.status(401).send();
  }

  await supabase
    .from('pass_registrations')
    .delete()
    .eq('device_id', deviceId)
    .eq('serial_number', serialNumber);

  res.status(200).send();
});

// Список обновлённых passes для устройства
app.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
  const { deviceId } = req.params;
  const { passesUpdatedSince } = req.query;

  const { data: regs } = await supabase
    .from('pass_registrations')
    .select('serial_number')
    .eq('device_id', deviceId);

  if (!regs || regs.length === 0) {
    return res.status(204).send();
  }

  // Проверяем какие customers обновились
  let query = supabase
    .from('customers')
    .select('id, updated_at')
    .in('id', regs.map(r => r.serial_number));

  if (passesUpdatedSince) {
    query = query.gt('updated_at', new Date(parseInt(passesUpdatedSince) * 1000).toISOString());
  }

  const { data: updated } = await query;

  if (!updated || updated.length === 0) {
    return res.status(304).send();
  }

  const lastModified = Math.max(...updated.map(u => new Date(u.updated_at).getTime() / 1000));

  res.json({
    serialNumbers: updated.map(u => u.id),
    lastUpdated:   String(Math.floor(lastModified)),
  });
});

// Отдать актуальный pass Apple
app.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
  const { serialNumber } = req.params;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('ApplePass ', '');

  if (token !== process.env.PASS_AUTH_TOKEN) {
    return res.status(401).send();
  }

  // Переиспользуем логику генерации pass — редиректим на наш эндпоинт
  req.params.id = serialNumber;
  return res.redirect(`/api/pass/${serialNumber}`);
});

// Логи от Apple
app.post('/v1/log', async (req, res) => {
  const { logs } = req.body;
  if (logs && logs.length > 0) {
    await supabase.from('pass_logs').insert(
      logs.map(msg => ({ message: typeof msg === 'string' ? msg : JSON.stringify(msg) }))
    );
  }
  res.status(200).send();
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