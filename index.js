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

// eBay category map
const CATEGORY_MAP = {
  // Men's Tops
  "men's t-shirt": '15687', "men's polo shirt": '2989', "men's polo": '2989',
  "men's casual shirt": '185100', "men's dress shirt": '57991', "men's shirt": '185100',
  "men's tank top": '15690', "men's henley": '185100',
  // Men's Bottoms
  "men's jeans": '11483', "men's chinos": '57989', "men's pants": '57989',
  "men's athletic shorts": '15689', "men's shorts": '15689',
  "men's sweatpants": '15691', "men's joggers": '15691',
  "men's athletic pants": '137094', "men's athletic top": '15687',
  // Men's Outerwear
  "men's suit jacket": '3001', "men's blazer": '3002',
  "men's jacket": '57988', "men's coat": '57988',
  "men's hoodie": '185101', "men's cardigan": '4250', "men's sweater": '4250',
  "men's vest": '15767',
  // Men's Shoes
  "men's sneakers": '15709', "men's running shoes": '15709', "men's slip-ons": '15709',
  "men's dress shoes": '53120', "men's loafers": '53120',
  "men's boots": '11498', "men's sandals": '11503',
  // Women's Tops
  "women's crop top": '53159', "women's camisole": '53159', "women's tank top": '53159',
  "women's t-shirt": '53159', "women's blouse": '53159', "women's top": '53159',
  "women's polo": '53159',
  // Women's Bottoms
  "women's athletic leggings": '169001', "women's leggings": '169001',
  "women's sports bra": '36988',
  "women's athletic top": '137084', "women's athletic shorts": '11555',
  "women's mini skirt": '63863', "women's maxi skirt": '63863', "women's skirt": '63863',
  "women's jeans": '11554',
  "women's sweatpants": '63867', "women's joggers": '63867', "women's pants": '63867',
  "women's shorts": '11555',
  // Women's Dresses
  "women's maxi dress": '63861', "women's mini dress": '63861', "women's midi dress": '63861',
  "women's casual dress": '63861', "women's formal dress": '63861',
  "women's sundress": '63861', "women's dress": '63861',
  // Women's Outerwear
  "women's blazer": '63862', "women's jacket": '63862', "women's coat": '63862', "women's vest": '63862',
  "women's cardigan": '63864', "women's hoodie": '63864', "women's sweater": '63864',
  // Women's Shoes
  "women's sneakers": '3034', "women's running shoes": '3034',
  "women's loafers": '3034', "women's slip-ons": '3034',
  "women's ankle boots": '45333', "women's wedges": '45333', "women's mules": '45333',
  "women's heels": '45333', "women's pumps": '45333',
  "women's boots": '45333', "women's sandals": '45333', "women's flats": '45333',
  // Boys'
  "boys' shoes": '57991', "boys' t-shirt": '57990', "boys' pants": '57990',
  "boys' shorts": '57990', "boys' jacket": '57990', "boys' hoodie": '57990',
  // Girls'
  "girls' shoes": '57991', "girls' t-shirt": '57991', "girls' dress": '57991',
  "girls' pants": '57991', "girls' skirt": '57991', "girls' jacket": '57991', "girls' hoodie": '57991',
  // Accessories
  "women's belt": '45233', "men's belt": '2993',
  "women's hat": '52382', "men's hat": '52365', "men's cap": '52365',
  "women's sunglasses": '101020', "men's sunglasses": '101020',
  "watch": '31387', "men's tie": '2999', "men's wallet": '15731',
  "women's handbag": '169291', "women's purse": '169291', "women's clutch": '169291',
  "backpack": '169291',
  "women's scarf": '45238', "men's scarf": '2996',
  "women's gloves": '45238', "men's gloves": '2992',
  "jewelry - necklace": '10968', "jewelry - bracelet": '10968',
  "jewelry - earrings": '10968', "jewelry - ring": '10968',
  "default": '11484'
};

function getCategoryId(categoryName) {
  const lower = (categoryName || '').toLowerCase();
  if (CATEGORY_MAP[lower]) return CATEGORY_MAP[lower];
  // Match longest key first (most specific)
  const keys = Object.keys(CATEGORY_MAP).filter(k => k !== 'default').sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return CATEGORY_MAP[key];
  }
  return CATEGORY_MAP.default;
}

function isShoeCategory(category) {
  return /sneakers?|running shoes?|dress shoes?|ankle boots?|boots?|sandals?|loafers?|slip.ons?|heels?|pumps?|flats?|wedges?|mules?/i.test(category || '');
}

function isAccessoryCategory(category) {
  return /\bbelt\b|\bhat\b|\bcap\b|sunglasses|\bwatch\b|\btie\b|\bwallet\b|handbag|\bpurse\b|\bclutch\b|backpack|\bscarf\b|gloves?|jewelry|necklace|bracelet|earrings?|\bring\b/i.test(category || '');
}

function getShoeType(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('sneaker')) return 'Sneakers & Athletic Shoes';
  if (lower.includes('running')) return 'Athletic Shoes';
  if (lower.includes('ankle boot')) return 'Ankle Boots & Booties';
  if (lower.includes('boot')) return 'Boots';
  if (lower.includes('sandal')) return 'Sandals';
  if (lower.includes('heel') || lower.includes('pump')) return 'Heels';
  if (lower.includes('flat')) return 'Flats & Oxfords';
  if (lower.includes('loafer') || lower.includes('slip')) return 'Loafers & Slip-Ons';
  if (lower.includes('dress shoe')) return 'Dress Shoes';
  if (lower.includes('wedge')) return 'Wedge Shoes';
  if (lower.includes('mule')) return 'Mules';
  return 'Shoes';
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
    // Resize + compress for Claude — keeps every image well under the 5 MB API limit
    const imageBlocks = await Promise.all(req.files.map(async f => {
      const buf = await sharp(f.path)
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } };
    }));

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
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
  "category": "pick best match: Men's T-Shirt, Men's Polo Shirt, Men's Casual Shirt, Men's Dress Shirt, Men's Tank Top, Men's Henley, Men's Jeans, Men's Chinos, Men's Pants, Men's Shorts, Men's Sweatpants, Men's Joggers, Men's Athletic Shorts, Men's Athletic Pants, Men's Athletic Top, Men's Jacket, Men's Coat, Men's Hoodie, Men's Sweater, Men's Cardigan, Men's Vest, Men's Blazer, Men's Suit Jacket, Men's Sneakers, Men's Running Shoes, Men's Dress Shoes, Men's Boots, Men's Sandals, Men's Loafers, Men's Slip-Ons, Women's T-Shirt, Women's Blouse, Women's Top, Women's Tank Top, Women's Crop Top, Women's Camisole, Women's Polo, Women's Jeans, Women's Pants, Women's Leggings, Women's Shorts, Women's Skirt, Women's Mini Skirt, Women's Maxi Skirt, Women's Sweatpants, Women's Joggers, Women's Casual Dress, Women's Formal Dress, Women's Maxi Dress, Women's Mini Dress, Women's Midi Dress, Women's Sundress, Women's Jacket, Women's Coat, Women's Hoodie, Women's Sweater, Women's Cardigan, Women's Vest, Women's Blazer, Women's Athletic Top, Women's Athletic Shorts, Women's Athletic Leggings, Women's Sports Bra, Women's Sneakers, Women's Running Shoes, Women's Heels, Women's Pumps, Women's Boots, Women's Ankle Boots, Women's Sandals, Women's Flats, Women's Wedges, Women's Loafers, Women's Slip-Ons, Women's Mules, Boys' T-Shirt, Boys' Pants, Boys' Shorts, Boys' Jacket, Boys' Hoodie, Boys' Shoes, Girls' T-Shirt, Girls' Dress, Girls' Pants, Girls' Skirt, Girls' Jacket, Girls' Hoodie, Girls' Shoes, Men's Belt, Women's Belt, Men's Hat, Women's Hat, Men's Sunglasses, Women's Sunglasses, Watch, Men's Tie, Men's Wallet, Women's Handbag, Women's Purse, Women's Clutch, Backpack, Men's Scarf, Women's Scarf, Men's Gloves, Women's Gloves, Jewelry - Necklace, Jewelry - Bracelet, Jewelry - Earrings, Jewelry - Ring",
  "size": "IMPORTANT: for shoes return US numeric size (e.g. 10, 10.5, 9). For clothing: XS/S/M/L/XL/XXL or waist/inseam (e.g. 32x30). Read tag if visible.",
  "sizeType": "for clothing: Regular, Big & Tall, Petite, Plus, Maternity. For shoes: Medium (Regular), Narrow, Wide, Extra Wide. Pick Regular/Medium if unsure.",
  "color": "primary color",
  "material": "for clothing: fabric (Cotton, Polyester, Denim, Wool, Linen). For shoes: upper material (Leather, Canvas, Mesh, Suede). Estimate if tag not visible.",
  "condition": "one of: New with tags, New without tags, Very Good, Good, Acceptable",
  "price": <number in USD, no quotes>,
  "description": "3-4 sentence eBay description covering: what it is, brand/style details, condition specifics, any flaws to disclose",
  "rotations": [array of integers, one per image in order — degrees clockwise to rotate each image to make it right-side up: 0, 90, 180, or 270. Use 0 if already correct. Detect upside-down (use 180), sideways (use 90 or 270). Most iPhone photos are correct at 0.]
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

    // Save processed JPEG for eBay image URLs — resize + auto-rotate EXIF
    const filenames = await Promise.all(req.files.map(async f => {
      const base = path.basename(f.path, path.extname(f.path));
      const jpegPath = path.join(uploadsDir, base + '.jpg');
      const buf = await sharp(f.path)
        .rotate()
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
      fs.writeFileSync(jpegPath, buf);
      if (f.path !== jpegPath) { try { fs.unlinkSync(f.path); } catch {} }
      return path.basename(jpegPath);
    }));
    data.uploadedFiles = filenames;
    if (!Array.isArray(data.rotations)) data.rotations = filenames.map(() => 0);

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

  const { title, description, price, condition, category, brand, size, color, sizeType, material, uploadedFiles, rotations } = req.body;
  const sku = `ls-${Date.now()}`;
  const baseUrl = 'https://listsync-server.onrender.com';

  // Apply rotations to saved images before sending to eBay
  if (rotations && rotations.length > 0) {
    await Promise.all((uploadedFiles || []).map(async (fname, i) => {
      const deg = Number(rotations[i] || 0);
      if (deg === 0) return;
      const fpath = path.join(__dirname, 'public', 'uploads', fname);
      if (!fs.existsSync(fpath)) return;
      const buf = await sharp(fpath).rotate(deg).toBuffer();
      fs.writeFileSync(fpath, buf);
    }));
  }

  const imageUrls = (uploadedFiles || []).map(f => `${baseUrl}/uploads/${f}`);
  console.log('IMAGE URLS BEING SENT TO EBAY:', JSON.stringify(imageUrls));

  try {
    const [policies, merchantLocationKey] = await Promise.all([getPolicies(), ensureLocation()]);
    console.log('Policies:', JSON.stringify(policies));
    console.log('Location key:', merchantLocationKey);

    let aspects;
    if (isShoeCategory(category)) {
      aspects = {
        Brand: [brand || 'Unknown'],
        'US Shoe Size': [size || 'See description'],
        Color: [color || 'See photos'],
        Department: [getDepartment(category)],
        Type: [getShoeType(category)],
        Width: [sizeType || 'Medium'],
        'Upper Material': [material || 'Leather'],
        Style: ['Casual'],
        Occasion: ['Casual'],
        'Country/Region of Manufacture': ['Unknown']
      };
    } else if (isAccessoryCategory(category)) {
      aspects = {
        Brand: [brand || 'Unknown'],
        Color: [color || 'See photos'],
        Department: [getDepartment(category)],
        'Country/Region of Manufacture': ['Unknown']
      };
    } else {
      aspects = {
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
    }
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
