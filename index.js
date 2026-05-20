const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${sanitized}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const {
  VERIFICATION_TOKEN,
  ENDPOINT_URL,
  EBAY_APP_ID,
  EBAY_CERT_ID,
  EBAY_RUNAME,
  ANTHROPIC_API_KEY,
  PORT = 3000
} = process.env;

const EBAY_RUNAME_CLEAN = (EBAY_RUNAME || '').trim();

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// eBay token storage
let ebayToken = null;
let ebayTokenExpiry = null;
let activeListings = [];

// eBay category map for clothing
const CATEGORY_MAP = {
  "men's t-shirt": '15687',
  "men's shirt": '185100',
  "men's dress shirt": '57991',
  "men's jeans": '11483',
  "men's pants": '57989',
  "men's shorts": '15689',
  "men's jacket": '57988',
  "men's coat": '57988',
  "men's sweater": '4250',
  "men's hoodie": '185101',
  "women's top": '53159',
  "women's blouse": '53159',
  "women's t-shirt": '53159',
  "women's jeans": '11554',
  "women's pants": '63867',
  "women's shorts": '11555',
  "women's dress": '63861',
  "women's skirt": '63863',
  "women's jacket": '63862',
  "women's coat": '63862',
  "women's sweater": '63864',
  "women's hoodie": '63864',
  "default": '11484'
};

function getCategoryId(categoryName) {
  const lower = (categoryName || '').toLowerCase();
  for (const [key, id] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return id;
  }
  return CATEGORY_MAP.default;
}

function getDepartment(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes("women")) return "Women";
  if (lower.includes("girl")) return "Girls";
  if (lower.includes("boy")) return "Boys";
  return "Men";
}

function getItemType(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('t-shirt')) return 'T-Shirt';
  if (lower.includes('dress shirt')) return 'Dress Shirt';
  if (lower.includes('hoodie')) return 'Hoodie';
  if (lower.includes('sweater')) return 'Sweater';
  if (lower.includes('jacket') || lower.includes('coat')) return 'Jacket';
  if (lower.includes('jeans')) return 'Jeans';
  if (lower.includes('shorts')) return 'Shorts';
  if (lower.includes('pants')) return 'Pants';
  if (lower.includes('dress')) return 'Dress';
  if (lower.includes('skirt')) return 'Skirt';
  if (lower.includes('blouse')) return 'Blouse';
  if (lower.includes('shirt')) return 'Shirt';
  if (lower.includes('top')) return 'Top';
  return 'Other';
}

function getStyle(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('hoodie')) return 'Pullover';
  if (lower.includes('jeans')) return 'Straight Leg';
  if (lower.includes('dress')) return 'Casual';
  if (lower.includes('jacket') || lower.includes('coat')) return 'Casual';
  if (lower.includes('sweater')) return 'Pullover';
  return 'Casual';
}

function getSleeveLength(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('t-shirt') || lower.includes('top') || lower.includes('blouse')) return 'Short Sleeve';
  if (lower.includes('shorts') || lower.includes('skirt') || lower.includes('dress') || lower.includes('jeans') || lower.includes('pants')) return 'Sleeveless';
  return 'Long Sleeve';
}

const CONDITION_MAP = {
  'New with tags': 'NEW',
  'New without tags': 'NEW_WITH_DEFECTS',
  'Very Good': 'USED_EXCELLENT',
  'Good': 'USED_VERY_GOOD',
  'Acceptable': 'USED_GOOD'
};

// eBay OAuth
const EBAY_SCOPE = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
].join(' ');

app.get('/api/auth-url', (req, res) => {
  const url = `https://auth.ebay.com/oauth2/authorize?` +
    `client_id=${EBAY_APP_ID}&` +
    `redirect_uri=${encodeURIComponent(EBAY_RUNAME_CLEAN)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(EBAY_SCOPE)}`;
  res.json({ url });
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No authorization code received from eBay.');

  try {
    const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
    const response = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: EBAY_RUNAME_CLEAN
      }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    ebayToken = response.data.access_token;
    ebayTokenExpiry = Date.now() + response.data.expires_in * 1000;
    const frontendUrl = process.env.FRONTEND_URL || 'https://sch3n67.github.io/listsync-app';
    res.send(`<html><body><script>window.location.href='${frontendUrl}/?connected=true';</script></body></html>`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('eBay login failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: !!(ebayToken),
    listingCount: activeListings.length
  });
});

app.post('/api/set-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });
  ebayToken = token.trim();
  ebayTokenExpiry = Date.now() + (2 * 60 * 60 * 1000);
  res.json({ success: true });
});

// Analyze photos with Claude AI
app.post('/api/analyze', upload.array('photos', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No photos uploaded' });
  }

  try {
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const imageBlocks = await Promise.all(req.files.map(async f => {
      let data, mediaType;
      if (supported.includes(f.mimetype)) {
        data = fs.readFileSync(f.path).toString('base64');
        mediaType = f.mimetype;
      } else {
        const converted = await sharp(f.path).jpeg({ quality: 85 }).toBuffer();
        data = converted.toString('base64');
        mediaType = 'image/jpeg';
      }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }));

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `You are an expert eBay clothing reseller. Analyze these clothing photos carefully and return a JSON object.

Look for any visible labels, tags, or text in the photos to identify brand, size, and material.
Assess the condition honestly based on what you can see.
Price competitively based on the brand and condition.

Return ONLY this JSON with no extra text:
{
  "title": "eBay title max 80 chars - include brand, item type, size, color, key details",
  "brand": "exact brand name or Unknown",
  "category": "one of: Men's T-Shirt, Men's Shirt, Men's Jeans, Men's Pants, Men's Shorts, Men's Jacket, Men's Sweater, Men's Hoodie, Women's Top, Women's T-Shirt, Women's Jeans, Women's Pants, Women's Shorts, Women's Dress, Women's Skirt, Women's Jacket, Women's Sweater, Women's Hoodie",
  "size": "exact size visible on tag or estimated (XS/S/M/L/XL/XXL or numeric)",
  "sizeType": "one of: Regular, Big & Tall, Petite, Plus, Maternity — pick Regular if unsure",
  "color": "primary color",
  "material": "fabric type visible on tag or estimated (e.g. Cotton, Polyester, Denim, Wool, Linen) — pick Cotton if unsure",
  "condition": "one of: New with tags, New without tags, Very Good, Good, Acceptable",
  "price": <number in USD, no quotes>,
  "description": "3-4 sentence eBay description covering: what it is, brand/style details, condition specifics, any flaws to disclose"
}`
          }
        ]
      }]
    });

    let data;
    const rawText = response.content[0].text;
    try {
      data = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI did not return valid JSON. Raw response: ' + rawText.slice(0, 200));
      data = JSON.parse(match[0]);
    }

    // Store uploaded file paths for later use
    const filenames = await Promise.all(req.files.map(async f => {
      const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (supported.includes(f.mimetype)) return path.basename(f.path);
      const jpegPath = f.path.replace(/\.[^.]+$/, '.jpg');
      await sharp(f.path).jpeg({ quality: 85 }).toFile(jpegPath);
      fs.unlinkSync(f.path);
      return path.basename(jpegPath);
    }));
    data.uploadedFiles = filenames;

    res.json(data);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function ensureLocation() {
  const locationKey = 'listsync1';
  const headers = {
    Authorization: `Bearer ${ebayToken}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US'
  };
  try {
    await axios.get(`https://api.ebay.com/sell/inventory/v1/location/${locationKey}`, { headers });
    console.log('Location already exists');
  } catch {
    try {
      const createRes = await axios.post(
        `https://api.ebay.com/sell/inventory/v1/location/${locationKey}`,
        {
          location: {
            address: {
              addressLine1: '1 Main St',
              city: 'San Jose',
              stateOrProvince: 'CA',
              postalCode: '95131',
              country: 'US'
            }
          },
          locationTypes: ['WAREHOUSE'],
          merchantLocationStatus: 'ENABLED',
          name: 'ListSync Default'
        },
        { headers }
      );
      console.log('Location created:', createRes.status);
    } catch (err) {
      console.error('Location create error:', err.response?.data || err.message);
    }
  }
  return locationKey;
}

async function getPolicies() {
  try {
    const headers = { Authorization: `Bearer ${ebayToken}` };
    const [fulfillment, payment, returns] = await Promise.all([
      axios.get('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US', { headers }),
      axios.get('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US', { headers }),
      axios.get('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US', { headers })
    ]);
    return {
      fulfillmentPolicyId: fulfillment.data.fulfillmentPolicies?.[0]?.fulfillmentPolicyId,
      paymentPolicyId: payment.data.paymentPolicies?.[0]?.paymentPolicyId,
      returnPolicyId: returns.data.returnPolicies?.[0]?.returnPolicyId
    };
  } catch (err) {
    console.error('getPolicies error:', err.response?.data || err.message);
    return {};
  }
}

// Create eBay listing
app.post('/api/list', async (req, res) => {
  if (!ebayToken || Date.now() >= ebayTokenExpiry) {
    return res.status(401).json({ error: 'Not connected to eBay. Please reconnect.' });
  }

  const { title, description, price, condition, category, brand, size, color, sizeType, material, uploadedFiles } = req.body;
  const sku = `ls-${Date.now()}`;
  const baseUrl = 'https://listsync-server.onrender.com';
  const imageUrls = (uploadedFiles || []).map(f => `${baseUrl}/uploads/${f}`);
  console.log('IMAGE URLS BEING SENT TO EBAY:', JSON.stringify(imageUrls));

  try {
    const [policies, merchantLocationKey] = await Promise.all([getPolicies(), ensureLocation()]);
    console.log('Policies:', JSON.stringify(policies));
    console.log('Location key:', merchantLocationKey);
    const aspects = {
      Brand: [brand || 'Unknown'],
      Size: [size || 'See description'],
      Color: [color || 'See photos'],
      Department: [getDepartment(category)],
      Type: [getItemType(category)],
      'Size Type': [sizeType || 'Regular'],
      'Fabric Type': [material || 'Cotton'],
      Style: [getStyle(category)],
      Fit: ['Regular'],
      Occasion: ['Casual'],
      Season: ['Fall', 'Winter', 'Spring', 'Summer'],
      'Sleeve Length': [getSleeveLength(category)],
      Pattern: ['Solid'],
      'Country/Region of Manufacture': ['Unknown']
    };
    console.log('Step 1: aspects being sent:', JSON.stringify(aspects));
    await axios.put(
      `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}`,
      {
        product: {
          title,
          description,
          ...(imageUrls.length > 0 && { imageUrls }),
          aspects
        },
        condition: CONDITION_MAP[condition] || 'USED_GOOD',
        availability: { shipToLocationAvailability: { quantity: 1 } }
      },
      {
        headers: {
          Authorization: `Bearer ${ebayToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        }
      }
    );

    // Step 2: Create offer
    const offerPayload = {
      sku,
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 1,
      categoryId: getCategoryId(category),
      listingDescription: description,
      merchantLocationKey,
      pricingSummary: {
        price: { value: Number(price).toFixed(2), currency: 'USD' }
      }
    };

    const listingPolicies = {};
    if (policies.fulfillmentPolicyId) listingPolicies.fulfillmentPolicyId = policies.fulfillmentPolicyId;
    if (policies.paymentPolicyId) listingPolicies.paymentPolicyId = policies.paymentPolicyId;
    if (policies.returnPolicyId) listingPolicies.returnPolicyId = policies.returnPolicyId;
    if (Object.keys(listingPolicies).length > 0) offerPayload.listingPolicies = listingPolicies;

    console.log('Step 2: Creating offer...');
    const offerRes = await axios.post(
      'https://api.ebay.com/sell/inventory/v1/offer',
      offerPayload,
      {
        headers: {
          Authorization: `Bearer ${ebayToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US'
        }
      }
    );

    const offerId = offerRes.data.offerId;

    console.log('Step 3: Publishing offer', offerId);
    const publishRes = await axios.post(
      `https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`,
      {},
      { headers: { Authorization: `Bearer ${ebayToken}`, 'Content-Type': 'application/json' } }
    );

    const listing = {
      sku,
      offerId,
      listingId: publishRes.data.listingId,
      title,
      price,
      condition,
      category,
      imageFile: uploadedFiles?.[0] || null,
      listedAt: new Date().toISOString()
    };
    activeListings.push(listing);

    res.json({ success: true, listingId: publishRes.data.listingId, sku });
  } catch (err) {
    console.error('Listing error:', err.response?.data || err.message);
    res.status(500).json({ error: JSON.stringify(err.response?.data) || err.message });
  }
});

// Get all active listings
app.get('/api/listings', (req, res) => {
  res.json(activeListings);
});

// Mark as sold / delete listing
app.delete('/api/listing/:sku', async (req, res) => {
  if (!ebayToken) return res.status(401).json({ error: 'Not connected to eBay' });

  try {
    await axios.delete(
      `https://api.ebay.com/sell/inventory/v1/inventory_item/${req.params.sku}`,
      { headers: { Authorization: `Bearer ${ebayToken}` } }
    );
    activeListings = activeListings.filter(l => l.sku !== req.params.sku);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err.response?.data || err.message);
    res.status(500).json({ error: JSON.stringify(err.response?.data) || err.message });
  }
});

// eBay compliance: account deletion notifications
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });
  const hash = crypto.createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', (req, res) => {
  res.status(200).json({ status: 'acknowledged' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`ListSync running on port ${PORT}`));
