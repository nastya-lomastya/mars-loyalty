require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

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
  const { customerId, baristaId } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId gerekli' });

  // Get current customer state
  const { data: customer, error: fetchErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (fetchErr || !customer) return res.status(404).json({ error: 'Müşteri bulunamadı' });

  // Check daily limit — max 2 cups per UUID per day
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

  // Check if gift is being given (cups reached total)
  const giftGiven = customer.cups >= TOTAL_CUPS;
  let newCups, newGifts;

  if (giftGiven) {
    // Reset cups to 1 (welcome cup), increment gift counter
    newCups = 1;
    newGifts = customer.gifts + 1;
  } else {
    newCups = customer.cups + 1;
    newGifts = customer.gifts;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('customers')
    .update({
      cups: newCups,
      gifts: newGifts,
      updated_at: new Date().toISOString()
    })
    .eq('id', customerId)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Log the action
  await supabase.from('logs').insert([{
    customer_id: customerId,
    barista_id: baristaId || 'unknown',
    action: giftGiven ? 'gift_given' : 'cup_added',
    cups_after: newCups
  }]);

  res.json({
    id: updated.id,
    cups: updated.cups,
    gifts: updated.gifts,
    giftGiven,
    giftEarned: updated.cups >= TOTAL_CUPS
  });
});

// ─── PAGES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/barista', (req, res) => res.sendFile(path.join(__dirname, 'public', 'barista.html')));
app.get('/card/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'card.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mars Loyalty running on http://localhost:${PORT}`));
