require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

const ATLANTIC_BASE = process.env.ATLANTIC_BASE || 'https://atlantich2h.com';
const ATLANTIC_KEY = process.env.ATLANTIC_KEY || '';
const ATLANTIC_PROFIT = Number(process.env.ATLANTIC_PROFIT || 10);
const PROFIT_PERCENT = ATLANTIC_PROFIT;
const PORT = Number(process.env.PORT || 3000);

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, {
    recursive: true
  });
}

const ORDERS_FILE = path.join(tmpDir, 'orders.json');

function generateRef(len = 12) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();
}

function slugify(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function endsWithTopup(v) {
  if (v == null) return false;
  return /\btopup\s*$/i.test(String(v).trim());
}

function sanitizeProductName(rawName) {
  if (rawName == null) return '';
  const name = String(rawName).trim();
  if (name.length === 0) return '';

  const manualRemovals = [
    'MOBILELEGENDS - ',
    'MOBILELEGEND - ',
    'MOBILELEGENDS-',
    'MOBILELEGEND-'
  ];

  const lower = name.toLowerCase();
  for (const prefix of manualRemovals) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return name.slice(prefix.length).trim();
    }
  }

  const separators = [' - ', '- ', ' -', '-'];
  let lastPos = -1;
  let sepLen = 0;
  for (const sep of separators) {
    const pos = name.lastIndexOf(sep);
    if (pos > lastPos) {
      lastPos = pos;
      sepLen = sep.length;
    }
  }
  if (lastPos >= 0) {
    const after = name.slice(lastPos + sepLen).trim();
    if (after.length > 0) return after;
  }

  return name;
}

function extractItemPrice(item) {
  if (!item) return 0;
  const candidates = ['price', 'harga', 'amount', 'nominal', 'sell_price', 'sellPrice', 'value', 'selling_price'];
  for (const k of candidates) {
    if (typeof item[k] !== 'undefined' && item[k] !== null && item[k] !== '') {
      const n = Number(String(item[k]).replace(/[^0-9.-]+/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];

    const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('orders.json parse error, resetting to empty array:', e.message);
      return [];
    }

    let arr = [];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && Array.isArray(parsed.orders)) {
      arr = parsed.orders;
    } else if (parsed && typeof parsed === 'object') {
      arr = Object.keys(parsed).map(k => parsed[k]);
    } else {
      arr = [];
    }

    arr = arr
      .filter(o => o && typeof o === 'object')
      .map(o => {
        const copy = Object.assign({}, o);
        if (typeof copy.id === 'undefined' || copy.id === null || copy.id === '') {
          copy.id = generateRef(12);
        } else {
          copy.id = String(copy.id);
        }
        return copy;
      });

    return arr;
  } catch (err) {
    console.error('Error reading orders file:', err);
    return [];
  }
}

function writeOrders(orders) {
  try {
    const arr = Array.isArray(orders) ? orders : [];
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error('Error writing orders file:', err);
  }
}

async function fetchPriceList() {
  const _sanitize = sanitizeProductName;
  const profitPercent = PROFIT_PERCENT / 100;
  const priceKeys = ['price', 'harga', 'amount', 'nominal', 'sell_price', 'sellPrice', 'value', 'selling_price'];

  try {
    const url = `${ATLANTIC_BASE}/layanan/price_list`;
    const res = await axios.post(
      url,
      new URLSearchParams({
        api_key: ATLANTIC_KEY,
        type: 'prabayar'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const raw = (res.data && res.data.data) ? res.data.data : [];

    const cleaned = raw
      .map(item => {
        const copy = Object.assign({}, item);
        copy.layanan = _sanitize(item.layanan || item.name || item.title || '');
        if (item.name) copy.name = _sanitize(item.name);
        if (item.title) copy.title = _sanitize(item.title);
        if (item.provider) copy.provider = _sanitize(item.provider);
        if (item.category) copy.category = _sanitize(item.category);

        if (profitPercent > 0) {
          for (const key of priceKeys) {
            if (typeof copy[key] !== 'undefined' && copy[key] !== null && copy[key] !== '') {
              let num = Number(String(copy[key]).replace(/[^0-9.-]+/g, ''));
              if (!Number.isNaN(num)) {
                copy[`_orig_${key}`] = num;
                copy[key] = Math.ceil(num * (1 + profitPercent));
              }
            }
          }
        }
        return copy;
      })
      .filter(item => {
        const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name, item.title].filter(Boolean);
        const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);

        const provHasTopup = provCandidates.some(p => endsWithTopup(p));
        const catHasTopup = catCandidates.some(c => endsWithTopup(c));
        return !(provHasTopup || catHasTopup);
      });

    return cleaned;
  } catch (err) {
    console.error('fetchPriceList error:', err && err.message ? err.message : err);
    return [];
  }
}

function extractMeta(priceList) {
  function sanitizeLocal(r) {
    return sanitizeProductName(r);
  }
  const list = Array.isArray(priceList) ? priceList : [];

  const sanitized = list
    .map(item => {
      const copy = Object.assign({}, item);
      copy.layanan = sanitizeLocal(item.layanan || item.name || item.title || '');
      if (item.name) copy.name = sanitizeLocal(item.name);
      if (item.title) copy.title = sanitizeLocal(item.title);
      if (item.provider) copy.provider = sanitizeLocal(item.provider);
      if (item.category) copy.category = sanitizeLocal(item.category);
      return copy;
    })
    .filter(item => {
      const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name, item.title].filter(Boolean);
      const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);
      return !(provCandidates.some(p => endsWithTopup(p)) || catCandidates.some(c => endsWithTopup(c)));
    });

  const catMap = new Map();
  const provMap = new Map();

  sanitized.forEach(item => {
    const providerNameRaw = item.provider || item.layanan || item.service || item.operator || item.name || 'Unknown';
    const providerName = sanitizeLocal(providerNameRaw) || providerNameRaw || 'Unknown';

    const categoryNameRaw = item.category || item.type || item.group || 'Other';
    const categoryName = sanitizeLocal(categoryNameRaw) || categoryNameRaw || 'Other';

    if (endsWithTopup(providerName) || endsWithTopup(categoryName)) return;

    const pSlug = slugify(providerName);
    const cSlug = slugify(categoryName);

    if (!provMap.has(pSlug)) {
      provMap.set(pSlug, {
        slug: pSlug,
        name: providerName,
        subtitle: item.subtitle || item.provider || item.layanan || '',
        img_url: item.img_url || item.img || item.image || item.logo || null,
        img: item.img || item.image || item.logo || null,
        count: 0,
        type: cSlug
      });
    }
    provMap.get(pSlug).count += 1;

    if (!catMap.has(cSlug)) {
      catMap.set(cSlug, {
        slug: cSlug,
        name: categoryName,
        count: 0
      });
    }
    catMap.get(cSlug).count += 1;
  });

  const plnSlug = 'pln';
  const voucherSlug = 'voucher';
  if (provMap.has(plnSlug)) {
    const plnProv = provMap.get(plnSlug);
    plnProv.type = voucherSlug;
    const plnCount = plnProv.count || 0;
    if (catMap.has(voucherSlug)) {
      catMap.get(voucherSlug).count += plnCount;
    } else {
      catMap.set(voucherSlug, {
        slug: voucherSlug,
        name: 'Voucher',
        count: plnCount
      });
    }
  }

  let categoriesArray = Array.from(catMap.values());
  let providersArray = Array.from(provMap.values());

  providersArray.sort((a, b) => String(a.name || a.slug || '').localeCompare(String(b.name || b.slug || ''), 'id', {
    sensitivity: 'base'
  }));
  categoriesArray.sort((a, b) => String(a.name || a.slug || '').localeCompare(String(b.name || b.slug || ''), 'id', {
    sensitivity: 'base'
  }));

  const allCategory = {
    slug: 'all',
    name: 'Semua',
    count: sanitized.length
  };

  const prioritySlugs = [
    'games',
    'voucher',
    'akun-premium',
    'data-internet',
    'pulsa-reguler',
    'pulsa-transfer'
  ];

  const catBySlug = new Map();
  categoriesArray.forEach(c => {
    if (c && c.slug) catBySlug.set(c.slug, c);
  });

  const ordered = [allCategory];
  prioritySlugs.forEach(s => {
    if (catBySlug.has(s)) {
      ordered.push(catBySlug.get(s));
      catBySlug.delete(s);
    }
  });

  const remaining = Array.from(catBySlug.values()).sort((a, b) => String(a.name || a.slug || '').localeCompare(String(b.name || b.slug || ''), 'id', {
    sensitivity: 'base'
  }));

  categoriesArray = [...ordered, ...remaining];

  return {
    categories: categoriesArray,
    providers: providersArray
  };
}

app.get('/', async (req, res) => {
  try {
    const list = await fetchPriceList();
    const meta = extractMeta(list);
    res.render('index', {
      categories: meta.categories,
      providers: meta.providers,
      rawProductsCount: list.length
    });
  } catch (err) {
    console.error('Error rendering home:', err);
    res.render('index', {
      categories: [],
      providers: [],
      rawProductsCount: 0
    });
  }
});

app.get('/:category/:provider', async (req, res) => {
  const {
    category,
    provider
  } = req.params;
  const list = await fetchPriceList();

  const sanitized = (Array.isArray(list) ? list : []).filter(item => {
    const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
    const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);
    const provHasTopup = provCandidates.some(p => endsWithTopup(p));
    const catHasTopup = catCandidates.some(c => endsWithTopup(c));
    const nameHasTopup = endsWithTopup(item.name) || endsWithTopup(item.title) || false;
    return !(provHasTopup || catHasTopup || nameHasTopup);
  });

  const filtered = sanitized.filter(item => {
    const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
    const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);

    const provMatch = provCandidates.some(p =>
      slugify(p).includes(slugify(provider)) ||
      slugify(provider).includes(slugify(p))
    );

    const catMatch = catCandidates.length ?
      catCandidates.some(c =>
        slugify(c).includes(slugify(category)) ||
        slugify(category).includes(slugify(c))
      ) :
      true;

    return provMatch && catMatch;
  });

  let products = filtered;
  if (!products.length) {
    products = sanitized.filter(item => {
      const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
      return provCandidates.some(p =>
        slugify(p).includes(slugify(provider)) ||
        slugify(provider).includes(slugify(p))
      );
    });
  }

  products.sort((a, b) => extractItemPrice(a) - extractItemPrice(b));

  let categoryName = null;
  let providerName = null;
  if (products.length) {
    const sample = products.find(p => p.provider) || products[0];
    providerName = sample.provider || sample.layanan || sample.service || sample.operator || provider;
    const catSample = products.find(p => p.category || p.type || p.group || p.service_type) || products[0];
    categoryName = catSample.category || catSample.type || catSample.group || catSample.service_type || category;
  } else {
    providerName = provider;
    categoryName = category;
  }

  res.render('provider', {
    categorySlug: category,
    providerSlug: provider,
    products,
    categoryName,
    providerName,
    showAllCategory: true
  });
});

app.get('/payment', (req, res) => {
  const {
    trx_id
  } = req.query;

  if (!trx_id) {
    return res.status(400).json({
      message: 'Paramter trx_id diperlukan'
    });
  }

  const orders = readOrders();
  const order = orders.find(o => String(o.id) === String(trx_id));

  if (!order) {
    return res.render('payment', {
      trx_id,
      order: null,
      notfound: true
    });
  }

  res.render('payment', {
    trx_id,
    order,
    notfound: false
  });
});

app.get('/status', (req, res) => {
  res.render('status');
});

app.get('/api/price-list', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  const data = await fetchPriceList();
  const sanitized = (Array.isArray(data) ? data : []).filter(item => {
    const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
    const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);
    const provHasTopup = provCandidates.some(p => endsWithTopup(p));
    const catHasTopup = catCandidates.some(c => endsWithTopup(c));
    const nameHasTopup = endsWithTopup(item.name) || endsWithTopup(item.title) || false;
    return !(provHasTopup || catHasTopup || nameHasTopup);
  });
  res.json({
    ok: true,
    count: sanitized.length,
    data: sanitized
  });
});

app.get('/api/categories', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  const list = await fetchPriceList();
  const {
    categories
  } = extractMeta(list);
  res.json({
    ok: true,
    count: categories.length,
    data: categories
  });
});

app.get('/api/providers', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  const {
    category = 'all'
  } = req.query;
  const list = await fetchPriceList();
  const {
    providers
  } = extractMeta(list);

  if (category === 'all') return res.json({
    ok: true,
    count: providers.length,
    data: providers
  });

  const filtered = providers.filter(p => p.type === slugify(category) || (p.name && p.name.toLowerCase().includes(String(category).toLowerCase())));
  filtered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id', {
    sensitivity: 'base'
  }));
  res.json({
    ok: true,
    count: filtered.length,
    data: filtered
  });
});

app.get('/api/products', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  const {
    provider = '', category = ''
  } = req.query;
  const list = await fetchPriceList();

  const sanitized = (Array.isArray(list) ? list : []).filter(item => {
    const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
    const catCandidates = [item.category, item.type, item.group, item.service_type].filter(Boolean);
    const provHasTopup = provCandidates.some(p => endsWithTopup(p));
    const catHasTopup = catCandidates.some(c => endsWithTopup(c));
    const nameHasTopup = endsWithTopup(item.name) || endsWithTopup(item.title) || false;
    return !(provHasTopup || catHasTopup || nameHasTopup);
  });

  const filtered = sanitized.filter(item => {
    const provCandidates = [item.provider, item.layanan, item.service, item.operator, item.name].filter(Boolean);
    const catCandidates = [item.category, item.type, item.group].filter(Boolean);
    const provMatch = provider ? provCandidates.some(p => slugify(p).includes(slugify(provider)) || slugify(provider).includes(slugify(p))) : true;
    const catMatch = category ? catCandidates.some(c => slugify(c).includes(slugify(category)) || slugify(category).includes(slugify(c))) : true;
    return provMatch && catMatch;
  });

  filtered.sort((a, b) => extractItemPrice(a) - extractItemPrice(b));

  res.json({
    ok: true,
    count: filtered.length,
    data: filtered
  });
});

app.post('/api/deposit-methods', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      type = '', method = ''
    } = req.body || {};
    const url = `${ATLANTIC_BASE}/deposit/metode`;
    const params = new URLSearchParams({
      api_key: ATLANTIC_KEY
    });
    if (type) params.append('type', type);
    if (method) params.append('metode', method);
    const resp = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });
    const payload = resp.data || {};
    const ok = payload.status === true || payload.ok === true || payload.success === true;
    const items = Array.isArray(payload.data) ? payload.data : [];

    const getTypeRank = (item) => {
      const raw = (item && (item.type || item.method || item.metode || item.category || item.kategori || item.name || item.nama)) || '';
      const s = String(raw).toLowerCase();
      if (/ewallet/.test(s) || /e-?wallet/.test(s)) return 0;
      if (/gopay|ovo|dana|linkaja|shopeepay/.test(s)) return 0;
      if (/bank/.test(s)) return 1;
      if (/va\b|virtual/.test(s) || /virtualaccount/.test(s)) return 2;
      return 3;
    };

    const ranked = items.map((it, idx) => ({
      it,
      idx,
      rank: getTypeRank(it)
    }));
    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.idx - b.idx;
    });
    let sortedData = ranked.map(r => r.it);

    const normalizeName = (it) => {
      return String((it && (it.method || it.metode || it.name || it.nama || it.type || it.code || it.id)) || '').toLowerCase();
    };

    const minFields = [
      'min_deposit', 'minimum_deposit', 'min', 'minimum', 'minimal', 'min_amount',
      'minAmount', 'minimumAmount', 'min_deposit_amount'
    ];

    const setMinOnObject = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      for (const f of minFields) {
        if (Object.prototype.hasOwnProperty.call(obj, f)) {
          try {
            obj[f] = 500;
          } catch (e) {}
        }
      }
      return true;
    };

    const applyMinToMethod = (methodObj) => {
      if (!methodObj || typeof methodObj !== 'object') return;
      setMinOnObject(methodObj);
      if (methodObj.limit && typeof methodObj.limit === 'object') {
        setMinOnObject(methodObj.limit);
        if (Object.prototype.hasOwnProperty.call(methodObj.limit, 'min')) methodObj.limit.min = 500;
        if (Object.prototype.hasOwnProperty.call(methodObj.limit, 'minimum')) methodObj.limit.minimum = 500;
      }
      if (methodObj.limits && typeof methodObj.limits === 'object') {
        setMinOnObject(methodObj.limits);
        if (Object.prototype.hasOwnProperty.call(methodObj.limits, 'min')) methodObj.limits.min = 500;
        if (Object.prototype.hasOwnProperty.call(methodObj.limits, 'minimum')) methodObj.limits.minimum = 500;
      }
      const hasAnyMin = minFields.some(f => Object.prototype.hasOwnProperty.call(methodObj, f)) ||
        (methodObj.limit && (methodObj.limit.min || methodObj.limit.minimum || methodObj.limit.min_deposit)) ||
        (methodObj.limits && (methodObj.limits.min || methodObj.limits.minimum || methodObj.limits.min_deposit));
      if (!hasAnyMin) {
        try {
          methodObj.min_deposit = 500;
        } catch (e) {}
      }
    };

    const findQrisFastIndex = () => {
      return sortedData.findIndex(it => {
        const n = normalizeName(it);
        return /qris.*fast|qrisfast|qris-?fast/.test(n);
      });
    };

    let qrisfastIndex = findQrisFastIndex();
    if (qrisfastIndex !== -1) {
      const qf = sortedData[qrisfastIndex];
      applyMinToMethod(qf);
      if (qrisfastIndex !== 0) {
        sortedData.splice(qrisfastIndex, 1);
        sortedData.unshift(qf);
      }
      sortedData = sortedData.filter((it, i) => {
        if (!it) return false;
        const n = normalizeName(it);
        if (i === 0) return true;
        if (/qris/.test(n) && !(/qris.*fast|qrisfast|qris-?fast/.test(n))) return false;
        return true;
      });
    } else {
      const qrisIndex = sortedData.findIndex(it => {
        const n = normalizeName(it);
        return /qris/.test(n) && !(/qris.*fast|qrisfast|qris-?fast/.test(n));
      });
      if (qrisIndex !== -1) {
        const qris = sortedData[qrisIndex];
        applyMinToMethod(qris);
        if (qrisIndex !== 0) {
          sortedData.splice(qrisIndex, 1);
          sortedData.unshift(qris);
        }
        sortedData = sortedData.filter((it, i) => {
          if (!it) return false;
          const n = normalizeName(it);
          if (i === 0) return true;
          if (/qris/.test(n) && !(/qris.*fast|qrisfast|qris-?fast/.test(n))) return false;
          return true;
        });
      }
    }

    return res.json({
      ok: ok,
      status: payload.status,
      code: payload.code || 200,
      data: sortedData,
      raw: payload
    });
  } catch (err) {
    console.error('deposit-methods proxy error:', err && err.message ? err.message : err);
    const detail = (err.response && err.response.data) ? err.response.data : {
      message: err.message
    };
    return res.status(500).json({
      ok: false,
      message: 'fetch deposit methods failed',
      error: detail
    });
  }
});

app.post('/api/create-deposit', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      price,
      type = 'ewallet',
      method = 'QRISFAST',
      phone,
      product
    } = req.body;
    if (!price) return res.status(400).json({
      ok: false,
      message: 'nominal required'
    });

    const reff_id = generateRef(12);

    const url = `${ATLANTIC_BASE}/deposit/create`;
    const params = new URLSearchParams({
      api_key: ATLANTIC_KEY,
      reff_id,
      nominal: price,
      type,
      metode: method,
      phone
    }).toString();

    const resp = await axios.post(url, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const data = resp.data;

    if (!data || !data.data) {
      return res.status(500).json({
        ok: false,
        message: data && data.message ? data.message : 'deposit create failed',
        raw: data
      });
    }

    let orders = readOrders();
    if (!Array.isArray(orders)) orders = [];

    const depositData = data.data;
    const order = {
      id: depositData.id != null ? String(depositData.id) : String(reff_id),
      reff_id: String(reff_id),
      nominal: Number(price),
      type: type,
      method: method,
      status: 'pending',
      created_at: new Date().toISOString(),
      expired_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 jam
      product: product || {}
    };

    if (depositData.nomor_va) order.account_number = depositData.nomor_va;
    if (depositData.tujuan) order.destination_number = depositData.tujuan;
    if (depositData.url) order.url = depositData.url;
    if (depositData.qr_string) order.qr_string = depositData.qr_string;
    if (depositData.qr_image) order.qr_image = depositData.qr_image;
    if (depositData.tambahan) order.addition = depositData.tambahan;
    if (depositData.fee) order.fee = depositData.fee;
    if (depositData.get_balance) order.get_balance = depositData.get_balance;

    if (!Array.isArray(orders)) orders = [];
    orders.push(order);
    writeOrders(orders);

    res.json({
      ok: true,
      reff_id,
      price,
      deposit: data.data,
      order_id: order.id
    });

  } catch (err) {
    console.error('create-deposit error:', err && err.response ? err.response.data || err.message : err);
    const message = err && err.message ? err.message : 'create deposit failed';
    res.status(500).json({
      ok: false,
      message: 'create deposit failed',
      error: message
    });
  }
});

app.post('/api/deposit-status', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      id
    } = req.body;
    if (!id) return res.status(400).json({
      ok: false,
      message: 'id required'
    });

    const url = `${ATLANTIC_BASE}/deposit/status`;
    const resp = await axios.post(url, new URLSearchParams({
      api_key: ATLANTIC_KEY,
      id
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const data = resp.data;

    if (data && data.data) {
      let orders = readOrders();
      const orderIndex = orders.findIndex(o => String(o.id) === String(id));
      if (orderIndex !== -1) {
        const newStatus = data.data.status || orders[orderIndex].status;
        orders[orderIndex].status = newStatus;

        if (!['pending', 'success'].includes(newStatus)) {
          orders.splice(orderIndex, 1);
        }

        writeOrders(orders);
      }
    }

    res.json({
      ok: true,
      data: resp.data
    });
  } catch (err) {
    console.error('deposit-status error:', err.response ? err.response.data : err.message);
    res.status(500).json({
      ok: false,
      message: 'deposit status failed',
      error: err.message
    });
  }
});

app.post('/api/deposit-cancel', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      id
    } = req.body;
    const url = `${ATLANTIC_BASE}/deposit/cancel`;
    const resp = await axios.post(url, new URLSearchParams({
      api_key: ATLANTIC_KEY,
      id
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    let orders = readOrders();
    orders = orders.filter(o => String(o.id) !== String(id));
    writeOrders(orders);

    res.json({
      ok: true,
      data: resp.data
    });
  } catch (err) {
    console.error('deposit-cancel error:', err.response ? err.response.data : err.message);
    res.status(500).json({
      ok: false,
      message: 'cancel failed',
      error: err.message
    });
  }
});

app.post('/api/transaction-create', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      reff_id,
      code,
      target
    } = req.body;
    if (!reff_id || !code || !target) return res.status(400).json({
      ok: false,
      message: 'reff_id, code, target required'
    });

    const url = `${ATLANTIC_BASE}/transaksi/create`;
    const params = new URLSearchParams({
      api_key: ATLANTIC_KEY,
      reff_id,
      code: String(code).toUpperCase(),
      target
    }).toString();

    const resp = await axios.post(url, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const data = resp.data;

    if (!data || !data.data) {
      return res.status(500).json({
        ok: false,
        message: data && data.message ? data.message : 'transaksi create failed',
        raw: data
      });
    }

    res.json({
      ok: true,
      data: data.data
    });
  } catch (err) {
    console.error('transaction-create error:', err.response ? err.response.data : err.message);
    res.status(500).json({
      ok: false,
      message: 'transaksi create failed',
      error: err.message
    });
  }
});

app.post('/api/transaction-status', async (req, res) => {
  const clientIp = req.ip;
  const allowedIps = ['::1', '127.0.0.1', '::ffff:127.0.0.1'];
  
  try {
    const {
      id,
      type = 'prabayar'
    } = req.body;
    const url = `${ATLANTIC_BASE}/transaksi/status`;
    const params = new URLSearchParams({
      api_key: ATLANTIC_KEY,
      id,
      type
    }).toString();
    const resp = await axios.post(url, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const data = resp.data;
    console.log(data)

    if (data && data.data) {
      const trxStatus = data.data.status || data.data.state || data.data.result || data.data.transaction_status || data.data.tx_status;
      const lowerStatus = String(trxStatus || '').toLowerCase();

      if (['success', 'done', 'paid', 'completed', 'failed', 'error', 'expired', 'cancel', 'cancelled'].includes(lowerStatus)) {
        let orders = readOrders();
        orders = orders.filter(o => String(o.id) !== String(id));
        writeOrders(orders);
      }
    }

    res.json({
      ok: true,
      data: resp.data
    });
  } catch (err) {
    console.error('transaction-status error:', err.response ? err.response.data : err.message);
    res.status(500).json({
      ok: false,
      message: 'transaksi status failed',
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (PORT=${PORT})`);
});