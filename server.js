const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_STATE_ID = process.env.APP_STATE_ID || 'default';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Create a .env file from .env.example.');
  process.exit(1);
}

const stateSchema = new mongoose.Schema(
  {
    appId: { type: String, required: true, unique: true, index: true },
    products: { type: [mongoose.Schema.Types.Mixed], default: [] },
    imports: { type: [mongoose.Schema.Types.Mixed], default: [] },
    exports: { type: [mongoose.Schema.Types.Mixed], default: [] },
    adjustments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    monthlySnapshots: { type: [mongoose.Schema.Types.Mixed], default: [] },
    revenueTransactions: { type: [mongoose.Schema.Types.Mixed], default: [] }
  },
  {
    timestamps: true,
    versionKey: false,
    minimize: false
  }
);

const WarehouseState = mongoose.model('WarehouseState', stateSchema);
const allowedKeys = [
  'products',
  'imports',
  'exports',
  'adjustments',
  'monthlySnapshots',
  'revenueTransactions'
];

function pickState(doc) {
  return {
    products: Array.isArray(doc.products) ? doc.products : [],
    imports: Array.isArray(doc.imports) ? doc.imports : [],
    exports: Array.isArray(doc.exports) ? doc.exports : [],
    adjustments: Array.isArray(doc.adjustments) ? doc.adjustments : [],
    monthlySnapshots: Array.isArray(doc.monthlySnapshots) ? doc.monthlySnapshots : [],
    revenueTransactions: Array.isArray(doc.revenueTransactions) ? doc.revenueTransactions : []
  };
}

function normalizeIncomingState(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const normalized = {};

  allowedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      normalized[key] = Array.isArray(source[key]) ? source[key] : [];
    }
  });

  return normalized;
}

function hasAnyData(state) {
  return allowedKeys.some((key) => Array.isArray(state[key]) && state[key].length > 0);
}

async function getOrCreateState() {
  let doc = await WarehouseState.findOne({ appId: APP_STATE_ID });

  if (!doc) {
    doc = await WarehouseState.create({
      appId: APP_STATE_ID,
      products: [],
      imports: [],
      exports: [],
      adjustments: [],
      monthlySnapshots: [],
      revenueTransactions: []
    });
  }

  return doc;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 });
});

app.get('/api/state', async (_req, res, next) => {
  try {
    const state = await getOrCreateState();
    res.json(pickState(state));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/state', async (req, res, next) => {
  try {
    const updates = {};

    allowedKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = Array.isArray(req.body[key]) ? req.body[key] : [];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid state keys provided.' });
    }

    const state = await WarehouseState.findOneAndUpdate(
      { appId: APP_STATE_ID },
      {
        $set: updates,
        $setOnInsert: { appId: APP_STATE_ID }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    res.json({ ok: true, updatedKeys: Object.keys(updates), state: pickState(state) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/migrate-local-state', async (req, res, next) => {
  try {
    const incomingState = normalizeIncomingState(req.body);

    if (!hasAnyData(incomingState)) {
      return res.status(400).json({ error: 'No local data to migrate.' });
    }

    const current = await getOrCreateState();
    const currentState = pickState(current);

    if (hasAnyData(currentState)) {
      return res.status(409).json({
        error: 'Server state already has data. Migration skipped to avoid overwrite.',
        state: currentState
      });
    }

    const updates = {};
    allowedKeys.forEach((key) => {
      updates[key] = Object.prototype.hasOwnProperty.call(incomingState, key) ? incomingState[key] : [];
    });

    const state = await WarehouseState.findOneAndUpdate(
      { appId: APP_STATE_ID },
      {
        $set: updates,
        $setOnInsert: { appId: APP_STATE_ID }
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    res.json({ ok: true, migrated: true, state: pickState(state) });
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log('MongoDB connected successfully.');

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});
