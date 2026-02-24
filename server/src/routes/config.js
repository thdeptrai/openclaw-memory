const express = require('express');
const router = express.Router();
const runtimeConfig = require('../runtimeConfig');

/**
 * GET /api/config
 * Returns all settings with metadata, current values, and defaults
 */
router.get('/', (req, res) => {
    res.json({ success: true, data: runtimeConfig.getAll() });
});

/**
 * PUT /api/config
 * Update one or more settings
 * Body: { settings: { "key": value, ... } }
 */
router.put('/', (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Body must contain { settings: { key: value } }' });
    }

    const results = {};
    const errors = [];

    for (const [key, value] of Object.entries(settings)) {
        const result = runtimeConfig.set(key, value);
        results[key] = result;
        if (!result.success) {
            errors.push(`${key}: ${result.error}`);
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, errors, results });
    }

    res.json({ success: true, message: `Updated ${Object.keys(settings).length} setting(s)`, results });
});

/**
 * POST /api/config/reset
 * Reset one setting or all settings to defaults
 * Body: { key: "setting.key" } or { all: true }
 */
router.post('/reset', (req, res) => {
    const { key, all } = req.body;

    if (all) {
        const result = runtimeConfig.resetAll();
        return res.json({ success: true, message: 'All settings reset to defaults' });
    }

    if (key) {
        const result = runtimeConfig.reset(key);
        return res.json(result);
    }

    res.status(400).json({ error: 'Provide { key: "..." } or { all: true }' });
});

module.exports = router;
