const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_STATE_ID = process.env.APP_STATE_ID || 'default';
const isVercel = process.env.VERCEL === '1';
const useInMemoryStore = !MONGODB_URI;

let mongoConnectPromise;
let memoryState;
let forceMemoryFallback = false;

if (useInMemoryStore) {
  console.warn('MONGODB_URI is missing. Running with in-memory storage (data resets on restart).');
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

function isMemoryMode() {
  return useInMemoryStore || forceMemoryFallback;
}

async function ensureMongoConnected() {
  if (isMemoryMode()) return;
  if (mongoose.connection.readyState === 1) return;

  if (!mongoConnectPromise) {
    mongoConnectPromise = mongoose.connect(MONGODB_URI).catch((error) => {
      mongoConnectPromise = null;
      forceMemoryFallback = true;
      console.warn(`MongoDB connection failed, switching to in-memory mode: ${error.message}`);
      throw error;
    });
  }

  try {
    await mongoConnectPromise;
  } catch (_error) {
    // keep app running with in-memory fallback
  }
}

async function getOrCreateState() {
  if (isMemoryMode()) {
    if (!memoryState) {
      memoryState = {
        appId: APP_STATE_ID,
        products: [],
        imports: [],
        exports: [],
        adjustments: [],
        monthlySnapshots: [],
        revenueTransactions: []
      };
    }

    return memoryState;
  }

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
  res.json({
    ok: true,
    mongo: mongoose.connection.readyState === 1,
    storage: isMemoryMode() ? 'memory' : 'mongodb'
  });
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

    if (isMemoryMode()) {
      const state = await getOrCreateState();
      Object.keys(updates).forEach((key) => {
        state[key] = updates[key];
      });

      return res.json({ ok: true, updatedKeys: Object.keys(updates), state: pickState(state) });
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

    if (isMemoryMode()) {
      const state = await getOrCreateState();
      allowedKeys.forEach((key) => {
        state[key] = updates[key];
      });

      return res.json({ ok: true, migrated: true, state: pickState(state) });
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

    res.json({ ok: true, migrated: true, state: pickState(state) });
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback for client-side routes (SPA)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  await ensureMongoConnected();
  if (isMemoryMode()) {
    console.log('Server started with in-memory storage.');
  } else {
    console.log('MongoDB connected successfully.');
  }

  const maxPortRetries = 10;
  const tryListen = (port, retriesLeft) => {
    const server = app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' && retriesLeft > 0) {
        console.warn(`Port ${port} is busy, retrying on ${port + 1}...`);
        tryListen(port + 1, retriesLeft - 1);
        return;
      }

      throw error;
    });
  };

  tryListen(PORT, maxPortRetries);
}

if (isVercel) {
  module.exports = async (req, res) => {
    await ensureMongoConnected();
    return app(req, res);
  };
} else {
  start().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  });
}